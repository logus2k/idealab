# three-spritetext (vendored)

Local copy of [`three-spritetext`](https://github.com/vasturiano/three-spritetext) — Vasco Asturiano's tiny library that renders text as a Three.js `Sprite` with a canvas-rendered texture. Used by the Graph view to draw persistent labels next to nodes and edges.

**Why vendored:** same reason as the rest of `vendor/` — no CDN at runtime.

## Pinned version

```
1.10.0
```

## Files

| File | Purpose | Loaded? |
|---|---|---|
| `three-spritetext.min.js` | UMD bundle (~9 KB). Reads `window.THREE` and exposes `window.SpriteText`. | **Yes** — loaded after Three.js is on `window.THREE`, before `3d-force-graph`. |
| `three-spritetext.mjs` | ESM build (~17 KB) that imports `Sprite`/`CanvasTexture`/etc. from `'three'`. Kept for bundler use; not loaded at runtime. | No. |
| `VERSION` | Plain-text version pin. | — |

## Re-vendoring

```bash
cd vendor/three-spritetext
VER="1.10.0"
curl -fsSL -o three-spritetext.min.js  "https://cdn.jsdelivr.net/npm/three-spritetext@${VER}/dist/three-spritetext.min.js"
curl -fsSL -o three-spritetext.mjs     "https://cdn.jsdelivr.net/npm/three-spritetext@${VER}/dist/three-spritetext.mjs"
echo "$VER" > VERSION
```

## Load order in app.js

```text
1. dynamic import('vendor/three/three.module.min.js')   → window.THREE
2. <script src="vendor/three-spritetext/...min.js">     → window.SpriteText (uses window.THREE)
3. <script src="vendor/3d-force-graph/...min.js">       → window.ForceGraph3D (its own bundled THREE)
4. <script src="graph.js">                              → idealab Graph view init
```

3d-force-graph still ships a bundled THREE internally; the two copies coexist in practice because Sprite rendering doesn't depend on cross-copy `instanceof` checks.
