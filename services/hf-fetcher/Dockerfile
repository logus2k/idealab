# syntax=docker/dockerfile:1.6
#
# idealab-hf-fetcher
#   Long-running service that polls Hugging Face's models API once per day
#   through Camoufox (anti-detect Firefox built on Playwright). Deduplicates
#   results across task × sort combinations and writes daily JSON snapshots
#   to /data/fetched/.
#
# Image layering is deliberate so day-to-day rebuilds (script-only changes)
# touch only the final COPY layer:
#
#   1. base                  — Python 3.12 slim
#   2. apt deps              — system libs Firefox links against
#   3. pip install camoufox  — pinned via build arg, cached aggressively
#   4. camoufox fetch        — downloads the patched Firefox binary
#   5. app code              — fetcher.py + entrypoint, rebuilt on every code change

# ─── 1. Base ─────────────────────────────────────────────────────────────────
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DEBIAN_FRONTEND=noninteractive

# ─── 2. System libraries Firefox needs at runtime ────────────────────────────
# Same list noted uses; rarely changes, so this layer caches well.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgtk-3-0 libdbus-glib-1-2 libasound2 libx11-xcb1 libxcomposite1 \
        libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libatk1.0-0 \
        libxshmfence1 libxfixes3 \
        ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# ─── 3. Pin Camoufox (version is the only thing that should bust this layer) ─
# Override at build time with:  --build-arg CAMOUFOX_VERSION=0.4.12
ARG CAMOUFOX_VERSION=0.4.11
RUN pip install --no-cache-dir "camoufox[geoip]==${CAMOUFOX_VERSION}"

# ─── 4. Download the Camoufox-patched Firefox into the image ────────────────
# This pulls ~80 MB. Pinned to the same version arg so the layer is
# reproducible for any given CAMOUFOX_VERSION.
RUN python -m camoufox fetch

# ─── 5. App code (last layer — rebuilt cheaply on every code change) ────────
WORKDIR /app
COPY fetcher.py /app/fetcher.py

# Tunables — overridable from docker-compose
ENV INTERVAL_HOURS=24 \
    REQUEST_INTERVAL_SECONDS=3 \
    HF_LIMIT=100 \
    DATA_DIR=/data

# Smoke test at build time: Camoufox can spawn the browser. If this fails
# the layer never lands, so a broken image never reaches the registry.
RUN python -c "from camoufox.sync_api import Camoufox; \
    Camoufox(headless=True).__enter__().__exit__(None, None, None); \
    print('camoufox smoke OK')"

CMD ["python", "/app/fetcher.py"]
