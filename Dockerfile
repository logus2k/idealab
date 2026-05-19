# Stage 1 — build the SQLite catalog from data/ + ideas_catalog.md.
# Alpine's sqlite-libs ships with FTS5 enabled by default (since 3.10), and the
# image has a smaller CVE surface than slim variants. This stage does not ship
# to the runtime image — only the produced catalog.sqlite is copied forward.
FROM python:3.12-alpine AS builder

WORKDIR /build

COPY data/ ./data/
COPY plans/ ./plans/
COPY ideas_catalog.md ./
COPY scripts/ ./scripts/

RUN python scripts/build_sqlite.py \
 && python scripts/build_graph.py

# Stage 2 — serve everything via Caddy
FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile

# Frontend
COPY index.html /srv/
COPY app.js     /srv/
COPY graph.js   /srv/
COPY styles.css /srv/
COPY db.js      /srv/

# Vendored runtime deps (sqlite-wasm, three.js, 3d-force-graph). All loaded from /srv/vendor/.
COPY vendor/ /srv/vendor/

# Source-of-truth files (still served so existing flows keep working)
COPY ideas_catalog.md /srv/
COPY plans/           /srv/plans/
COPY data/            /srv/data/

# Built artifacts — catalog.sqlite is served at /srv/catalog.sqlite by db.js;
# graph.json lives at /srv/public/graph.json (graph.js fetches it by that path).
COPY --from=builder /build/public/catalog.sqlite /srv/catalog.sqlite
COPY --from=builder /build/public/graph.json     /srv/public/graph.json

EXPOSE 6444
