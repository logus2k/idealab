#!/usr/bin/env python3
"""T2.4 — Generate data/plans.json from plans/index.json + frontmatter.

For each plan markdown file:
  - Read YAML frontmatter to extract title + type.
  - Assign a UUIDv4 (random, per memory rules).
  - Slug = filename without extension.
  - order_idx = position in plans/index.json.

Idempotent: existing entries in data/plans.json keep their UUIDs (matched by
slug). New plans get fresh UUIDs. Removed plans stay in the registry as
orphans (manually delete if desired — never auto-prune to keep references safe).
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLANS_DIR = ROOT / "plans"
INDEX_PATH = PLANS_DIR / "index.json"
OUT_PATH = ROOT / "data" / "plans.json"


def new_uuid() -> str:
    return subprocess.run(["uuidgen"], capture_output=True, text=True, check=True).stdout.strip().lower()


def parse_frontmatter(text: str) -> dict:
    m = re.match(r"^---\n([\s\S]*?)\n---\n?", text)
    if not m:
        return {}
    out = {}
    for line in m.group(1).split("\n"):
        line = line.strip()
        if not line or ":" not in line:
            continue
        k, v = line.split(":", 1)
        out[k.strip()] = v.strip()
    return out


def main() -> int:
    if not INDEX_PATH.exists():
        print(f"FAIL: {INDEX_PATH} not found", file=sys.stderr)
        return 1

    files = json.loads(INDEX_PATH.read_text())

    # Preserve UUIDs from any existing plans.json
    existing: dict[str, dict] = {}
    if OUT_PATH.exists():
        for e in json.loads(OUT_PATH.read_text()):
            existing[e["slug"]] = e

    new_plans = []
    for idx, filename in enumerate(files):
        path = PLANS_DIR / filename
        slug = path.stem
        if not path.exists():
            print(f"  WARN: {filename} not found, skipping")
            continue

        text = path.read_text()
        fm = parse_frontmatter(text)
        # H1 fallback for title
        title = fm.get("title", "").strip()
        if not title:
            h1 = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
            title = h1.group(1).strip() if h1 else slug.replace("-", " ").title()

        if slug in existing:
            entry = dict(existing[slug])
            entry["title"]     = title or entry.get("title", slug)
            entry["type"]      = fm.get("type") or entry.get("type") or slug.split("-")[0]
            entry["file"]      = filename
            entry["order_idx"] = idx
        else:
            entry = {
                "uuid":      new_uuid(),
                "slug":      slug,
                "title":     title,
                "type":      fm.get("type") or slug.split("-")[0],
                "file":      filename,
                "order_idx": idx,
            }
        new_plans.append(entry)

    OUT_PATH.write_text(json.dumps(new_plans, indent=2, ensure_ascii=False) + "\n")

    # Report
    from collections import Counter
    by_type = Counter(p["type"] for p in new_plans)
    print(f"Wrote {OUT_PATH} ({len(new_plans)} plans)")
    print()
    print("By type:")
    for t, n in by_type.most_common():
        print(f"  {t:<30} {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
