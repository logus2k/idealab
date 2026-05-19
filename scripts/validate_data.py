#!/usr/bin/env python3
"""Cross-reference validator for data/*.json.

Implements the validation snippet from the data-relational-model memory note:
- every UUID in links.json must resolve to an entity in the matching registry
- no duplicate UUIDs / slugs
- every idea SHOULD have >=1 requirement and >=1 KPI link (warning only,
  since sections 2-32 are pending population)
- reports unused vocabulary entries

Exit code: 0 if no errors (warnings are OK), 1 if errors found.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"


def load(name):
    p = DATA / name
    if not p.exists():
        return None
    return json.loads(p.read_text())


def check_unique(items, field, name):
    seen = {}
    dups = []
    for i in items:
        v = i[field]
        if v in seen:
            dups.append(v)
        seen[v] = i
    if dups:
        print(f"  ERROR: duplicate {field} in {name}: {', '.join(dups)}")
    return len(dups)


RELATION_TAXONOMY = {
    ("idea", "kpi"):         {"reduces", "increases", "trades-off-against", "leading-indicator-of"},
    ("idea", "requirement"): {"addresses", "partially-mitigates", "creates-new-instance-of"},
    ("idea", "idea"):        {"prerequisite-for", "extends", "evolves-into", "competes-with", "complementary-to"},
    ("idea", "entity"):      {"case-study-at", "incumbent-competitor", "target-customer-of"},
    ("idea", "model"):       {"production-baseline", "state-of-the-art-option", "cheap-option", "evaluation-only"},
    ("idea", "dataset"):     {"training-on", "evaluation-on", "fine-tuning-on"},
    ("plan", "idea"):        {"core-pillar", "optional-extension", "prerequisite", "pilot-only"},
}


def main():
    ideas = load("ideas.json") or []
    requirements = load("requirements.json") or []
    kpis = load("kpis.json") or []
    entities = load("entities.json") or []
    tasks = load("tasks.json") or []
    links = load("links.json") or {}
    plans = load("plans.json") or []
    idea_semantics = load("idea_semantics.json") or []
    sem_edges = load("semantic_edges.json") or {"edges": []}

    ideas_by_uuid = {i["uuid"] for i in ideas}
    req_by_uuid = {r["uuid"] for r in requirements}
    kpi_by_uuid = {k["uuid"] for k in kpis}
    entity_by_uuid = {e["uuid"] for e in entities}
    task_by_uuid = {t["uuid"] for t in tasks}
    plan_by_uuid = {p["uuid"] for p in plans}

    errors = 0
    warns = 0

    print("Uniqueness checks:")
    errors += check_unique(ideas, "uuid", "ideas")
    errors += check_unique(ideas, "slug", "ideas")
    errors += check_unique(requirements, "uuid", "requirements")
    errors += check_unique(requirements, "slug", "requirements")
    errors += check_unique(kpis, "uuid", "kpis")
    errors += check_unique(kpis, "slug", "kpis")
    if entities:
        errors += check_unique(entities, "uuid", "entities")
        errors += check_unique(entities, "slug", "entities")
    if plans:
        errors += check_unique(plans, "uuid", "plans")
        errors += check_unique(plans, "slug", "plans")
    if errors == 0:
        print("  OK")

    print("\nCross-reference checks:")
    cross_errors_start = errors

    for row in links.get("idea_requirements", []):
        if row["idea"] not in ideas_by_uuid:
            print(f"  ERROR: idea_requirements -> unknown idea {row['idea']}")
            errors += 1
        for ruid in row.get("requirements", []):
            if ruid not in req_by_uuid:
                print(f"  ERROR: idea_requirements -> unknown requirement {ruid}")
                errors += 1

    for row in links.get("idea_kpis", []):
        if row["idea"] not in ideas_by_uuid:
            print(f"  ERROR: idea_kpis -> unknown idea {row['idea']}")
            errors += 1
        for kuid in row.get("kpis", []):
            if kuid not in kpi_by_uuid:
                print(f"  ERROR: idea_kpis -> unknown kpi {kuid}")
                errors += 1

    for row in links.get("idea_entities", []):
        if row["idea"] not in ideas_by_uuid:
            print(f"  ERROR: idea_entities -> unknown idea {row['idea']}")
            errors += 1
        for euid in row.get("entities", []):
            if euid not in entity_by_uuid:
                print(f"  ERROR: idea_entities -> unknown entity {euid}")
                errors += 1

    for row in links.get("idea_tasks", []):
        if row["idea"] not in ideas_by_uuid:
            print(f"  ERROR: idea_tasks -> unknown idea {row['idea']}")
            errors += 1
        for tuid in row.get("tasks", []):
            if tuid not in task_by_uuid:
                print(f"  ERROR: idea_tasks -> unknown task {tuid}")
                errors += 1

    # idea_models / idea_datasets use HF id strings, not UUIDs — we only
    # validate the idea-side ref. The model_id / dataset_id strings are
    # checked at build_graph time against the latest snapshot (soft-warn).
    for row in links.get("idea_models", []):
        if row["idea"] not in ideas_by_uuid:
            print(f"  ERROR: idea_models -> unknown idea {row['idea']}")
            errors += 1
    for row in links.get("idea_datasets", []):
        if row["idea"] not in ideas_by_uuid:
            print(f"  ERROR: idea_datasets -> unknown idea {row['idea']}")
            errors += 1

    for row in links.get("plan_ideas", []):
        if row.get("plan") not in plan_by_uuid:
            print(f"  ERROR: plan_ideas -> unknown plan {row.get('plan')}")
            errors += 1
        for iuid in row.get("ideas", []):
            if iuid not in ideas_by_uuid:
                print(f"  ERROR: plan_ideas -> unknown idea {iuid}")
                errors += 1

    for row in links.get("plan_requirements", []):
        if row.get("plan") not in plan_by_uuid:
            print(f"  ERROR: plan_requirements -> unknown plan {row.get('plan')}")
            errors += 1
        for ruid in row.get("requirements", []):
            if ruid not in req_by_uuid:
                print(f"  ERROR: plan_requirements -> unknown requirement {ruid}")
                errors += 1

    for row in links.get("plan_kpis", []):
        if row.get("plan") not in plan_by_uuid:
            print(f"  ERROR: plan_kpis -> unknown plan {row.get('plan')}")
            errors += 1
        for kuid in row.get("kpis", []):
            if kuid not in kpi_by_uuid:
                print(f"  ERROR: plan_kpis -> unknown kpi {kuid}")
                errors += 1

    # --- idea_semantics.json ---
    IDEA_SEM_FIELDS = {
        "kpi_reduces":                          ("kpi",         kpi_by_uuid),
        "kpi_increases":                        ("kpi",         kpi_by_uuid),
        "kpi_trades_off_against":               ("kpi",         kpi_by_uuid),
        "requirement_creates_new_instance_of":  ("requirement", req_by_uuid),
        "prerequisite_for":                     ("idea",        ideas_by_uuid),
        "extends":                              ("idea",        ideas_by_uuid),
        "evolves_into":                         ("idea",        ideas_by_uuid),
        "competes_with":                        ("idea",        ideas_by_uuid),
        "complementary_to":                     ("idea",        ideas_by_uuid),
        "case_study_at":                        ("entity",      entity_by_uuid),
        "incumbent_competitors":                ("entity",      entity_by_uuid),
    }
    for row in idea_semantics:
        if row.get("idea") not in ideas_by_uuid:
            print(f"  ERROR: idea_semantics -> unknown idea {row.get('idea')}")
            errors += 1
            continue
        for field, (kind, registry) in IDEA_SEM_FIELDS.items():
            for uid in row.get(field, []) or []:
                if uid not in registry:
                    print(f"  ERROR: idea_semantics.{field} -> unknown {kind} {uid}")
                    errors += 1

    # --- semantic_edges.json ---
    registries_by_prefix = {
        "idea":        ideas_by_uuid,
        "requirement": req_by_uuid,
        "kpi":         kpi_by_uuid,
        "entity":      entity_by_uuid,
        "task":        task_by_uuid,
        "plan":        plan_by_uuid,
    }
    for e in sem_edges.get("edges", []):
        for end in ("from", "to"):
            ref = e.get(end, "")
            if ":" not in ref:
                print(f"  ERROR: semantic_edges[{end}] missing type prefix: {ref}")
                errors += 1
                continue
            prefix, inner = ref.split(":", 1)
            # model/dataset use HF id strings, not UUIDs — soft-check only
            if prefix in registries_by_prefix and inner not in registries_by_prefix[prefix]:
                print(f"  ERROR: semantic_edges[{end}] unknown {prefix}: {inner}")
                errors += 1
        # relation must be valid for this source→target pair
        from_pref = e.get("from", "").split(":", 1)[0]
        to_pref   = e.get("to",   "").split(":", 1)[0]
        allowed = RELATION_TAXONOMY.get((from_pref, to_pref))
        if allowed is None:
            print(f"  ERROR: semantic_edges relation pair not in taxonomy: {from_pref}->{to_pref}")
            errors += 1
        elif e.get("relation") not in allowed:
            print(f"  ERROR: semantic_edges relation '{e.get('relation')}' not allowed for {from_pref}->{to_pref}")
            errors += 1
        # confidence range
        c = e.get("confidence")
        if c is None or not (0.0 <= float(c) <= 1.0):
            print(f"  ERROR: semantic_edges confidence out of range: {c}")
            errors += 1

    if errors == cross_errors_start:
        print("  OK")

    print("\nCoverage (warnings only — `kind=pattern` ideas are exempt from req/kpi links by design):")
    linked_req = {row["idea"] for row in links.get("idea_requirements", [])}
    linked_kpi = {row["idea"] for row in links.get("idea_kpis", [])}
    concrete_ideas = [i for i in ideas if (i.get("kind") or "idea") == "idea"]
    missing_req = [i for i in concrete_ideas if i["uuid"] not in linked_req]
    missing_kpi = [i for i in concrete_ideas if i["uuid"] not in linked_kpi]
    for i in missing_req:
        print(f"  WARN: no requirement links: {i['title']}")
        warns += 1
    for i in missing_kpi:
        print(f"  WARN: no KPI links:         {i['title']}")
        warns += 1
    if not missing_req and not missing_kpi:
        print(f"  All {len(concrete_ideas)} kind=idea entries have requirement + KPI links.")

    print("\nVocabulary usage:")
    used_req = {
        ruid
        for row in links.get("idea_requirements", [])
        for ruid in row.get("requirements", [])
    }
    used_kpi = {
        kuid
        for row in links.get("idea_kpis", [])
        for kuid in row.get("kpis", [])
    }
    used_ent = {
        euid
        for row in links.get("idea_entities", [])
        for euid in row.get("entities", [])
    }
    unused_req = [r["slug"] for r in requirements if r["uuid"] not in used_req]
    unused_kpi = [k["slug"] for k in kpis if k["uuid"] not in used_kpi]
    unused_ent = [e["slug"] for e in entities if e["uuid"] not in used_ent]
    if unused_req:
        print(f"  Unused requirement vocab ({len(unused_req)}): {', '.join(unused_req)}")
    if unused_kpi:
        print(f"  Unused KPI vocab ({len(unused_kpi)}): {', '.join(unused_kpi)}")
    if unused_ent:
        print(f"  Unused entity vocab ({len(unused_ent)}): {', '.join(unused_ent)}")
    if not unused_req and not unused_kpi and not unused_ent:
        print("  All vocabulary is in use.")

    print(f"\nResult: {errors} error(s), {warns} warning(s).")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
