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
  const BACKGROUND = '#ffffff';
  const ENTITY_STYLES = {
    idea:          { color: '#2e7d32', size: 6,  label: 'Idea' },          // green
    plan:          { color: '#7b1fa2', size: 8,  label: 'Plan' },          // purple
    requirement:   { color: '#c2185b', size: 5,  label: 'Requirement' },   // pink
    kpi:           { color: '#1565c0', size: 5,  label: 'KPI' },           // blue
    kpi_category:  { color: '#0d47a1', size: 9,  label: 'KPI category' },
    entity:        { color: '#ef6c00', size: 5,  label: 'Entity' },        // orange
    task:          { color: '#6a1b9a', size: 5,  label: 'Task' },          // deep purple
    task_category: { color: '#4a148c', size: 9,  label: 'Task category' },
    model:         { color: '#00695c', size: 4,  label: 'Model' },         // teal
    dataset:       { color: '#004d40', size: 4,  label: 'Dataset' },
    modality:      { color: '#455a64', size: 7,  label: 'Modality' },
    format:        { color: '#37474f', size: 7,  label: 'Format' },
    _default:      { color: '#616161', size: 4,  label: 'Node' },
  };

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
    edgeLabelZoom: 180,
    handlers: {},
  };

  // ============================================================================
  //  Initialization
  // ============================================================================

  async function init(opts) {
    const { stage, breadcrumb, hudStatus, edgeLabelZoom, edgeLabelZoomVal, showAll } = opts;
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
      .nodeColor(n => (ENTITY_STYLES[n.type] || ENTITY_STYLES._default).color)
      .nodeVal(n => (ENTITY_STYLES[n.type] || ENTITY_STYLES._default).size)
      .nodeOpacity(0.95)
      .nodeThreeObjectExtend(true)
      .nodeThreeObject(buildNodeLabel)
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
      .cooldownTicks(80)
      .warmupTicks(40);

    renderInitialOverview();
    drawBreadcrumb(breadcrumb);
    setStatus(hudStatus, formatStatus());

    if (edgeLabelZoom) {
      S.edgeLabelZoom = Number(edgeLabelZoom.value) || 180;
      if (edgeLabelZoomVal) edgeLabelZoomVal.textContent = String(S.edgeLabelZoom);
      edgeLabelZoom.addEventListener('input', () => {
        S.edgeLabelZoom = Number(edgeLabelZoom.value);
        if (edgeLabelZoomVal) edgeLabelZoomVal.textContent = String(S.edgeLabelZoom);
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
    S.handlers = { breadcrumb, hudStatus };

    const ro = new ResizeObserver(() => {
      if (!S.fg) return;
      const r = stage.getBoundingClientRect();
      S.fg.width(r.width).height(r.height);
    });
    ro.observe(stage);
  }

  // ============================================================================
  //  Node & edge label sprites
  // ============================================================================

  function buildNodeLabel(node) {
    const style = ENTITY_STYLES[node.type] || ENTITY_STYLES._default;
    const text = (node.label || node.id).slice(0, 60);
    const sprite = new window.SpriteText(text);
    sprite.color = '#1a202c';                // near-black, readable on white
    sprite.backgroundColor = 'rgba(255, 255, 255, 0.82)';
    sprite.borderColor = style.color;
    sprite.borderWidth = 0.6;
    sprite.borderRadius = 2;
    sprite.padding = [2, 1];
    sprite.textHeight = NODE_LABEL_HEIGHT;
    // Offset the label so it sits *above* the node sphere rather than
    // through its center.
    sprite.position.y = style.size + NODE_LABEL_HEIGHT * 0.8;
    return sprite;
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
    sprite.visible = false;                  // toggled per-frame from camera distance
    return sprite;
  }

  // Called by 3d-force-graph for every link every frame — keeps the label
  // sprite at the edge midpoint and gates visibility by camera distance +
  // by whether the edge touches the focused subgraph.
  function positionEdgeLabel(sprite, { start, end }) {
    if (!sprite) return;
    const mid = {
      x: (start.x + end.x) / 2,
      y: (start.y + end.y) / 2,
      z: ((start.z || 0) + (end.z || 0)) / 2,
    };
    sprite.position.set(mid.x, mid.y, mid.z);

    // Camera distance gate (the zoom slider in the HUD)
    const cam = S.fg && S.fg.camera && S.fg.camera();
    if (!cam) { sprite.visible = false; return; }
    const dx = cam.position.x - mid.x;
    const dy = cam.position.y - mid.y;
    const dz = cam.position.z - mid.z;
    const distance = Math.sqrt(dx*dx + dy*dy + dz*dz);
    sprite.visible = distance < S.edgeLabelZoom;
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
  }

  // ============================================================================
  //  Degree-of-interest navigation
  // ============================================================================

  function onNodeClick(node) {
    if (!node) return;
    if (S.focusStack[S.focusStack.length - 1] !== node.id) S.focusStack.push(node.id);
    expandFocus(node.id);
    animateCameraTo(node);
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

  function animateCameraTo(node) {
    if (node.x == null || node.y == null || node.z == null) return;
    const dist = 140;
    const ratio = 1 + dist / Math.hypot(node.x, node.y, node.z || 1);
    S.fg.cameraPosition(
      { x: node.x * ratio, y: node.y * ratio, z: (node.z || 0) * ratio },
      node,
      900,
    );
  }

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
