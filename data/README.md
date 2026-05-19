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
| `plans.json`        | `[{uuid, slug, title, type, file, order_idx}]` | Registry for `plans/*.md`. |
| `links.json`        | object, partitioned by key | All structural cross-entity references. See below. |
| `idea_semantics.json` | `[{idea, kpi_reduces?, kpi_increases?, ...}]` | Human-curated semantic refinements. Optional fields per idea; see "Semantic enrichment layer" below. |
| `semantic_edges.json` | `{metadata, edges: [{from, to, relation, confidence, rationale, source}]}` | LLM-extracted typed relations. See "Semantic enrichment layer" below. |

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

## Semantic enrichment layer

`links.json` records *that* two entities are connected (structural scaffold). The semantic layer records *how* they are connected — `reduces` vs `increases`, `prerequisite-for` vs `extends`, `case-study-at` vs `incumbent-competitor`. Two files feed it:

- `idea_semantics.json` — human-curated, per-idea. High-confidence semantics a curator can add faster than an LLM (polarity on KPIs, prerequisite/competes pairs, case-study vs competitor distinction).
- `semantic_edges.json` — LLM-extracted, flat edge list. Filled by `scripts/extract_semantic_edges.py` (Sonnet 4.6, conservative + auditable preset). Re-runnable as the catalog grows; only un-processed idea UUIDs are sent to the model.

Both are *additive* — they don't replace structural edges, they refine them. When `build_graph.py` emits the graph, a structural edge between two entities gets upgraded with a `relation`, `polarity`, `confidence`, and `rationale` if either file has a match. Human-curated wins over LLM-extracted on conflict.

### `idea_semantics.json` shape

```json
[
  {
    "idea": "<idea-uuid>",
    "kpi_reduces":   ["<kpi-uuid>", ...],
    "kpi_increases": ["<kpi-uuid>", ...],
    "kpi_trades_off_against":             ["<kpi-uuid>", ...],
    "requirement_creates_new_instance_of":["<req-uuid>", ...],
    "prerequisite_for":   ["<idea-uuid>", ...],
    "extends":            ["<idea-uuid>", ...],
    "evolves_into":       ["<idea-uuid>", ...],
    "competes_with":      ["<idea-uuid>", ...],
    "complementary_to":   ["<idea-uuid>", ...],
    "case_study_at":          ["<entity-uuid>", ...],
    "incumbent_competitors":  ["<entity-uuid>", ...]
  }
]
```

All fields except `idea` are optional. Curator fills in only the high-confidence ones.

### `semantic_edges.json` shape

```json
{
  "metadata": {
    "schema_version": "1.0",
    "extractor": "extract_semantic_edges.py",
    "extracted_at": "<ISO 8601 UTC>",
    "model": "claude-sonnet-4-6",
    "processed_idea_uuids": ["<uuid>", ...]
  },
  "edges": [
    {
      "from": "idea:<uuid>",
      "to":   "kpi:<uuid>",
      "relation":   "reduces",
      "confidence": 0.85,
      "rationale":  "Body states: 'cuts time-to-hire from 5 days to 2'",
      "source":     "idea_body"
    }
  ]
}
```

`from` / `to` use the type-prefixed graph ID convention (`<type>:<inner>`) — see Type-prefixed node IDs below. `confidence` is in `[0,1]`; the extractor only emits edges ≥ 0.7. `rationale` is a short prose snippet quoted from the source for auditability. `source` is one of `idea_body`, `plan_body`, `human_curation`.

### Closed relation taxonomy

The extractor must pick from this list — no free-form relation names. Adding a new relation requires updating this taxonomy AND `EDGE_LABELS` in `scripts/build_graph.py`.

| Source → Target | Relations |
|---|---|
| **idea → kpi**         | `reduces` · `increases` · `trades-off-against` · `leading-indicator-of` |
| **idea → requirement** | `addresses` · `partially-mitigates` · `creates-new-instance-of` |
| **idea → idea**        | `prerequisite-for` · `extends` · `evolves-into` · `competes-with` · `complementary-to` |
| **idea → entity**      | `case-study-at` · `incumbent-competitor` · `target-customer-of` |
| **idea → model**       | `production-baseline` · `state-of-the-art-option` · `cheap-option` · `evaluation-only` |
| **idea → dataset**     | `training-on` · `evaluation-on` · `fine-tuning-on` |
| **plan → idea**        | `core-pillar` · `optional-extension` · `prerequisite` · `pilot-only` |

Polarity (used for color/icon hints in the graph viz):

| Relation | Polarity |
|---|---|
| `reduces`, `increases` | `positive` (the idea moves the KPI in the desired direction) |
| `trades-off-against`, `creates-new-instance-of` | `negative` (side-effect / anti-pattern signal) |
| `competes-with`, `incumbent-competitor` | `competitive` |
| everything else | `neutral` |

### Type-prefixed graph node IDs

When `build_graph.py` exports the graph, every node ID is `<type>:<inner>`:

- `idea:<uuid>` · `requirement:<uuid>` · `kpi:<uuid>` · `entity:<uuid>`
- `plan:<uuid>` · `task:<uuid>` · `modality:<uuid>` · `format:<uuid>`
- `kpi_category:<slug>` · `task_category:<slug>` *(derived spine nodes)*
- `model:<hf_id>` · `dataset:<hf_id>`

Original IDs in `data/*.json` stay unprefixed; the prefix is only added at graph-export time so the viewer can route on `type` cheaply. `semantic_edges.json` already uses the prefixed form because it's an export-time artefact, not a registry.

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
