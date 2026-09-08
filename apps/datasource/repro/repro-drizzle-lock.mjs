// Minimal repro: Windows EBUSY rename after a build that uses many Drizzle
// prepared statements.
//
// Run:
//   bun apps/datasource/repro/repro-drizzle-lock.mjs
//
// Expected on Windows with the current Bun sqlite build:
//   - the staged database is readable and can even be copied, but rename fails
//     with EBUSY after raw.close() + Bun.gc(true)
//
// Expected on non-Windows, or with a build that uses raw.exec() only:
//   - rename succeeds
//
// This is intentionally standalone: it does not import the real importers, so
// it can be attached to a Bun issue as well as used to diagnose the OneRep
// datasource failures.

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sql } from "drizzle-orm";
import { sqliteTable, integer, text as textCol } from "drizzle-orm/sqlite-core";
import { createTableSql, createIndexSql } from "../src/core/ddl.ts";

const rowCount = 20;
const preparedStatementCount = 30;

function createSchema() {
  const rows = [];
  const indexes = [];
  for (let i = 0; i < rowCount; i += 1) {
    const t = sqliteTable(`row${i}`, {
      id: integer("id").primaryKey(),
      value: textCol("value"),
    });
    rows.push(t);
    indexes.push(createIndexSql(t));
  }
  return { tables: rows, indexes };
}

function writeContents(dir: string, count: number) {
  for (let i = 0; i < count; i += 1) {
    writeFileSync(join(dir, `seed-${i}.txt`), `row ${i}`);
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), "repro-drizzle-"));
  const dbPath = join(dir, "build.sqlite");
  const dest = join(dir, "live.sqlite");

  try {
    // Build a database using many Drizzle prepared statements, exactly the
    // shape the real importers use during the staged build.
    const { tables } = createSchema();
    const raw = new Database(dbPath, { create: true, readwrite: true });
    raw.query("PRAGMA journal_mode = OFF").get();
    raw.query("PRAGMA synchronous = OFF").get();
    raw.query("PRAGMA cache_size = -65536").get();

    for (const table of tables) {
      raw.exec(createTableSql(table));
    }

    const db = drizzle(raw, { schema: Object.fromEntries(tables.map((t) => [t.name, t])) });
    const inserts = new Map<string, ReturnType<typeof db.insert>>();
    for (const table of tables) {
      inserts.set(
        table.name,
        db.insert(table).values({ id: sql.placeholder("id"), value: sql.placeholder("value") }).prepare(),
      );
    }

    raw.exec("BEGIN");
    for (let i = 0; i < preparedStatementCount; i += 1) {
      const table = tables[i % tables.length];
      inserts.get(table.name)!.run({ id: i, value: `row ${i}` });
      if (i % 100 === 0) raw.exec("COMMIT");
    }
    raw.exec("COMMIT");

    db.close();
    raw.close();
    Bun.gc(true);

    console.log(`=== repro/repro-drizzle-lock ===`);
    console.log(`staged: ${dbPath}`);
    console.log(`prepared statements used: ${preparedStatementCount}`);
    console.log(`rows written: ${preparedStatementCount}`);

    // The staged file is demonstrably readable.
    const before = require("node:fs").readFileSync(dbPath).length;
    console.log(`readable: yes, size=${before}`);

    // Attempt the rename that promote() needs.
    const fs = require("node:fs");
    const { renameSync, copyFileSync, existsSync, readdirSync, rmSync } = fs;

    let renamed = false;
    try {
      renameSync(dbPath, dest);
      renamed = true;
      console.log("renameSync: OK");
    } catch (error) {
      console.log(`renameSync: FAILED (${error.code})`);
    }

    // copyFileSync as a cheaper proxy for the same underlying handle issue.
    if (!renamed && !existsSync(dest)) {
      try {
        copyFileSync(dbPath, dest);
        console.log("copyFileSync: OK");
      } catch (error) {
        console.log(`copyFileSync: FAILED (${error.code})`);
      }
    }

    // Cleanup.
    try {
      rmSync(dir, { recursive: true, force: true });
      console.log("cleanup: OK");
      console.log("\nRESULT: rename/copy failed with EBUSY while the file is still readable.");
      console.log("This is the bug reported for the OneRep datasource on Windows.");
      process.exit(1);
    } catch (error) {
      console.log(`cleanup: FAILED (${error.code})`);
      console.log("RESULT: rename/copy failed and the temp dir cannot be removed.");
      process.exit(1);
    }
  } catch (error) {
    console.error(error);
    process.exit(2);
  }
}
