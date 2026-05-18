# sqlite-wasm (vendored)

Local copy of `@sqlite.org/sqlite-wasm` — the SQLite team's official WebAssembly build, used by [db.js](../../db.js) to query [catalog.sqlite](../..) in the browser.

**Why vendored:** idealab is deployed in environments without external network access. All runtime dependencies live in-repo so the app loads identically from `file://`, local Caddy, or a fully air-gapped network.

## Pinned version

```
3.53.0-build1
```

The SQLite version is in [VERSION](./VERSION). FTS5 is compiled in (`SQLITE_ENABLE_FTS5`), which is the contract `scripts/build_sqlite.py` relies on for the `ideas_fts` / `requirements_fts` / `kpis_fts` / `entities_fts` virtual tables.

## Files

| File | Purpose | Loaded? |
|---|---|---|
| `index.mjs` | ESM entry point; defines `sqlite3InitModule` (the `default` export). | **Yes** — imported by `db.js` |
| `sqlite3.wasm` | The compiled SQLite engine. | **Yes** — fetched by `index.mjs` via `locateFile` |
| `index.min.mjs` | Minified variant of `index.mjs`. | Reserved (swap into `db.js` if you want smaller transfer). |
| `sqlite3-opfs-async-proxy.js` | Worker proxy for OPFS-backed persistence. | Only if OPFS is used (we don't, but kept so the module never 404s). |
| `sqlite3-worker1.mjs` | Worker-thread API. | Only if `sqlite3.oo1.Worker1` is invoked (we use the main-thread API). |
| `VERSION` | Plain-text version pin. | — |

## Re-vendoring

```bash
cd vendor/sqlite-wasm
VER="3.53.0-build1"   # bump deliberately
BASE="https://cdn.jsdelivr.net/npm/@sqlite.org/sqlite-wasm@${VER}/dist"
for f in index.mjs index.min.mjs sqlite3.wasm \
         sqlite3-opfs-async-proxy.js sqlite3-worker1.mjs; do
  curl -fsSLO "${BASE}/${f}"
done
echo "$VER" > VERSION
```

After updating, re-run `scripts/build_sqlite.py` and exercise the app at least once — newer SQLite releases occasionally tweak FTS5 query parsing.

## Upstream

- Package: <https://www.npmjs.com/package/@sqlite.org/sqlite-wasm>
- Docs: <https://sqlite.org/wasm/doc/trunk/index.md>
- FTS5: <https://sqlite.org/fts5.html>
