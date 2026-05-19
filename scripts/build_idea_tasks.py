#!/usr/bin/env python3
"""T1.3 — Build idea_tasks bridge edges programmatically.

For each idea in data/ideas.json, derive its task UUIDs from:
  1. tech tag (function/industry/tech facets read from ideas_catalog.md via the SQLite DB)
  2. title + description keyword matches

Writes the merged result back to data/links.json (key: idea_tasks). Existing
idea_tasks rows are PRESERVED (additive merge). Idempotent.

Mapping rules below are best-effort and conservative — better to under-link
than over-link (it's easier to add than to discover spurious connections).
Hand-tune the MAPPING dicts as needed.
"""
from __future__ import annotations

import json
import re
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
LINKS_PATH = DATA / "links.json"
DB_PATH = ROOT / "public" / "catalog.sqlite"

# ──────── Mapping rules ──────────────────────────────────────────────────────

# Tech tag → task slug(s). Conservative: only map when the connection is
# unambiguous. Generic tags ('genai', 'classical-ml') need title keywords.
TECH_TO_TASKS: dict[str, list[str]] = {
    "llm":                  ["text-generation"],
    "rag":                  ["text-generation", "feature-extraction"],
    "agentic":              ["text-generation"],
    "copilot":              ["text-generation"],
    "chatbot":              ["text-generation"],
    "voice-ai":             ["automatic-speech-recognition", "text-to-speech"],
    "text-to-image":        ["text-to-image"],
    "text-to-video":        ["text-to-video"],
    "gan":                  ["unconditional-image-generation"],
    "vector-search":        ["feature-extraction"],
    "nlp":                  ["text-classification"],  # tighten via keyword if possible
    "generative-design":    [],   # no HF equivalent — engineering CAD
    "synthetic-data":       [],   # no HF task — this is methodology
    "fine-tuning":          [],   # methodology
    "digital-twin":         [],   # no HF task
    "multimodal":           ["image-text-to-text"],
}

# Title/description keyword → task slug. Matches are case-insensitive whole-word.
# Order doesn't matter — all hits union together.
KEYWORD_TO_TASKS: list[tuple[str, list[str]]] = [
    (r"\bshopping\b|\bcustomer.{0,10}service\b|\bsupport\b", ["text-generation"]),
    (r"\bchatbot\b|\bconversational\b|\bassistant\b",       ["text-generation"]),
    (r"\bspeech.{0,10}recogni|\btranscription\b|\bASR\b|\bdictation\b", ["automatic-speech-recognition"]),
    (r"\btext.to.speech\b|\bTTS\b|\bvoiceover\b|\bvoice.{0,6}clone", ["text-to-speech"]),
    (r"\bvoice.{0,10}activity\b|\bVAD\b",                   ["voice-activity-detection"]),
    (r"\btranslat(e|ion)\b",                                ["translation"]),
    (r"\bsummariz",                                          ["summarization"]),
    (r"\bsentiment\b",                                       ["text-classification"]),
    (r"\b(NER|named.entity|entity.recognition)\b",          ["token-classification"]),
    (r"\bimage.{0,10}(generation|creation|gen)\b|\bvisual.{0,10}generat", ["text-to-image"]),
    (r"\bimage.to.image\b|\bimage.{0,10}editing\b",         ["image-to-image"]),
    (r"\bvideo.{0,10}generation\b|\bvideo.{0,10}create",    ["text-to-video"]),
    (r"\bobject.{0,10}detect",                              ["object-detection"]),
    (r"\bsegmentation\b",                                    ["image-segmentation"]),
    (r"\bembedding\b|\bsemantic.{0,10}search\b",            ["feature-extraction"]),
    (r"\bretrieval\b",                                       ["feature-extraction"]),
    (r"\b(fraud|anomaly).{0,10}detect",                     ["tabular-classification"]),
    (r"\bforecast|\bpredict.{0,10}(demand|churn|revenue|sales)|\btime.series",
                                                             ["time-series-forecasting"]),
    (r"\bunderwriting\b|\bcredit.{0,10}scoring\b|\bclaims.{0,10}automation\b",
                                                             ["tabular-classification"]),
    (r"\bpricing\b|\bvaluation\b|\byield\b",                ["tabular-regression"]),
    (r"\bOCR\b|\boptical.{0,5}character",                   ["image-to-text"]),
    (r"\bcaption(ing)?\b",                                   ["image-to-text"]),
    (r"\bdepth.{0,10}estimat",                              ["depth-estimation"]),
    (r"\bzero.shot.{0,10}classif",                          ["zero-shot-classification"]),
    (r"\brobotic|\bautonomous.{0,15}(robot|vehicle|drone)", ["robotics"]),
    (r"\brecommend",                                         ["text-classification"]),
    (r"\bquestion.{0,5}answer|\bQA\b",                      ["question-answering"]),
    (r"\bdocument.{0,15}question|\bDocVQA\b",               ["document-question-answering"]),
    (r"\bvisual.{0,5}question",                             ["visual-question-answering"]),
    (r"\bcontent.{0,10}generat|\bcopy.{0,10}generat|\bwriting.{0,10}assist", ["text-generation"]),
    (r"\bsearch.{0,10}engine|\binformation.{0,10}retrieval", ["text-retrieval"]),
    (r"\b(text|content).{0,5}rank",                         ["text-ranking"]),
    # Tabular / predictive-ML cluster
    (r"\b(lead.{0,5}scoring|prospecting|lead.{0,5}generation)\b",  ["tabular-classification"]),
    (r"\b(upsell|cross.sell|cart.{0,10}abandonment|churn.{0,10}prediction)\b", ["tabular-classification"]),
    (r"\b(attribution|incrementality|mix.{0,5}model)\b",   ["tabular-regression"]),
    (r"\b(predictive|preventative).{0,15}maintenance\b",    ["tabular-classification", "time-series-forecasting"]),
    (r"\b(reconciliation|auditing|audit\b)\b",              ["tabular-classification"]),
    (r"\b(account.{0,5}takeover|\bATO\b)\b",                ["tabular-classification"]),
    (r"\b(safety.stock|inventory.{0,10}optim)\b",           ["time-series-forecasting"]),
    (r"\b(claims.{0,10}(automation|estate)|motor.claims)\b", ["tabular-classification"]),
    (r"\b(dropout|risk).{0,10}prediction\b",                ["tabular-classification"]),
    (r"\b(dynamic|real.time).{0,15}(campaign|pricing|optim)\b", ["tabular-regression"]),
    (r"\b(infrastructure.{0,10}placement|location.{0,10}optim)\b", ["tabular-regression"]),
    (r"\b(diverse|atypical).{0,10}(hire|target)\b",         ["tabular-classification"]),
    (r"\b(fairness|bias).{0,10}(audit|monitor|dashboard)\b", ["text-classification"]),
    (r"\b(data.{0,10}quality|dataset.{0,10}categoriz)\b",   ["tabular-classification", "text-classification"]),
    (r"\b(workload.{0,10}routing|task.{0,10}assignment)\b", ["tabular-classification"]),
    (r"\b(PPE|workplace.{0,10}safety|compliance.{0,10}vision)\b", ["image-classification", "object-detection"]),
    (r"\b(attendance|occupancy).{0,10}monitor",              ["image-classification"]),
    (r"\b(continuous.{0,10}audit|cash.flow.{0,10}oversight)\b", ["tabular-classification"]),
]


def main() -> int:
    if not DB_PATH.exists():
        print(f"FAIL: {DB_PATH} not found — run scripts/build_sqlite.py first",
              file=sys.stderr)
        return 1

    # Load tasks (slug → uuid)
    tasks = json.loads((DATA / "tasks.json").read_text())
    slug_to_uuid = {t["slug"]: t["uuid"] for t in tasks}

    # Load ideas + their tech tags + descriptions from the DB
    conn = sqlite3.connect(DB_PATH)
    ideas = conn.execute(
        "SELECT uuid, title, description, kind FROM ideas"
    ).fetchall()
    print(f"Loaded {len(ideas)} ideas from {DB_PATH}")

    # tech tag values per idea (so we can apply TECH_TO_TASKS)
    tech_tags: dict[str, list[str]] = defaultdict(list)
    for uuid, value in conn.execute(
        "SELECT idea_uuid, value FROM idea_tags WHERE facet = 'tech'"
    ):
        tech_tags[uuid].append(value)

    # Build idea → set(task_uuid)
    derived: dict[str, set[str]] = defaultdict(set)
    skipped_unknown_slug: set[str] = set()

    def add_task_slugs(uuid: str, slugs: list[str]) -> None:
        for s in slugs:
            tuid = slug_to_uuid.get(s)
            if not tuid:
                skipped_unknown_slug.add(s)
                continue
            derived[uuid].add(tuid)

    for idea_uuid, title, description, kind in ideas:
        # 1) Tech-tag-based mapping
        for tt in tech_tags.get(idea_uuid, []):
            if tt in TECH_TO_TASKS:
                add_task_slugs(idea_uuid, TECH_TO_TASKS[tt])
        # 2) Keyword mapping on title + description (lowercased)
        haystack = ((title or "") + " " + (description or "")).lower()
        for pattern, slugs in KEYWORD_TO_TASKS:
            if re.search(pattern, haystack):
                add_task_slugs(idea_uuid, slugs)

    # Merge into existing links.json (additive — never destructive)
    links = json.loads(LINKS_PATH.read_text())
    existing_rows = links.get("idea_tasks", [])
    existing_map: dict[str, set[str]] = {r["idea"]: set(r.get("tasks", []))
                                          for r in existing_rows}
    for uuid, new_tasks in derived.items():
        existing_map.setdefault(uuid, set()).update(new_tasks)

    # Reformat back, sorted for stable diffs
    merged_rows = [
        {"idea": uuid, "tasks": sorted(tasks)}
        for uuid, tasks in sorted(existing_map.items())
        if tasks
    ]
    links["idea_tasks"] = merged_rows
    LINKS_PATH.write_text(json.dumps(links, indent=2, ensure_ascii=False) + "\n")

    # Report
    n_with_tasks = sum(1 for _, tasks in existing_map.items() if tasks)
    n_without = len(ideas) - n_with_tasks
    print(f"\nWrote {len(merged_rows)} idea_tasks rows to {LINKS_PATH}")
    print(f"  ideas with ≥1 task:  {n_with_tasks}")
    print(f"  ideas with 0 tasks:  {n_without}")
    if skipped_unknown_slug:
        print(f"  WARN: unknown task slug(s) referenced: {sorted(skipped_unknown_slug)}")

    # Distribution
    from collections import Counter
    by_count = Counter(len(tasks) for _, tasks in existing_map.items())
    print("\n  Task-count distribution per idea:")
    for n in sorted(by_count):
        print(f"    {n} tasks: {by_count[n]} ideas")
    return 0


if __name__ == "__main__":
    sys.exit(main())
