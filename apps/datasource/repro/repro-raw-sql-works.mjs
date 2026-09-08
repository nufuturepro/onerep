// Minimal repro: the same kind of build using raw.exec() only, which on
// Windows avoids the lock that Drizzle prepared statements create.
//
// Run:
//   bun apps/datasource/repro/repro-raw-sql-works.mjs
//
// Expected: rename succeeds on Windows and the temp dir is cleaned up.
//
// This is the shape the datasource should migrate toward (or at least gate
// behind a Windows-specific code path) for the staged database build.

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tableCount = 20;
const insertCount = 300;

{
  const dir = mkdtempSync(join(tmpdir(), "repro-rawsql-"));
  const dbPath = join(dir, "build.sqlite");
  const dest = join(dir, "live.sqlite");

  try {
    const raw = new Database(dbPath, { create: true, readwrite: true });
    raw.query("PRAGMA journal_mode = OFF").get();
    raw.query("PRAGMA synchronous = OFF").get();
    raw.query("PRAGMA cache_size = -65536").get();

    // Build a schema with several tables, all created with raw.exec().
    for (let i = 0; i < tableCount; i += 1) {
      raw.exec(`CREATE TABLE row${i} (id INTEGER PRIMARY KEY, value TEXT)`);
    }

    raw.exec("BEGIN");
    for (let i = 0; i < insertCount; i += 1) {
      const table = `row${i % tableCount}`;
      raw.exec(`INSERT INTO ${table} (id, value) VALUES (${i}, 'row ${i}')`);
      if (i % 100 === 0) {
        raw.exec("COMMIT");
        raw.exec("BEGIN");
      }
    }
    raw.exec("COMMIT");

    raw.close();
    Bun.gc(true);

    console.log(`=== repro/repro-raw-sql-works ===`);
    console.log(`staged: ${dbPath}`);
    console.log(`tables created: ${tableCount}`);
    console.log(`rows written: ${insertCount}`);
    console.log(`prepared statements used: 0 (raw.exec only)`);

    const fs = require("node:fs");
    const { existsSync, renameSync, rmSync } = fs;

    try {
      renameSync(dbPath, dest);
      console.log("renameSync: OK");
    } catch (error) {
      console.log(`renameSync: FAILED (${error.code})`);
      console.log("RESULT: even raw.exec() is failing (unexpected on Windows).");
      process.exit(1);
    }

    try {
      rmSync(dir, { recursive: true, force: true });
      console.log("cleanup: OK");
      console.log("\nRESULT: rename succeeded. A raw.exec()-only build avoids the lock.");
      process.exit(0);
    } catch (error) {
      console.log(`cleanup: FAILED (${error.code})`);
      console.log("RESULT: rename worked but cleanup failed.");
      process.exit(1);
    }
  } catch (error) {
    console.error(error);
    process.exit(2);
  }
}
