#!/usr/bin/env python3
"""T3.2 — Build public/graph.json from data/*.json + latest HF snapshots.

A single curated projection of the catalog as a graph the Three.js viewer
can consume. Idempotent; runs in <10s.

Node ID convention (T3.1) — every node ID is `<type>:<inner>`:
  - idea:<uuid> / requirement:<uuid> / kpi:<uuid> / entity:<uuid>
  - plan:<uuid> / task:<uuid> / modality:<uuid> / format:<uuid>
  - kpi_category:<slug> / task_category:<slug>
  - model:<hf_id>  / dataset:<hf_id>     (HF id strings, not UUIDs)

The original IDs in data/*.json stay unprefixed; the prefix is only added
here at export time so the graph viewer can route on `type` cheaply.

Projection (T3.3) — the model snapshot has ~10k entries. Keep:
  - everything referenced from idea_models / plan_models (curated)
  - everything that's top-20 by trendingScore in any task
Same logic for datasets at top-10. Final node budget is ~3k.
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
FETCHED = DATA / "fetched"
PUBLIC = ROOT / "public"

TOP_MODELS_PER_TASK = 20
TOP_DATASETS_PER_TASK = 10

# Dataset modality / format slugs as they appear in the HF tag namespaces
# (`modality:foo`, `format:bar`) — used to derive dataset→modality/format edges.
MOD_TAG_PREFIX = "modality:"
FMT_TAG_PREFIX = "format:"

# Human-readable phrasing for edges, indexed by structural type.
# Used by the Three.js viewer for hover tooltips + breadcrumb verbs.
EDGE_LABELS = {
    "idea_requirement":  "addresses",
    "idea_kpi":          "moves",
    "idea_entity":       "cites",
    "idea_task":         "uses task",
    "idea_model":        "implemented with",
    "idea_dataset":      "trains on",
    "plan_idea":         "includes",
    "plan_requirement":  "addresses",
    "plan_kpi":          "moves",
    "plan_model":        "recommends model",
    "plan_dataset":      "recommends dataset",
    "kpi_in_category":   "in category",
    "task_in_category":  "in category",
    "model_task":        "performs",
    "dataset_task":      "supports",
    "dataset_modality":  "has modality",
    "dataset_format":    "in format",
    "model_vendor":      "published by",
    "dataset_vendor":    "published by",
    "idea_idea":         "related to",  # refined by `relation` from semantic layer
}

# Polarity per relation (used by the viewer for color/icon hints).
RELATION_POLARITY = {
    "reduces":                  "positive",
    "increases":                "positive",
    "trades-off-against":       "negative",
    "creates-new-instance-of":  "negative",
    "competes-with":            "competitive",
    "incumbent-competitor":     "competitive",
}

# Map: human-curated field name in idea_semantics.json → (target node type, relation slug).
# Used to flatten idea_semantics.json into the same shape as semantic_edges.json entries.
SEMANTICS_FIELD_TO_RELATION = {
    "kpi_reduces":                          ("kpi",         "reduces"),
    "kpi_increases":                        ("kpi",         "increases"),
    "kpi_trades_off_against":               ("kpi",         "trades-off-against"),
    "requirement_creates_new_instance_of":  ("requirement", "creates-new-instance-of"),
    "prerequisite_for":                     ("idea",        "prerequisite-for"),
    "extends":                              ("idea",        "extends"),
    "evolves_into":                         ("idea",        "evolves-into"),
    "competes_with":                        ("idea",        "competes-with"),
    "complementary_to":                     ("idea",        "complementary-to"),
    "case_study_at":                        ("entity",      "case-study-at"),
    "incumbent_competitors":                ("entity",      "incumbent-competitor"),
}

# Map: (source_type, target_type) → structural edge `type` (the bucket the
# refinement upgrades). When no structural edge exists yet (e.g. idea→idea),
# we fall back to a derived bucket name like "idea_idea".
PAIR_TO_STRUCTURAL_TYPE = {
    ("idea", "kpi"):         "idea_kpi",
    ("idea", "requirement"): "idea_requirement",
    ("idea", "idea"):        "idea_idea",
    ("idea", "entity"):      "idea_entity",
    ("idea", "model"):       "idea_model",
    ("idea", "dataset"):     "idea_dataset",
    ("plan", "idea"):        "plan_idea",
}


def load(name: str):
    p = DATA / name
    return json.loads(p.read_text()) if p.exists() else None


def latest_snapshot(prefix: str) -> Path | None:
    files = sorted(FETCHED.glob(f"{prefix}-*.json"))
    return files[-1] if files else None


def main() -> int:
    ideas         = load("ideas.json") or []
    requirements  = load("requirements.json") or []
    kpis          = load("kpis.json") or []
    entities      = load("entities.json") or []
    tasks         = load("tasks.json") or []
    plans         = load("plans.json") or []
    modalities    = load("dataset_modalities.json") or []
    formats       = load("dataset_formats.json") or []
    links         = load("links.json") or {}
    idea_semantics = load("idea_semantics.json") or []
    sem_edges_doc  = load("semantic_edges.json") or {"edges": []}

    # ---- snapshots ----
    m_path = latest_snapshot("hf-models")
    d_path = latest_snapshot("hf-datasets")
    if not m_path or not d_path:
        print("FAIL: missing hf-models / hf-datasets snapshot", file=sys.stderr)
        return 1
    models_snap = json.loads(m_path.read_text())
    datasets_snap = json.loads(d_path.read_text())
    print(f"snapshots: {m_path.name} ({len(models_snap)} models) | "
          f"{d_path.name} ({len(datasets_snap)} datasets)")

    # ---- lookups ----
    task_by_slug = {t["slug"]: t for t in tasks}
    task_by_uuid = {t["uuid"]: t for t in tasks}
    mod_by_slug  = {m["slug"]: m for m in modalities}
    fmt_by_slug  = {f["slug"]: f for f in formats}
    entity_by_slug = {e["slug"]: e for e in entities}

    # ---- curated id sets ----
    curated_model_ids = set()
    for row in links.get("idea_models", []):
        curated_model_ids.update(row.get("model_ids", []))
    for row in links.get("plan_models", []):
        curated_model_ids.update(row.get("model_ids", []))

    curated_dataset_ids = set()
    for row in links.get("idea_datasets", []):
        curated_dataset_ids.update(row.get("dataset_ids", []))
    for row in links.get("plan_datasets", []):
        curated_dataset_ids.update(row.get("dataset_ids", []))

    # ---- projection: which models/datasets to keep ----
    def passes_topn(sources: list, n: int) -> bool:
        for s in sources or []:
            if s.get("sort") == "trendingScore" and s.get("rank", 1e9) < n:
                return True
        return False

    kept_models = {}      # hf_id -> entry
    kept_datasets = {}
    for entry in models_snap:
        hf_id = entry["item"]["id"]
        if hf_id in curated_model_ids or passes_topn(entry.get("sources"), TOP_MODELS_PER_TASK):
            kept_models[hf_id] = entry
    for entry in datasets_snap:
        hf_id = entry["item"]["id"]
        if hf_id in curated_dataset_ids or passes_topn(entry.get("sources"), TOP_DATASETS_PER_TASK):
            kept_datasets[hf_id] = entry
    print(f"kept models:   {len(kept_models):>5}  (curated {len(curated_model_ids)} ∪ top-{TOP_MODELS_PER_TASK})")
    print(f"kept datasets: {len(kept_datasets):>5}  (curated {len(curated_dataset_ids)} ∪ top-{TOP_DATASETS_PER_TASK})")

    # ---- node assembly ----
    nodes: list[dict] = []
    seen_ids: set[str] = set()

    def push(node_id: str, **attrs):
        if node_id in seen_ids:
            return
        seen_ids.add(node_id)
        nodes.append({"id": node_id, **attrs})

    # KPI categories (derived nodes)
    kpi_categories = sorted({k["category"] for k in kpis if k.get("category")})
    for slug in kpi_categories:
        label = slug.replace("-", " ").title()
        push(f"kpi_category:{slug}", type="kpi_category", label=label)

    # Task categories
    task_categories = sorted({t["category"] for t in tasks if t.get("category")})
    for slug in task_categories:
        label = slug.replace("-", " ").title()
        push(f"task_category:{slug}", type="task_category", label=label)

    # Ideas (only those that have at least one outgoing edge — see post-prune below;
    # for now include all, then prune orphans).
    for i in ideas:
        push(f"idea:{i['uuid']}", type="idea",
             label=i["title"], slug=i["slug"], section=i.get("section"),
             kind=i.get("kind", "idea"))

    for r in requirements:
        push(f"requirement:{r['uuid']}", type="requirement",
             label=r["label"], slug=r["slug"])

    for k in kpis:
        push(f"kpi:{k['uuid']}", type="kpi",
             label=k["label"], slug=k["slug"], category=k.get("category"))

    for e in entities:
        push(f"entity:{e['uuid']}", type="entity",
             label=e["name"], slug=e["slug"], entity_type=e.get("type"))

    for t in tasks:
        push(f"task:{t['uuid']}", type="task",
             label=t["label"], slug=t["slug"], category=t.get("category"),
             applies_to=t.get("applies_to"))

    for p in plans:
        push(f"plan:{p['uuid']}", type="plan",
             label=p["title"], slug=p["slug"], plan_type=p.get("type"))

    for m in modalities:
        push(f"modality:{m['uuid']}", type="modality",
             label=m["label"], slug=m["slug"])
    for f in formats:
        push(f"format:{f['uuid']}", type="format",
             label=f["label"], slug=f["slug"])

    # Models / datasets (after projection)
    for hf_id, entry in kept_models.items():
        item = entry["item"]
        push(f"model:{hf_id}", type="model",
             label=hf_id, author=item.get("author"),
             pipeline_tag=item.get("pipeline_tag"),
             downloads=item.get("downloads", 0),
             likes=item.get("likes", 0),
             curated=(hf_id in curated_model_ids))
    for hf_id, entry in kept_datasets.items():
        item = entry["item"]
        push(f"dataset:{hf_id}", type="dataset",
             label=hf_id, author=item.get("author"),
             downloads=item.get("downloads", 0),
             likes=item.get("likes", 0),
             curated=(hf_id in curated_dataset_ids))

    # ---- edges ----
    edges: list[dict] = []

    def add_edge(src: str, dst: str, etype: str, **attrs):
        if src not in seen_ids or dst not in seen_ids:
            return
        edges.append({
            "source": src,
            "target": dst,
            "type": etype,
            "label": EDGE_LABELS.get(etype, etype.replace("_", " ")),
            **attrs,
        })

    # idea ↔ requirement / kpi / entity / task
    for row in links.get("idea_requirements", []):
        src = f"idea:{row['idea']}"
        for ruid in row.get("requirements", []):
            add_edge(src, f"requirement:{ruid}", "idea_requirement")

    for row in links.get("idea_kpis", []):
        src = f"idea:{row['idea']}"
        for kuid in row.get("kpis", []):
            add_edge(src, f"kpi:{kuid}", "idea_kpi")

    for row in links.get("idea_entities", []):
        src = f"idea:{row['idea']}"
        for euid in row.get("entities", []):
            add_edge(src, f"entity:{euid}", "idea_entity")

    for row in links.get("idea_tasks", []):
        src = f"idea:{row['idea']}"
        for tuid in row.get("tasks", []):
            add_edge(src, f"task:{tuid}", "idea_task")

    # idea ↔ model / dataset (only when the model/dataset survived projection)
    for row in links.get("idea_models", []):
        src = f"idea:{row['idea']}"
        for mid in row.get("model_ids", []):
            add_edge(src, f"model:{mid}", "idea_model")
    for row in links.get("idea_datasets", []):
        src = f"idea:{row['idea']}"
        for did in row.get("dataset_ids", []):
            add_edge(src, f"dataset:{did}", "idea_dataset")

    # plan ↔ idea / requirement / kpi / model / dataset
    for row in links.get("plan_ideas", []):
        src = f"plan:{row['plan']}"
        for iuid in row.get("ideas", []):
            add_edge(src, f"idea:{iuid}", "plan_idea")
    for row in links.get("plan_requirements", []):
        src = f"plan:{row['plan']}"
        for ruid in row.get("requirements", []):
            add_edge(src, f"requirement:{ruid}", "plan_requirement")
    for row in links.get("plan_kpis", []):
        src = f"plan:{row['plan']}"
        for kuid in row.get("kpis", []):
            add_edge(src, f"kpi:{kuid}", "plan_kpi")
    for row in links.get("plan_models", []):
        src = f"plan:{row['plan']}"
        for mid in row.get("model_ids", []):
            add_edge(src, f"model:{mid}", "plan_model")
    for row in links.get("plan_datasets", []):
        src = f"plan:{row['plan']}"
        for did in row.get("dataset_ids", []):
            add_edge(src, f"dataset:{did}", "plan_dataset")

    # kpi → kpi_category (derived)
    for k in kpis:
        if k.get("category"):
            add_edge(f"kpi:{k['uuid']}", f"kpi_category:{k['category']}", "kpi_in_category")

    # task → task_category (derived)
    for t in tasks:
        if t.get("category"):
            add_edge(f"task:{t['uuid']}", f"task_category:{t['category']}", "task_in_category")

    # model → task (from pipeline_tag + sources)
    for hf_id, entry in kept_models.items():
        item = entry["item"]
        tslugs: set[str] = set()
        if item.get("pipeline_tag"):
            tslugs.add(item["pipeline_tag"])
        for s in entry.get("sources", []):
            if s.get("axis") == "task" and s.get("vocab_slug"):
                tslugs.add(s["vocab_slug"])
        for slug in tslugs:
            t = task_by_slug.get(slug)
            if t:
                add_edge(f"model:{hf_id}", f"task:{t['uuid']}", "model_task")

    # dataset → task / modality / format (from sources + tags)
    for hf_id, entry in kept_datasets.items():
        item = entry["item"]
        tslugs: set[str] = set()
        for s in entry.get("sources", []):
            if s.get("axis") == "task" and s.get("vocab_slug"):
                tslugs.add(s["vocab_slug"])
        for slug in tslugs:
            t = task_by_slug.get(slug)
            if t:
                add_edge(f"dataset:{hf_id}", f"task:{t['uuid']}", "dataset_task")
        for tag in item.get("tags") or []:
            if tag.startswith(MOD_TAG_PREFIX):
                slug = tag[len(MOD_TAG_PREFIX):]
                mod = mod_by_slug.get(slug)
                if mod:
                    add_edge(f"dataset:{hf_id}", f"modality:{mod['uuid']}", "dataset_modality")
            elif tag.startswith(FMT_TAG_PREFIX):
                slug = tag[len(FMT_TAG_PREFIX):]
                fmt = fmt_by_slug.get(slug)
                if fmt:
                    add_edge(f"dataset:{hf_id}", f"format:{fmt['uuid']}", "dataset_format")

    # model/dataset → vendor (author → entity if known)
    for hf_id, entry in kept_models.items():
        author = (entry["item"].get("author") or "").lower()
        ent = entity_by_slug.get(author)
        if ent:
            add_edge(f"model:{hf_id}", f"entity:{ent['uuid']}", "model_vendor")
    for hf_id, entry in kept_datasets.items():
        author = (entry["item"].get("author") or "").lower()
        ent = entity_by_slug.get(author)
        if ent:
            add_edge(f"dataset:{hf_id}", f"entity:{ent['uuid']}", "dataset_vendor")

    # ---- semantic enrichment layer ----
    # Refines existing edges (sets `relation`/`polarity`/`confidence`/`rationale`)
    # and creates new edges for pairs that have no structural backing yet
    # (idea→idea is the main case). Human-curated wins over LLM-extracted.

    # Build an index of existing edges so we can upgrade them in place.
    edge_index: dict[tuple[str, str, str], dict] = {}
    for e in edges:
        edge_index[(e["source"], e["target"], e["type"])] = e

    def apply_semantic(src: str, dst: str, relation: str, *,
                       confidence: float, rationale: str | None,
                       source: str, human_curated: bool) -> None:
        from_pref = src.split(":", 1)[0]
        to_pref   = dst.split(":", 1)[0]
        etype = PAIR_TO_STRUCTURAL_TYPE.get((from_pref, to_pref))
        if not etype:
            return
        key = (src, dst, etype)
        edge = edge_index.get(key)
        if edge is None:
            # No structural edge — create one (idea→idea is the typical case).
            if src not in seen_ids or dst not in seen_ids:
                return
            edge = {
                "source": src,
                "target": dst,
                "type": etype,
                "label": EDGE_LABELS.get(etype, etype.replace("_", " ")),
            }
            edges.append(edge)
            edge_index[key] = edge
        # Don't downgrade human curation with weaker LLM signal.
        if edge.get("source_kind") == "human_curation" and not human_curated:
            return
        edge["relation"]   = relation
        edge["confidence"] = float(confidence)
        if rationale:
            edge["rationale"] = rationale
        edge["source_kind"] = "human_curation" if human_curated else source
        polarity = RELATION_POLARITY.get(relation)
        if polarity:
            edge["polarity"] = polarity

    # idea_semantics.json — human-curated, confidence 1.0
    sem_curated_count = 0
    for row in idea_semantics:
        iuid = row.get("idea")
        if not iuid:
            continue
        src = f"idea:{iuid}"
        for field, (target_type, relation) in SEMANTICS_FIELD_TO_RELATION.items():
            for target_inner in row.get(field, []) or []:
                dst = f"{target_type}:{target_inner}"
                apply_semantic(src, dst, relation,
                               confidence=1.0, rationale=None,
                               source="human_curation", human_curated=True)
                sem_curated_count += 1

    # semantic_edges.json — LLM-extracted
    sem_llm_count = 0
    for e in sem_edges_doc.get("edges", []):
        src = e.get("from")
        dst = e.get("to")
        relation = e.get("relation")
        confidence = e.get("confidence")
        if not (src and dst and relation and confidence is not None):
            continue
        apply_semantic(src, dst, relation,
                       confidence=confidence,
                       rationale=e.get("rationale"),
                       source=e.get("source", "llm"),
                       human_curated=False)
        sem_llm_count += 1

    print(f"semantic enrichment: {sem_curated_count} human-curated, {sem_llm_count} LLM-extracted")

    # ---- orphan prune ----
    deg = defaultdict(int)
    for e in edges:
        deg[e["source"]] += 1
        deg[e["target"]] += 1

    before = len(nodes)
    # Always keep top-level "spine" nodes even if isolated (categories should anchor the graph).
    spine_types = {"kpi_category", "task_category", "modality", "format"}
    nodes = [n for n in nodes if deg[n["id"]] > 0 or n.get("type") in spine_types]
    pruned = before - len(nodes)
    print(f"pruned {pruned} orphan node(s); kept {len(nodes)}")

    # ---- emit ----
    PUBLIC.mkdir(exist_ok=True)
    out = PUBLIC / "graph.json"
    payload = {
        "generated_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "node_count": len(nodes),
        "edge_count": len(edges),
        "projection": {
            "top_models_per_task": TOP_MODELS_PER_TASK,
            "top_datasets_per_task": TOP_DATASETS_PER_TASK,
        },
        "nodes": nodes,
        "links": edges,
    }
    out.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    print(f"wrote {out}  ({len(nodes)} nodes / {len(edges)} edges, "
          f"{out.stat().st_size / 1024:.1f} KB)")

    # ---- summary ----
    from collections import Counter
    type_counts = Counter(n["type"] for n in nodes)
    edge_counts = Counter(e["type"] for e in edges)
    print("\nNodes by type:")
    for t, n in type_counts.most_common():
        print(f"  {t:<18} {n:>5}")
    print("\nEdges by type:")
    for t, n in edge_counts.most_common():
        print(f"  {t:<22} {n:>6}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
