#!/usr/bin/env python3
"""T2.5b — Derive plan_requirements + plan_kpis from existing plan_ideas.

For each plan with `plan_ideas`, look at the requirements/KPIs of the linked
ideas (via idea_requirements / idea_kpis) and keep those that appear in at
least PLAN_VOCAB_CONSENSUS distinct ideas. This is the same consensus filter
that curate_tier_b uses for plan_models / plan_datasets — just applied to
UUID-keyed vocab tables instead of HF id strings.

Writes are additive to data/links.json (hand-curated rows preserved).
"""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LINKS_PATH = ROOT / "data" / "links.json"

PLAN_VOCAB_CONSENSUS = 2  # vocab item appears in ≥ this many of the plan's ideas


def main() -> int:
    links = json.loads(LINKS_PATH.read_text())
    plan_ideas        = {r["plan"]: r.get("ideas", []) for r in links.get("plan_ideas", [])}
    idea_requirements = {r["idea"]: r.get("requirements", []) for r in links.get("idea_requirements", [])}
    idea_kpis         = {r["idea"]: r.get("kpis", []) for r in links.get("idea_kpis", [])}

    plan_reqs: dict[str, set[str]] = defaultdict(set)
    plan_kpis: dict[str, set[str]] = defaultdict(set)
    for plan_uuid, idea_uuids in plan_ideas.items():
        req_counter: Counter[str] = Counter()
        kpi_counter: Counter[str] = Counter()
        for iuid in idea_uuids:
            for ruid in idea_requirements.get(iuid, []):
                req_counter[ruid] += 1
            for kuid in idea_kpis.get(iuid, []):
                kpi_counter[kuid] += 1
        for ruid, n in req_counter.items():
            if n >= PLAN_VOCAB_CONSENSUS:
                plan_reqs[plan_uuid].add(ruid)
        for kuid, n in kpi_counter.items():
            if n >= PLAN_VOCAB_CONSENSUS:
                plan_kpis[plan_uuid].add(kuid)

    def merge(key: str, mapping: dict[str, set[str]], field: str):
        existing_rows = links.get(key, [])
        existing_map = {r["plan"]: set(r.get(field, [])) for r in existing_rows}
        for k, vals in mapping.items():
            existing_map.setdefault(k, set()).update(vals)
        merged = [{"plan": k, field: sorted(v)} for k, v in sorted(existing_map.items()) if v]
        links[key] = merged

    merge("plan_requirements", plan_reqs, "requirements")
    merge("plan_kpis",         plan_kpis, "kpis")

    LINKS_PATH.write_text(json.dumps(links, indent=2, ensure_ascii=False) + "\n")
    print(f"Wrote {LINKS_PATH}")
    print(f"  plan_requirements rows: {sum(1 for v in plan_reqs.values() if v)} "
          f"(avg {sum(len(v) for v in plan_reqs.values()) / max(1, sum(1 for v in plan_reqs.values() if v)):.1f} reqs/plan)")
    print(f"  plan_kpis rows:         {sum(1 for v in plan_kpis.values() if v)} "
          f"(avg {sum(len(v) for v in plan_kpis.values()) / max(1, sum(1 for v in plan_kpis.values() if v)):.1f} kpis/plan)")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
