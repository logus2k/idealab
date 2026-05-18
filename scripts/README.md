# scripts/

Build and validation tools for the idealab data layer.

**All scripts are read-only against `data/*.json`, `ideas_catalog.md`, and `plans/*.md`.** They never mutate the source of truth — the SQLite output in `public/catalog.sqlite` is a derived artifact.

## Files

- `build_sqlite.py` — Read `data/*.json` + `ideas_catalog.md` + `plans/index.json` → emit `public/catalog.sqlite`.
- `validate_data.py` — Cross-reference validator per the data-relational-model memory note. Run before commits that touch `data/`.
- `smoke_test.py` — Open the built DB and run a few sanity queries (counts, FTS5, demand-side match).

## Usage

```bash
# from project root
python3 scripts/validate_data.py       # catch broken refs / dup IDs first
python3 scripts/build_sqlite.py        # produces public/catalog.sqlite
python3 scripts/smoke_test.py          # verify the build
```

No third-party dependencies — Python ≥ 3.10 stdlib (`json`, `re`, `sqlite3`, `pathlib`).

## Schema

UUID-keyed, six entity / join tables plus FTS5:

```
ideas(uuid PK, slug, title, section_no, section_name, description, source_md, is_sub)
requirements(uuid PK, slug, label, description)
kpis(uuid PK, slug, label, description)
plans(uuid PK, slug, title, type, file, order_idx)

tags(facet, value)                                    -- markdown vocabulary
idea_tags(idea_uuid, facet, value)                    -- M:N
idea_requirements(idea_uuid, requirement_uuid)        -- M:N from links.json
idea_kpis(idea_uuid, kpi_uuid)                        -- M:N from links.json
plan_ideas / plan_requirements / plan_kpis            -- M:N from links.json (deferred)

ideas_fts / requirements_fts / kpis_fts               -- FTS5 (porter unicode61)
```

## How descriptions and tags reach the DB

`data/ideas.json` only carries `{uuid, slug, title, section}`. Description, source citation, and the six tag facets (`function/industry/tech/audience/value/maturity`) live in `ideas_catalog.md`. The build script joins them by **exact title match**: each idea row in JSON looks up its bullet in the markdown by `title`.

If a title doesn't match, the idea still gets a row — just without description/tags. The script prints a warning listing every unmatched title. As of Section 1 (17 ideas), expected matched count is 17.

## Plans

`plans/index.json` lists filenames but **does not contain UUIDs**. To activate the `plans` table:

1. Create `data/plans.json` with one entry per plan: `{uuid, slug, title, type, file, order_idx}`. Generate UUIDs with `uuidgen` (UUIDv4, per memory rule). Never regenerate once committed.
2. Populate `plan_ideas` / `plan_requirements` / `plan_kpis` arrays in `data/links.json`.
3. Re-run `build_sqlite.py`.

Until then, the `plans` table builds empty and `plan_*` joins return nothing — by design.

## Output

`public/catalog.sqlite` is regenerated from scratch each run. It is **not** committed to git (see `.gitignore`); CI / Docker rebuilds it on every image build.
