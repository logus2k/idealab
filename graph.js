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
      .linkVisibility(linkVisible)                   // hide edges touching hidden types
      .linkOpacity(0.75)
      .linkWidth(l => (l.relation ? 1.4 : 0.6))
      .linkThreeObjectExtend(true)
      .linkThreeObject(buildEdgeLabel)
      .linkPositionUpdate(positionEdgeLabel)
      .linkLabel(linkTooltipHtml)
      .nodeLabel(nodeTooltipHtml)
      .onNodeClick(onNodeClick)
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

  function onNodeClick(node) {
    if (!node) return;
    if (S.focusStack[S.focusStack.length - 1] !== node.id) S.focusStack.push(node.id);
    expandFocus(node.id);                  // scheduleFit() runs inside applyVisible()
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
  function applyTypeVisibility() {
    if (!S.fg) return;
    const data = S.fg.graphData();
    // Node shapes: fade opacity of the mesh; the label sprite is handled
    // separately by applyNodeLabelVisibility (hidden outright, not faded).
    for (const n of data.nodes) {
      const obj = n.__threeObj;
      if (!obj) continue;
      const labelSprite = S.nodeSpritesByNode.get(n);
      const op = S.hiddenTypes.has(n.type) ? HIDDEN_OPACITY : VISIBLE_OPACITY;
      obj.traverse(child => {
        if (child === labelSprite) return;          // label visibility handled below
        if (!child.material) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of mats) {
          m.transparent = true;
          m.opacity = op;
        }
      });
    }
    applyNodeLabelVisibility();                     // hides labels of faded types
    applyEdgeLabelVisibility();                     // hides verbs of faded edges
    // Tell the lib to re-evaluate the per-link visibility predicate so
    // edges touching faded nodes disappear entirely (not just fade).
    S.fg.linkVisibility(linkVisible);
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

  window.idealabGraph = { init };
})();
