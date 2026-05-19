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
  // `isCategory` adds a contrasting gold halo around the mesh so the higher-
  // level "category" nodes are visually distinct from their non-category
  // counterparts (which otherwise share the same shape and a similar color).
  const HALO_COLOR = 0xffc107;
  const ENTITY_STYLES = {
    idea:          { color: '#2e7d32', size: 6,  shape: 'sphere',      label: 'Idea' },
    plan:          { color: '#7b1fa2', size: 8,  shape: 'cone',        label: 'Plan' },
    requirement:   { color: '#c2185b', size: 5,  shape: 'octahedron',  label: 'Requirement' },
    kpi:           { color: '#1565c0', size: 5,  shape: 'cylinder',    label: 'KPI' },
    kpi_category:  { color: '#0d47a1', size: 9,  shape: 'cylinder',    label: 'KPI category', isCategory: true },
    entity:        { color: '#ef6c00', size: 5,  shape: 'box',         label: 'Entity' },
    task:          { color: '#6a1b9a', size: 5,  shape: 'tetrahedron', label: 'Task' },
    task_category: { color: '#4a148c', size: 9,  shape: 'tetrahedron', label: 'Task category', isCategory: true },
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
  function buildHaloGeometry(size) {
    const key = 'halo:' + size;
    if (GEOMETRY_CACHE.has(key)) return GEOMETRY_CACHE.get(key);
    const T = window.THREE;
    const g = new T.TorusGeometry(size * 1.35, size * 0.09, 8, 28);
    GEOMETRY_CACHE.set(key, g);
    return g;
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
  const NODE_LABEL_HEIGHT = 3;
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
    showNodeLabels: true,            // default: persistent text labels above each node
    showEdgeLabels: false,           // default: hover-only tooltips, no on-canvas labels
    nodeSpritesByNode: new WeakMap(),
    edgeSpritesByLink: new WeakMap(),
    // Per-entity-type visibility toggle, controlled from the legend.
    // A type in this Set is "hidden" → its nodes (and their edges) render
    // at very low opacity so the topology stays visible but the type
    // visually steps back. Clicking the legend row toggles membership.
    hiddenTypes: new Set(),
    // Pinned nodes — kept visible across navigations. Right-click a node to
    // toggle. Persisted to localStorage so it survives reload.
    pinnedIds: new Set(),
    focusHaloMesh: null,
    suppressHashSync: false,         // re-entrance guard during hashchange restore
    inspectedId: null,               // single-click target (details panel only, no navigation)
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
      .nodeVisibility(nodeVisible)                   // hide nodes of toggled-off types (pinned always visible)
      .linkColor(linkColor)
      .linkVisibility(linkVisible)                   // hide edges touching hidden types
      .linkOpacity(0.75)
      .linkWidth(l => (l.relation ? 1.4 : 0.6))
      .linkThreeObjectExtend(true)
      .linkThreeObject(buildEdgeLabel)
      .linkPositionUpdate(positionEdgeLabel)
      .linkLabel(linkTooltipHtml)
      .nodeLabel(nodeTooltipHtml)
      .onNodeClick(onNodeClick)
      .onNodeRightClick(onNodeRightClick)            // right-click → pin toggle
      .onEngineStop(onEngineStop)
      .cooldownTicks(80)
      .warmupTicks(40);

    // Radial confinement — pulls every non-pinned node toward origin with
    // strength proportional to its distance. Without this, d3-force's
    // default `charge` + `center` combo leaves isolated nodes (zero edges,
    // or one weak edge) drifting far outside the main cluster: charge
    // repels them, the default center force only translates the whole
    // layout (it doesn't spring individual nodes inward), so equilibrium
    // ends up with peripheral nodes far from center. A weak radial pull
    // keeps the bounding box bounded without distorting the topology.
    if (S.fg.d3Force) {
      S.fg.d3Force('radial-confine', makeRadialConfineForce(0.06));
    }

    loadPersistedPins();
    renderInitialOverview();
    // Try to restore the focus stack from the URL hash; if it matches a
    // valid path, that overrides the default overview.
    queueMicrotask(() => {
      if (!restoreFromUrlHash()) {
        drawBreadcrumb(breadcrumb);
        setStatus(hudStatus, formatStatus());
      }
    });
    // Back / forward button → re-parse the hash and re-render.
    window.addEventListener('hashchange', () => {
      restoreFromUrlHash();
    });

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

    if (opts.showNodeLabels) {
      const cb = opts.showNodeLabels;
      S.showNodeLabels = !!cb.checked;
      cb.addEventListener('change', () => {
        S.showNodeLabels = !!cb.checked;
        applyNodeLabelVisibility();
      });
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

    // Make the legend + recommendations panels draggable around the canvas.
    // The legend has its own header (.graph-legend-head) which is the drag
    // handle. The recs panel uses its head (.graph-recs-head) the same way.
    if (legendBox) makePanelDraggable(legendBox, '.graph-legend-head', 'idealab.graph.legendPos');
    const recsBox = document.getElementById('graphRecs');
    if (recsBox)   makePanelDraggable(recsBox,   '.graph-recs-head',   'idealab.graph.recsPos');

    // Any user interaction on the canvas cancels a pending auto-fit so we
    // don't yank the camera mid-gesture.
    stage.addEventListener('mousedown', cancelPendingFit, { passive: true });
    stage.addEventListener('wheel',     cancelPendingFit, { passive: true });
    stage.addEventListener('touchstart', cancelPendingFit, { passive: true });

    // Press-and-hold to push the force simulation away from its current rest.
    //   Left button  → REPEL (-charge ×10, nodes spread apart)
    //   Right button → ATTRACT (+charge, nodes pull together)
    // Release restores normal physics. A 250 ms threshold separates a hold
    // from a regular click (which still navigates).
    stage.addEventListener('mousedown',   onStageMouseDown);
    stage.addEventListener('mousemove',   onStageMouseMove, { passive: true });
    stage.addEventListener('mouseup',     stopChargeBoost);
    stage.addEventListener('mouseleave',  stopChargeBoost);
    stage.addEventListener('contextmenu', e => e.preventDefault());

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
  // where there's no engine restart to wait for). rAF-debounced so we
  // fit ONE frame after the last resize event — no timer needed.
  let _resizeRafId = null;
  function fitOnceSoon() {
    S.fitPending = true;
    if (_resizeRafId !== null) cancelAnimationFrame(_resizeRafId);
    _resizeRafId = requestAnimationFrame(() => {
      _resizeRafId = null;
      if (S.fitPending) {
        S.fitPending = false;
        S.fg && S.fg.zoomToFit(500, 60);
      }
    });
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

    // Category nodes get a horizontal gold halo (a flattened torus) so they
    // pop visually against their non-category siblings of the same shape.
    if (style.isCategory) {
      const halo = new T.Mesh(
        buildHaloGeometry(style.size),
        new T.MeshBasicMaterial({ color: HALO_COLOR, transparent: true, opacity: 0.95 }),
      );
      halo.rotation.x = Math.PI / 2;     // lay the ring flat
      group.add(halo);
    }

    const sprite = new window.SpriteText((node.label || node.id).slice(0, 60));
    sprite.color = '#1a202c';
    sprite.backgroundColor = 'rgba(255, 255, 255, 0.82)';
    sprite.borderColor = style.color;
    sprite.borderWidth = 0.3;
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
    sprite.visible = nodeLabelShouldShow(node);
    bindLabelScaleCap(sprite, LABEL_MAX_DIST_NODE);
    S.nodeSpritesByNode.set(node, sprite);
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
    sprite.visible = edgeLabelShouldShow(link);
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

  // -------- Recommendations panel (T5.3) --------
  // For the currently-focused node, surface the top-K most-related nodes
  // grouped by adjacent entity type — "Top ideas that move this KPI", etc.
  // "Most related" = highest edge weight or first-encountered; we sort by
  // a simple score: 1 per structural edge, +confidence for semantically
  // refined edges so curated relations rank above generic ones.
  const RECS_PER_TYPE = 3;
  const RECS_SUGGEST_TYPES = {
    // For each focus type, the adjacent types we want to surface (in display order).
    idea:          ['kpi', 'requirement', 'entity', 'plan', 'idea'],
    plan:          ['idea', 'kpi', 'requirement', 'model'],
    requirement:   ['idea', 'plan'],
    kpi:           ['idea', 'plan'],
    kpi_category:  ['kpi'],
    entity:        ['idea', 'model', 'dataset', 'task'],
    task:          ['idea', 'model', 'dataset', 'entity'],
    task_category: ['task'],
    model:         ['idea', 'plan', 'task', 'entity', 'dataset'],
    dataset:       ['idea', 'plan', 'task', 'entity', 'model'],
    modality:      ['dataset'],
    format:        ['dataset'],
  };

  function updateRecommendations(inspectedId) {
    const el = document.getElementById('graphRecs');
    if (!el) return;
    // Prefer the explicitly-inspected node (set by a single click);
    // otherwise show recs for the current focus.
    const focusId = inspectedId || S.inspectedId || S.focusStack[S.focusStack.length - 1];
    if (!focusId) { el.hidden = true; el.innerHTML = ''; return; }
    const focus = S.nodeById.get(focusId);
    if (!focus) { el.hidden = true; return; }

    const adjacency = S.adjacency.get(focusId) || new Set();
    if (adjacency.size === 0) { el.hidden = true; return; }

    // Group adjacent nodes by type, score each.
    const buckets = new Map();
    for (const nid of adjacency) {
      const n = S.nodeById.get(nid);
      if (!n) continue;
      // Skip hidden types — recs shouldn't suggest things the user has toggled off.
      if (S.hiddenTypes.has(n.type)) continue;
      const edge = S.edgesByPair.get(focusId + '→' + nid) || S.edgesByPair.get(nid + '→' + focusId);
      let score = 1;
      if (edge) {
        if (edge.weight)     score += Number(edge.weight) * 0.2;
        if (edge.confidence) score += Number(edge.confidence);
      }
      if (!buckets.has(n.type)) buckets.set(n.type, []);
      buckets.get(n.type).push({ node: n, score, edge });
    }
    const wantedTypes = RECS_SUGGEST_TYPES[focus.type] || [...buckets.keys()];
    const sections = [];
    for (const t of wantedTypes) {
      const items = buckets.get(t);
      if (!items || !items.length) continue;
      items.sort((a, b) => b.score - a.score);
      const top = items.slice(0, RECS_PER_TYPE);
      const style = ENTITY_STYLES[t] || ENTITY_STYLES._default;
      const rows = top.map(({ node, edge }) => {
        const label = escapeHtml(node.label || node.id);
        const verb  = edge && (edge.relation || (edge.label && edge.label !== 'related to' ? edge.label : ''));
        const verbTag = verb ? `<span class="graph-recs-verb">${escapeHtml(verb)}</span>` : '';
        return `<div class="graph-recs-item" data-id="${escapeHtml(node.id)}" role="button" tabindex="0">${verbTag}${label}</div>`;
      }).join('');
      sections.push(
        `<div class="graph-recs-section">` +
          `<div class="graph-recs-section-head" style="color:${style.color}">${escapeHtml(suggestionVerbFor(focus.type, t, style))}</div>` +
          `<div class="graph-recs-section-body">${rows}</div>` +
        `</div>`
      );
    }
    if (!sections.length) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML =
      `<div class="graph-recs-head">` +
        `<span class="graph-recs-title">Related</span>` +
        `<span class="graph-recs-focus">${escapeHtml(focus.label || focus.id)}</span>` +
      `</div>` +
      `<div class="graph-recs-body">${sections.join('')}</div>`;
    // Wire clicks to navigate to that node.
    el.querySelectorAll('.graph-recs-item').forEach(row => {
      const go = () => {
        const node = S.nodeById.get(row.dataset.id);
        if (node) onNodeClick(node);
      };
      row.addEventListener('click', go);
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
    });
  }
  // Cute headers — same verb the breadcrumb might use, but phrased as a
  // "Top X..." section header.
  const REC_HEADERS = {
    'idea→kpi':           'Moves these KPIs',
    'idea→requirement':   'Addresses these pains',
    'idea→entity':        'Cited at',
    'idea→plan':          'Featured in plans',
    'idea→idea':          'Similar / complementary ideas',
    'idea→model':         'Implemented with',
    'idea→dataset':       'Trains on',
    'idea→task':          'Uses tasks',
    'plan→idea':          'Includes ideas',
    'plan→kpi':           'Moves these KPIs',
    'plan→requirement':   'Addresses these pains',
    'plan→model':         'Recommends models',
    'plan→dataset':       'Recommends datasets',
    'requirement→idea':   'Ideas that address this',
    'requirement→plan':   'Plans that address this',
    'kpi→idea':           'Ideas that move this',
    'kpi→plan':           'Plans that move this',
    'kpi→kpi_category':   'In category',
    'kpi_category→kpi':   'KPIs in this category',
    'entity→idea':        'Ideas cited at',
    'entity→model':       'Models published',
    'entity→dataset':     'Datasets published',
    'entity→task':        'Active in tasks',
    'task→idea':          'Ideas that use this task',
    'task→model':         'Top models',
    'task→dataset':       'Top datasets',
    'task→entity':        'Top publishers',
    'task→task_category': 'In category',
    'task_category→task': 'Tasks in this category',
    'model→idea':         'Ideas that use this model',
    'model→plan':         'Plans that recommend this',
    'model→task':         'Performs',
    'model→entity':       'Published by',
    'model→dataset':      'Trained on',
    'dataset→idea':       'Ideas that train on this',
    'dataset→plan':       'Plans that recommend this',
    'dataset→task':       'Supports',
    'dataset→entity':     'Published by',
    'dataset→modality':   'Modality',
    'dataset→format':     'Format',
    'modality→dataset':   'Datasets with this modality',
    'format→dataset':     'Datasets in this format',
  };
  function suggestionVerbFor(srcType, dstType, dstStyle) {
    return REC_HEADERS[`${srcType}→${dstType}`] || `Top ${dstStyle.label.toLowerCase()}s`;
  }

  // -------- Focus halo (T4.5b) --------
  // Highlights the current focus node with a billboarded gold ring. The
  // mesh is parented to the focus node's __threeObj so it follows the
  // node automatically as the simulation ticks.
  function updateFocusHalo() {
    if (!S.fg || !window.THREE) return;
    // Detach from previous parent (if any) — focus changed.
    if (S.focusHaloMesh && S.focusHaloMesh.parent) {
      S.focusHaloMesh.parent.remove(S.focusHaloMesh);
    }
    const focusId = S.focusStack[S.focusStack.length - 1];
    if (!focusId) return;
    const node = S.nodeById.get(focusId);
    if (!node || !node.__threeObj) return;
    if (!S.focusHaloMesh) {
      const T = window.THREE;
      const geom = new T.RingGeometry(10, 12.5, 36);
      const mat  = new T.MeshBasicMaterial({
        color: 0xff5722, transparent: true, opacity: 0.85, side: T.DoubleSide,
      });
      mat.depthTest = false;
      mat.depthWrite = false;
      S.focusHaloMesh = new T.Mesh(geom, mat);
      S.focusHaloMesh.renderOrder = 200;
      // Billboard: rotate to face camera each frame.
      S.focusHaloMesh.onBeforeRender = function (renderer, scene, camera) {
        this.lookAt(camera.position);
      };
    }
    node.__threeObj.add(S.focusHaloMesh);
  }

  // -------- URL hash deeplinking (T4.6b) --------
  // The hash mirrors the focus stack as `#/<type>:<slug>/<type>:<slug>/...`.
  // Shareable; restored on page load + on `hashchange` (back/forward button).
  function syncUrlHash() {
    if (S.suppressHashSync) return;
    const path = S.focusStack.map(id => {
      const node = S.nodeById.get(id);
      if (!node) return '';
      const inner = (id.split(':', 2)[1] || '');
      const slug = node.slug || inner;
      return `${node.type}:${slug}`;
    }).filter(Boolean);
    const newHash = path.length ? `#/${path.join('/')}` : '';
    if (window.location.hash !== newHash) {
      // replaceState: don't pollute browser history on every node click.
      // (Use pushState if you want back-button = step-back through the stack.)
      try { history.replaceState(null, '', newHash || ' '); } catch { /* ignore */ }
    }
  }
  function restoreFromUrlHash() {
    const h = window.location.hash.replace(/^#\/?/, '');
    if (!h) return false;
    const want = h.split('/').filter(Boolean);
    const newStack = [];
    // Build a quick lookup: (type, slug) → node.id. Slug fallback to the
    // raw inner ID so HF model/dataset IDs (which don't have a `slug`
    // field) round-trip through the hash too.
    const ix = new Map();
    for (const n of S.raw.nodes) {
      const inner = n.id.split(':', 2)[1] || '';
      ix.set(`${n.type}:${n.slug || inner}`, n.id);
    }
    for (const seg of want) {
      const id = ix.get(seg);
      if (id) newStack.push(id);
    }
    if (!newStack.length) return false;
    S.suppressHashSync = true;
    S.focusStack = newStack;
    expandFocus(newStack[newStack.length - 1]);
    drawBreadcrumb(S.handlers.breadcrumb);
    setStatus(S.handlers.hudStatus, formatStatus());
    updateFocusHalo();
    S.suppressHashSync = false;
    return true;
  }

  function nodeLabelShouldShow(n) {
    return S.showNodeLabels && !S.hiddenTypes.has(n.type);
  }
  function edgeLabelShouldShow(l) {
    return S.showEdgeLabels && !isEdgeHidden(l);
  }

  function applyEdgeLabelVisibility() {
    if (!S.fg) return;
    const { links } = S.fg.graphData();
    for (const l of links) {
      const sprite = S.edgeSpritesByLink.get(l);
      if (sprite) sprite.visible = edgeLabelShouldShow(l);
    }
  }

  function applyNodeLabelVisibility() {
    if (!S.fg) return;
    const { nodes } = S.fg.graphData();
    for (const n of nodes) {
      const sprite = S.nodeSpritesByNode.get(n);
      if (sprite) sprite.visible = nodeLabelShouldShow(n);
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

  // Render a "scoped" view seeded by IDs the host app derived from its
  // current filter state. We expand each seed to its 1-hop neighborhood
  // so the user sees not only the matching items but also what they
  // connect to. Empty seed set falls back to the generic overview.
  function renderScopedView(seedIds) {
    if (!seedIds || seedIds.size === 0) {
      renderInitialOverview();
      return;
    }
    const keepIds = new Set(seedIds);
    for (const id of seedIds) {
      const neighbors = S.adjacency.get(id);
      if (!neighbors) continue;
      for (const nid of neighbors) keepIds.add(nid);
    }
    for (const id of S.pinnedIds) keepIds.add(id);
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
    // A new visible set means a fresh layout — clear any leftover pins
    // from a prior press-and-hold so the simulation can place new nodes.
    for (const n of visibleNodes) {
      n.fx = undefined; n.fy = undefined; n.fz = undefined;
    }
    S.fg.graphData({ nodes: visibleNodes, links: visibleEdges });
    // Authorize ONE upcoming fit when the simulation settles. Any user
    // interaction (mouse / wheel / drag) before then cancels it so we never
    // yank the camera while they're interacting.
    S.fitPending = true;
    // Result count in the topbar, e.g. "98 of 2671 nodes"
    updateResultCount();
    // 3d-force-graph builds each node's __threeObj asynchronously; wait one
    // microtask before applying type-visibility opacity so the new objects
    // exist by the time we walk them.
    if (S.hiddenTypes.size) queueMicrotask(applyTypeVisibility);
  }

  // Fires once each time the simulation cools below the cooldown threshold.
  // Use it as the natural moment to frame the visible set — if the user is
  // already interacting, fitPending is false and we skip.
  // zoomToFit also moves controls.target to the bbox centroid, which is
  // (by construction of "focus + 1-hop") very close to the focused node.
  // We deliberately don't snap target onto the focus node afterward,
  // because controls.update() then re-orients the camera and the user
  // sees a small visible "jump" at the end of the tween.
  function onEngineStop() {
    if (!S.fitPending) return;
    S.fitPending = false;
    if (!S.fg) return;
    const { nodes } = S.fg.graphData();
    if (!nodes.length) return;
    S.fg.zoomToFit(600, 60);
  }

  function cancelPendingFit() {
    S.fitPending = false;
  }

  // ----- press-and-hold charge boost (repel / attract) -----
  // The gesture must be a STATIONARY press; if the mouse moves more than a
  // few pixels before the threshold fires, it's a drag (rotate/pan) and we
  // bail. Without this guard, the simulation reheats while the user is
  // mid-drag → visible flicker as nodes try to redistribute under the cursor.
  const HOLD_THRESHOLD_MS = 250;
  const HOLD_MAX_MOVE_PX = 5;
  let _holdTimer = null;
  let _holdStartX = 0;
  let _holdStartY = 0;
  let _activeChargeMode = null;        // 'repel' | 'attract' | null
  let _chargeBaseline = null;          // captured the first time we boost

  function onStageMouseDown(e) {
    if (e.button !== 0 && e.button !== 2) return;
    if (e.button === 2) e.preventDefault();
    if (_holdTimer) clearTimeout(_holdTimer);
    _holdStartX = e.clientX;
    _holdStartY = e.clientY;
    const mode = e.button === 0 ? 'repel' : 'attract';
    _holdTimer = setTimeout(() => {
      _holdTimer = null;
      activateChargeBoost(mode);
    }, HOLD_THRESHOLD_MS);
  }

  function onStageMouseMove(e) {
    if (!_holdTimer) return;
    const dx = e.clientX - _holdStartX;
    const dy = e.clientY - _holdStartY;
    if (dx * dx + dy * dy > HOLD_MAX_MOVE_PX * HOLD_MAX_MOVE_PX) {
      // Movement → user is dragging (rotate/pan/node-drag), not pressing.
      clearTimeout(_holdTimer);
      _holdTimer = null;
    }
  }

  function stopChargeBoost() {
    if (_holdTimer) { clearTimeout(_holdTimer); _holdTimer = null; }
    if (_activeChargeMode) deactivateChargeBoost();
  }

  // The boost manually animates `fx/fy/fz` each frame — d3-force is NOT
  // involved. This sidesteps the "collapse to baseline equilibrium first,
  // then expand" problem you'd get if we just changed the charge force,
  // because d3 would briefly run with high alpha and pull nodes toward
  // its rest state before the new force was strong enough to push them
  // back out. Hand-rolling the animation means the gesture starts from
  // EXACTLY the user's current pose with zero immediate movement.
  //
  // Each frame, each node is displaced along the ray from the visible
  // graph's centroid:
  //   repel  → outward from centroid (+ direction)
  //   attract → inward toward centroid (− direction)
  // Speed ramps from 0 at gesture start to MAX_SPEED at BOOST_RAMP_MS.
  const BOOST_RAMP_MS       = 3000;
  const REPEL_MAX_SPEED     = 2.0;       // world units per frame at full ramp
  const ATTRACT_MAX_SPEED   = 1.5;
  const ATTRACT_MIN_DIST    = 12;        // don't pull nodes closer than this to centroid
  let _boostStartTs = 0;
  let _boostRafId   = null;

  function activateChargeBoost(mode) {
    if (!S.fg) return;
    _activeChargeMode = mode;
    // Pin every node at its CURRENT position so the simulation can't perturb
    // them while we hand-animate. Idempotent if already pinned from a prior
    // boost release.
    pinAllNodesAtCurrentPosition();
    // Auto-fit shouldn't fight the user's gesture.
    cancelPendingFit();
    _boostStartTs = performance.now();
    if (_boostRafId !== null) cancelAnimationFrame(_boostRafId);
    _boostRafId = requestAnimationFrame(rampStep);
  }

  function rampStep() {
    if (!_activeChargeMode || !S.fg) { _boostRafId = null; return; }
    const data = S.fg.graphData();
    if (!data.nodes.length) { _boostRafId = requestAnimationFrame(rampStep); return; }

    const t = Math.min(1, (performance.now() - _boostStartTs) / BOOST_RAMP_MS);
    const maxSpeed = _activeChargeMode === 'repel' ? REPEL_MAX_SPEED : ATTRACT_MAX_SPEED;
    const speed = maxSpeed * t;          // linear ramp 0 → maxSpeed
    const sign  = _activeChargeMode === 'repel' ? +1 : -1;

    // Centroid of currently-rendered nodes (the gesture's anchor point).
    let cx = 0, cy = 0, cz = 0;
    for (const n of data.nodes) {
      cx += n.x || 0; cy += n.y || 0; cz += n.z || 0;
    }
    cx /= data.nodes.length; cy /= data.nodes.length; cz /= data.nodes.length;

    for (const n of data.nodes) {
      const dx = (n.x || 0) - cx;
      const dy = (n.y || 0) - cy;
      const dz = (n.z || 0) - cz;
      const norm = Math.sqrt(dx*dx + dy*dy + dz*dz);
      // For attract, stop pulling when the node is already close to the
      // centroid so nodes don't all collapse onto a single point.
      if (sign < 0 && norm <= ATTRACT_MIN_DIST) continue;
      // Nodes exactly at the centroid have no defined direction — skip them
      // (they'll be carried along by their neighbors moving outward).
      if (norm < 0.001) continue;
      const ux = dx / norm, uy = dy / norm, uz = dz / norm;
      // Update both the pin AND the rendered position so the change is
      // immediately visible without waiting for the next d3 tick.
      const fx = (n.fx == null ? n.x : n.fx) + ux * sign * speed;
      const fy = (n.fy == null ? n.y : n.fy) + uy * sign * speed;
      const fz = (n.fz == null ? n.z : n.fz) + uz * sign * speed;
      n.fx = fx; n.fy = fy; n.fz = fz;
      n.x  = fx; n.y  = fy; n.z  = fz;
    }
    _boostRafId = requestAnimationFrame(rampStep);
  }

  function deactivateChargeBoost() {
    _activeChargeMode = null;
    if (_boostRafId !== null) { cancelAnimationFrame(_boostRafId); _boostRafId = null; }
    // Nodes are already pinned at their final positions — nothing else to do.
    // We deliberately do NOT touch d3-force (no charge change, no alpha
    // reheat) so the user's hand-animated layout persists as-is.
  }

  // d3-force compatible custom force — a spring pulling each non-pinned
  // node toward (0,0,0) with magnitude ∝ distance × strength × alpha.
  // Returned function follows the d3-force `force(alpha)` / `initialize(nodes)`
  // contract so the layout includes it on every tick.
  function makeRadialConfineForce(strength) {
    let nodes = [];
    function force(alpha) {
      const k = strength * alpha;
      for (const n of nodes) {
        if (n.fx != null) continue;          // pinned — d3 will ignore vx anyway
        n.vx = (n.vx || 0) - (n.x || 0) * k;
        n.vy = (n.vy || 0) - (n.y || 0) * k;
        n.vz = (n.vz || 0) - (n.z || 0) * k;
      }
    }
    force.initialize = (ns) => { nodes = ns; };
    return force;
  }

  function unpinAllNodes() {
    if (!S.fg) return;
    const data = S.fg.graphData();
    for (const n of data.nodes) {
      n.fx = undefined;
      n.fy = undefined;
      n.fz = undefined;
    }
  }
  function pinAllNodesAtCurrentPosition() {
    if (!S.fg) return;
    const data = S.fg.graphData();
    for (const n of data.nodes) {
      if (n.x != null) n.fx = n.x;
      if (n.y != null) n.fy = n.y;
      if (n.z != null) n.fz = n.z;
    }
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

  // Click semantics:
  //   single click  → show the bottom-right details panel for that node
  //                   (no focus push, no DOI expand)
  //   double click  → navigate (push focus stack, expand 1-hop, refit camera)
  // We distinguish single vs double using a small dwell timer; 350 ms is
  // long enough to feel forgiving without making singles feel laggy.
  const DOUBLE_CLICK_MS = 350;
  let _pendingClick = null;   // { id, timer } — pending single-click

  function onNodeClick(node) {
    if (!node) return;
    if (_pendingClick && _pendingClick.id === node.id) {
      // Second click of a double — cancel the pending single, navigate instead.
      clearTimeout(_pendingClick.timer);
      _pendingClick = null;
      navigateToNode(node);
      return;
    }
    // First click — start a dwell timer; if no second click lands in time,
    // treat as single and show details only.
    if (_pendingClick) clearTimeout(_pendingClick.timer);
    _pendingClick = {
      id: node.id,
      timer: setTimeout(() => {
        _pendingClick = null;
        inspectNode(node);
      }, DOUBLE_CLICK_MS),
    };
  }

  function inspectNode(node) {
    S.inspectedId = node.id;
    updateRecommendations(node.id);
  }

  function navigateToNode(node) {
    S.inspectedId = null;
    if (S.focusStack[S.focusStack.length - 1] !== node.id) S.focusStack.push(node.id);
    expandFocus(node.id);
    drawBreadcrumb(S.handlers.breadcrumb);
    setStatus(S.handlers.hudStatus, formatStatus());
    updateFocusHalo();
    updateRecommendations();
    syncUrlHash();
  }

  function onNodeRightClick(node) {
    if (!node) return;
    togglePin(node.id);
  }

  function togglePin(id) {
    if (S.pinnedIds.has(id)) S.pinnedIds.delete(id);
    else                     S.pinnedIds.add(id);
    persistPins();
    // The node might be currently hidden by type-toggle; re-apply visibility
    // so pinned nodes stay visible everywhere.
    applyTypeVisibility();
    // Make sure pinned nodes are in the visible set (added by expandFocus
    // & friends on subsequent navigations). For the current view we
    // re-emit graph data so newly-pinned nodes show even if they weren't
    // in the prior keep-set.
    if (S.focusStack.length > 0) {
      expandFocus(S.focusStack[S.focusStack.length - 1]);
    } else if (!S.showAll) {
      renderInitialOverview();
    }
  }

  // Generic drag-to-reposition for an absolutely-positioned panel inside the
  // graph container. Position is stored in localStorage under `storageKey`
  // and restored on next init so panels persist where the user put them.
  function makePanelDraggable(panel, handleSelector, storageKey) {
    // Apply any persisted position right away.
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        panel.style.left = saved.left + 'px';
        panel.style.top  = saved.top  + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      }
    } catch { /* ignore */ }

    // Attach the drag handler lazily — it must rebind every time the panel
    // re-renders (head innerHTML changes invalidate the listener).
    const onMouseDown = (e) => {
      const handle = e.target.closest(handleSelector);
      if (!handle) return;
      // The close × inside the head should not start a drag.
      if (e.target.closest('button')) return;
      e.preventDefault();
      const rect = panel.getBoundingClientRect();
      const parent = panel.offsetParent || panel.parentElement;
      const parentRect = parent.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      // Switch to left/top positioning so movement is straightforward.
      panel.style.left   = (rect.left - parentRect.left) + 'px';
      panel.style.top    = (rect.top  - parentRect.top)  + 'px';
      panel.style.right  = 'auto';
      panel.style.bottom = 'auto';
      panel.classList.add('is-dragging');

      const onMove = (ev) => {
        let nx = ev.clientX - parentRect.left - offsetX;
        let ny = ev.clientY - parentRect.top  - offsetY;
        // Keep at least a small bit of the panel on-screen.
        const w = panel.offsetWidth, h = panel.offsetHeight;
        nx = Math.max(-w + 32, Math.min(parentRect.width  - 32, nx));
        ny = Math.max(0,         Math.min(parentRect.height - 32, ny));
        panel.style.left = nx + 'px';
        panel.style.top  = ny + 'px';
      };
      const onUp = () => {
        panel.classList.remove('is-dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
        // Persist.
        try {
          localStorage.setItem(storageKey, JSON.stringify({
            left: parseFloat(panel.style.left) || 0,
            top:  parseFloat(panel.style.top)  || 0,
          }));
        } catch { /* ignore */ }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    };
    // Re-fire on panel — the head is a descendant.
    panel.addEventListener('mousedown', onMouseDown);
  }

  function persistPins() {
    try { localStorage.setItem('idealab.graph.pinned', JSON.stringify([...S.pinnedIds])); }
    catch { /* private-mode browsers etc. — ignore */ }
  }
  function loadPersistedPins() {
    try {
      const arr = JSON.parse(localStorage.getItem('idealab.graph.pinned') || '[]');
      if (Array.isArray(arr)) for (const id of arr) S.pinnedIds.add(id);
    } catch { /* ignore */ }
  }

  function expandFocus(focusId) {
    const keep = new Set([focusId]);
    const neighbors = S.adjacency.get(focusId) || new Set();
    for (const nid of neighbors) keep.add(nid);
    for (const id of S.focusStack) keep.add(id);
    for (const id of S.pinnedIds) keep.add(id);   // pinned nodes follow the user
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
        `<span class="graph-breadcrumb-crumb${isCurrent ? ' current' : ''}" data-step="${idx}">` +
          `<span class="graph-breadcrumb-type">${typeLabel(node.type)}</span>` +
          `<span class="graph-breadcrumb-label">${label}</span>` +
          `<button type="button" class="graph-breadcrumb-x" aria-label="Drop this focus" title="Drop this focus">×</button>` +
        `</span>`
      );
      if (!isCurrent) parts.push('<span class="graph-breadcrumb-sep">›</span>');
    });
    el.innerHTML = parts.join('');

    // Jump to a step (truncate at idx+1, focus becomes that crumb).
    el.querySelectorAll('.graph-breadcrumb-crumb').forEach(crumb => {
      crumb.addEventListener('click', e => {
        if (e.target.closest('.graph-breadcrumb-x')) return;  // × handled separately
        const step = Number(crumb.dataset.step);
        S.focusStack = S.focusStack.slice(0, step + 1);
        expandFocus(S.focusStack[S.focusStack.length - 1]);
        drawBreadcrumb(el);
        setStatus(S.handlers.hudStatus, formatStatus());
        updateFocusHalo();
        updateRecommendations();
        syncUrlHash();
      });
    });

    // × on a crumb → truncate at that crumb (drop it + everything after).
    // If it was the first crumb, the stack empties and we revert to overview.
    el.querySelectorAll('.graph-breadcrumb-x').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const crumb = btn.closest('.graph-breadcrumb-crumb');
        const step = Number(crumb.dataset.step);
        S.focusStack = S.focusStack.slice(0, step);   // remove this + after
        if (S.focusStack.length === 0) {
          S.showAll ? renderFullGraph() : renderInitialOverview();
        } else {
          expandFocus(S.focusStack[S.focusStack.length - 1]);
        }
        drawBreadcrumb(el);
        setStatus(S.handlers.hudStatus, formatStatus());
        updateFocusHalo();
        updateRecommendations();
        syncUrlHash();
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

  // True when either endpoint's type is currently toggled off in the legend.
  // Used by linkVisibility + edge-label visibility to hide edges that connect
  // to faded nodes.
  function isEdgeHidden(l) {
    if (!S.hiddenTypes.size) return false;
    const src = (typeof l.source === 'object') ? l.source : S.nodeById.get(l.source);
    const dst = (typeof l.target === 'object') ? l.target : S.nodeById.get(l.target);
    return (src && S.hiddenTypes.has(src.type)) ||
           (dst && S.hiddenTypes.has(dst.type));
  }
  function linkVisible(l) {
    return !isEdgeHidden(l);
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
  function shapeSvg(shape, color, isCategory) {
    const c = color;
    // Category rows get a gold ring around the shape to mirror the 3D halo.
    const halo = isCategory
      ? `<ellipse cx="0" cy="0" rx="11" ry="3" fill="none" stroke="#ffc107" stroke-width="1.6"/>`
      : '';
    let body;
    switch (shape) {
      case 'box':         body = `<rect x="-8" y="-8" width="16" height="16" rx="1" fill="${c}" stroke="rgba(0,0,0,0.25)"/>`; break;
      case 'cone':        body = `<polygon points="0,-10 9,8 -9,8" fill="${c}" stroke="rgba(0,0,0,0.25)"/>`; break;
      case 'cylinder':    body = `<ellipse cx="0" cy="-6" rx="9" ry="2.4" fill="${c}" stroke="rgba(0,0,0,0.25)"/><rect x="-9" y="-6" width="18" height="12" fill="${c}" stroke="rgba(0,0,0,0.25)"/><ellipse cx="0" cy="6" rx="9" ry="2.4" fill="${c}" stroke="rgba(0,0,0,0.25)"/>`; break;
      case 'octahedron':  body = `<polygon points="0,-10 10,0 0,10 -10,0" fill="${c}" stroke="rgba(0,0,0,0.25)"/>`; break;
      case 'tetrahedron': body = `<polygon points="0,-10 9,7 -9,7" fill="${c}" stroke="rgba(0,0,0,0.25)"/><line x1="0" y1="-10" x2="0" y2="7" stroke="rgba(0,0,0,0.25)"/>`; break;
      case 'torus':       body = `<circle cx="0" cy="0" r="9" fill="none" stroke="${c}" stroke-width="4"/>`; break;
      case 'sphere':
      default:            body = `<circle cx="0" cy="0" r="9" fill="${c}" stroke="rgba(0,0,0,0.25)"/>`; break;
    }
    return `<svg viewBox="-13 -13 26 26">${body}${halo}</svg>`;
  }

  function renderLegendInto(el) {
    // Only the entity types that can actually appear in the graph (skip _default).
    const rows = Object.entries(ENTITY_STYLES)
      .filter(([k]) => k !== '_default')
      .map(([type, style]) => {
        const off = S.hiddenTypes.has(type);
        const catCls = style.isCategory ? ' graph-legend-row--category' : '';
        return `<div class="graph-legend-row${off ? ' graph-legend-row--off' : ''}${catCls}" data-type="${type}" role="button" tabindex="0" title="Toggle ${escapeHtml(style.label)} visibility">` +
            `<span class="graph-legend-icon" style="color:${style.color}">${shapeSvg(style.shape, style.color, style.isCategory)}</span>` +
            `<span class="graph-legend-label">${escapeHtml(style.label)}</span>` +
          `</div>`;
      }).join('');
    el.innerHTML =
      `<div class="graph-legend-head">` +
        `<span class="graph-legend-title">Legend</span>` +
        `<button type="button" class="graph-legend-close" aria-label="Close legend" title="Close">×</button>` +
      `</div>` +
      `<div class="graph-legend-body">${rows}</div>`;
    // Click any row → toggle visibility of that entity type.
    el.querySelectorAll('.graph-legend-row').forEach(row => {
      row.addEventListener('click', () => toggleTypeVisibility(row.dataset.type));
      row.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleTypeVisibility(row.dataset.type);
        }
      });
    });
  }

  function toggleTypeVisibility(type) {
    if (S.hiddenTypes.has(type)) S.hiddenTypes.delete(type);
    else S.hiddenTypes.add(type);
    applyTypeVisibility();
    // Re-render the legend so the visual row state matches.
    const legend = document.getElementById('graphLegend');
    if (legend && !legend.hidden) renderLegendInto(legend);
  }

  // Fade node groups whose type is currently toggled off in the legend.
  // We touch material.opacity on every descendant of each node's Three.js
  // group; the simulation still receives those nodes so the layout is
  // unaffected — only the visual emphasis changes.
  const VISIBLE_OPACITY = 0.95;
  const HIDDEN_OPACITY  = 0.08;
  function nodeVisible(n) {
    // Pinned nodes stay visible regardless of type toggles.
    if (S.pinnedIds.has(n.id)) return true;
    return !S.hiddenTypes.has(n.type);
  }
  function applyTypeVisibility() {
    if (!S.fg) return;
    // The library re-evaluates each callback when re-set with a function
    // ref — this is how we trigger a fresh visibility pass after a legend
    // toggle without rebuilding any meshes.
    S.fg.nodeVisibility(nodeVisible);
    S.fg.linkVisibility(linkVisible);
    applyNodeLabelVisibility();
    applyEdgeLabelVisibility();
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
    return `Focused on ${S.focusStack.length} level(s). Use the breadcrumb to step back.`;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  // Public method to scope the graph to a host-app-derived seed set.
  // app.js calls this whenever the user enters the Graph tab so the
  // initial view reflects the current sidebar filters (sticky across
  // view changes since the recent setView refactor).
  function scopeTo(seedIds) {
    if (!S.fg) return;             // not initialized yet
    if (S.focusStack.length > 0) return;   // user is mid-navigation; don't yank
    renderScopedView(seedIds);
  }

  window.idealabGraph = { init, scopeTo };
})();
