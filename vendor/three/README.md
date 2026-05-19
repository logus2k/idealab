# three (vendored)

Local copy of [Three.js](https://threejs.org/), the WebGL 3D library. Used directly when [3d-force-graph](../3d-force-graph/)'s built-in node renderer is not enough — e.g. for custom node geometry (shape per entity type) or text sprites.

**Why vendored:** same reason as the rest of `vendor/` — idealab must load identically from `file://`, local Caddy, or an air-gapped network. No CDN at runtime.

## Pinned version

```
0.176.0
```

See [VERSION](./VERSION). For symmetry with [noted's KnowledgeGraph3D](../../../assets/noted/frontend/js/knowledge-graph/KnowledgeGraph3D.js) the API surface used (`Mesh`, `SphereGeometry`, `Raycaster`, `Color`, `Vector2`/`Vector3`) is stable across r150+.

## Files

| File | Purpose | Loaded? |
|---|---|---|
| `three.module.min.js` | ES-module entry-shim. Re-exports the public API but **imports everything from `./three.core.min.js`**, so both files MUST live side-by-side or dynamic import 404s. | On-demand by the Graph view via `import * as THREE from '…'`. |
| `three.core.min.js` | The actual Three.js engine (geometry, materials, renderer, etc.). Imported by the shim above. | Pulled in transitively by the shim. |
| `VERSION` | Plain-text version pin. | — |

## Re-vendoring

```bash
cd vendor/three
VER="0.176.0"
curl -fsSL -o three.module.min.js  "https://cdn.jsdelivr.net/npm/three@${VER}/build/three.module.min.js"
curl -fsSL -o three.core.min.js    "https://cdn.jsdelivr.net/npm/three@${VER}/build/three.core.min.js"
echo "$VER" > VERSION
```

**Don't forget the `.core` file** — the `.module` file is a thin shim that imports it via `./three.core.min.js`; missing it breaks dynamic-import.

If you also need addons (e.g. `OrbitControls`), grab them from `https://cdn.jsdelivr.net/npm/three@${VER}/examples/jsm/controls/OrbitControls.js`. Save as `OrbitControls.js` and update its `import` paths to point at the local `three.module.min.js` (noted's vendor folder has a working example).

## Relationship to `vendor/3d-force-graph/`

`3d-force-graph` already bundles a copy of Three.js internally — for the default node/link rendering you don't need to load this module at all. We keep it vendored separately for cases where the Graph view wants raw Three.js access (custom geometry, sprites, advanced interactions). When both are loaded, the global `THREE` may be the library's internal copy *or* this one depending on load order; treat them as version-compatible but don't mix instances of the same class across copies.
