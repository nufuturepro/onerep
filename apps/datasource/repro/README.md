# Windows datasource repro scripts

These are standalone diagnostic scripts for the Windows `promote()` EBUSY
issue discussed in the PR.

- `repro-drizzle-lock.mjs` — reproduces the lock: a staged SQLite database
  built with many Drizzle prepared statements cannot be renamed on Windows
  after `raw.close()` + `Bun.gc(true)`, even though the file is still
  readable.
- `repro-raw-sql-works.mjs` — shows the workaround: the same shape of build
  using `raw.exec()` only can be renamed normally on Windows.

Run them with:

```sh
bun apps/datasource/repro/repro-drizzle-lock.mjs
bun apps/datasource/repro/repro-raw-sql-works.mjs
```

They are Windows-specific by nature. On non-Windows they should both exit
cleanly; on Windows the first one is expected to fail with `EBUSY` and the
second to succeed.

These scripts are not part of the production build and are intentionally kept
out of the project `tsconfig.json` typecheck by way of
`tsconfig.build.json`.
