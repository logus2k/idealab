#!/usr/bin/env python3
"""Long-running Hugging Face fetcher (models + datasets, multi-axis).

Once per INTERVAL_HOURS (default 24), walk every endpoint in ENDPOINTS,
every axis within each endpoint, every vocab entry within each axis, and
every sort in SORTS — hit the HF API through a Camoufox-driven Firefox,
save the raw JSON, and produce a deduplicated roll-up per endpoint.

Endpoints / axes currently configured:
  - models:    task (filter=pipeline_tag=<slug>)
  - datasets:  task (filter=task_categories:<slug>)
               modality (filter=modality:<slug>)

The HF JSON API is fetched through Playwright's APIRequestContext (via
Camoufox's browser context) so the request goes out with the same
anti-detect fingerprint as a normal navigation, but without paying for
full page rendering.

Filter conventions (verified empirically — see services/hf-fetcher/README.md):
  - Models:    ?pipeline_tag=<value>             (dedicated param)
  - Datasets:  ?filter=<group>:<value>           (generic filter syntax)
  Datasets' ?task_categories=X and ?modality=X return 200 but only
  partial-filter (51/100 and 24/100 hits actually match) — DO NOT use.

Politeness:
  - REQUEST_INTERVAL_SECONDS between requests (default 3 s)
  - exponential backoff on 429 / 5xx
  - Retry-After header honored when present

Pacing/session/failure-handling hardening per the Camoufox spec is a
separate (still-pending) patch — current loop is regular-spacing only.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

from camoufox.sync_api import Camoufox

# ───────── Config ────────────────────────────────────────────────────────────

INTERVAL_HOURS = float(os.environ.get("INTERVAL_HOURS", "24"))
REQUEST_INTERVAL_SECONDS = float(os.environ.get("REQUEST_INTERVAL_SECONDS", "3"))
HF_LIMIT = int(os.environ.get("HF_LIMIT", "100"))
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))

RAW_DIR = DATA_DIR / "raw" / "hf"
FETCHED_DIR = DATA_DIR / "fetched"

# UI "Trending" → API "trendingScore". Plain 'trending' returns 400.
SORTS = ("trendingScore", "likes", "downloads")

# Each endpoint has one or more axes. An axis defines:
#   - vocab_file:       JSON file under DATA_DIR listing the values to iterate
#   - applies_filter:   if set, only vocab entries whose `applies_to` list
#                       contains this string are used (lets the shared
#                       tasks.json drive both models and datasets)
#   - filter_param:     query parameter name
#   - filter_template:  format string applied to vocab_entry["slug"]
ENDPOINTS = (
    {
        "kind": "models",
        "api_url": "https://huggingface.co/api/models",
        "id_keys": ("id", "modelId"),
        "axes": [
            {
                "name": "task",
                "vocab_file": "tasks.json",
                "applies_filter": "models",
                "filter_param": "pipeline_tag",
                "filter_template": "{slug}",
            },
        ],
    },
    {
        "kind": "datasets",
        "api_url": "https://huggingface.co/api/datasets",
        "id_keys": ("id",),
        "axes": [
            {
                "name": "task",
                "vocab_file": "tasks.json",
                "applies_filter": "datasets",
                "filter_param": "filter",
                "filter_template": "task_categories:{slug}",
            },
            {
                "name": "modality",
                "vocab_file": "dataset_modalities.json",
                "applies_filter": None,
                "filter_param": "filter",
                "filter_template": "modality:{slug}",
            },
        ],
    },
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("hf-fetcher")


# ───────── Helpers ───────────────────────────────────────────────────────────


def build_url(endpoint: dict, axis: dict, vocab_entry: dict, sort: str) -> str:
    qs = urllib.parse.urlencode({
        axis["filter_param"]: axis["filter_template"].format(slug=vocab_entry["slug"]),
        "sort": sort,
        "direction": -1,
        "limit": HF_LIMIT,
        "full": "true",
    })
    return f"{endpoint['api_url']}?{qs}"


def first_id(item: dict, keys: tuple) -> str | None:
    for k in keys:
        v = item.get(k)
        if v:
            return v
    return None


def load_axis_vocab(axis: dict) -> list[dict] | None:
    """Load + filter the vocab for one axis. Returns None if the file is missing."""
    path = DATA_DIR / axis["vocab_file"]
    if not path.exists():
        return None
    vocab = json.loads(path.read_text())
    if axis.get("applies_filter"):
        vocab = [v for v in vocab if axis["applies_filter"] in v.get("applies_to", [])]
    return vocab


def fetch_json(request_ctx, url: str, *, max_attempts: int = 4) -> list:
    """GET `url`, return parsed JSON list. Retries with backoff on 429/5xx."""
    delay = REQUEST_INTERVAL_SECONDS
    for attempt in range(1, max_attempts + 1):
        try:
            resp = request_ctx.get(url, timeout=30_000)
            if resp.status == 200:
                return resp.json()
            if resp.status == 429 or 500 <= resp.status < 600:
                wait = float(resp.headers.get("retry-after", delay))
                log.warning("HTTP %d on %s (attempt %d/%d), sleeping %.1fs",
                            resp.status, url, attempt, max_attempts, wait)
                time.sleep(wait)
                delay = min(delay * 2, 60)
                continue
            log.error("HTTP %d on %s — giving up", resp.status, url)
            return []
        except Exception as e:
            log.warning("fetch_json error on %s (attempt %d/%d): %s",
                        url, attempt, max_attempts, e)
            time.sleep(delay)
            delay = min(delay * 2, 60)
    return []


# ───────── Per-endpoint logic ────────────────────────────────────────────────


def run_endpoint(endpoint: dict, request_ctx, today: str) -> None:
    """Walk every axis × vocab × sort for one endpoint, dedupe, write roll-up."""
    axes_to_run: list[tuple[dict, list[dict]]] = []
    for axis in endpoint["axes"]:
        vocab = load_axis_vocab(axis)
        if vocab is None:
            log.info("[%s] Skipping axis %s: vocab file %s not found",
                     endpoint["kind"], axis["name"], axis["vocab_file"])
            continue
        if not vocab:
            log.info("[%s] Skipping axis %s: vocab is empty after applies_filter",
                     endpoint["kind"], axis["name"])
            continue
        axes_to_run.append((axis, vocab))

    if not axes_to_run:
        log.info("[%s] No runnable axes — skipping endpoint", endpoint["kind"])
        return

    n_total = sum(len(v) for _, v in axes_to_run) * len(SORTS)
    axes_summary = ", ".join(f"{a['name']}={len(v)}" for a, v in axes_to_run)
    log.info("[%s] %d requests across %d axes (%s) × %d sorts",
             endpoint["kind"], n_total, len(axes_to_run), axes_summary, len(SORTS))

    # id → {item, sources: [{axis, vocab_slug, vocab_uuid, sort, rank, fetched_at}]}
    deduped: dict[str, dict] = {}
    n_done = 0
    started = time.monotonic()

    for axis, vocab in axes_to_run:
        for entry in vocab:
            for sort in SORTS:
                url = build_url(endpoint, axis, entry, sort)
                items = fetch_json(request_ctx, url)
                fetched_at = datetime.now(timezone.utc).isoformat()
                n_done += 1
                log.info("[%s %d/%d] %s/%s · %s → %d items",
                         endpoint["kind"], n_done, n_total,
                         axis["name"], entry["slug"], sort, len(items))

                # Raw persist: data/raw/hf/<date>/<kind>/<axis>/<sort>/<slug>.json
                raw_path = (RAW_DIR / today / endpoint["kind"]
                            / axis["name"] / sort / f"{entry['slug']}.json")
                raw_path.parent.mkdir(parents=True, exist_ok=True)
                raw_path.write_text(json.dumps(items, indent=2, ensure_ascii=False))

                # Dedupe
                for rank, item in enumerate(items):
                    mid = first_id(item, endpoint["id_keys"])
                    if not mid:
                        continue
                    e = deduped.setdefault(mid, {"item": item, "sources": []})
                    e["sources"].append({
                        "axis":        axis["name"],
                        "vocab_slug":  entry["slug"],
                        "vocab_uuid":  entry["uuid"],
                        "sort":        sort,
                        "rank":        rank,
                        "fetched_at":  fetched_at,
                    })
                    e["item"] = item

                time.sleep(REQUEST_INTERVAL_SECONDS)

    # Roll-up
    FETCHED_DIR.mkdir(parents=True, exist_ok=True)
    out_path = FETCHED_DIR / f"hf-{endpoint['kind']}-{today}.json"
    rollup = sorted(deduped.values(), key=lambda e: -len(e["sources"]))
    out_path.write_text(json.dumps(rollup, indent=2, ensure_ascii=False))
    elapsed = time.monotonic() - started
    log.info("[%s] done in %.1fs: %d unique → %s",
             endpoint["kind"], elapsed, len(rollup), out_path)


def write_manifest(today: str) -> None:
    """Write data/fetched/index.json so the frontend can find the latest snapshot."""
    manifest: dict = {"last_run_utc": datetime.now(timezone.utc).isoformat()}
    for endpoint in ENDPOINTS:
        path = FETCHED_DIR / f"hf-{endpoint['kind']}-{today}.json"
        if path.exists():
            manifest[endpoint["kind"]] = {
                "filename": path.name,
                "date": today,
                "size_bytes": path.stat().st_size,
            }
    (FETCHED_DIR / "index.json").write_text(json.dumps(manifest, indent=2))
    log.info("Wrote manifest with %d snapshot(s) → %s",
             sum(1 for k in manifest if k != "last_run_utc"),
             FETCHED_DIR / "index.json")


def run_once() -> None:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    log.info("Run start (utc=%s)", today)

    with Camoufox(headless=True) as browser:
        context = browser.new_context()
        try:
            for endpoint in ENDPOINTS:
                run_endpoint(endpoint, context.request, today)
        finally:
            try:
                context.close()
            except Exception:
                pass

    write_manifest(today)


def main() -> int:
    log.info(
        "hf-fetcher starting (interval=%.1fh, spacing=%.1fs, limit=%d, endpoints=%s)",
        INTERVAL_HOURS, REQUEST_INTERVAL_SECONDS, HF_LIMIT,
        [e["kind"] for e in ENDPOINTS],
    )
    while True:
        try:
            run_once()
        except Exception:
            log.exception("Run failed")
        log.info("Sleeping %.1fh until next run", INTERVAL_HOURS)
        time.sleep(INTERVAL_HOURS * 3600)


if __name__ == "__main__":
    sys.exit(main())
