# Graph layer & Three.js visualization — discrete task plan

End-state: every entity in the catalog (ideas, requirements, KPIs, entities, plans, tasks, modalities, formats, models, datasets) is a node in a single graph; every relationship between them is an edge. A Three.js + `3d-force-graph` view lets users navigate the graph via *degree-of-interest* expansion: click a focus node → see type-buckets of its neighbors → click a bucket → expand the instances → click an instance → it becomes the new focus.

**Why this exists:** the catalog's reason for being is demand-side matching ("user states a pain → catalog returns candidate ideas → which models / datasets implement them → which plan fits"). The graph is the data structure that question is naturally posed against. A visual navigator makes it explorable for non-technical users.

**Status legend:** ⬜ todo · 🟡 in progress · ✅ done · ⏸ deferred · 🔧 tech-debt

Related memory: [[data-relational-model]], [[sqljs-infrastructure]], [[hf-fetcher-and-views]].

---

## Phase 1 — Data foundation (no graph viz yet, just edges)

Goal: by the end of Phase 1, the graph is *fully connected* — there's at least one edge path from any node type to any other.

| ID | Task | Status | Output | Depends on |
|---|---|---|---|---|
| T1.1 | **KPI taxonomy** — define 6–7 category buckets. Hand-classify all 109 KPIs. Add `category` field to each entry in `data/kpis.json`. Extend `scripts/build_sqlite.py` schema with `kpis.category` column + index. | ✅ | 109/109 KPIs classified into 7 buckets (revenue-and-growth=9, operational-efficiency=40, customer-experience=11, cost-and-margin=5, risk-and-compliance=12, talent-and-productivity=13, quality-and-accuracy=19). Schema column + index added. | — |
| T1.2 | **Auto-promote frequent HF authors → entities.json** — script reads latest `data/fetched/hf-models-*.json` snapshot, counts `item.author`, adds those above threshold to `entities.json` with `type: "vendor"`. | ✅ | `scripts/promote_hf_authors.py` written + run. **1098 new vendor entities** added (threshold ≥3 models/datasets). Idempotent. | — |
| T1.3 | **`idea_tasks` bridge edge** — the most important new link. Programmatic mapping using tech tags + title keywords + description. Stored as `idea_tasks: [{idea: <uuid>, tasks: [<uuid>, ...]}]`. Validator + SQLite schema + index extended. | ✅ | `scripts/build_idea_tasks.py` written + run. **230/262 ideas mapped** (88% coverage; 32 unmapped are mostly patterns + strategy with no HF-task equivalent — expected). New `idea_tasks` table in SQLite with idx_idea_tasks_task / idx_idea_tasks_idea. | T1.1 not required |

**Phase 1 acceptance:** `python3 scripts/validate_data.py` reports 0 errors; `python3 scripts/build_sqlite.py` produces a DB with the new `kpis.category` column populated and a non-empty `idea_tasks` table.

---

## Phase 2 — Curated relationships (the slow, opinion-rich work)

Goal: idea nodes connect to specific models, datasets, and plans they touch.

| ID | Task | Status | Output | Depends on |
|---|---|---|---|---|
| T2.1 | **ID convention for models / datasets in `links.json`** — store HF id strings (`meta-llama/Llama-3.1-8B-Instruct`) directly, not UUIDs. Lighter than maintaining a `data/models.json` registry; HF ids are stable+unique. Document the choice in `data/README.md`. | ⬜ | Decision logged | — |
| T2.2 | **`idea_models` curation** — for each idea where it's not overreach, name 2–8 specific models. New `idea_models: [{idea: <uuid>, model_ids: ["author/name", ...]}]` in `data/links.json`. Start with Section 1 ideas; expand later. Extend validator to warn (not error) when `model_ids` references a model not in the latest snapshot. | ⬜ | `idea_models` array; validator soft-check | T1.3, T2.1 |
| T2.3 | **`idea_datasets` curation** — same pattern. `idea_datasets: [{idea: <uuid>, dataset_ids: [...]}]`. | ⬜ | `idea_datasets` array | T2.1 |
| T2.4 | **Plans registry** — create `data/plans.json` with `{uuid, slug, title, type, file, order_idx}` for every entry in `plans/index.json`. UUIDs via `uuidgen`. Per [[data-relational-model]] rule, never regenerate. The build script's `plans` table will populate automatically. | ⬜ | `data/plans.json` (25 entries) | — |
| T2.5 | **`plan_ideas` + `plan_requirements` + `plan_kpis` + `plan_models` + `plan_datasets` curation** — for each plan in `plans/*.md`, identify the ideas/requirements/KPIs/models/datasets it cites. Populate the (currently empty) `plan_*` arrays in `data/links.json`. Extend `scripts/build_sqlite.py` to insert into `plan_models` + `plan_datasets` join tables. | ⬜ | Filled-in `plan_*` arrays; new SQL tables | T2.4, T2.2, T2.3 |

**Phase 2 acceptance:** every Phase-1-curated idea has ≥1 outgoing `idea_models` edge; every plan has ≥1 outgoing `plan_ideas` edge; validator clean.

---

## Phase 3 — Graph build pipeline (export the unified graph)

Goal: a single `public/graph.json` that the Three.js view can consume — a curated projection, not a verbatim dump.

| ID | Task | Status | Output | Depends on |
|---|---|---|---|---|
| T3.1 | **Type-prefixed node IDs** — all graph IDs use the form `<type>:<id>`. Example: `idea:0275f620-...`, `task:6c1ba557-...`, `model:meta-llama/Llama-3.1-8B-Instruct`. The original IDs in `data/*.json` stay unchanged — prefix is added at graph-export time. One helper function `parseNodeId(s) → {type, id}`. | ⬜ | Helper function (one place); convention documented | — |
| T3.2 | **`scripts/build_graph.py`** — reads `data/*.json` + the latest `data/fetched/hf-*-*.json` snapshots + the SQLite catalog. Emits `public/graph.json` shaped as `{nodes: [{id, type, label, ...}], links: [{source, target, type, weight?}]}` — exactly what `3d-force-graph` expects. Idempotent. Runs in <10 s. | ⬜ | `public/graph.json` (~3k nodes, ~30k links projected) | T1.3, T3.1 |
| T3.3 | **Curation projection (top-N per task)** — the snapshot has ~10k models. The graph wants only the popular + curated subset. Build config: `{models: {per_task: 20}, datasets: {per_task: 10}}`. `build_graph.py` keeps a model if it (a) is in `idea_models`/`plan_models`, OR (b) is top-20 by `trendingScore` in any of its tasks. Same logic for datasets. | ⬜ | Projection config in build_graph.py | T3.2 |
| T3.4 | **Pre-computed force-layout positions** — `build_graph.py` optionally runs the force simulation server-side (Python port of d3-force, or shell out to a Node helper) and writes `public/graph-positions.json` with `{node_id: {x, y, z}}`. Frontend uses these as initial positions so the layout doesn't visibly converge from random on every load. Skippable if too costly — frontend falls back to live simulation. | ⬜ | `public/graph-positions.json` (optional) | T3.2 |
| T3.5 | **`scripts/build_graph.py` runs as part of fetcher's daily cycle** — minor addition to the daily run so positions stay fresh. Update `services/hf-fetcher/fetcher.py` to invoke it after roll-up. | ⬜ | Daily refresh of `graph.json` | T3.2 |

**Phase 3 acceptance:** `public/graph.json` exists, parses cleanly, every node has degree ≥ 1 (no orphans), and `wc -c` is <5 MB.

---

## Phase 4 — Three.js visualization (the navigator)

Goal: a `Graph` tab in the frontend that loads `graph.json` and lets users navigate via degree-of-interest expansion.

| ID | Task | Status | Output | Depends on |
|---|---|---|---|---|
| T4.1 | **Vendor Three.js + 3d-force-graph** — download into `vendor/three/` and `vendor/3d-force-graph/`. Pin versions in `VERSION` files. README with re-vendoring recipe (mirrors `vendor/sqlite-wasm/README.md`). Lazy-loaded — the other 6 tabs don't pay the cost. Bundle size budget: ~750 KB. | ⬜ | `vendor/three/` + `vendor/3d-force-graph/` populated | — |
| T4.2 | **`Graph` tab in `index.html`** + `state.view = 'graph'` handling in `app.js`. Sidebar shows entry-point picker ("Start from a tag · a requirement · a KPI · an idea · a vendor · a task") + the breadcrumb. Center pane holds the Three.js canvas. | ⬜ | New tab in shell; empty stage | T3.2 |
| T4.3 | **Adjacency index** — on graph load, build `Map<nodeId, Set<neighborId>>` once. Click → expand becomes O(neighbors) instead of O(edges). | ⬜ | One function in `app.js` | T4.2 |
| T4.4 | **Degree-of-interest expansion** — click a focus node → walk adjacency index → group neighbors by type → render type-bucket nodes around the focus. Click a bucket → expand its instances. Click an instance → it becomes the new focus (the previous focus shrinks and stays on stage). ~30 lines on top of `3d-force-graph`. | ⬜ | Interaction logic in `app.js` | T4.3 |
| T4.5 | **Concentric ring visual hierarchy** — focus = largest with accent halo; type buckets = medium, color by entity type, label = `Type · N`; instances = smaller, color inherited from bucket, label on hover. Previously-focused nodes stay visible (shrunk) so the path is visually traceable. | ⬜ | Custom node renderer in `app.js` | T4.4 |
| T4.6 | **Breadcrumb + URL deeplinking** — render the breadcrumb above the stage. URL hash mirrors the path (`#/hr/kpis/time-to-hire/ideas/ai-resume-screening`). Back button works. Sharable URLs. | ⬜ | Breadcrumb component + hash router | T4.4 |
| T4.7 | **Pinned nodes** — small pin icon on each on-stage node. Pinned nodes stay even when navigating away. | ⬜ | Pin/unpin toggle | T4.4 |
| T4.8 | **"Show full graph" escape hatch** — toggle that turns off focus-mode and renders everything (with degree-based culling for nodes < N neighbors). Slow but useful for big-picture overview. | ⬜ | Toggle in graph view | T4.5 |

**Phase 4 acceptance:** open the Graph tab, click "HR" → see bucket ring → click `KPIs` → see KPI nodes → click "Time-to-hire" → it becomes focus, new buckets fan out. Breadcrumb URL is shareable.

---

## Phase 5 — Ranking & retrieval

Goal: the graph is no longer just navigable; it's *recommendable* — show the best plan for a stated need, the best models for a given task, etc.

| ID | Task | Status | Output | Depends on |
|---|---|---|---|---|
| T5.1 | **Plan ranking** — implement `plan_fitness(plan, target)` using the weighted formula in [[hf-fetcher-and-views]] §3 (industry+function dominant, requirements/KPIs via edge counts, entities asymmetric, maturity tiebreaker). Display *why* — "matched 4/5 of your pain points" / "shares Walmart as case point" — so ranking is auditable. | ⬜ | Ranking function + UI in idea/requirement views | T2.5 |
| T5.2 | **Idea ranking from requirements bundle** — given a Set of selected requirements, rank ideas by `count(idea_requirements ∩ selected) / |selected|`. Already partly works in current sidebar filter; formalize as a ranked score with a "how well does this idea match your stated pains?" badge on cards. | ⬜ | Score + badge | T1.3 |
| T5.3 | **Cross-entity recommendation widget** — small panel in Graph tab that, given the current focus node, surfaces the top 3 recommendations of the most-frequently-connected adjacent type. E.g. focus on a KPI → "Top ideas that move this KPI" + "Top plans that cite this KPI". | ⬜ | Side panel | T4.4 |

---

## Phase 6 — Derived edges (analytics-grade)

Goal: edges that are computed, not curated. Nice-to-have, lower priority.

| ID | Task | Status | Output | Depends on |
|---|---|---|---|---|
| T6.1 | **Vendor ↔ task derivation** — for each vendor entity, count models published per task from the latest snapshot. Visible in the graph as weighted edges. | ⬜ | Derived edges in `build_graph.py` | T3.2, T1.2 |
| T6.2 | **Model ↔ dataset training lineage** — extract `dataset:` entries from model `cardData` (HF model-card YAML — already in snapshot when `full=true`). Add as `model_trained_on` edges in `build_graph.py`. Noisy data; treat as advisory only. | ⬜ | Derived edges | T3.2 |
| T6.3 | **Idea co-occurrence (similar ideas)** — for each pair of ideas, compute shared edges (requirements ∩, KPIs ∩, tasks ∩). Surface "similar ideas" suggestions. | ⬜ | Derived edges + "see also" widget | T1.3, T2.2, T2.3 |

---

## Phase 7 — Outstanding polish (parallel tracks)

These are pre-existing TODOs unrelated to the graph but worth listing so they don't get lost.

| ID | Task | Status | Notes |
|---|---|---|---|
| T7.1 | **Camoufox pacing/session hardening** — implement the low-volume home-IP spec (jittered delays, 2–3 sessions/day, stop-on-block, fingerprint per-session). Do before scaling request volume. | ⬜ | See [[hf-fetcher-and-views]] |
| T7.2 | **Sort dropdown in Models / Datasets views** — currently fixed at `trendingScore` desc. Add trending / likes / downloads switcher. | ⬜ | Tiny UI addition |
| T7.3 | **Hand-add the 7 remaining task icons** — `multiple-choice`, `table-to-text`, `text-retrieval`, `text-to-audio`, `voice-activity-detection`, `tabular-to-text`, `time-series-forecasting`. Use Carbon Icons; idempotent re-run of `scripts/fetch_task_icons.py` preserves existing entries. | ⬜ | Cosmetic |
| T7.4 | **Within-task search inside Models / Datasets cards** — narrow by model name / author / library / tag. Top search bar already partially does this; promote to inline filter chips. | ⬜ | UX |
| T7.5 | **Dead-code cleanup** — `.task-chip`, `.task-tile-column`, `.task-cat-header`, `.vocab-chip` CSS classes and the matching JS helpers `renderRequirements` / `renderKpis` / `renderVocabCard` / `jumpToIdeasForRequirement` / `jumpToIdeasForKpi` are unreachable after the sidebar-picker refactor. Safe to delete in a cleanup pass. | ⬜ 🔧 | Tech-debt |

---

## Dependency graph (which phases gate which)

```
T1.1 (KPI taxonomy) ─┐
T1.2 (HF authors)  ─┼─► T3.2 (build_graph.py) ─┬─► T4.2 (Graph tab) ─► T4.4 (DOI nav) ─► T4.6 (breadcrumb)
T1.3 (idea_tasks) ──┘                          │
                                               └─► T5.1 (plan ranking)
T2.1 (id convention) ─► T2.2 (idea_models) ───►┐
                       T2.3 (idea_datasets) ──►├─► T3.3 (curation projection)
T2.4 (plans.json) ────► T2.5 (plan_* curate) ─►┘
T4.1 (vendor three.js) ─► T4.2
```

Phase 4 can begin in parallel with Phase 2 once T1.3 is in (the bridge edge is the minimum viable graph).

## Reading order for a fresh session

1. **`MEMORY.md`** — entry-point.
2. **[[data-relational-model]]** — the JSON layer the graph is built from.
3. **[[hf-fetcher-and-views]]** — the snapshot pipeline + UI patterns the graph builds on.
4. **[[sqljs-infrastructure]]** — where the catalog data is queried from at runtime.
5. **This file (graph_planning.md)** — what's left to build and in what order.

---

*Last revised: 2026-05-19. Update task statuses inline as work lands; let MEMORY.md keep only the pointer.*
