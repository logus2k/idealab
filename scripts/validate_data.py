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


def main():
    ideas = load("ideas.json") or []
    requirements = load("requirements.json") or []
    kpis = load("kpis.json") or []
    entities = load("entities.json") or []
    tasks = load("tasks.json") or []
    links = load("links.json") or {}
    plans = load("plans.json") or []

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
