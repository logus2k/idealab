#!/usr/bin/env python3
"""Classify each entry in data/requirements.json into one of the 7 closed
buckets defined for the requirement taxonomy.

Backends:
  - `local` (default): llama.cpp + Gemma 4 on http://localhost:8500
  - `anthropic`: Sonnet 4.6 via the anthropic package (requires API key)

Idempotent: skips requirements that already carry a category. Use --force to
re-classify everything.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REQS_PATH = ROOT / "data" / "requirements.json"

# ---------- closed taxonomy ----------
# Slug → { label, hint }. The hint is what gets shown to the LLM to steer
# its choice; keep each hint to one sentence so the prompt stays compact.
TAXONOMY = {
    "workflow-friction": {
        "label": "Workflow friction",
        "hint":  "Manual, repetitive, or time-consuming tasks performed by staff. Pain = 'we do this by hand'.",
    },
    "coverage-gap": {
        "label": "Coverage gap",
        "hint":  "A capability is missing — the org cannot do X at all today. Pain = 'we have no way to do this'.",
    },
    "accuracy-and-quality": {
        "label": "Accuracy & quality",
        "hint":  "Outputs are inconsistent, error-prone, or low-quality. Pain = 'when we do it, we get it wrong'.",
    },
    "decision-support": {
        "label": "Decision support",
        "hint":  "Lack of insight, forecast, attribution, or visibility. Pain = 'we can't see / can't decide'.",
    },
    "compliance-and-risk": {
        "label": "Compliance & risk",
        "hint":  "Regulatory, governance, fraud, security, bias, or reputational exposure. Pain = 'we're at risk'.",
    },
    "customer-experience-friction": {
        "label": "Customer-experience friction",
        "hint":  "Pain points in customer-facing flows — cart abandonment, support latency, poor self-service.",
    },
    "scaling-and-throughput": {
        "label": "Scaling & throughput",
        "hint":  "Bottlenecks on growth — can't increase output proportionally, capacity caps, throughput limits.",
    },
}
ALL_SLUGS = list(TAXONOMY.keys())

BACKEND_DEFAULTS = {
    "local":     {"model": "gemma-4",          "endpoint": "http://localhost:8500/v1/chat/completions"},
    "anthropic": {"model": "claude-sonnet-4-6", "endpoint": None},
}
# Gemma 4 routinely produces 400-700 "thinking" tokens before its JSON
# answer — those tokens are stripped from the visible `content` field in
# this llama-server build but they still count toward max_tokens. A
# 200-token cap silently truncates everything; 4000 gives plenty of room.
MAX_TOKENS = 4000
TEMPERATURE = 0.0


SYSTEM_PROMPT = """You are idealab's requirement_classifier. You read one entry from a catalog of business "pain points" (requirements) and assign it to exactly ONE category from the closed taxonomy below.

OUTPUT
- Output ONLY the JSON object. No code fences, no preamble, no chat-style filler.
- Schema: {"category": "<one slug from taxonomy>", "confidence": <0..1>}
- Single-line string values, no `\\n`.

TAXONOMY (pick the one that BEST matches the pain — exactly one):

""" + "\n".join(
    f"  - {slug}\n      {meta['label']} — {meta['hint']}"
    for slug, meta in TAXONOMY.items()
) + """

HOW TO DECIDE
1. Read the requirement's label + description literally.
2. Ask: "What is the SHAPE of the pain?"
   - If staff is wasting time doing tasks → workflow-friction
   - If the capability flat-out doesn't exist yet → coverage-gap
   - If the thing happens, but with errors / inconsistency → accuracy-and-quality
   - If the issue is visibility / forecasting / attribution → decision-support
   - If the issue is regulatory / risk / fraud / bias → compliance-and-risk
   - If the customer is the one suffering → customer-experience-friction
   - If the team can't scale output to meet demand → scaling-and-throughput
3. When two categories seem to fit, prefer the one closer to ROOT cause.
   Example: "Cart abandonment" → customer-experience-friction (not decision-support,
   even though analytics could help — the pain itself is customer-side).
4. confidence ≥ 0.7. If the requirement is ambiguous, still pick the best fit
   and lower confidence accordingly.

DO NOT
- Do not invent slugs not in the taxonomy.
- Do not output anything but the JSON object.
"""


def parse_llm_json(raw: str) -> dict:
    raw = raw.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        i, j = raw.find("{"), raw.rfind("}")
        if i != -1 and j > i:
            try:
                return json.loads(raw[i : j + 1])
            except json.JSONDecodeError:
                pass
    return {"_parse_error": True, "_raw": raw[:300]}


def call_local(user_msg: str, *, model: str, endpoint: str) -> dict:
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": user_msg},
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
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            payload = json.loads(resp.read())
    except urllib.error.URLError as exc:
        print(f"  WARN: local endpoint error: {exc}")
        return {}
    raw = payload["choices"][0]["message"]["content"]
    parsed = parse_llm_json(raw)
    if parsed.get("_parse_error"):
        print(f"  WARN: JSON parse error; raw[:160]={parsed['_raw'][:160]}")
        return {}
    return parsed


def call_anthropic(user_msg: str, *, model: str) -> dict:
    try:
        import anthropic
    except ImportError:
        sys.exit("FAIL: `pip install anthropic` first")
    client = anthropic.Anthropic()
    resp = client.messages.create(
        model=model,
        max_tokens=MAX_TOKENS,
        temperature=TEMPERATURE,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_msg}],
    )
    parsed = parse_llm_json(resp.content[0].text)
    if parsed.get("_parse_error"):
        print(f"  WARN: JSON parse error; raw[:160]={parsed['_raw'][:160]}")
        return {}
    return parsed


def classify_one(req: dict, *, backend: str, model: str, endpoint: str | None) -> str | None:
    msg = (
        f"Label:       {req['label']}\n"
        f"Slug:        {req['slug']}\n"
        f"Description: {req.get('description') or '(none)'}\n\n"
        f"Emit the JSON object now."
    )
    raw = call_anthropic(msg, model=model) if backend == "anthropic" else call_local(msg, model=model, endpoint=endpoint)
    slug = (raw or {}).get("category")
    if slug not in ALL_SLUGS:
        return None
    return slug


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", choices=["local", "anthropic"], default="local")
    ap.add_argument("--model", default=None)
    ap.add_argument("--endpoint", default=None)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    defaults = BACKEND_DEFAULTS[args.backend]
    model    = args.model    or defaults["model"]
    endpoint = args.endpoint or defaults["endpoint"]

    reqs = json.loads(REQS_PATH.read_text())
    targets = [r for r in reqs if args.force or not r.get("category")]
    if args.limit:
        targets = targets[: args.limit]
    print(f"Classifying {len(targets)} requirement(s) — backend={args.backend}, model={model}")

    changed = 0
    by_cat: dict[str, int] = {}
    for n, req in enumerate(targets, 1):
        slug = classify_one(req, backend=args.backend, model=model, endpoint=endpoint)
        if slug is None:
            print(f"  [{n}/{len(targets)}] {req['slug']:<40} → SKIP (no valid category)")
            continue
        req["category"] = slug
        changed += 1
        by_cat[slug] = by_cat.get(slug, 0) + 1
        print(f"  [{n}/{len(targets)}] {req['slug']:<40} → {slug}")

    REQS_PATH.write_text(json.dumps(reqs, indent=2, ensure_ascii=False) + "\n")
    print(f"\nWrote {REQS_PATH} ({changed}/{len(targets)} classified)")
    print("\nBy category:")
    for slug, n in sorted(by_cat.items(), key=lambda t: -t[1]):
        print(f"  {slug:<30} {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
