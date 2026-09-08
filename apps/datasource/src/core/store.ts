import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createIndexSql, createTableSql, schemaTables } from "./ddl.ts";

/**
 * Database lifecycle shared by every provider.
 *
 * An import never touches the live file. It builds `<id>.next.sqlite` from
 * nothing, validates it, and renames it into place, keeping the outgoing file
 * as `<id>.previous.sqlite` for rollback. A failed build is discarded and
 * restarted rather than recovered, which is why the staging database runs with
 * durability switched off.
 */

export function livePath(dataDir: string, id: string): string {
  return join(dataDir, `${id}.sqlite`);
}

export function stagedPath(dataDir: string, id: string): string {
  return join(dataDir, `${id}.next.sqlite`);
}

export function previousPath(dataDir: string, id: string): string {
  return join(dataDir, `${id}.previous.sqlite`);
}

export type Staged<S extends Record<string, unknown>> = {
  /** Typed query builder over the provider's schema. */
  db: BunSQLiteDatabase<S>;
  /** The underlying handle, for FTS5 DDL and explicit transactions. */
  raw: Database;
  /**
   * Finalizes the prepared statements and closes the handle. Idempotent, so
   * both the success and the error path of an import may call it.
   */
  close(): void;
};

/**
 * Opens an empty staging database and creates the provider's tables from its
 * Drizzle schema. Indexes are deliberately *not* created here — every importer
 * builds them after the bulk load, where they cost one sort instead of a btree
 * insert per row.
 */
export function openStaged<S extends Record<string, unknown>>(
  dataDir: string,
  id: string,
  schema: S,
): Staged<S> {
  const path = stagedPath(dataDir, id);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });

  const raw = new Database(path, { create: true, readwrite: true });
  // Pragmas are stepped with `.get()` rather than `.exec()`, because the ones
  // that report a resulting value are not applied by `exec()` alone.
  //
  // `journal_mode = OFF` is requested but *not* relied on: Bun's SQLite build
  // refuses it and reports `delete` back, whatever the call style. WAL,
  // TRUNCATE and MEMORY all take, so this is specific to OFF. A rollback
  // journal is therefore always in play during an import, which is exactly why
  // the bulk loaders commit in batches instead of wrapping millions of rows in
  // one transaction — see `commitEvery`.
  raw.query("PRAGMA journal_mode = OFF").get();
  raw.query("PRAGMA synchronous = OFF").get();
  raw.query("PRAGMA temp_store = MEMORY").get();
  // Bounded so an import cannot page the 4 GB host into swap.
  raw.query("PRAGMA cache_size = -262144").get();

  for (const table of schemaTables(schema)) raw.exec(createTableSql(table));

  let closed = false;
  return {
    db: drizzle(raw, { schema }),
    raw,
    close() {
      if (closed) return;
      closed = true;
      // Drizzle's prepared statements are reclaimed by the garbage collector,
      // not by `Database.close()`, and on Windows an unfinalized statement
      // keeps the SQLite file handle open. That would make the rename in
      // `promote()` fail with EBUSY, so force a collection pass here. POSIX
      // is unaffected either way; the cost is one GC per import.
      raw.close();
      Bun.gc(true);
    },
  };
}

/**
 * Runs a bulk load in batched transactions.
 *
 * A single transaction spanning millions of rows is the fast way to load
 * SQLite right up until it isn't: the rollback journal that Bun's build will
 * not let us disable forces the dirty pages of an open transaction to be held,
 * and on the Open Food Facts import that reached the 2 GB cgroup limit within
 * 250,000 products and was OOM-killed. Committing periodically bounds it.
 *
 * The staging database is a throwaway that is only promoted once the whole
 * build succeeds, so a partial commit is never visible to anything — the
 * atomicity that matters is the file swap, not the transaction.
 */
export function commitEvery(raw: Database, rows: number, batchSize = 50_000): void {
  if (rows > 0 && rows % batchSize === 0) {
    raw.exec("COMMIT");
    raw.exec("BEGIN");
  }
}

/** Creates every index declared on the provider's Drizzle schema. */
export function createIndexes<S extends Record<string, unknown>>(
  staged: Staged<S>,
  schema: S,
): void {
  for (const table of schemaTables(schema)) {
    for (const statement of createIndexSql(table)) staged.raw.exec(statement);
  }
}

/**
 * Readonly handles currently open on live database files, keyed by file path.
 *
 * Windows cannot rename a file that any handle has open, so before a promotion
 * swaps a live file out, the readers registered here must be closed. They
 * reopen lazily on the next request, which is exactly what {@link LiveStore}
 * is designed to do.
 */
const liveReaders = new Map<string, Set<Database>>();

function readersFor(path: string): Set<Database> {
  let readers = liveReaders.get(path);
  if (!readers) {
    readers = new Set();
    liveReaders.set(path, readers);
  }
  return readers;
}

/**
 * Closes every registered reader on `path`. POSIX unaffected; Windows required.
 *
 * Closing is not enough on Windows: any drizzle statement a reader created is
 * only reclaimed by the garbage collector, and an unfinalized statement keeps
 * the file handle open. The forced collection pass finalizes them, which is
 * what makes the rename in {@link promote} safe.
 */
function releaseLiveReaders(path: string): void {
  const readers = liveReaders.get(path);
  if (!readers) return;
  liveReaders.delete(path);
  for (const reader of [...readers]) {
    try {
      reader.close();
    } catch {
      // Already gone; the reopen path does not care.
    }
  }
  Bun.gc(true);
}

/**
 * Validates a staged database and swaps it in, keeping the outgoing file as a
 * rollback copy. A failure here leaves the running server untouched.
 */
export function promote(dataDir: string, id: string, expectedRows: number): void {
  const staged = stagedPath(dataDir, id);
  const live = livePath(dataDir, id);
  const previous = previousPath(dataDir, id);

  const db = new Database(staged, { readonly: true });
  try {
    const integrity = db.query("PRAGMA integrity_check").get() as Record<string, string>;
    const result = Object.values(integrity)[0];
    if (result !== "ok") throw new Error(`integrity_check failed: ${result}`);
    if (expectedRows <= 0) throw new Error("refusing to promote an empty database");
  } finally {
    db.close();
  }

  // On Windows the renames below fail with EBUSY while any handle still has
  // the live file open, so same-process readers are closed first and reopen
  // lazily afterwards. The collection pass finalizes drizzle statements from
  // the build phase, whose file handles would otherwise survive until an
  // arbitrary later GC.
  releaseLiveReaders(live);
  Bun.gc(true);
  if (existsSync(live)) {
    rmSync(previous, { force: true });
    renameSync(live, previous);
  }
  try {
    renameSync(staged, live);
  } catch (error) {
    throw new Error(
      `promote: could not rename ${staged} to ${live} after releasing live readers`,
      { cause: error },
    );
  }
}

export function rollback(dataDir: string, id: string): void {
  const live = livePath(dataDir, id);
  const previous = previousPath(dataDir, id);
  if (!existsSync(previous)) throw new Error(`no rollback database for ${id}`);
  releaseLiveReaders(live);
  const spare = `${live}.rollback-swap`;
  if (existsSync(live)) renameSync(live, spare);
  renameSync(previous, live);
  if (existsSync(spare)) renameSync(spare, previous);
}

/**
 * A read-only handle to a live database that reopens itself after a promotion
 * replaces the file underneath it. The inode is re-checked at most once per
 * interval, so the common request path stays a single cached lookup.
 *
 * Returns null until the provider has been imported for the first time.
 */
export class LiveStore<S extends Record<string, unknown>> {
  private raw: Database | null = null;
  private db: BunSQLiteDatabase<S> | null = null;
  private inode: number | null = null;
  private checkedAt = 0;

  constructor(
    private readonly path: string,
    private readonly schema: S,
    private readonly recheckMs = 10_000,
  ) {}

  get(): BunSQLiteDatabase<S> | null {
    const now = Date.now();
    if (this.db && now - this.checkedAt < this.recheckMs) return this.db;
    this.checkedAt = now;

    if (!existsSync(this.path)) {
      this.close();
      return null;
    }

    const inode = statSync(this.path).ino;
    if (this.db && inode === this.inode) return this.db;

    this.close();
    this.raw = new Database(this.path, { readonly: true });
    this.db = drizzle(this.raw, { schema: this.schema });
    this.inode = inode;
    readersFor(this.path).add(this.raw);
    return this.db;
  }

  /** The raw handle behind {@link get}, for FTS5 queries Drizzle cannot type. */
  rawHandle(): Database | null {
    this.get();
    return this.raw;
  }

  close(): void {
    if (this.raw) liveReaders.get(this.path)?.delete(this.raw);
    this.raw?.close();
    this.raw = null;
    this.db = null;
    this.inode = null;
    // Drizzle statements opened through this store are finalized by the
    // collector; without this, Windows keeps the file locked until they run.
    Bun.gc(true);
  }
}
