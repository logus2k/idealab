#!/usr/bin/env python3
"""One-shot enrichment: pull HF task icons (SVG) and merge them into tasks.json.

Source of truth: https://huggingface.co/tasks  — server-rendered, every tile
contains an inline <svg> and a Tailwind color class on it. We extract:

  icon_svg    — the full <svg ...>...</svg> string, ready to drop into innerHTML.
                We re-normalize: strip Tailwind/sizing classes, keep viewBox,
                set fill="currentColor", set width/height to 1em so the host
                element controls the size.
  icon_color  — the Tailwind color suffix HF used (e.g. "orange-400",
                "indigo-400"). The frontend can map this to its own palette
                or use it directly.

Tasks present in tasks.json but missing from /tasks (HF doesn't have a page
for every pipeline_tag — only ~47 of our 56) get no icon — the frontend
falls back to a generic dot/badge for those.

Idempotent — safe to re-run. Preserves UUIDs and every other field.
"""
from __future__ import annotations

import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TASKS_FILE = ROOT / "data" / "tasks.json"
TASKS_URL = "https://huggingface.co/tasks"

# Regex anchored on the tile href; lazy-match through to </a>.
TILE_RE = re.compile(
    r'<a [^>]*href="/tasks/(?P<slug>[a-z][a-z0-9-]+)"[^>]*>'
    r'(?P<inner>.*?)</a>',
    re.DOTALL,
)
SVG_RE = re.compile(r'<svg [^>]*?>.*?</svg>', re.DOTALL)
COLOR_RE = re.compile(r'\btext-([a-z]+-\d{3})\b')
SVG_OPEN_RE = re.compile(r'<svg\b([^>]*)>', re.DOTALL)


def normalize_svg(raw: str) -> str:
    """Strip layout-only classes, keep viewBox, force currentColor + 1em sizing."""
    m = SVG_OPEN_RE.match(raw)
    if not m:
        return raw
    attrs_str = m.group(1)

    # Pull individual attributes (very small set, plain regex is fine).
    def pick(name: str) -> str | None:
        x = re.search(rf'{name}="([^"]*)"', attrs_str)
        return x.group(1) if x else None

    viewbox = pick("viewBox") or "0 0 18 18"
    # Rebuild a clean opening tag — no classes, no aria, no preserveAspectRatio
    # (defaults are fine), no xmlns:xlink (we don't reference xlink), no role.
    new_open = (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'viewBox="{viewbox}" width="1em" height="1em" '
        f'fill="currentColor" aria-hidden="true">'
    )
    rest = raw[m.end():]
    return new_open + rest


def main() -> int:
    if not TASKS_FILE.exists():
        print(f"FAIL: {TASKS_FILE} not found", file=sys.stderr)
        return 1

    print(f"Fetching {TASKS_URL} …")
    req = urllib.request.Request(TASKS_URL, headers={"User-Agent": "idealab-icon-probe/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        html = r.read().decode("utf-8")
    print(f"  {len(html):,} bytes")

    # Build {slug → (svg, color)}
    extracted: dict[str, tuple[str, str | None]] = {}
    for tile in TILE_RE.finditer(html):
        slug = tile.group("slug")
        inner = tile.group("inner")
        svg_m = SVG_RE.search(inner)
        if not svg_m:
            continue
        raw_svg = svg_m.group(0)
        color_m = COLOR_RE.search(raw_svg)
        color = color_m.group(1) if color_m else None
        extracted[slug] = (normalize_svg(raw_svg), color)

    print(f"  parsed {len(extracted)} task tiles from /tasks page")

    # Merge into tasks.json
    tasks = json.loads(TASKS_FILE.read_text())
    matched = 0
    missing: list[str] = []
    for t in tasks:
        if t["slug"] in extracted:
            svg, color = extracted[t["slug"]]
            t["icon_svg"] = svg
            if color:
                t["icon_color"] = color
            matched += 1
        else:
            # Don't overwrite a pre-existing icon (e.g. if we ever hand-add)
            if "icon_svg" not in t:
                missing.append(t["slug"])

    TASKS_FILE.write_text(json.dumps(tasks, indent=2, ensure_ascii=False) + "\n")
    print()
    print(f"matched: {matched}/{len(tasks)} tasks now have icon_svg + icon_color")
    if missing:
        print(f"missing ({len(missing)} — no HF /tasks page for these):")
        for s in missing:
            print(f"  - {s}")

    # Quick stats on which categories are well-covered
    from collections import Counter
    covered = Counter(t.get("category") for t in tasks if "icon_svg" in t)
    uncovered = Counter(t.get("category") for t in tasks if "icon_svg" not in t)
    print()
    print("Coverage by category:")
    for cat in sorted(set(covered) | set(uncovered)):
        print(f"  {cat:<32} {covered.get(cat,0):>2} covered / {uncovered.get(cat,0):>2} missing")
    return 0


if __name__ == "__main__":
    sys.exit(main())
