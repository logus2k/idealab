/* ============================================================================
 * idealab Graph view — 3d-force-graph over public/graph.json with degree-of-
 * interest navigation: click a focus node → see its 1-hop neighborhood →
 * click another → drill further. Click empty space to step back.
 *
 * Loaded on-demand by app.js when the Graph tab is first opened. Reads:
 *   window.THREE       — Three.js (loaded by app.js via dynamic ESM import)
 *   window.SpriteText  — three-spritetext UMD bundle
 *   window.ForceGraph3D — 3d-force-graph UMD bundle
 *
 * Mirrors noted's GraphNodeRenderer.ENTITY_STYLES convention so the two viz
 * layers feel like cousins.
 * ========================================================================= */
(function () {
  'use strict';

  // ----- visual palette tuned for a WHITE background -----
  // Shape is meaningful (not just colour) so colourblind viewers can also
  // parse types at a glance. Sizes are world-space radii / half-widths.
  const BACKGROUND = '#ffffff';
  const ENTITY_STYLES = {
    idea:          { color: '#2e7d32', size: 6,  shape: 'sphere',      label: 'Idea' },
    plan:          { color: '#7b1fa2', size: 8,  shape: 'cone',        label: 'Plan' },
    requirement:   { color: '#c2185b', size: 5,  shape: 'octahedron',  label: 'Requirement' },
    kpi:           { color: '#1565c0', size: 5,  shape: 'cylinder',    label: 'KPI' },
    kpi_category:  { color: '#0d47a1', size: 9,  shape: 'cylinder',    label: 'KPI category' },
    entity:        { color: '#ef6c00', size: 5,  shape: 'box',         label: 'Entity' },
    task:          { color: '#6a1b9a', size: 5,  shape: 'tetrahedron', label: 'Task' },
    task_category: { color: '#4a148c', size: 9,  shape: 'tetrahedron', label: 'Task category' },
    model:         { color: '#00695c', size: 4,  shape: 'torus',       label: 'Model' },
    dataset:       { color: '#004d40', size: 4,  shape: 'box',         label: 'Dataset' },
    modality:      { color: '#455a64', size: 7,  shape: 'octahedron',  label: 'Modality' },
    format:        { color: '#37474f', size: 7,  shape: 'octahedron',  label: 'Format' },
    _default:      { color: '#616161', size: 4,  shape: 'sphere',      label: 'Node' },
  };

  // Cache geometries per (shape, size) so identical-type nodes share buffers.
  const GEOMETRY_CACHE = new Map();
  function buildGeometry(shape, size) {
    const key = shape + ':' + size;
    if (GEOMETRY_CACHE.has(key)) return GEOMETRY_CACHE.get(key);
    const T = window.THREE;
    let geom;
    switch (shape) {
      case 'box':         geom = new T.BoxGeometry(size * 1.6, size * 1.6, size * 1.6); break;
      case 'cone':        geom = new T.ConeGeometry(size, size * 2, 16); break;
      case 'cylinder':    geom = new T.CylinderGeometry(size, size, size * 1.6, 18); break;
      case 'octahedron':  geom = new T.OctahedronGeometry(size); break;
      case 'tetrahedron': geom = new T.TetrahedronGeometry(size * 1.1); break;
      case 'torus':       geom = new T.TorusGeometry(size, size * 0.38, 10, 18); break;
      case 'sphere':
      default:            geom = new T.SphereGeometry(size, 18, 14); break;
    }
    GEOMETRY_CACHE.set(key, geom);
    return geom;
  }

  // Polarity → edge color (matches RELATION_POLARITY in build_graph.py)
  const POLARITY_COLORS = {
    positive:    'rgba(46, 125, 50, 0.85)',     // green
    negative:    'rgba(198, 40, 40, 0.85)',     // red
    competitive: 'rgba(239, 108, 0, 0.85)',     // amber
    neutral:     'rgba(108, 117, 125, 0.45)',   // grey
  };
  const DEFAULT_LINK_COLOR = 'rgba(108, 117, 125, 0.32)';

  // Label sizing — these are world-space heights, not pixels. 3d-force-graph
  // does the projection; SpriteText handles the canvas-rendering.
  const NODE_LABEL_HEIGHT = 4;
  const EDGE_LABEL_HEIGHT = 2.5;

  // Camera-distance threshold (world units) below which label sprites stop
  // growing on screen. Above this, labels keep their natural world-space
  // size; below, world-scale is dialed down linearly so screen size stays
  // constant. Without this, zooming in makes labels occlude their own nodes.
  const LABEL_MAX_DIST_NODE = 200;
  const LABEL_MAX_DIST_EDGE = 150;

  // Bind a per-frame scale-cap onto a SpriteText so it never grows beyond
  // the screen-size it would have at `maxDist`. Records the natural scale
  // SpriteText computed during _genCanvas() so we can restore it when far.
  const _tmpVec = (typeof window !== 'undefined' && window.THREE) ? null : null; // set after THREE loads
  function bindLabelScaleCap(sprite, maxDist) {
    const T = window.THREE;
    sprite.userData.naturalScale = sprite.scale.clone();
    const tmp = new T.Vector3();
    sprite.onBeforeRender = function (renderer, scene, camera) {
      const dist = camera.position.distanceTo(this.getWorldPosition(tmp));
      const nat = this.userData.naturalScale;
      if (dist < maxDist) {
        const k = dist / maxDist;
        this.scale.set(nat.x * k, nat.y * k, nat.z * k || 0);
      } else {
        this.scale.copy(nat);
      }
    };
  }

  // ----- internal state -----
  const S = {
    raw: null,
    fg: null,
    nodeById: new Map(),
    adjacency: new Map(),
    edgesByPair: new Map(),
    focusStack: [],
    visibleNodeIds: new Set(),
    visibleEdgeKeys: new Set(),
    showAll: false,
    showEdgeLabels: false,           // default: hover-only tooltips, no on-canvas labels
    edgeSpritesByLink: new WeakMap(),
    // Auto-fit cooperation with the user — set when the view changes; cleared
    // the moment the user starts interacting (mouse, wheel, drag). The
    // post-settle fit only runs while this flag is still true.
    fitPending: false,
    handlers: {},
  };

  // ============================================================================
  //  Initialization
  // ============================================================================

  async function init(opts) {
    const {
      stage, breadcrumb, hudStatus,
      showEdgeLabels, showAll,
      settingsBtn, settingsPanel,
    } = opts;
    if (S.fg) return;

    setStatus(hudStatus, 'Loading graph.json…');
    let payload;
    try {
      const resp = await fetch('public/graph.json', { cache: 'force-cache' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      payload = await resp.json();
    } catch (err) {
      setStatus(hudStatus, 'Failed to load public/graph.json: ' + err.message);
      throw err;
    }
    S.raw = payload;

    // Adjacency + edge indices, built once.
    for (const n of payload.nodes) S.nodeById.set(n.id, n);
    for (const e of payload.links) {
      const src = (typeof e.source === 'object') ? e.source.id : e.source;
      const dst = (typeof e.target === 'object') ? e.target.id : e.target;
      S.edgesByPair.set(src + '→' + dst, e);
      if (!S.adjacency.has(src)) S.adjacency.set(src, new Set());
      if (!S.adjacency.has(dst)) S.adjacency.set(dst, new Set());
      S.adjacency.get(src).add(dst);
      S.adjacency.get(dst).add(src);
    }

    if (typeof window.ForceGraph3D !== 'function') {
      setStatus(hudStatus, 'ForceGraph3D global not found — vendor bundle missing?');
      throw new Error('ForceGraph3D missing');
    }
    if (typeof window.SpriteText !== 'function') {
      setStatus(hudStatus, 'SpriteText global not found — three-spritetext bundle missing?');
      throw new Error('SpriteText missing');
    }

    S.fg = window.ForceGraph3D()(stage)
      .backgroundColor(BACKGROUND)
      .nodeThreeObjectExtend(false)                  // replace default sphere
      .nodeThreeObject(buildNode)
      .linkColor(linkColor)
      .linkOpacity(0.75)
      .linkWidth(l => (l.relation ? 1.4 : 0.6))
      .linkThreeObjectExtend(true)
      .linkThreeObject(buildEdgeLabel)
      .linkPositionUpdate(positionEdgeLabel)
      .linkLabel(linkTooltipHtml)
      .nodeLabel(nodeTooltipHtml)
      .onNodeClick(onNodeClick)
      .onBackgroundClick(onBackgroundClick)
      .onEngineStop(onEngineStop)
      .cooldownTicks(80)
      .warmupTicks(40);

    renderInitialOverview();
    drawBreadcrumb(breadcrumb);
    setStatus(hudStatus, formatStatus());

    // Make sure orbit controls don't clamp zoom — far nodes need to be
    // approachable, and on-canvas labels need to be readable up close.
    const controls = S.fg.controls && S.fg.controls();
    if (controls) {
      controls.minDistance = 1;
      controls.maxDistance = 20000;
    }
    const cam = S.fg.camera && S.fg.camera();
    if (cam) {
      cam.near = 0.5;
      cam.far  = 50000;
      cam.updateProjectionMatrix && cam.updateProjectionMatrix();
    }

    if (showEdgeLabels) {
      S.showEdgeLabels = !!showEdgeLabels.checked;
      showEdgeLabels.addEventListener('change', () => {
        S.showEdgeLabels = !!showEdgeLabels.checked;
        applyEdgeLabelVisibility();
      });
    }
    if (showAll) {
      showAll.addEventListener('change', () => {
        S.showAll = !!showAll.checked;
        S.showAll ? renderFullGraph() : renderInitialOverview();
        drawBreadcrumb(breadcrumb);
        setStatus(hudStatus, formatStatus());
      });
    }

    // Legend wiring — checkbox in settings panel + an in-canvas floating panel.
    const legendBox  = opts.legend;
    const showLegend = opts.showLegend;
    if (legendBox) renderLegendInto(legendBox);
    if (showLegend && legendBox) {
      const apply = () => { legendBox.hidden = !showLegend.checked; };
      apply();
      showLegend.addEventListener('change', apply);
      // Close button inside the legend panel toggles the same checkbox.
      legendBox.addEventListener('click', e => {
        if (e.target.closest('.graph-legend-close')) {
          showLegend.checked = false;
          apply();
        }
      });
    }

    // Settings popover — click gear to toggle, click outside to close.
    if (settingsBtn && settingsPanel) {
      const toggle = (open) => {
        const willOpen = open === undefined ? settingsPanel.hidden : open;
        settingsPanel.hidden = !willOpen;
        settingsBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      };
      settingsBtn.addEventListener('click', e => {
        e.stopPropagation();
        toggle();
      });
      document.addEventListener('click', e => {
        if (settingsPanel.hidden) return;
        if (settingsPanel.contains(e.target) || settingsBtn.contains(e.target)) return;
        toggle(false);
      });
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !settingsPanel.hidden) toggle(false);
      });
    }

    S.handlers = { breadcrumb, hudStatus };

    // Any user interaction on the canvas cancels a pending auto-fit so we
    // don't yank the camera mid-gesture.
    stage.addEventListener('mousedown', cancelPendingFit, { passive: true });
    stage.addEventListener('wheel',     cancelPendingFit, { passive: true });
    stage.addEventListener('touchstart', cancelPendingFit, { passive: true });

    const ro = new ResizeObserver(() => {
      if (!S.fg) return;
      const r = stage.getBoundingClientRect();
      S.fg.width(r.width).height(r.height);
      // Authorize one fit after the resize settles (engine doesn't restart
      // for a resize, so we trigger it ourselves once via fitOnceSoon).
      fitOnceSoon();
    });
    ro.observe(stage);
  }

  // Authorize-and-attempt a fit shortly after the call (used for resizes,
  // where there's no engine restart to wait for).
  let _resizeFitTimer = null;
  function fitOnceSoon() {
    if (_resizeFitTimer) clearTimeout(_resizeFitTimer);
    S.fitPending = true;
    _resizeFitTimer = setTimeout(() => {
      _resizeFitTimer = null;
      if (S.fitPending) {
        S.fitPending = false;
        S.fg && S.fg.zoomToFit(500, 60);
      }
    }, 350);
  }

  // ============================================================================
  //  Node & edge label sprites
  // ============================================================================

  // Build a Group containing the shape mesh AND the floating label sprite.
  // 3d-force-graph translates the group's origin to the node's simulated
  // position each frame; the shape sits at the origin and the label is
  // offset upward.
  function buildNode(node) {
    const style = ENTITY_STYLES[node.type] || ENTITY_STYLES._default;
    const T = window.THREE;
    const group = new T.Group();

    const mesh = new T.Mesh(
      buildGeometry(style.shape, style.size),
      new T.MeshLambertMaterial({ color: style.color, transparent: true, opacity: 0.95 }),
    );
    // Stand cones/cylinders so the apex points "up" relative to camera default.
    // Default Three.js cone/cylinder is already Y-up; no rotation needed.
    group.add(mesh);

    const sprite = new window.SpriteText((node.label || node.id).slice(0, 60));
    sprite.color = '#1a202c';
    sprite.backgroundColor = 'rgba(255, 255, 255, 0.82)';
    sprite.borderColor = style.color;
    sprite.borderWidth = 0.6;
    sprite.borderRadius = 2;
    sprite.padding = [2, 1];
    sprite.textHeight = NODE_LABEL_HEIGHT;
    sprite.position.y = style.size + NODE_LABEL_HEIGHT * 0.8;
    // Keep the label readable from any camera angle — disable depth-testing
    // and render after all meshes so it's never occluded by its own shape
    // (or by any other node when rotating).
    sprite.material.depthTest = false;
    sprite.material.depthWrite = false;
    sprite.renderOrder = 999;
    bindLabelScaleCap(sprite, LABEL_MAX_DIST_NODE);
    group.add(sprite);

    return group;
  }

  function buildEdgeLabel(link) {
    // We only want a label when the verb is meaningful (refined by semantic
    // layer). Pure structural edges (no `relation`) get the hover tooltip only.
    const verb = link.relation || link.label;
    if (!verb || verb === 'in category') return null;
    const sprite = new window.SpriteText(verb);
    sprite.color = '#475569';
    sprite.backgroundColor = 'rgba(255, 255, 255, 0.78)';
    sprite.padding = [1.5, 0.6];
    sprite.borderRadius = 1.5;
    sprite.textHeight = EDGE_LABEL_HEIGHT;
    sprite.material.depthTest = false;
    sprite.material.depthWrite = false;
    sprite.renderOrder = 998;        // just below node labels
    sprite.visible = S.showEdgeLabels;
    bindLabelScaleCap(sprite, LABEL_MAX_DIST_EDGE);
    S.edgeSpritesByLink.set(link, sprite);
    return sprite;
  }

  // Called by 3d-force-graph for every link every frame — only job here is to
  // keep the label sprite at the edge midpoint. Visibility is driven by the
  // "Show edge labels" checkbox via applyEdgeLabelVisibility().
  function positionEdgeLabel(sprite, { start, end }) {
    if (!sprite) return;
    sprite.position.set(
      (start.x + end.x) / 2,
      (start.y + end.y) / 2,
      ((start.z || 0) + (end.z || 0)) / 2,
    );
  }

  function applyEdgeLabelVisibility() {
    if (!S.fg) return;
    const { links } = S.fg.graphData();
    for (const l of links) {
      const sprite = S.edgeSpritesByLink.get(l);
      if (sprite) sprite.visible = S.showEdgeLabels;
    }
  }

  // ============================================================================
  //  Rendering modes
  // ============================================================================

  function renderInitialOverview() {
    const spineTypes = new Set(['kpi_category', 'task_category', 'modality', 'format']);
    const keepIds = new Set();
    for (const n of S.raw.nodes) {
      if (spineTypes.has(n.type)) keepIds.add(n.id);
    }
    for (const n of S.raw.nodes) {
      if (n.type === 'plan') keepIds.add(n.id);
    }
    const deg = degreeMap();
    const ideas = S.raw.nodes.filter(n => n.type === 'idea')
      .sort((a, b) => (deg.get(b.id) || 0) - (deg.get(a.id) || 0))
      .slice(0, 40);
    for (const n of ideas) keepIds.add(n.id);
    applyVisible(keepIds);
  }

  function renderFullGraph() {
    applyVisible(new Set(S.raw.nodes.map(n => n.id)));
  }

  function applyVisible(nodeIds) {
    S.visibleNodeIds = nodeIds;
    S.visibleEdgeKeys = new Set();
    const visibleNodes = [];
    const visibleEdges = [];
    for (const id of nodeIds) {
      const n = S.nodeById.get(id);
      if (n) visibleNodes.push(n);
    }
    for (const [k, e] of S.edgesByPair) {
      const src = (typeof e.source === 'object') ? e.source.id : e.source;
      const dst = (typeof e.target === 'object') ? e.target.id : e.target;
      if (nodeIds.has(src) && nodeIds.has(dst)) {
        S.visibleEdgeKeys.add(k);
        visibleEdges.push(e);
      }
    }
    S.fg.graphData({ nodes: visibleNodes, links: visibleEdges });
    // Authorize ONE upcoming fit when the simulation settles. Any user
    // interaction (mouse / wheel / drag) before then cancels it so we never
    // yank the camera while they're interacting.
    S.fitPending = true;
    // Result count in the topbar, e.g. "98 of 2671 nodes"
    updateResultCount();
  }

  // Fires once each time the simulation cools below the cooldown threshold.
  // Use it as the natural moment to frame the visible set — if the user is
  // already interacting, fitPending is false and we skip.
  function onEngineStop() {
    if (!S.fitPending) return;
    S.fitPending = false;
    if (!S.fg) return;
    const { nodes } = S.fg.graphData();
    if (!nodes.length) return;
    S.fg.zoomToFit(600, 60);
    // After the fit, anchor zoom-target on the focused node so user zoom
    // dollies toward what they clicked, not the bbox centroid.
    setTimeout(() => {
      const focus = S.focusStack[S.focusStack.length - 1];
      if (!focus) return;
      const node = S.fg.graphData().nodes.find(n => n.id === focus);
      const controls = S.fg.controls && S.fg.controls();
      if (node && controls && controls.target) {
        controls.target.set(node.x || 0, node.y || 0, node.z || 0);
        controls.update && controls.update();
      }
    }, 650);
  }

  function cancelPendingFit() {
    S.fitPending = false;
  }

  function updateResultCount() {
    const el = document.getElementById('resultCount');
    if (!el) return;
    const total = S.raw ? S.raw.nodes.length : 0;
    el.textContent = `${S.visibleNodeIds.size} of ${total} nodes`;
  }

  // ============================================================================
  //  Degree-of-interest navigation
  // ============================================================================

  function onNodeClick(node) {
    if (!node) return;
    if (S.focusStack[S.focusStack.length - 1] !== node.id) S.focusStack.push(node.id);
    expandFocus(node.id);                  // scheduleFit() runs inside applyVisible()
    drawBreadcrumb(S.handlers.breadcrumb);
    setStatus(S.handlers.hudStatus, formatStatus());
  }

  function onBackgroundClick() {
    if (S.focusStack.length === 0) return;
    S.focusStack.pop();
    if (S.focusStack.length === 0) {
      S.showAll ? renderFullGraph() : renderInitialOverview();
    } else {
      expandFocus(S.focusStack[S.focusStack.length - 1]);
    }
    drawBreadcrumb(S.handlers.breadcrumb);
    setStatus(S.handlers.hudStatus, formatStatus());
  }

  function expandFocus(focusId) {
    const keep = new Set([focusId]);
    const neighbors = S.adjacency.get(focusId) || new Set();
    for (const nid of neighbors) keep.add(nid);
    for (const id of S.focusStack) keep.add(id);
    applyVisible(keep);
  }

  // Per-node camera animation removed — scheduleFit() (called from
  // applyVisible) frames the entire visible set, so the focused node
  // naturally lands at/near the bbox center.

  // ============================================================================
  //  Breadcrumb
  // ============================================================================

  function drawBreadcrumb(el) {
    if (!el) return;
    if (S.focusStack.length === 0) {
      el.innerHTML = '<span class="graph-breadcrumb-empty">Click a node to start navigating.</span>';
      return;
    }
    const parts = [];
    S.focusStack.forEach((id, idx) => {
      const node = S.nodeById.get(id);
      if (!node) return;
      const isCurrent = idx === S.focusStack.length - 1;
      const label = escapeHtml(node.label || node.id);
      parts.push(
        `<span class="graph-breadcrumb-crumb ${isCurrent ? 'current' : ''}" data-step="${idx}">` +
          `<span class="graph-breadcrumb-type">${typeLabel(node.type)}</span>` +
          `<span class="graph-breadcrumb-label">${label}</span>` +
        `</span>`
      );
      if (!isCurrent) parts.push('<span class="graph-breadcrumb-sep">›</span>');
    });
    el.innerHTML = parts.join('');
    el.querySelectorAll('.graph-breadcrumb-crumb').forEach(node => {
      node.addEventListener('click', () => {
        const step = Number(node.dataset.step);
        S.focusStack = S.focusStack.slice(0, step + 1);
        expandFocus(S.focusStack[S.focusStack.length - 1]);
        drawBreadcrumb(el);
        setStatus(S.handlers.hudStatus, formatStatus());
      });
    });
  }

  // ============================================================================
  //  Tooltips + helpers
  // ============================================================================

  function nodeTooltipHtml(n) {
    const style = ENTITY_STYLES[n.type] || ENTITY_STYLES._default;
    return `<div style="font-family:sans-serif;font-size:12px">` +
      `<div style="color:${style.color};font-weight:600;text-transform:uppercase;letter-spacing:.05em;font-size:10px">${style.label}</div>` +
      `<div style="color:#1a202c">${escapeHtml(n.label || n.id)}</div>` +
    `</div>`;
  }

  function linkTooltipHtml(l) {
    const verb = l.relation || l.label || l.type;
    const conf = (l.confidence != null) ? ` (${Math.round(l.confidence * 100)}%)` : '';
    const rationale = l.rationale ? `<div style="color:#64748b;font-style:italic;margin-top:2px">«${escapeHtml(l.rationale)}»</div>` : '';
    return `<div style="font-family:sans-serif;font-size:12px;color:#1a202c">` +
      `<b>${escapeHtml(verb)}</b>${conf}${rationale}` +
    `</div>`;
  }

  function linkColor(l) {
    if (l.polarity && POLARITY_COLORS[l.polarity]) return POLARITY_COLORS[l.polarity];
    return DEFAULT_LINK_COLOR;
  }

  function degreeMap() {
    const out = new Map();
    for (const [id, neigh] of S.adjacency) out.set(id, neigh.size);
    return out;
  }

  function typeLabel(t) {
    return (ENTITY_STYLES[t] || ENTITY_STYLES._default).label;
  }

  // Small inline SVG thumbnail per shape so the legend can show the
  // actual shape next to its color without spinning up a Three.js scene
  // for each row.
  function shapeSvg(shape, color) {
    const c = color;
    switch (shape) {
      case 'box':         return `<svg viewBox="-12 -12 24 24"><rect x="-8" y="-8" width="16" height="16" rx="1" fill="${c}" stroke="rgba(0,0,0,0.25)"/></svg>`;
      case 'cone':        return `<svg viewBox="-12 -12 24 24"><polygon points="0,-10 9,8 -9,8" fill="${c}" stroke="rgba(0,0,0,0.25)"/></svg>`;
      case 'cylinder':    return `<svg viewBox="-12 -12 24 24"><ellipse cx="0" cy="-6" rx="9" ry="2.4" fill="${c}" stroke="rgba(0,0,0,0.25)"/><rect x="-9" y="-6" width="18" height="12" fill="${c}" stroke="rgba(0,0,0,0.25)"/><ellipse cx="0" cy="6" rx="9" ry="2.4" fill="${c}" stroke="rgba(0,0,0,0.25)"/></svg>`;
      case 'octahedron':  return `<svg viewBox="-12 -12 24 24"><polygon points="0,-10 10,0 0,10 -10,0" fill="${c}" stroke="rgba(0,0,0,0.25)"/></svg>`;
      case 'tetrahedron': return `<svg viewBox="-12 -12 24 24"><polygon points="0,-10 9,7 -9,7" fill="${c}" stroke="rgba(0,0,0,0.25)"/><line x1="0" y1="-10" x2="0" y2="7" stroke="rgba(0,0,0,0.25)"/></svg>`;
      case 'torus':       return `<svg viewBox="-12 -12 24 24"><circle cx="0" cy="0" r="9" fill="none" stroke="${c}" stroke-width="4"/></svg>`;
      case 'sphere':
      default:            return `<svg viewBox="-12 -12 24 24"><circle cx="0" cy="0" r="9" fill="${c}" stroke="rgba(0,0,0,0.25)"/></svg>`;
    }
  }

  function renderLegendInto(el) {
    // Only the entity types that can actually appear in the graph (skip _default).
    const rows = Object.entries(ENTITY_STYLES)
      .filter(([k]) => k !== '_default')
      .map(([type, style]) =>
        `<div class="graph-legend-row">` +
          `<span class="graph-legend-icon" style="color:${style.color}">${shapeSvg(style.shape, style.color)}</span>` +
          `<span class="graph-legend-label">${escapeHtml(style.label)}</span>` +
        `</div>`
      ).join('');
    el.innerHTML =
      `<div class="graph-legend-head">` +
        `<span class="graph-legend-title">Legend</span>` +
        `<button type="button" class="graph-legend-close" aria-label="Close legend" title="Close">×</button>` +
      `</div>` +
      `<div class="graph-legend-body">${rows}</div>`;
  }

  function setStatus(el, text) {
    if (el) el.textContent = text;
  }

  function formatStatus() {
    if (S.showAll) {
      return `Full graph: ${S.visibleNodeIds.size} node(s), ${S.visibleEdgeKeys.size} edge(s). Click a node to focus.`;
    }
    if (S.focusStack.length === 0) {
      return `Overview: ${S.visibleNodeIds.size} node(s). Click any node to expand its neighbors.`;
    }
    return `Focused on ${S.focusStack.length} level(s). Click empty space to step back.`;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  window.idealabGraph = { init };
})();
