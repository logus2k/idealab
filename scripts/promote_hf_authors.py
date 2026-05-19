#!/usr/bin/env python3
"""T1.2 — Auto-promote frequent Hugging Face authors into data/entities.json.

Reads the latest data/fetched/hf-models-*.json snapshot, counts model.author
occurrences, and appends any author with >= THRESHOLD models as a new
entity (type='vendor') UNLESS an entity with the same slug already exists.

UUIDs are random UUIDv4 via `uuidgen`. Existing entries are never modified.
Idempotent — safe to re-run after each snapshot.
"""
from __future__ import annotations

import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
FETCHED = DATA / "fetched"
ENTITIES_PATH = DATA / "entities.json"
THRESHOLD = 3                     # min models for an author to be promoted
SOURCES = ("models", "datasets")  # which snapshots to scan


def slugify(name: str) -> str:
    """HF author → entity slug. e.g. 'meta-llama' → 'meta-llama'."""
    s = name.lower()
    out = []
    for ch in s:
        if ch.isalnum() or ch in "-_":
            out.append(ch)
        else:
            out.append("-")
    return "-".join(filter(None, "".join(out).split("-")))


def latest_snapshot(kind: str) -> Path | None:
    files = sorted(FETCHED.glob(f"hf-{kind}-*.json"), reverse=True)
    return files[0] if files else None


def new_uuid() -> str:
    return subprocess.run(["uuidgen"], capture_output=True, text=True, check=True).stdout.strip().lower()


def main() -> int:
    if not ENTITIES_PATH.exists():
        print(f"FAIL: {ENTITIES_PATH} not found", file=sys.stderr)
        return 1

    entities = json.loads(ENTITIES_PATH.read_text())
    existing_slugs = {e["slug"] for e in entities}
    existing_names = {e["name"].lower() for e in entities}

    counts: Counter[str] = Counter()
    for kind in SOURCES:
        snap = latest_snapshot(kind)
        if not snap:
            print(f"  (no snapshot for {kind})")
            continue
        rows = json.loads(snap.read_text())
        for row in rows:
            author = (row.get("item") or {}).get("author")
            if author:
                counts[author] += 1
        print(f"  {kind}: {len(rows)} rows from {snap.name}")

    promotable = [(name, n) for name, n in counts.most_common() if n >= THRESHOLD]
    print(f"\nAuthors meeting threshold (>={THRESHOLD} models+datasets): {len(promotable)}")

    added = []
    skipped_existing = []
    for name, n in promotable:
        slug = slugify(name)
        if slug in existing_slugs or name.lower() in existing_names:
            skipped_existing.append((name, n))
            continue
        entry = {
            "uuid": new_uuid(),
            "slug": slug,
            "name": name,
            "type": "vendor",
        }
        entities.append(entry)
        existing_slugs.add(slug)
        existing_names.add(name.lower())
        added.append((name, n))

    if not added:
        print("\nNothing to add — all promotable authors already in entities.json.")
        return 0

    ENTITIES_PATH.write_text(json.dumps(entities, indent=2, ensure_ascii=False) + "\n")

    print(f"\nAdded {len(added)} new vendor entities to {ENTITIES_PATH}:")
    for name, n in added[:30]:
        print(f"  + {name:<45} ({n} models/datasets)")
    if len(added) > 30:
        print(f"  ... and {len(added) - 30} more.")
    print(f"\nSkipped (already present): {len(skipped_existing)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
