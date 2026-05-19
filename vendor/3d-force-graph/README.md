# 3d-force-graph (vendored)

Local copy of [`3d-force-graph`](https://github.com/vasturiano/3d-force-graph), Vasco Asturiano's force-directed 3D graph renderer built on Three.js. Used by the **Graph** view to render `public/graph.json`.

**Why vendored:** same reason as the rest of `vendor/` — idealab must load identically from `file://`, local Caddy, or an air-gapped network.

## Pinned version

```
1.76.0
```

See [VERSION](./VERSION). The library exposes a UMD global `ForceGraph3D` once `3d-force-graph.min.js` is loaded.

## Files

| File | Purpose | Loaded? |
|---|---|---|
| `3d-force-graph.min.js` | UMD bundle (~1.15 MB). Three.js is bundled inside; the global `ForceGraph3D` is the constructor. | **Yes** — via `<script src="vendor/3d-force-graph/3d-force-graph.min.js">` on the Graph view. |
| `VERSION` | Plain-text version pin. | — |

## Re-vendoring

```bash
cd vendor/3d-force-graph
VER="1.76.0"
curl -fsSL -o 3d-force-graph.min.js \
  "https://cdn.jsdelivr.net/npm/3d-force-graph@${VER}/dist/3d-force-graph.min.js"
echo "$VER" > VERSION
```

## API surface idealab uses

Documented at <https://github.com/vasturiano/3d-force-graph?tab=readme-ov-file#api-reference>. The Graph view configures these methods on the `ForceGraph3D()` instance:

- `graphData({nodes, links})` — feed the projected `public/graph.json`.
- `nodeAutoColorBy('type')` / `nodeVal(n => …)` / `nodeLabel(n => …)` — visual encoding.
- `nodeThreeObject(n => …)` — custom Three.js mesh per node (used when entity-type shape is needed; otherwise the library uses spheres).
- `linkColor`, `linkOpacity`, `linkLabel`, `linkDirectionalArrowLength` — edge rendering.
- `onNodeClick`, `onNodeHover` — DOI-navigation hooks (see Phase 4 plan).
- `cameraPosition` — animated focus transitions.

## Why this and not pure Three.js (like noted)?

[noted's KnowledgeGraph3D](../../../assets/noted/frontend/js/knowledge-graph/KnowledgeGraph3D.js) builds the force simulation + raycaster + drag-plane from raw Three.js (~1150 lines). idealab's graph layer reuses `3d-force-graph` as a head-start so we can spend our budget on the *navigation* model (degree-of-interest, breadcrumb, URL deeplinks) rather than re-implementing force layout. Visual conventions (entity color/shape) are deliberately mirrored from noted's `GraphNodeRenderer.ENTITY_STYLES` so the two viz layers feel like cousins. If the library proves limiting we can graduate to a noted-style implementation without rewriting the data layer.
