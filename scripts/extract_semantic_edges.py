#!/usr/bin/env python3
"""Extract typed semantic relations from idea prose with an LLM.

Backends:
  - `local`     OpenAI-compatible endpoint (default: llama.cpp serving Gemma 4
                on http://localhost:8500/v1). Free, slower, slightly noisier.
  - `anthropic` Claude Sonnet 4.6 via the anthropic package. Higher quality
                + calibrated confidence; ~$3-5 for full ~300-idea pass.

For each idea bullet in `ideas_catalog.md`, send the prose + a candidate list
of already-linked entities to the model, ask it to pick relations from a
closed taxonomy, validate, and append to `data/semantic_edges.json`.

Idempotent: skips ideas whose UUIDs are already in
`semantic_edges.json.metadata.processed_idea_uuids`.

Usage:
  # Default: local Gemma 4 (llama-vision container)
  python3 scripts/extract_semantic_edges.py --limit 3
  python3 scripts/extract_semantic_edges.py --backend local --model gemma-4

  # Anthropic backend (when you want the higher-quality pass)
  pip install anthropic && export ANTHROPIC_API_KEY=sk-ant-...
  python3 scripts/extract_semantic_edges.py --backend anthropic --limit 3

  # Other knobs
  python3 scripts/extract_semantic_edges.py --ideas <uuid>   # one specific idea
  python3 scripts/extract_semantic_edges.py --dry-run        # print prompts only
  python3 scripts/extract_semantic_edges.py --force          # re-process processed
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CATALOG_PATH = ROOT / "ideas_catalog.md"
OUT_PATH = DATA / "semantic_edges.json"

# Per-backend defaults — overridable via CLI.
BACKEND_DEFAULTS = {
    "local":     {"model": "gemma-4",          "endpoint": "http://localhost:8500/v1/chat/completions"},
    "anthropic": {"model": "claude-sonnet-4-6", "endpoint": None},
}

# Gemma 4 (small local model) is verbose under json_object mode and routinely
# produces 1500-2000 completion tokens for 4-6 relations. The llama-vision
# slot has n_ctx_slot=131072, so 16000 gives plenty of headroom without
# risking truncation on the chattiest outputs.
# Sonnet 4.6 is much more compact (typically <500 tokens) — same cap is fine.
MAX_TOKENS = 16000
TEMPERATURE = 0.0
MIN_CONFIDENCE = 0.7    # drop weaker signals
SLEEP_BETWEEN = 0.1     # seconds; pacing between calls

# --- closed relation taxonomy (must match data/README.md + validate_data.py) ---
TAXONOMY = {
    ("idea", "kpi"):         ["reduces", "increases", "trades-off-against", "leading-indicator-of"],
    ("idea", "requirement"): ["addresses", "partially-mitigates", "creates-new-instance-of"],
    ("idea", "idea"):        ["prerequisite-for", "extends", "evolves-into", "competes-with", "complementary-to"],
    ("idea", "entity"):      ["case-study-at", "incumbent-competitor", "target-customer-of"],
    ("idea", "model"):       ["production-baseline", "state-of-the-art-option", "cheap-option", "evaluation-only"],
    ("idea", "dataset"):     ["training-on", "evaluation-on", "fine-tuning-on"],
}


# ---------- catalog parsing ----------

BULLET_RE = re.compile(r"^- \*\*(?P<title>[^*]+?)\*\*\s*[—-]\s*(?P<body>.*)$", re.MULTILINE)


def parse_catalog_bodies() -> dict[str, str]:
    """Return {normalized_title: body_text} for every top-level bullet."""
    text = CATALOG_PATH.read_text()
    out: dict[str, str] = {}
    for m in BULLET_RE.finditer(text):
        title = m.group("title").strip()
        body = m.group("body").strip()
        # strip the trailing **Tags:** block — keep description + Source if present
        body = re.sub(r"\s*\*\*Tags:\*\*.*$", "", body, flags=re.DOTALL).strip()
        out[title.lower()] = body
    return out


# ---------- candidate building ----------

def candidate_lines(items: list, fields: list[str]) -> list[str]:
    """Format a small list of {uuid|id, label} candidates for the prompt."""
    return [f'- {{"id": "{i[fields[0]]}", "label": "{i[fields[1]]}"}}' for i in items]


# Default location of the role's system prompt (mirrors what agent_server would
# inject when targeting the `idealab_relation_extractor` preset). The full
# taxonomy + schema + decision algorithm live there; the user message stays slim.
DEFAULT_SYSTEM_PROMPT_PATH = Path.home() / "env/assets/agent_server/data/prompts/idealab_relation_extractor_system_prompt.txt"


def load_system_prompt(path: Path | None) -> str:
    p = path or DEFAULT_SYSTEM_PROMPT_PATH
    if not p.exists():
        sys.exit(f"FAIL: system prompt file not found at {p}")
    return p.read_text()


def build_user_message(idea, body, candidates, neighbor_ideas) -> str:
    """Slim user message — system prompt already carries taxonomy + schema."""
    def fmt(items):
        return "\n".join(f"  {{\"id\": \"{i['id']}\", \"label\": \"{i['label']}\"}}" for i in items) or "  (none)"

    return f"""IDEA
====
Title:   {idea['title']}
Section: {idea.get('section', '')}

Body:
{body}

CANDIDATES (use to_id values verbatim — do NOT invent IDs)
==========================================================
KPIs (to_type = "kpi"):
{fmt(candidates['kpis'])}

Requirements (to_type = "requirement"):
{fmt(candidates['requirements'])}

Entities — companies/vendors (to_type = "entity"):
{fmt(candidates['entities'])}

Models (to_type = "model"):
{fmt(candidates['models'])}

Datasets (to_type = "dataset"):
{fmt(candidates['datasets'])}

Neighbor ideas (to_type = "idea"):
{fmt(neighbor_ideas)}

Emit the JSON object now."""


# ---------- LLM call ----------

def parse_llm_json(raw: str) -> dict:
    """Robust JSON extraction from LLM output. Handles fences and leading prose."""
    raw = raw.strip()
    # Strip ```json fences if present
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    # If the model added preamble, try to slice from the first { to the last }
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        i = raw.find("{")
        j = raw.rfind("}")
        if i != -1 and j > i:
            try:
                return json.loads(raw[i : j + 1])
            except json.JSONDecodeError:
                pass
    return {"_parse_error": True, "_raw": raw[:400]}


def call_local(user_message: str, *, model: str, endpoint: str, system_prompt: str) -> dict:
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_message},
        ],
        "max_tokens": MAX_TOKENS,
        "temperature": TEMPERATURE,
        "top_k": 40,
        "top_p": 0.9,
        "min_p": 0.05,
        "response_format": {"type": "json_object"},
    }).encode("utf-8")
    req = urllib.request.Request(
        endpoint, data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            payload = json.loads(resp.read())
    except urllib.error.URLError as exc:
        print(f"  WARN: local endpoint error: {exc}")
        return {"relations": []}
    raw = payload["choices"][0]["message"]["content"]
    parsed = parse_llm_json(raw)
    if parsed.get("_parse_error"):
        print(f"  WARN: JSON parse error; raw[:200]={parsed['_raw'][:200]}")
        return {"relations": []}
    return parsed


def call_anthropic(user_message: str, *, model: str, system_prompt: str) -> dict:
    try:
        import anthropic
    except ImportError:
        sys.exit("FAIL: `pip install anthropic` first")
    client = anthropic.Anthropic()
    resp = client.messages.create(
        model=model,
        max_tokens=MAX_TOKENS,
        temperature=TEMPERATURE,
        system=system_prompt,
        messages=[{"role": "user", "content": user_message}],
    )
    parsed = parse_llm_json(resp.content[0].text)
    if parsed.get("_parse_error"):
        print(f"  WARN: JSON parse error; raw[:200]={parsed['_raw'][:200]}")
        return {"relations": []}
    return parsed


def call_model(user_message: str, *, backend: str, model: str, endpoint: str | None,
               system_prompt: str, dry_run: bool) -> dict:
    if dry_run:
        print("=== SYSTEM ===")
        print(system_prompt)
        print("\n=== USER ===")
        print(user_message)
        print("\n--- (dry-run; no API call) ---")
        return {"relations": []}
    if backend == "local":
        return call_local(user_message, model=model, endpoint=endpoint, system_prompt=system_prompt)
    if backend == "anthropic":
        return call_anthropic(user_message, model=model, system_prompt=system_prompt)
    sys.exit(f"FAIL: unknown backend {backend!r}")


# ---------- validation ----------

def validate_relations(idea_uuid: str, raw: dict, *, lookups) -> list[dict]:
    out = []
    for rel in raw.get("relations", []):
        to_type   = rel.get("to_type")
        to_id     = rel.get("to_id")
        relation  = rel.get("relation")
        conf      = rel.get("confidence")
        rationale = (rel.get("rationale") or "").strip()
        if to_type is None or to_id is None or relation is None or conf is None:
            continue
        if conf < MIN_CONFIDENCE:
            continue
        allowed = TAXONOMY.get(("idea", to_type))
        if not allowed or relation not in allowed:
            continue
        # resolve id — for KPI/requirement/entity/idea, must be a known UUID
        if to_type in lookups and to_id not in lookups[to_type]:
            continue
        out.append({
            "from": f"idea:{idea_uuid}",
            "to":   f"{to_type}:{to_id}",
            "relation": relation,
            "confidence": round(float(conf), 3),
            "rationale": rationale[:240],
            "source": "idea_body",
        })
    return out


# ---------- orchestration ----------

def tag_overlap(a: list[str], b: list[str]) -> int:
    return len(set(a) & set(b))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", choices=["local", "anthropic"], default="local",
                    help="LLM backend (default: local Gemma via llama-vision)")
    ap.add_argument("--model",    default=None, help="override model id for the chosen backend")
    ap.add_argument("--endpoint", default=None, help="override OpenAI-compatible endpoint (local backend only)")
    ap.add_argument("--limit",    type=int, default=None, help="process at most N ideas")
    ap.add_argument("--ideas",    default=None, help="comma-separated idea UUIDs to (re)process")
    ap.add_argument("--dry-run",  action="store_true", help="print prompts, skip API calls")
    ap.add_argument("--force",    action="store_true", help="re-process ideas already in processed_idea_uuids")
    ap.add_argument("--system-prompt", default=None,
                    help="path to system prompt file (default: agent_server's idealab_relation_extractor role)")
    args = ap.parse_args()
    defaults = BACKEND_DEFAULTS[args.backend]
    model    = args.model    or defaults["model"]
    endpoint = args.endpoint or defaults["endpoint"]
    system_prompt = load_system_prompt(Path(args.system_prompt) if args.system_prompt else None)

    bodies = parse_catalog_bodies()
    ideas       = json.loads((DATA / "ideas.json").read_text())
    kpis        = json.loads((DATA / "kpis.json").read_text())
    reqs        = json.loads((DATA / "requirements.json").read_text())
    entities    = json.loads((DATA / "entities.json").read_text())
    links       = json.loads((DATA / "links.json").read_text())
    doc         = json.loads(OUT_PATH.read_text()) if OUT_PATH.exists() else {
        "metadata": {"schema_version": "1.0", "processed_idea_uuids": []}, "edges": []
    }

    by_uuid = {i["uuid"]: i for i in ideas}
    kpi_by_uuid = {k["uuid"]: k for k in kpis}
    req_by_uuid = {r["uuid"]: r for r in reqs}
    ent_by_uuid = {e["uuid"]: e for e in entities}

    # candidate fetchers — only the entities each idea is structurally linked to
    idea_kpis = {row["idea"]: row.get("kpis", []) for row in links.get("idea_kpis", [])}
    idea_reqs = {row["idea"]: row.get("requirements", []) for row in links.get("idea_requirements", [])}
    idea_ents = {row["idea"]: row.get("entities", []) for row in links.get("idea_entities", [])}
    idea_mods = {row["idea"]: row.get("model_ids", []) for row in links.get("idea_models", [])}
    idea_dats = {row["idea"]: row.get("dataset_ids", []) for row in links.get("idea_datasets", [])}

    # idea→idea neighbor candidates: same-section + tag-overlap top-N.
    # Tag overlap requires reading tag arrays from somewhere — the catalog
    # bullets carry tags inline. Parse once here (lightweight).
    text = CATALOG_PATH.read_text()
    idea_tags: dict[str, list[str]] = {}
    section_for: dict[str, str] = {}
    current_section = ""
    for line in text.splitlines():
        sm = re.match(r"^##\s+(\d+\.\s+.+)$", line)
        if sm:
            current_section = sm.group(1).strip()
            continue
        bm = re.match(r"^- \*\*(.+?)\*\*\s+[—-].*?\*\*Tags:\*\*\s*(.+)$", line)
        if bm:
            title = bm.group(1).strip().lower()
            tags = re.findall(r"`([^`]+)`", bm.group(2))
            for i in ideas:
                if i["title"].lower() == title:
                    idea_tags[i["uuid"]] = tags
                    section_for[i["uuid"]] = current_section
                    break

    def neighbors_for(idea_uuid: str, k: int = 8) -> list[dict]:
        my_tags = idea_tags.get(idea_uuid, [])
        my_section = section_for.get(idea_uuid)
        scored = []
        for i in ideas:
            u = i["uuid"]
            if u == idea_uuid:
                continue
            score = tag_overlap(idea_tags.get(u, []), my_tags)
            # boost same-section neighbours
            if my_section and section_for.get(u) == my_section:
                score += 2
            if score > 0:
                scored.append((score, i))
        scored.sort(key=lambda t: t[0], reverse=True)
        return [{"id": i["uuid"], "label": i["title"]} for _, i in scored[:k]]

    # decide which ideas to process
    processed = set(doc["metadata"].get("processed_idea_uuids", []))
    if args.ideas:
        targets = [by_uuid[u] for u in args.ideas.split(",") if u in by_uuid]
    else:
        targets = [
            i for i in ideas
            if (i.get("kind") or "idea") == "idea"
            and (args.force or i["uuid"] not in processed)
        ]
    if args.limit:
        targets = targets[: args.limit]

    print(f"Targets: {len(targets)} idea(s); backend={args.backend}; model={model}; dry_run={args.dry_run}")
    if not targets:
        print("Nothing to do.")
        return 0

    lookups = {
        "kpi": kpi_by_uuid, "requirement": req_by_uuid, "entity": ent_by_uuid,
        "idea": by_uuid,
        # model/dataset use HF id strings — no UUID lookup, accept anything
        # the model proposed if it appeared in the candidates list
    }

    new_edges = []
    new_processed = []
    for n, idea in enumerate(targets, 1):
        body = bodies.get(idea["title"].lower())
        if not body:
            print(f"[{n}/{len(targets)}] SKIP {idea['slug']!r} — no body match in ideas_catalog.md")
            continue

        cand = {
            "kpis":         [{"id": u, "label": kpi_by_uuid[u]["label"]} for u in idea_kpis.get(idea["uuid"], []) if u in kpi_by_uuid],
            "requirements": [{"id": u, "label": req_by_uuid[u]["label"]} for u in idea_reqs.get(idea["uuid"], []) if u in req_by_uuid],
            "entities":     [{"id": u, "label": ent_by_uuid[u]["name"]}  for u in idea_ents.get(idea["uuid"], []) if u in ent_by_uuid],
            "models":       [{"id": m, "label": m} for m in idea_mods.get(idea["uuid"], [])],
            "datasets":     [{"id": d, "label": d} for d in idea_dats.get(idea["uuid"], [])],
        }
        neighbors = neighbors_for(idea["uuid"])

        user_message = build_user_message(idea, body, cand, neighbors)
        raw = call_model(user_message, backend=args.backend, model=model,
                         endpoint=endpoint, system_prompt=system_prompt,
                         dry_run=args.dry_run)
        relations = validate_relations(idea["uuid"], raw, lookups=lookups)
        new_edges.extend(relations)
        new_processed.append(idea["uuid"])
        print(f"[{n}/{len(targets)}] {idea['slug']:<45} -> {len(relations)} relation(s)")
        if not args.dry_run:
            time.sleep(SLEEP_BETWEEN)

    if args.dry_run:
        print(f"\nDry run: {len(new_edges)} relation(s) extracted from {len(new_processed)} idea(s) (no file write).")
        return 0

    # merge into existing doc (de-dupe by (from, to, relation) — last write wins)
    existing = {(e["from"], e["to"], e["relation"]): e for e in doc["edges"]}
    for e in new_edges:
        existing[(e["from"], e["to"], e["relation"])] = e
    doc["edges"] = sorted(existing.values(), key=lambda e: (e["from"], e["to"], e["relation"]))
    doc["metadata"].update({
        "extractor":    "extract_semantic_edges.py",
        "extracted_at": datetime.now(timezone.utc).isoformat(),
        "backend":      args.backend,
        "model":        model,
        "processed_idea_uuids": sorted(set(doc["metadata"].get("processed_idea_uuids", []) + new_processed)),
    })
    OUT_PATH.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    print(f"\nWrote {OUT_PATH}: {len(doc['edges'])} total edge(s), "
          f"{len(doc['metadata']['processed_idea_uuids'])} processed idea(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
