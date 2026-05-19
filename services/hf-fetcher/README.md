# hf-fetcher

Long-running sidecar that polls the Hugging Face models API once per day via Camoufox (anti-detect Firefox built on Playwright), deduplicates across `(model_task × sort)` combinations, and writes JSON snapshots into `data/raw/hf/` and `data/fetched/`.

## What it fetches

Two endpoints, multiple axes, all driven by vocab files under `data/`:

| Endpoint     | Axis     | Filter convention                       | Vocab file (count)                    |
| ------------ | -------- | --------------------------------------- | ------------------------------------- |
| `/api/models`   | `task`     | `?pipeline_tag=<slug>`             | `data/tasks.json` filtered by `applies_to=models` (52) |
| `/api/datasets` | `task`     | `?filter=task_categories:<slug>`   | `data/tasks.json` filtered by `applies_to=datasets` (52) |
| `/api/datasets` | `modality` | `?filter=modality:<slug>`          | `data/dataset_modalities.json` (9)    |

Notes on filter conventions (verified empirically):
- **Models** use the dedicated `?pipeline_tag=` param — works correctly.
- **Datasets** must use `?filter=<group>:<id>` — the apparent shortcuts `?task_categories=X` and `?modality=X` only *partial-filter* (51/100 and 24/100 hits actually match the requested tag).
- `sort=trending` returns 400; the API value is **`trendingScore`** even though the UI label is "Trending".
- `limit` is hard-capped at 1000. We use 100 (page-1 equivalent).
- Pagination (if ever needed) is cursor-based via the `Link: …; rel="next"` header — `?p=N` is ignored by the API.

Per request shape:

```
https://huggingface.co/api/<kind>
  ?<filter_param>=<value>
  &sort=trendingScore | likes | downloads
  &direction=-1
  &limit=100
  &full=true
```

Per run (current):
- Models: 52 tasks × 3 sorts = **156 requests**
- Datasets task axis: 52 × 3 = **156 requests**
- Datasets modality axis: 9 × 3 = **27 requests**
- **Total: 339 requests**, ~**17 min** at 3 s spacing.

Any axis whose vocab file is missing on disk is logged + skipped (does not abort the run).

## Outputs

```
data/
  raw/hf/<YYYY-MM-DD>/
    models/
      trendingScore/<task-slug>.json   ← raw API response (up to 100 entries)
      likes/<task-slug>.json
      downloads/<task-slug>.json
    datasets/                          ← created when dataset taxonomy exists
      trendingScore/<task-slug>.json
      …
  fetched/
    hf-models-<YYYY-MM-DD>.json        ← deduped roll-up per kind
    hf-datasets-<YYYY-MM-DD>.json
```

Each roll-up entry has the shape:

```json
{
  "item": { ... HF API record ... },
  "sources": [
    {"task_slug": "audio-text-to-text", "task_uuid": "…", "sort": "trendingScore", "rank": 0, "fetched_at": "…"},
    {"task_slug": "audio-text-to-text", "task_uuid": "…", "sort": "likes",         "rank": 3, "fetched_at": "…"}
  ]
}
```

## Run

```bash
docker compose up -d --build hf-fetcher
docker compose logs -f hf-fetcher
```

First build is slow (~5–10 min): pip install + Camoufox downloading the patched Firefox (~80 MB). Subsequent rebuilds touching only `fetcher.py` are fast — that file lives in the last image layer.

To run a single cycle without waiting for the daily schedule, exec into the container:

```bash
docker compose exec hf-fetcher python /app/fetcher.py
```

(or override `INTERVAL_HOURS` to a small value while iterating).

## Layering & version pinning

Camoufox is pinned via a Docker build argument so an upgrade is a one-line change:

```dockerfile
ARG CAMOUFOX_VERSION=0.4.11
RUN pip install --no-cache-dir "camoufox[geoip]==${CAMOUFOX_VERSION}"
RUN python -m camoufox fetch
```

Bumping the pin:

```bash
docker compose build --build-arg CAMOUFOX_VERSION=0.4.12 hf-fetcher
```

The Firefox download is a separate `RUN` so it caches with the same key. Application-code changes only invalidate the last layer.

## Tunables

| Env var                   | Default | Meaning                                  |
| ------------------------- | ------- | ---------------------------------------- |
| `INTERVAL_HOURS`          | `24`    | Wait between runs.                       |
| `REQUEST_INTERVAL_SECONDS`| `3`     | Spacing between HTTP requests.           |
| `HF_LIMIT`                | `100`   | Results per (task, sort) request.        |
| `DATA_DIR`                | `/data` | Where input/outputs live in the container. |

## Why Camoufox vs plain `httpx`

HF doesn't aggressively block direct API hits today, but we choose the same anti-detect path noted uses so that idealab is robust if HF (or any other future source) starts looking at TLS fingerprints, JA3, navigator properties, etc. The cost is a heavier image (~370 MB) and slightly slower per-request startup. Acceptable for a once-a-day cron.
