# `data/` — relational layer

UUID-keyed JSON sidecars to `ideas_catalog.md` and `plans/`. The SQLite catalog (`public/catalog.sqlite`) is built from this directory; the markdown stays as prose-only.

See [`../documents/parallel_population_guide.md`](../documents/parallel_population_guide.md) for the full contributor guide.

## Files

| File | Shape | Notes |
|---|---|---|
| `ideas.json`        | `[{uuid, slug, title, section, kind}]` | One row per idea. Title must **exactly** match the bullet in `ideas_catalog.md`. `kind` is `"idea"` or `"pattern"`. |
| `requirements.json` | `[{uuid, slug, label, description}]` | Controlled vocabulary of demand-side pain points. |
| `kpis.json`         | `[{uuid, slug, label, description, category}]` | `category` is one of: revenue-and-growth, operational-efficiency, customer-experience, cost-and-margin, risk-and-compliance, talent-and-productivity, quality-and-accuracy. |
| `entities.json`     | `[{uuid, slug, name, type}]` | `type` is `"company"` or `"vendor"`. Includes 61 hand-curated + ~1100 auto-promoted HF authors. |
| `tasks.json`        | `[{uuid, slug, label, category, applies_to, icon_svg?, icon_color?}]` | HF pipeline_tag + task_categories taxonomy, 56 entries. `applies_to` is `["models"]`, `["datasets"]`, or both. |
| `dataset_modalities.json` | `[{uuid, slug, label}]` | 9 entries from HF datasets taxonomy. |
| `dataset_formats.json`    | `[{uuid, slug, label}]` | 10 entries from HF datasets taxonomy. |
| `plans.json`        | `[{uuid, slug, title, type, file, order_idx}]` *(pending creation)* | Registry for `plans/*.md`. |
| `links.json`        | object, partitioned by key | All cross-entity references. See below. |

## `links.json` keys (M:N edges)

Each entry is `{<entity-uuid-field>: <uuid>, <related-field>: [<uuid|id>, ...]}`.

| Key | Source | Target | Target ID format | Owner |
|---|---|---|---|---|
| `idea_requirements` | idea uuid | requirements | UUID | population thread |
| `idea_kpis`         | idea uuid | kpis         | UUID | population thread |
| `idea_entities`     | idea uuid | entities     | UUID | population thread |
| `idea_tasks`        | idea uuid | tasks        | UUID | graph thread |
| `idea_models`       | idea uuid | model_ids    | **HF id string** (e.g. `"meta-llama/Llama-3.1-8B-Instruct"`) | graph thread |
| `idea_datasets`     | idea uuid | dataset_ids  | **HF id string** | graph thread |
| `plan_ideas`        | plan uuid | ideas        | UUID | graph thread |
| `plan_requirements` | plan uuid | requirements | UUID | graph thread |
| `plan_kpis`         | plan uuid | kpis         | UUID | graph thread |
| `plan_models`       | plan uuid | model_ids    | HF id string | graph thread |
| `plan_datasets`     | plan uuid | dataset_ids  | HF id string | graph thread |

### Why HF id strings for models / datasets (not UUIDs)

Models and datasets live in HF snapshot files (`data/fetched/hf-*-*.json`), not as a local UUID registry. Their HF id (`<author>/<name>`) is globally unique and stable, so using it as the foreign key:

- Skips the registry-round-trip ("which local UUID does this HF model map to?").
- Stays valid as the snapshot refreshes daily — no stale references.
- Round-trips cleanly to URLs (`https://huggingface.co/<id>` and `https://huggingface.co/datasets/<id>`).
- Avoids the curation burden of a `models.json` / `datasets.json` registry that would need pruning every time the snapshot evolves.

The build script's `idea_models` / `idea_datasets` / `plan_models` / `plan_datasets` tables therefore use `TEXT` columns for the IDs, not foreign-key references.

## UUID + slug rules

- **UUIDs are random UUIDv4** (use `uuidgen`). Never regenerate or rewrite an existing UUID — references break silently.
- **Slugs are stable handles** — once committed, don't rename unless the entry is unreferenced.
- Slugs are unique *within* their entity type; cross-type collisions are fine (an idea and a requirement can share a slug, disambiguated by UUID + type).

## Build pipeline

```
data/*.json + ideas_catalog.md + plans/index.json
                       │
                       ▼
              scripts/build_sqlite.py
                       │
                       ▼
              public/catalog.sqlite
                       │
                       ▼      (built once per dev session;
                              regenerated daily by hf-fetcher)
              scripts/build_graph.py   ──►  public/graph.json
                                              (graph-viz consumes this)
```

Before any commit touching `data/`:

```bash
python3 scripts/validate_data.py    # 0 errors required
python3 scripts/build_sqlite.py     # must succeed
python3 scripts/smoke_test.py       # sanity check
```

For the population thread's bigger guide, see [`../documents/parallel_population_guide.md`](../documents/parallel_population_guide.md).
For the graph layer's plan, see [`../documents/graph_planning.md`](../documents/graph_planning.md).
