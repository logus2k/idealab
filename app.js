(() => {
  'use strict';

  // ====================================================================
  //  Configuration
  // ====================================================================

  const FACETS = ['function', 'industry', 'tech', 'audience', 'value', 'maturity'];
  const FACET_LABELS = {
    function: 'Function',
    industry: 'Industry',
    tech: 'Technology',
    audience: 'Audience',
    value: 'Value driver',
    maturity: 'Maturity',
  };

  // Decisive facets for plan↔idea matching: industry/function carry weight,
  // value/tech contribute, audience/maturity are tie-breakers.
  const TAG_WEIGHTS = { industry: 3, function: 2, value: 2, tech: 2, audience: 1, maturity: 1 };
  const MIN_RELATED_SCORE = 4;

  const PLAN_TYPE_LABELS = {
    'consultancy-framework': 'Consultancy',
    'company-case-study': 'Case study',
    'industry-blueprint': 'Industry',
    'vendor-architecture': 'Vendor',
  };

  // Vocabulary facets sourced from the relational layer (data/links.json).
  // Each shows a per-facet search box because they can be large (149/109/61).
  const VOCAB_FACETS = ['requirement', 'kpi', 'entity'];
  const VOCAB_LABELS = {
    requirement: 'Requirement (pain point)',
    kpi: 'KPI moved',
    entity: 'Company / vendor',
  };
  // Closed taxonomies — must stay in sync with scripts/build_sqlite.py +
  // scripts/classify_requirements.py + data/kpis.json categories.
  // Display order is curated (not alphabetical) so the sidebar reads from
  // most-frequent / most-strategic at the top.
  const KPI_CATEGORY_ORDER = [
    'revenue-and-growth', 'operational-efficiency', 'customer-experience',
    'cost-and-margin', 'risk-and-compliance',
    'talent-and-productivity', 'quality-and-accuracy',
  ];
  const KPI_CATEGORY_LABELS = {
    'revenue-and-growth':      'Revenue & growth',
    'operational-efficiency':  'Operational efficiency',
    'customer-experience':     'Customer experience',
    'cost-and-margin':         'Cost & margin',
    'risk-and-compliance':     'Risk & compliance',
    'talent-and-productivity': 'Talent & productivity',
    'quality-and-accuracy':    'Quality & accuracy',
  };
  const REQUIREMENT_CATEGORY_ORDER = [
    'workflow-friction', 'coverage-gap', 'accuracy-and-quality',
    'decision-support', 'compliance-and-risk',
    'customer-experience-friction', 'scaling-and-throughput',
  ];
  const REQUIREMENT_CATEGORY_LABELS = {
    'workflow-friction':            'Workflow friction',
    'coverage-gap':                 'Coverage gap',
    'accuracy-and-quality':         'Accuracy & quality',
    'decision-support':             'Decision support',
    'compliance-and-risk':          'Compliance & risk',
    'customer-experience-friction': 'Customer-experience friction',
    'scaling-and-throughput':       'Scaling & throughput',
  };

  // ===== Models view ======================================================
  // Category labels + a stable display order for the task picker.
  const TASK_CATEGORY_LABELS = {
    'multimodal':                  'Multimodal',
    'computer-vision':             'Computer Vision',
    'natural-language-processing': 'Natural Language Processing',
    'audio':                       'Audio',
    'tabular':                     'Tabular',
    'reinforcement-learning':      'Reinforcement Learning',
    'other':                       'Other',
  };
  const TASK_CATEGORY_ORDER = Object.keys(TASK_CATEGORY_LABELS);

  // HF's per-task Tailwind colors → readable hex for our palette.
  const ICON_COLOR_MAP = {
    'orange-400':  '#fb923c',
    'blue-400':    '#60a5fa',
    'red-400':     '#f87171',
    'green-400':   '#4ade80',
    'indigo-400':  '#818cf8',
    'yellow-400':  '#facc15',
    'purple-400':  '#c084fc',
    'pink-400':    '#f472b6',
  };
  // Per-category default (used when a task lacks icon_color, and for category headings).
  const CATEGORY_COLOR = {
    'multimodal':                  '#fb923c',
    'computer-vision':             '#60a5fa',
    'natural-language-processing': '#f87171',
    'audio':                       '#4ade80',
    'tabular':                     '#818cf8',
    'reinforcement-learning':      '#c084fc',
    'other':                       '#facc15',
  };

  function hfUrl(kind, id) {
    return kind === 'datasets'
      ? `https://huggingface.co/datasets/${id}`
      : `https://huggingface.co/${id}`;
  }

  // ====================================================================
  //  State
  // ====================================================================

  const state = {
    view: 'ideas',                 // 'ideas' | 'plans' | 'requirements' | 'kpis' | 'models'
    db: null,                      // CatalogDb instance

    ideas: [],                     // array of normalized idea objects
    plans: [],                     // parsed from plans/*.md
    requirements: [],              // ordered array (alpha by label) for cards
    kpis: [],                      // ordered array (alpha by label) for cards
    requirementsByUuid: new Map(), // uuid → {uuid, slug, label, description}
    kpisByUuid: new Map(),
    entitiesByUuid: new Map(),

    // Pre-computed at load time so card rendering is O(1) per item.
    ideaCountByRequirementUuid: new Map(),
    ideaCountByKpiUuid: new Map(),

    filters: Object.fromEntries(FACETS.map(f => [f, new Set()])),     // tag facets
    vocabFilters: Object.fromEntries(VOCAB_FACETS.map(f => [f, new Set()])), // req/kpi/entity uuids
    kindFilter: 'all',             // 'all' | 'idea' | 'pattern'

    query: '',
    searchHits: null,              // Set<idea_uuid> from FTS5, or null
    collapsedFacets: new Set(),
    vocabFacetSearch: { requirement: '', kpi: '', entity: '' },

    // Models view
    tasks: [],                            // /data/tasks.json (eager)
    tasksByCategory: new Map(),           // category → [task]
    modelsSnapshot: null,                 // {date, items: [{item, sources}, …]} once fetched
    modelsLoading: false,
    selectedTaskSlugs: new Set(),         // task filter — OR within facet, like other filters
    collapsedTaskCategories: new Set(),   // category names currently collapsed in the sidebar
    // Per-facet sets of currently-collapsed category sections in the
    // vocab pickers. Defaults to "all open"; user toggles persist for the
    // life of the session (not localStorage — these are ephemeral).
    collapsedVocabCats: Object.fromEntries(VOCAB_FACETS.map(f => [f, new Set()])),
    modelsCountByTaskSlug: new Map(),     // task slug → # of models in snapshot

    // Datasets view (mirror of Models, two axes: task + modality)
    modalities: [],                       // /data/dataset_modalities.json (eager)
    datasetsSnapshot: null,
    datasetsLoading: false,
    selectedDatasetTaskSlugs: new Set(),
    selectedModalitySlugs: new Set(),
    datasetsCountByTaskSlug: new Map(),
    datasetsCountByModalitySlug: new Map(),
  };

  // ====================================================================
  //  Data shaping
  // ====================================================================

  function splitPipe(s) {
    if (!s) return [];
    return String(s).split('|').filter(Boolean);
  }

  function normalizeIdeaRow(row) {
    const tags = splitPipe(row.tags_concat).map(full => {
      const idx = full.indexOf('/');
      return idx < 0
        ? { facet: full, value: '', full }
        : { facet: full.substring(0, idx), value: full.substring(idx + 1), full };
    });
    return {
      uuid: row.uuid,
      slug: row.slug,
      title: row.title,
      sectionNo: row.section_no,
      sectionName: row.section_name,
      descriptionMd: row.description || '',
      sourceMd: row.source_md || '',
      isSub: !!row.is_sub,
      kind: row.kind || 'idea',
      tags,
      requirementUuids: splitPipe(row.req_uuids),
      kpiUuids: splitPipe(row.kpi_uuids),
      entityUuids: splitPipe(row.ent_uuids),
    };
  }

  // ====================================================================
  //  Plan markdown parsing (unchanged — plans live outside the DB until
  //  data/plans.json is created with uuidgen'd UUIDs).
  // ====================================================================

  function parseFrontmatter(text) {
    const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!m) return { data: {}, body: text };
    const body = text.substring(m[0].length);
    const data = {};
    for (const rawLine of m[1].split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const key = line.substring(0, idx).trim();
      let val = line.substring(idx + 1).trim();
      if (val.startsWith('[') && val.endsWith(']')) {
        val = val.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
      }
      data[key] = val;
    }
    return { data, body };
  }

  function parsePlan(filename, text) {
    const { data, body } = parseFrontmatter(text);
    const tags = (data.tags || []).map(slug => {
      const [facet, value] = String(slug).split('/');
      return { facet, value, full: `${facet}/${value}` };
    }).filter(t => t.facet && t.value);

    let snapshot = '';
    const snapMatch = body.match(/##\s+1\.\s+Executive Snapshot\s*\n([\s\S]*?)(?=\n##\s|$)/);
    if (snapMatch) snapshot = snapMatch[1].trim();

    let title = data.title || '';
    if (!title) {
      const h1 = body.match(/^#\s+(.+)$/m);
      if (h1) title = h1[1].trim();
    }

    const industries = Array.isArray(data.industries) ? data.industries : (data.industries ? [data.industries] : []);

    return {
      filename, title,
      type: data.type || '',
      source: data.source || '',
      sourceUrl: data.source_url || '',
      date: data.date || '',
      industries,
      maturity: data.maturity || '',
      verification: data.verification || '',
      tags, snapshot, body,
    };
  }

  // ====================================================================
  //  Inline markdown rendering
  // ====================================================================

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function inlineMd(md) {
    if (!md) return '';
    const placeholders = [];
    let html = md.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt, url) => {
      placeholders.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(txt)}</a>`);
      return ` LINK${placeholders.length - 1} `;
    });
    html = escapeHtml(html);
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/ LINK(\d+) /g, (_, i) => placeholders[parseInt(i, 10)]);
    return html;
  }

  function highlight(html, query) {
    if (!query) return html;
    const q = query.trim();
    if (!q) return html;
    const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    let out = '';
    let i = 0;
    while (i < html.length) {
      const next = html.indexOf('<', i);
      if (next < 0) { out += html.substring(i).replace(re, '<mark>$1</mark>'); break; }
      out += html.substring(i, next).replace(re, '<mark>$1</mark>');
      const close = html.indexOf('>', next);
      if (close < 0) { out += html.substring(next); break; }
      out += html.substring(next, close + 1);
      i = close + 1;
    }
    return out;
  }

  // Block-level renderer for the plan modal body.
  function renderPlanBody(text) {
    const lines = text.split('\n');
    const out = [];
    let mode = null;
    let buf = [];

    function flush() {
      if (!mode || buf.length === 0) { mode = null; buf = []; return; }
      if (mode === 'p') out.push(`<p>${inlineMd(buf.join(' '))}</p>`);
      else if (mode === 'blockquote') out.push(`<blockquote>${buf.map(b => inlineMd(b)).join('<br>')}</blockquote>`);
      else if (mode === 'ul' || mode === 'ol') {
        const items = buf.map(b => `<li>${inlineMd(b)}</li>`).join('');
        out.push(`<${mode}>${items}</${mode}>`);
      }
      mode = null;
      buf = [];
    }

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) { flush(); continue; }
      const h1 = line.match(/^#\s+(.+)$/);
      const h2 = line.match(/^##\s+(.+)$/);
      const h3 = line.match(/^###\s+(.+)$/);
      if (h1 || h2 || h3) {
        flush();
        if (h1) out.push(`<h1>${inlineMd(h1[1])}</h1>`);
        else if (h2) out.push(`<h2>${inlineMd(h2[1])}</h2>`);
        else out.push(`<h3>${inlineMd(h3[1])}</h3>`);
        continue;
      }
      const bq = line.match(/^>\s*(.*)$/);
      if (bq) { if (mode !== 'blockquote') { flush(); mode = 'blockquote'; } buf.push(bq[1]); continue; }
      const ul = line.match(/^[-*]\s+(.+)$/);
      const ol = line.match(/^\d+\.\s+(.+)$/);
      if (ul) { if (mode !== 'ul') { flush(); mode = 'ul'; } buf.push(ul[1]); continue; }
      if (ol) { if (mode !== 'ol') { flush(); mode = 'ol'; } buf.push(ol[1]); continue; }
      if (mode !== 'p') { flush(); mode = 'p'; }
      buf.push(line);
    }
    flush();
    return out.join('\n');
  }

  // ====================================================================
  //  Filtering
  // ====================================================================

  function activeItems() {
    if (state.view === 'ideas') return state.ideas;
    if (state.view === 'plans') return state.plans;
    if (state.view === 'requirements') return state.requirements;
    if (state.view === 'kpis') return state.kpis;
    return [];
  }

  function matchesTagFilters(item) {
    for (const facet of FACETS) {
      const selected = state.filters[facet];
      if (selected.size === 0) continue;
      const hasMatch = item.tags.some(t => t.facet === facet && selected.has(t.value));
      if (!hasMatch) return false;
    }
    return true;
  }

  function matchesIdea(idea) {
    if (!matchesTagFilters(idea)) return false;
    if (state.kindFilter !== 'all' && idea.kind !== state.kindFilter) return false;
    if (state.vocabFilters.requirement.size > 0) {
      const ok = idea.requirementUuids.some(u => state.vocabFilters.requirement.has(u));
      if (!ok) return false;
    }
    if (state.vocabFilters.kpi.size > 0) {
      const ok = idea.kpiUuids.some(u => state.vocabFilters.kpi.has(u));
      if (!ok) return false;
    }
    if (state.vocabFilters.entity.size > 0) {
      const ok = idea.entityUuids.some(u => state.vocabFilters.entity.has(u));
      if (!ok) return false;
    }
    if (state.searchHits && !state.searchHits.has(idea.uuid)) return false;
    return true;
  }

  function matchesPlan(plan) {
    if (!matchesTagFilters(plan)) return false;
    if (!state.query) return true;
    const q = state.query.toLowerCase();
    if (plan.title.toLowerCase().includes(q)) return true;
    if (plan.snapshot.toLowerCase().includes(q)) return true;
    if (plan.source.toLowerCase().includes(q)) return true;
    if (plan.type.toLowerCase().includes(q)) return true;
    if (plan.tags.some(t => t.full.toLowerCase().includes(q))) return true;
    return false;
  }

  // Count how many ideas/plans WOULD match if the given (facet, value) tag
  // were added to the current filter set — drives the live chip badges.
  function countWithTag(facet, value) {
    const isIdeas = state.view === 'ideas';
    const items = isIdeas ? state.ideas : state.plans;
    const original = state.filters[facet];
    const simulated = new Set(original);
    simulated.add(value);
    state.filters[facet] = simulated;
    let count = 0;
    for (const item of items) {
      if (isIdeas ? matchesIdea(item) : matchesPlan(item)) count++;
    }
    state.filters[facet] = original;
    return count;
  }

  function countWithVocab(facet, uuid) {
    if (state.view !== 'ideas') return 0;
    const original = state.vocabFilters[facet];
    const simulated = new Set(original);
    simulated.add(uuid);
    state.vocabFilters[facet] = simulated;
    let count = 0;
    for (const idea of state.ideas) if (matchesIdea(idea)) count++;
    state.vocabFilters[facet] = original;
    return count;
  }

  // ====================================================================
  //  Cross-linking: plan ↔ idea via tag overlap
  // ====================================================================

  function tagOverlapScore(tagsA, tagsB) {
    const aSet = new Set(tagsA.map(t => t.full));
    let score = 0;
    for (const t of tagsB) if (aSet.has(t.full)) score += (TAG_WEIGHTS[t.facet] || 1);
    return score;
  }

  function topRelatedPlans(idea, k = 3) {
    return state.plans
      .map(p => ({ plan: p, score: tagOverlapScore(idea.tags, p.tags) }))
      .filter(x => x.score >= MIN_RELATED_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  function topRelatedIdeas(plan, k = 6) {
    return state.ideas
      .map(i => ({ idea: i, score: tagOverlapScore(plan.tags, i.tags) }))
      .filter(x => x.score >= MIN_RELATED_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  // ====================================================================
  //  Sidebar
  // ====================================================================

  function buildFacetIndex(items) {
    const idx = Object.fromEntries(FACETS.map(f => [f, new Map()]));
    for (const item of items) {
      const seen = new Set();
      for (const t of item.tags) {
        const key = `${t.facet}/${t.value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!idx[t.facet]) continue;
        idx[t.facet].set(t.value, (idx[t.facet].get(t.value) || 0) + 1);
      }
    }
    return idx;
  }

  function vocabUsageCounts(facet) {
    // Count over current ideas — not affected by *which* vocab filters are
    // currently selected, only by other filters and search.
    const counts = new Map();
    const ideasView = state.view === 'ideas';
    if (!ideasView) return counts;
    const original = state.vocabFilters[facet];
    state.vocabFilters[facet] = new Set();
    for (const idea of state.ideas) {
      if (!matchesIdea(idea)) continue;
      const list = facet === 'requirement' ? idea.requirementUuids
                : facet === 'kpi' ? idea.kpiUuids
                : idea.entityUuids;
      for (const u of list) counts.set(u, (counts.get(u) || 0) + 1);
    }
    state.vocabFilters[facet] = original;
    return counts;
  }

  function renderFilters() {
    const root = document.getElementById('filterFacets');
    root.innerHTML = '';

    // Models view — sidebar = task picker grouped by category, main = model list.
    if (state.view === 'models') {
      root.appendChild(renderTasksFacetGroup());
      renderActiveSummary();
      return;
    }

    // Datasets view — sidebar = tasks + modality, main = dataset list.
    if (state.view === 'datasets') {
      root.appendChild(renderDatasetsFacetGroups());
      renderActiveSummary();
      return;
    }

    // Requirements / KPIs views — single-vocab picker using the same
    // compact task-chip pattern as Models / Datasets, for visual consistency.
    if (state.view === 'requirements' || state.view === 'kpis') {
      const facet = state.view === 'requirements' ? 'requirement' : 'kpi';
      root.appendChild(renderSinglePickerFacet(facet));
      renderActiveSummary();
      return;
    }

    if (state.view === 'ideas') {
      root.appendChild(renderKindToggle());
    }

    const tagIdx = buildFacetIndex(activeItems());
    for (const facet of FACETS) {
      const values = [...tagIdx[facet].entries()].sort(([a], [b]) => a.localeCompare(b));
      if (values.length === 0) continue;
      root.appendChild(renderTagFacetGroup(facet, values));
    }

    if (state.view === 'ideas') {
      for (const facet of VOCAB_FACETS) {
        root.appendChild(renderVocabFacetGroup(facet));
      }
    }

    renderActiveSummary();
  }

  function renderKindToggle() {
    const group = document.createElement('div');
    group.className = 'facet-group kind-group';
    const opts = [
      { v: 'all', label: 'All' },
      { v: 'idea', label: 'Ideas' },
      { v: 'pattern', label: 'Patterns' },
    ];
    const buttons = opts.map(o => {
      const selected = state.kindFilter === o.v;
      return `<button type="button" class="kind-toggle-btn${selected ? ' selected' : ''}" data-kind="${o.v}">${o.label}</button>`;
    }).join('');
    group.innerHTML = `<div class="facet-header static"><span>Kind</span></div><div class="kind-toggle">${buttons}</div>`;
    group.querySelectorAll('.kind-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        state.kindFilter = btn.dataset.kind;
        render();
      });
    });
    return group;
  }

  function renderTagFacetGroup(facet, values) {
    const group = document.createElement('div');
    group.className = 'facet-group';
    const collapsed = state.collapsedFacets.has(facet);

    const header = document.createElement('button');
    header.className = 'facet-header' + (collapsed ? ' collapsed' : '');
    header.type = 'button';
    header.innerHTML = `<span>${FACET_LABELS[facet]}</span><span class="chevron">▾</span>`;
    header.addEventListener('click', () => {
      if (collapsed) state.collapsedFacets.delete(facet); else state.collapsedFacets.add(facet);
      renderFilters();
    });

    const options = document.createElement('div');
    options.className = 'facet-options' + (collapsed ? ' collapsed' : '');
    for (const [value, totalCount] of values) {
      const isSelected = state.filters[facet].has(value);
      const liveCount = isSelected ? totalCount : countWithTag(facet, value);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip facet-' + facet + (isSelected ? ' selected' : '') + ((liveCount === 0 && !isSelected) ? ' zero' : '');
      chip.innerHTML = `${value} <span class="count">${liveCount}</span>`;
      chip.title = `${facet}/${value}`;
      chip.addEventListener('click', () => {
        if (state.filters[facet].has(value)) state.filters[facet].delete(value);
        else state.filters[facet].add(value);
        render();
      });
      options.appendChild(chip);
    }

    group.appendChild(header);
    group.appendChild(options);
    return group;
  }

  function renderVocabFacetGroup(facet) {
    const group = document.createElement('div');
    group.className = 'facet-group vocab-group';
    const collapsed = state.collapsedFacets.has(facet);
    const usage = vocabUsageCounts(facet);
    const total = facet === 'requirement' ? state.requirementsByUuid.size
                : facet === 'kpi' ? state.kpisByUuid.size
                : state.entitiesByUuid.size;

    const header = document.createElement('button');
    header.className = 'facet-header' + (collapsed ? ' collapsed' : '');
    header.type = 'button';
    header.innerHTML = `<span>${VOCAB_LABELS[facet]}</span><span class="chevron-row"><span class="vocab-count">${state.vocabFilters[facet].size || ''}</span><span class="chevron">▾</span></span>`;
    header.title = `${total} total · click to expand`;
    header.addEventListener('click', () => {
      if (collapsed) state.collapsedFacets.delete(facet); else state.collapsedFacets.add(facet);
      renderFilters();
    });
    group.appendChild(header);

    if (collapsed) return group;

    // Per-facet search box — these vocabs have 60–150 entries.
    const searchWrap = document.createElement('div');
    searchWrap.className = 'vocab-search-wrap';
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'vocab-search';
    searchInput.placeholder = `Search ${facet}s…`;
    searchInput.value = state.vocabFacetSearch[facet];
    searchInput.addEventListener('input', e => {
      state.vocabFacetSearch[facet] = e.target.value;
      renderFilters();
      // Re-focus so the user can keep typing.
      const reFocused = document.querySelector(`.vocab-group input[data-facet="${facet}"]`);
      if (reFocused) { reFocused.focus(); reFocused.setSelectionRange(reFocused.value.length, reFocused.value.length); }
    });
    searchInput.dataset.facet = facet;
    searchWrap.appendChild(searchInput);
    group.appendChild(searchWrap);

    // Build the list of vocab entries to show.
    const map = facet === 'requirement' ? state.requirementsByUuid
              : facet === 'kpi' ? state.kpisByUuid
              : state.entitiesByUuid;
    const entries = [...map.values()].map(v => ({
      ...v,
      count: usage.get(v.uuid) || 0,
      displayName: v.label || v.name,
      typeChip: v.type || null,
    }));
    const needle = state.vocabFacetSearch[facet].trim().toLowerCase();
    let filtered = entries;
    if (needle) {
      filtered = entries.filter(e =>
        (e.displayName || '').toLowerCase().includes(needle) ||
        (e.slug || '').toLowerCase().includes(needle) ||
        (e.description || '').toLowerCase().includes(needle)
      );
    }
    // Selected first, then highest count, then alphabetical.
    filtered.sort((a, b) => {
      const aSel = state.vocabFilters[facet].has(a.uuid) ? 1 : 0;
      const bSel = state.vocabFilters[facet].has(b.uuid) ? 1 : 0;
      if (aSel !== bSel) return bSel - aSel;
      if (a.count !== b.count) return b.count - a.count;
      return (a.displayName || '').localeCompare(b.displayName || '');
    });
    // When there's no search needle, show ones used by current view first
    // (count > 0), then truncate to a sane window with a "show more" toggle.
    const showAll = state.vocabFacetSearch[facet] || state.vocabFilters[facet].size > 0;
    const visible = showAll ? filtered : filtered.filter(e => e.count > 0).slice(0, 40);

    // For KPIs / requirements, the entries carry a `category` from the
    // closed taxonomy. We render category-section headers between groups
    // of chips so the user can scan by bucket. Entities (no category)
    // fall through to a flat single-section render.
    const supportsCategories = (facet === 'kpi' || facet === 'requirement') &&
                               visible.some(e => e.category);
    const buildChip = (e) => {
      const isSelected = state.vocabFilters[facet].has(e.uuid);
      const liveCount = isSelected ? e.count : countWithVocab(facet, e.uuid);
      const catCls = e.category ? ` vocab-cat-${e.category}` : '';
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'vocab-chip facet-' + facet + catCls + (isSelected ? ' selected' : '') + ((liveCount === 0 && !isSelected) ? ' zero' : '');
      const typeBadge = e.typeChip ? `<span class="vocab-type">${e.typeChip}</span>` : '';
      chip.innerHTML = `${typeBadge}<span class="vocab-label">${escapeHtml(e.displayName)}</span> <span class="count">${liveCount}</span>`;
      if (e.description) chip.title = e.description;
      chip.addEventListener('click', () => {
        if (state.vocabFilters[facet].has(e.uuid)) state.vocabFilters[facet].delete(e.uuid);
        else state.vocabFilters[facet].add(e.uuid);
        render();
      });
      return chip;
    };

    if (!supportsCategories) {
      const options = document.createElement('div');
      options.className = 'vocab-options';
      for (const e of visible) options.appendChild(buildChip(e));
      group.appendChild(options);
    } else {
      // Group entries by category, then render in the taxonomy's display order.
      const order = (facet === 'kpi') ? KPI_CATEGORY_ORDER : REQUIREMENT_CATEGORY_ORDER;
      const labels = (facet === 'kpi') ? KPI_CATEGORY_LABELS : REQUIREMENT_CATEGORY_LABELS;
      const byCat = new Map();
      for (const e of visible) {
        const cat = e.category || '_other';
        if (!byCat.has(cat)) byCat.set(cat, []);
        byCat.get(cat).push(e);
      }
      // Emit sections in declared order; any unrecognized categories trail at the end.
      const cats = [
        ...order.filter(c => byCat.has(c)),
        ...[...byCat.keys()].filter(c => !order.includes(c) && c !== '_other'),
        ...(byCat.has('_other') ? ['_other'] : []),
      ];
      for (const cat of cats) {
        const entries = byCat.get(cat);
        const collapsed = state.collapsedVocabCats[facet].has(cat);
        const section = document.createElement('div');
        section.className = 'facet-group vocab-cat-group vocab-cat-' + cat;

        const header = document.createElement('button');
        header.className = 'facet-header' + (collapsed ? ' collapsed' : '');
        header.type = 'button';
        const catLabel = cat === '_other' ? 'Uncategorized' : (labels[cat] || cat);
        const selectedInCat = entries.filter(e => state.vocabFilters[facet].has(e.uuid)).length;
        header.innerHTML =
          `<span class="facet-header-label">${escapeHtml(catLabel)}</span>` +
          `<span class="chevron-row">` +
            `<span class="vocab-count">${selectedInCat ? selectedInCat + '/' : ''}${entries.length}</span>` +
            `<span class="chevron">▾</span>` +
          `</span>`;
        header.addEventListener('click', () => {
          if (collapsed) state.collapsedVocabCats[facet].delete(cat);
          else state.collapsedVocabCats[facet].add(cat);
          renderFilters();
        });
        section.appendChild(header);

        const options = document.createElement('div');
        options.className = 'facet-options' + (collapsed ? ' collapsed' : '');
        for (const e of entries) options.appendChild(buildChip(e));
        section.appendChild(options);
        group.appendChild(section);
      }
    }

    if (!showAll && filtered.length > visible.length) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'ghost-btn vocab-more';
      more.textContent = `Show all ${filtered.length}`;
      more.addEventListener('click', () => {
        state.vocabFacetSearch[facet] = ' ';
        renderFilters();
        state.vocabFacetSearch[facet] = '';
        // Make the search input visible & focused.
        const input = document.querySelector(`.vocab-group input[data-facet="${facet}"]`);
        if (input) input.focus();
      });
      group.appendChild(more);
    }

    return group;
  }

  // Sidebar block for Requirements / KPIs views — single picker, same
  // .tag-chip pill style as Ideas / Plans / Models / Datasets.
  function renderSinglePickerFacet(facet) {
    const wrap = document.createElement('div');
    wrap.className = 'facet-group';

    const items     = facet === 'requirement' ? state.requirements           : state.kpis;
    const counts    = facet === 'requirement' ? state.ideaCountByRequirementUuid : state.ideaCountByKpiUuid;
    const selected  = state.vocabFilters[facet];
    const titleText = facet === 'requirement' ? 'Requirements (pain points)' : 'KPIs moved';

    const header = document.createElement('div');
    header.className = 'facet-header static';
    header.innerHTML =
      `<span>${escapeHtml(titleText)}</span>` +
      `<span class="vocab-count">${selected.size || ''}</span>`;
    wrap.appendChild(header);

    // In-sidebar search to narrow the picker when the list is long (149/109).
    const searchWrap = document.createElement('div');
    searchWrap.className = 'vocab-search-wrap';
    const sb = document.createElement('input');
    sb.type = 'search';
    sb.className = 'vocab-search';
    sb.placeholder = `Filter ${facet}s…`;
    sb.value = state.vocabFacetSearch[facet] || '';
    sb.dataset.facet = facet;
    sb.addEventListener('input', (e) => {
      state.vocabFacetSearch[facet] = e.target.value;
      renderFilters();
      const refocused = document.querySelector(
        `#filterFacets input.vocab-search[data-facet="${facet}"]`
      );
      if (refocused) {
        refocused.focus();
        refocused.setSelectionRange(refocused.value.length, refocused.value.length);
      }
    });
    searchWrap.appendChild(sb);
    wrap.appendChild(searchWrap);

    const needle = (state.vocabFacetSearch[facet] || '').trim().toLowerCase();
    const filtered = items.filter(v =>
      !needle ||
      (v.label || '').toLowerCase().includes(needle) ||
      (v.description || '').toLowerCase().includes(needle) ||
      (v.slug || '').toLowerCase().includes(needle)
    );
    // Selected first, then highest usage count, then alpha.
    filtered.sort((a, b) => {
      const aSel = selected.has(a.uuid) ? 1 : 0;
      const bSel = selected.has(b.uuid) ? 1 : 0;
      if (aSel !== bSel) return bSel - aSel;
      const ac = counts.get(a.uuid) || 0;
      const bc = counts.get(b.uuid) || 0;
      if (ac !== bc) return bc - ac;
      return (a.label || '').localeCompare(b.label || '');
    });

    const buildChipBtn = (v) => {
      const isSel = selected.has(v.uuid);
      const count = counts.get(v.uuid) || 0;
      const catCls = v.category ? ` vocab-cat-${v.category}` : '';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tag-chip facet-picker' + catCls + (isSel ? ' selected' : '');
      if (v.description) btn.title = v.description;
      btn.textContent = v.label;
      if (count) {
        const c = document.createElement('span');
        c.className = 'count';
        c.textContent = String(count);
        btn.appendChild(c);
      }
      btn.addEventListener('click', () => {
        if (selected.has(v.uuid)) selected.delete(v.uuid);
        else selected.add(v.uuid);
        render();
      });
      return btn;
    };

    // When the entries carry a category (T1.1 KPIs, T-cat requirements),
    // group them under collapsible section headers. Otherwise fall back
    // to a flat list. Both branches share buildChipBtn so styling matches.
    const supportsCats = (facet === 'kpi' || facet === 'requirement') &&
                         filtered.some(v => v.category);
    if (!supportsCats) {
      const opts = document.createElement('div');
      opts.className = 'facet-options';
      for (const v of filtered) opts.appendChild(buildChipBtn(v));
      wrap.appendChild(opts);
      return wrap;
    }

    const order  = (facet === 'kpi') ? KPI_CATEGORY_ORDER  : REQUIREMENT_CATEGORY_ORDER;
    const labels = (facet === 'kpi') ? KPI_CATEGORY_LABELS : REQUIREMENT_CATEGORY_LABELS;
    const byCat = new Map();
    for (const v of filtered) {
      const c = v.category || '_other';
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c).push(v);
    }
    const cats = [
      ...order.filter(c => byCat.has(c)),
      ...[...byCat.keys()].filter(c => !order.includes(c) && c !== '_other'),
      ...(byCat.has('_other') ? ['_other'] : []),
    ];
    // Mirror the existing .facet-group / .facet-header / .facet-options
     // pattern from the Ideas / Plans sidebars so the look and the wrap
     // behavior are identical. Each category becomes its own facet-group;
     // its left-stripe color is conveyed by the vocab-cat-<slug> class
     // (a one-line CSS rule per category, already in styles.css).
    for (const cat of cats) {
      const entries = byCat.get(cat);
      const collapsed = state.collapsedVocabCats[facet].has(cat);
      const section = document.createElement('div');
      section.className = 'facet-group vocab-cat-group vocab-cat-' + cat;

      const head = document.createElement('button');
      head.className = 'facet-header' + (collapsed ? ' collapsed' : '');
      head.type = 'button';
      const catLabel = cat === '_other' ? 'Uncategorized' : (labels[cat] || cat);
      const selectedInCat = entries.filter(v => selected.has(v.uuid)).length;
      head.innerHTML =
        `<span class="facet-header-label">${escapeHtml(catLabel)}</span>` +
        `<span class="chevron-row">` +
          `<span class="vocab-count">${selectedInCat ? selectedInCat + '/' : ''}${entries.length}</span>` +
          `<span class="chevron">▾</span>` +
        `</span>`;
      head.addEventListener('click', () => {
        if (collapsed) state.collapsedVocabCats[facet].delete(cat);
        else state.collapsedVocabCats[facet].add(cat);
        renderFilters();
      });
      section.appendChild(head);

      const opts = document.createElement('div');
      opts.className = 'facet-options' + (collapsed ? ' collapsed' : '');
      for (const v of entries) opts.appendChild(buildChipBtn(v));
      section.appendChild(opts);
      wrap.appendChild(section);
    }
    return wrap;
  }

  // Generic helper: build a sidebar facet that lists tasks grouped by category.
  // Used by Models view (single axis) and Datasets view (one of two axes).
  function buildTasksByCategoryGroup({ titleText, applies, selectedSet, countsMap }) {
    const wrap = document.createElement('div');
    wrap.className = 'facet-group';

    const header = document.createElement('div');
    header.className = 'facet-header static';
    header.innerHTML = `<span>${escapeHtml(titleText)}</span>` +
                      `<span class="vocab-count">${selectedSet.size || ''}</span>`;
    wrap.appendChild(header);

    const tasks = state.tasks.filter(t => (t.applies_to || []).includes(applies));
    const byCat = new Map();
    for (const c of TASK_CATEGORY_ORDER) byCat.set(c, []);
    for (const t of tasks) {
      if (!byCat.has(t.category)) byCat.set(t.category, []);
      byCat.get(t.category).push(t);
    }

    for (const cat of TASK_CATEGORY_ORDER) {
      const items = byCat.get(cat) || [];
      if (!items.length) continue;
      const catColor = CATEGORY_COLOR[cat] || '#9ca3af';

      const sub = document.createElement('div');
      sub.className = 'facet-subheader';
      sub.innerHTML =
        `<span class="facet-subheader-dot" style="background:${catColor}"></span>` +
        `${escapeHtml(TASK_CATEGORY_LABELS[cat] || cat)}`;
      wrap.appendChild(sub);

      const opts = document.createElement('div');
      opts.className = 'facet-options';
      for (const t of items) {
        const iconColor = ICON_COLOR_MAP[t.icon_color] || catColor;
        const icon = t.icon_svg || '<span aria-hidden="true">●</span>';
        const isSel = selectedSet.has(t.slug);
        const count = countsMap.get(t.slug);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tag-chip facet-picker' + (isSel ? ' selected' : '');
        btn.title = t.label;
        btn.innerHTML =
          `<span class="tag-chip-icon" style="color:${iconColor}">${icon}</span>` +
          escapeHtml(t.label) +
          (count ? `<span class="count">${count}</span>` : '');
        btn.addEventListener('click', () => {
          if (selectedSet.has(t.slug)) selectedSet.delete(t.slug);
          else selectedSet.add(t.slug);
          render();
        });
        opts.appendChild(btn);
      }
      wrap.appendChild(opts);
    }
    return wrap;
  }

  // Sidebar block for the Models view — Tasks facet, grouped by category.
  function renderTasksFacetGroup() {
    return buildTasksByCategoryGroup({
      titleText:   'Tasks',
      applies:     'models',
      selectedSet: state.selectedTaskSlugs,
      countsMap:   state.modelsCountByTaskSlug,
    });
  }

  function renderActiveSummary() {
    const root = document.getElementById('activeSummary');
    // Build a flat list of {kind, facet, value, label, classes} so the
    // close-button handler can act on any one chip without branching.
    const chips = [];
    for (const facet of FACETS) {
      for (const value of state.filters[facet]) {
        chips.push({
          kind: 'tag',
          facet,
          value,
          label: `${FACET_LABELS[facet]}: ${value}`,
          classes: `facet-${facet}`,
        });
      }
    }
    if (state.kindFilter !== 'all') {
      chips.push({ kind: 'kind', facet: '', value: state.kindFilter, label: `Kind: ${state.kindFilter}`, classes: '' });
    }
    for (const facet of VOCAB_FACETS) {
      const sel = state.vocabFilters[facet];
      if (sel.size === 0) continue;
      const map = facet === 'requirement' ? state.requirementsByUuid
                : facet === 'kpi' ? state.kpisByUuid
                : state.entitiesByUuid;
      for (const uuid of sel) {
        const e = map.get(uuid);
        const text = e ? (e.label || e.name) : uuid;
        chips.push({
          kind: 'vocab',
          facet,
          value: uuid,
          label: `${VOCAB_LABELS[facet]}: ${text}`,
          classes: `vocab-${facet}`,
        });
      }
    }
    if (state.query) {
      chips.push({ kind: 'query', facet: '', value: state.query, label: `Search: ${state.query}`, classes: '' });
    }

    if (chips.length === 0) {
      root.hidden = true;
      root.innerHTML = '';
    } else {
      root.hidden = false;
      root.innerHTML = chips.map(c =>
        `<span class="filter-chip ${c.classes}" ` +
              `data-kind="${c.kind}" ` +
              `data-facet="${escapeHtml(c.facet)}" ` +
              `data-value="${escapeHtml(String(c.value))}">` +
          `<span class="filter-chip-label">${escapeHtml(c.label)}</span>` +
          `<button type="button" class="filter-chip-x" aria-label="Remove filter">×</button>` +
        `</span>`
      ).join('');
      root.querySelectorAll('.filter-chip-x').forEach(btn => {
        btn.addEventListener('click', () => {
          const chip = btn.closest('.filter-chip');
          const kind  = chip.dataset.kind;
          const facet = chip.dataset.facet;
          const value = chip.dataset.value;
          if (kind === 'tag') {
            state.filters[facet].delete(value);
          } else if (kind === 'vocab') {
            state.vocabFilters[facet].delete(value);
          } else if (kind === 'kind') {
            state.kindFilter = 'all';
          } else if (kind === 'query') {
            state.query = '';
            state.searchHits = null;
            const search = document.getElementById('search');
            if (search) search.value = '';
          }
          render();
        });
      });
    }

    document.getElementById('clearFilters').disabled = (chips.length === 0);
  }

  // ====================================================================
  //  Idea rendering
  // ====================================================================

  function renderIdeas() {
    const root = document.getElementById('ideasContainer');
    const filtered = state.ideas.filter(matchesIdea);

    document.getElementById('resultCount').textContent =
      filtered.length === state.ideas.length
        ? `${state.ideas.length} ideas`
        : `${filtered.length} of ${state.ideas.length} ideas`;

    if (filtered.length === 0) { root.innerHTML = emptyState(); return; }

    // T5.2 — match-score against the currently-selected requirements + KPIs.
    // When the user has any vocab filter on, compute how many of their
    // selected items the idea hits, then sort matched ideas within each
    // section by that score (descending). renderIdeaCard renders a badge.
    const selectedReqs = state.vocabFilters.requirement;
    const selectedKpis = state.vocabFilters.kpi;
    const totalSelected = selectedReqs.size + selectedKpis.size;
    const ideaMatchScore = new Map();
    if (totalSelected > 0) {
      for (const idea of filtered) {
        let hits = 0;
        for (const u of idea.requirementUuids) if (selectedReqs.has(u)) hits++;
        for (const u of idea.kpiUuids) if (selectedKpis.has(u)) hits++;
        if (hits > 0) ideaMatchScore.set(idea.uuid, { hits, total: totalSelected });
      }
    }

    const bySection = new Map();
    for (const idea of filtered) {
      const key = `${idea.sectionNo}|${idea.sectionName}`;
      if (!bySection.has(key)) bySection.set(key, { sectionNo: idea.sectionNo, sectionName: idea.sectionName, items: [] });
      bySection.get(key).items.push(idea);
    }
    if (totalSelected > 0) {
      // Sort each section's items by match score descending; unmatched
      // ideas keep their original order at the bottom of the section.
      for (const bucket of bySection.values()) {
        bucket.items.sort((a, b) => {
          const sa = (ideaMatchScore.get(a.uuid) || { hits: 0 }).hits;
          const sb = (ideaMatchScore.get(b.uuid) || { hits: 0 }).hits;
          return sb - sa;
        });
      }
    }
    const ordered = [...bySection.values()].sort((a, b) => a.sectionNo - b.sectionNo);

    const q = state.query;
    const html = ordered.map(({ sectionNo, sectionName, items }) => `
      <section>
        <div class="section-header">
          <span class="section-number">${sectionNo}</span>
          <h2 class="section-title">${escapeHtml(sectionName || '')}</h2>
          <span class="section-count">${items.length}</span>
        </div>
        ${items.map(idea => renderIdeaCard(idea, q, ideaMatchScore.get(idea.uuid))).join('')}
      </section>`).join('');

    root.innerHTML = html;
    wireIdeaCardEvents(root);
  }

  function renderIdeaCard(idea, query, matchScore) {
    const titleHtml = highlight(escapeHtml(idea.title), query);
    const descHtml = highlight(inlineMd(idea.descriptionMd), query);
    const sourceHtml = idea.sourceMd
      ? `<div class="idea-source">Source: ${highlight(inlineMd(idea.sourceMd), query)}</div>`
      : '';

    const kindBadge = idea.kind === 'pattern'
      ? `<span class="kind-badge kind-pattern" title="Cross-cutting capability / framework">pattern</span>`
      : '';

    // T5.2 — match badge: shows "hits / total" against the currently-selected
    // requirement + KPI filters. Only present when the user has at least one
    // vocab filter on and this idea actually matches some of them.
    const matchBadge = (matchScore && matchScore.hits > 0)
      ? `<span class="kind-badge match-badge" title="${matchScore.hits} of ${matchScore.total} selected pains/KPIs addressed">${matchScore.hits}/${matchScore.total} match</span>`
      : '';

    const tagsHtml = idea.tags.map(t => {
      const selected = state.filters[t.facet] && state.filters[t.facet].has(t.value);
      return `<button type="button" class="tag-chip facet-${t.facet}${selected ? ' selected' : ''}" data-facet="${t.facet}" data-value="${t.value}" title="${escapeHtml(t.full)}">${escapeHtml(t.value)}</button>`;
    }).join('');

    const reqHtml = idea.requirementUuids.length === 0 ? '' : `
      <div class="meta-strip meta-req">
        <span class="meta-strip-label">Solves</span>
        ${idea.requirementUuids.map(u => {
          const r = state.requirementsByUuid.get(u);
          if (!r) return '';
          const sel = state.vocabFilters.requirement.has(u);
          return `<button type="button" class="vocab-chip facet-requirement${sel ? ' selected' : ''}" data-vocab="requirement" data-uuid="${u}" title="${escapeHtml(r.description || '')}">${escapeHtml(r.label)}</button>`;
        }).join('')}
      </div>`;

    const kpiHtml = idea.kpiUuids.length === 0 ? '' : `
      <div class="meta-strip meta-kpi">
        <span class="meta-strip-label">Moves</span>
        ${idea.kpiUuids.map(u => {
          const k = state.kpisByUuid.get(u);
          if (!k) return '';
          const sel = state.vocabFilters.kpi.has(u);
          return `<button type="button" class="vocab-chip facet-kpi${sel ? ' selected' : ''}" data-vocab="kpi" data-uuid="${u}" title="${escapeHtml(k.description || '')}">${escapeHtml(k.label)}</button>`;
        }).join('')}
      </div>`;

    const entHtml = idea.entityUuids.length === 0 ? '' : `
      <div class="meta-strip meta-entity">
        <span class="meta-strip-label">Proof points</span>
        ${idea.entityUuids.map(u => {
          const e = state.entitiesByUuid.get(u);
          if (!e) return '';
          const sel = state.vocabFilters.entity.has(u);
          return `<button type="button" class="vocab-chip facet-entity${sel ? ' selected' : ''}" data-vocab="entity" data-uuid="${u}" title="${e.type}">${escapeHtml(e.name)}</button>`;
        }).join('')}
      </div>`;

    const related = topRelatedPlans(idea, 3);
    const relatedHtml = related.length === 0 ? '' : `
      <div class="related-strip">
        <span class="related-label">Related plans</span>
        ${related.map(({ plan }) => `<button type="button" class="related-chip" data-plan="${escapeHtml(plan.filename)}" title="${escapeHtml(plan.title)} — ${PLAN_TYPE_LABELS[plan.type] || plan.type}">
          <span class="related-type type-${plan.type}">${PLAN_TYPE_LABELS[plan.type] || plan.type}</span>
          <span class="related-title">${escapeHtml(plan.title)}</span>
        </button>`).join('')}
      </div>`;

    return `
      <article class="idea-card${idea.isSub ? ' sub' : ''}${idea.kind === 'pattern' ? ' is-pattern' : ''}" data-uuid="${idea.uuid}">
        <h3 class="idea-title">${kindBadge}${matchBadge}${titleHtml}</h3>
        <div class="idea-desc">${descHtml}</div>
        ${sourceHtml}
        <div class="idea-tags">${tagsHtml}</div>
        ${reqHtml}${kpiHtml}${entHtml}
        ${relatedHtml}
      </article>`;
  }

  function wireIdeaCardEvents(root) {
    root.querySelectorAll('.idea-tags .tag-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const { facet, value } = chip.dataset;
        if (!facet || !value) return;
        if (state.filters[facet].has(value)) state.filters[facet].delete(value);
        else state.filters[facet].add(value);
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
    root.querySelectorAll('.vocab-chip[data-vocab]').forEach(chip => {
      chip.addEventListener('click', () => {
        const { vocab, uuid } = chip.dataset;
        if (!vocab || !uuid) return;
        if (state.vocabFilters[vocab].has(uuid)) state.vocabFilters[vocab].delete(uuid);
        else state.vocabFilters[vocab].add(uuid);
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
    root.querySelectorAll('.related-chip[data-plan]').forEach(chip => {
      chip.addEventListener('click', () => {
        const plan = state.plans.find(p => p.filename === chip.dataset.plan);
        if (plan) openPlanModal(plan);
      });
    });
  }

  // ====================================================================
  //  Plan rendering
  // ====================================================================

  function renderPlans() {
    const root = document.getElementById('ideasContainer');
    const filtered = state.plans.filter(matchesPlan);

    document.getElementById('resultCount').textContent =
      filtered.length === state.plans.length
        ? `${state.plans.length} plans`
        : `${filtered.length} of ${state.plans.length} plans`;

    if (filtered.length === 0) { root.innerHTML = emptyState(); return; }

    const TYPE_ORDER = ['consultancy-framework', 'company-case-study', 'industry-blueprint', 'vendor-architecture'];
    const byType = new Map();
    for (const t of TYPE_ORDER) byType.set(t, []);
    for (const p of filtered) {
      if (!byType.has(p.type)) byType.set(p.type, []);
      byType.get(p.type).push(p);
    }

    const q = state.query;
    const sections = [];
    let idx = 1;
    for (const [type, plans] of byType.entries()) {
      if (plans.length === 0) continue;
      const label = PLAN_TYPE_LABELS[type] || type;
      const items = plans.map(p => renderPlanCard(p, q)).join('');
      sections.push(`
        <section>
          <div class="section-header">
            <span class="section-number">${idx}</span>
            <h2 class="section-title">${escapeHtml(label)}${plans.length === 1 ? '' : ' frameworks'}</h2>
            <span class="section-count">${plans.length}</span>
          </div>
          ${items}
        </section>`);
      idx++;
    }

    root.innerHTML = sections.join('');
    wirePlanCardEvents(root);
  }

  function renderPlanCard(plan, query) {
    const titleHtml = highlight(escapeHtml(plan.title), query);
    const snapshotHtml = highlight(inlineMd(plan.snapshot), query);
    const typeLabel = PLAN_TYPE_LABELS[plan.type] || plan.type || 'Plan';

    const meta = [];
    if (plan.source) meta.push(`<span>${escapeHtml(plan.source)}</span>`);
    if (plan.date) meta.push(`<span>${escapeHtml(String(plan.date))}</span>`);
    const metaHtml = meta.length ? `<div class="plan-meta">${meta.join(' · ')}</div>` : '';

    const tagsHtml = plan.tags.map(t => {
      const selected = state.filters[t.facet] && state.filters[t.facet].has(t.value);
      return `<button type="button" class="tag-chip facet-${t.facet}${selected ? ' selected' : ''}" data-facet="${t.facet}" data-value="${t.value}" title="${escapeHtml(t.full)}">${escapeHtml(t.value)}</button>`;
    }).join('');

    const related = topRelatedIdeas(plan, 6);
    const relatedHtml = related.length === 0 ? '' : `
      <div class="related-strip">
        <span class="related-label">Related ideas</span>
        <button type="button" class="related-jump" data-plan="${escapeHtml(plan.filename)}">${related.length} matching · view in Ideas →</button>
      </div>`;

    return `
      <article class="plan-card">
        <div class="plan-card-head">
          <span class="plan-badge type-${plan.type}">${typeLabel}</span>
          <h3 class="plan-title" data-plan="${escapeHtml(plan.filename)}">${titleHtml}</h3>
        </div>
        ${metaHtml}
        <div class="plan-snapshot">${snapshotHtml}</div>
        <div class="idea-tags">${tagsHtml}</div>
        ${relatedHtml}
      </article>`;
  }

  function wirePlanCardEvents(root) {
    root.querySelectorAll('.idea-tags .tag-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const { facet, value } = chip.dataset;
        if (!facet || !value) return;
        if (state.filters[facet].has(value)) state.filters[facet].delete(value);
        else state.filters[facet].add(value);
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
    root.querySelectorAll('.plan-title[data-plan]').forEach(el => {
      el.addEventListener('click', () => {
        const plan = state.plans.find(p => p.filename === el.dataset.plan);
        if (plan) openPlanModal(plan);
      });
    });
    root.querySelectorAll('.related-jump[data-plan]').forEach(btn => {
      btn.addEventListener('click', () => {
        const plan = state.plans.find(p => p.filename === btn.dataset.plan);
        if (plan) jumpToRelatedIdeas(plan);
      });
    });
  }

  // ====================================================================
  //  Models view (tile picker + per-task list)
  // ====================================================================

  function indexModelsSnapshot() {
    state.modelsCountByTaskSlug.clear();
    if (!state.modelsSnapshot) return;
    for (const entry of state.modelsSnapshot.items) {
      const tag = entry.item && entry.item.pipeline_tag;
      if (!tag) continue;
      state.modelsCountByTaskSlug.set(tag, (state.modelsCountByTaskSlug.get(tag) || 0) + 1);
    }
  }

  async function ensureModelsSnapshot() {
    if (state.modelsSnapshot || state.modelsLoading) return;
    state.modelsLoading = true;
    render();   // shows the loading state
    try {
      const idxRes = await fetch('data/fetched/index.json', { cache: 'no-store' });
      if (!idxRes.ok) throw new Error(`index.json: HTTP ${idxRes.status}`);
      const idx = await idxRes.json();
      if (!idx.models || !idx.models.filename) {
        throw new Error('No models snapshot in index.json — fetcher may not have run yet.');
      }
      const url = `data/fetched/${idx.models.filename}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const items = await res.json();
      state.modelsSnapshot = { date: idx.models.date, filename: idx.models.filename, items };
      indexModelsSnapshot();
    } catch (err) {
      state.modelsSnapshot = { error: err.message };
    } finally {
      state.modelsLoading = false;
      render();
    }
  }

  function renderModels() {
    const root = document.getElementById('ideasContainer');

    // Loading / error states
    if (state.modelsLoading) {
      root.innerHTML = `<div class="info-msg">Loading models snapshot…</div>`;
      return;
    }
    if (state.modelsSnapshot && state.modelsSnapshot.error) {
      root.innerHTML = `<div class="error-msg"><strong>Couldn't load models snapshot.</strong><br>${escapeHtml(state.modelsSnapshot.error)}</div>`;
      return;
    }
    if (!state.modelsSnapshot) {
      // Kick off the fetch lazily, then re-render once it lands
      ensureModelsSnapshot();
      root.innerHTML = `<div class="info-msg">Loading models snapshot…</div>`;
      return;
    }

    // Apply task filter (OR within facet, like our other filters)
    const selected = state.selectedTaskSlugs;
    const all = state.modelsSnapshot.items;
    const taskFiltered = selected.size === 0
      ? all
      : all.filter(e => e.item && selected.has(e.item.pipeline_tag));

    // Apply text search
    const q = (state.query || '').trim().toLowerCase();
    const filtered = !q
      ? taskFiltered
      : taskFiltered.filter(e => {
          const it = e.item;
          return (it.id || '').toLowerCase().includes(q)
              || (it.author || '').toLowerCase().includes(q)
              || (it.library_name || '').toLowerCase().includes(q)
              || (it.tags || []).some(t => t.toLowerCase().includes(q));
        });

    document.getElementById('resultCount').textContent =
      filtered.length === all.length
        ? `${all.length} models`
        : `${filtered.length} of ${all.length} models`;

    if (filtered.length === 0) { root.innerHTML = emptyState(); return; }

    // Default sort: trendingScore desc
    filtered.sort((a, b) => (b.item.trendingScore || 0) - (a.item.trendingScore || 0));

    // Cap the rendered list — 9919 cards on one page would freeze the browser.
    const RENDER_CAP = 500;
    const visible = filtered.slice(0, RENDER_CAP);
    const overflowNotice = filtered.length > RENDER_CAP
      ? `<div class="info-msg" style="margin-bottom:10px">Showing top ${RENDER_CAP} by trending score. Narrow with a task filter or search to see more specifically.</div>`
      : '';
    const cardsHtml = visible.map(e => renderModelCard(e.item)).join('');
    root.innerHTML = overflowNotice + `<div class="model-list">${cardsHtml}</div>`;
  }

  // =====================================================================
  //  Datasets view (mirror of Models: sidebar filters → main list)
  // =====================================================================

  function indexDatasetsSnapshot() {
    state.datasetsCountByTaskSlug.clear();
    state.datasetsCountByModalitySlug.clear();
    if (!state.datasetsSnapshot) return;
    for (const entry of state.datasetsSnapshot.items) {
      const tags = (entry.item && entry.item.tags) || [];
      for (const tag of tags) {
        if (tag.startsWith('task_categories:')) {
          const slug = tag.substring('task_categories:'.length);
          state.datasetsCountByTaskSlug.set(slug, (state.datasetsCountByTaskSlug.get(slug) || 0) + 1);
        } else if (tag.startsWith('modality:')) {
          const slug = tag.substring('modality:'.length);
          state.datasetsCountByModalitySlug.set(slug, (state.datasetsCountByModalitySlug.get(slug) || 0) + 1);
        }
      }
    }
  }

  async function ensureDatasetsSnapshot() {
    if (state.datasetsSnapshot || state.datasetsLoading) return;
    state.datasetsLoading = true;
    render();
    try {
      const idxRes = await fetch('data/fetched/index.json', { cache: 'no-store' });
      if (!idxRes.ok) throw new Error(`index.json: HTTP ${idxRes.status}`);
      const idx = await idxRes.json();
      if (!idx.datasets || !idx.datasets.filename) {
        throw new Error('No datasets snapshot in index.json — fetcher may not have run yet.');
      }
      const url = `data/fetched/${idx.datasets.filename}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const items = await res.json();
      state.datasetsSnapshot = { date: idx.datasets.date, filename: idx.datasets.filename, items };
      indexDatasetsSnapshot();
    } catch (err) {
      state.datasetsSnapshot = { error: err.message };
    } finally {
      state.datasetsLoading = false;
      render();
    }
  }

  function renderDatasets() {
    const root = document.getElementById('ideasContainer');
    if (state.datasetsLoading) {
      root.innerHTML = `<div class="info-msg">Loading datasets snapshot…</div>`;
      return;
    }
    if (state.datasetsSnapshot && state.datasetsSnapshot.error) {
      root.innerHTML = `<div class="error-msg"><strong>Couldn't load datasets snapshot.</strong><br>${escapeHtml(state.datasetsSnapshot.error)}</div>`;
      return;
    }
    if (!state.datasetsSnapshot) {
      ensureDatasetsSnapshot();
      root.innerHTML = `<div class="info-msg">Loading datasets snapshot…</div>`;
      return;
    }

    const selTasks = state.selectedDatasetTaskSlugs;
    const selMods  = state.selectedModalitySlugs;
    const all = state.datasetsSnapshot.items;
    // AND across facets, OR within a facet (consistent with our other views)
    const filtered0 = all.filter(e => {
      const tags = (e.item && e.item.tags) || [];
      if (selTasks.size > 0) {
        const ok = tags.some(t => t.startsWith('task_categories:') && selTasks.has(t.substring('task_categories:'.length)));
        if (!ok) return false;
      }
      if (selMods.size > 0) {
        const ok = tags.some(t => t.startsWith('modality:') && selMods.has(t.substring('modality:'.length)));
        if (!ok) return false;
      }
      return true;
    });

    const q = (state.query || '').trim().toLowerCase();
    const filtered = !q ? filtered0 : filtered0.filter(e => {
      const it = e.item;
      return (it.id || '').toLowerCase().includes(q)
          || (it.author || '').toLowerCase().includes(q)
          || (it.description || '').toLowerCase().includes(q)
          || (it.tags || []).some(t => t.toLowerCase().includes(q));
    });

    document.getElementById('resultCount').textContent =
      filtered.length === all.length
        ? `${all.length} datasets`
        : `${filtered.length} of ${all.length} datasets`;

    if (filtered.length === 0) { root.innerHTML = emptyState(); return; }

    filtered.sort((a, b) => (b.item.trendingScore || 0) - (a.item.trendingScore || 0));

    const RENDER_CAP = 500;
    const visible = filtered.slice(0, RENDER_CAP);
    const overflowNotice = filtered.length > RENDER_CAP
      ? `<div class="info-msg" style="margin-bottom:10px">Showing top ${RENDER_CAP} by trending score. Narrow with a task or modality filter to see more specifically.</div>`
      : '';
    const cardsHtml = visible.map(e => renderDatasetCard(e.item)).join('');
    root.innerHTML = overflowNotice + `<div class="model-list">${cardsHtml}</div>`;
  }

  function renderDatasetCard(d) {
    const url = hfUrl('datasets', d.id);
    const author = d.author || (d.id || '').split('/')[0] || '';
    const name = (d.id || '').split('/').slice(1).join('/') || d.id || '(unknown)';
    const fmt = (n) => n == null ? '—' : (n >= 1_000_000 ? (n/1_000_000).toFixed(1)+'M'
                                       : n >= 1_000 ? (n/1_000).toFixed(1)+'K'
                                       : String(n));
    const tagBadges = (d.tags || [])
      .filter(t => !t.startsWith('region:') && !t.startsWith('license:'))
      .slice(0, 6)
      .map(t => `<span class="model-tag">${escapeHtml(t)}</span>`)
      .join('');
    const desc = d.description
      ? `<div class="dataset-desc">${escapeHtml(d.description.slice(0, 240))}${d.description.length > 240 ? '…' : ''}</div>`
      : '';
    return `
      <article class="model-card">
        <div class="model-card-head">
          <a class="model-id" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
            <span class="model-author">${escapeHtml(author)}</span><span class="model-slash">/</span><span class="model-name">${escapeHtml(name)}</span>
          </a>
          <a class="model-extlink" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="Open on Hugging Face">↗</a>
        </div>
        ${desc}
        <div class="model-card-meta">
          <span title="Trending score">🔥 ${fmt(d.trendingScore)}</span>
          <span title="Likes">♥ ${fmt(d.likes)}</span>
          <span title="Downloads">↓ ${fmt(d.downloads)}</span>
        </div>
        ${tagBadges ? `<div class="model-tags">${tagBadges}</div>` : ''}
      </article>`;
  }

  // Sidebar block for the Datasets view — tasks + modalities, two facet groups.
  function renderDatasetsFacetGroups() {
    const frag = document.createDocumentFragment();
    frag.appendChild(renderTasksForDatasetsFacetGroup());
    frag.appendChild(renderModalitiesFacetGroup());
    return frag;
  }

  function renderTasksForDatasetsFacetGroup() {
    return buildTasksByCategoryGroup({
      titleText:   'Tasks',
      applies:     'datasets',
      selectedSet: state.selectedDatasetTaskSlugs,
      countsMap:   state.datasetsCountByTaskSlug,
    });
  }

  function renderModalitiesFacetGroup() {
    const wrap = document.createElement('div');
    wrap.className = 'facet-group';
    const header = document.createElement('div');
    header.className = 'facet-header static';
    header.innerHTML = `<span>Modality</span><span class="vocab-count">${state.selectedModalitySlugs.size || ''}</span>`;
    wrap.appendChild(header);

    const opts = document.createElement('div');
    opts.className = 'facet-options';
    for (const m of state.modalities) {
      const isSel = state.selectedModalitySlugs.has(m.slug);
      const count = state.datasetsCountByModalitySlug.get(m.slug);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tag-chip facet-picker' + (isSel ? ' selected' : '');
      btn.title = m.label;
      btn.textContent = m.label;
      if (count) {
        const c = document.createElement('span');
        c.className = 'count';
        c.textContent = String(count);
        btn.appendChild(c);
      }
      btn.addEventListener('click', () => {
        if (state.selectedModalitySlugs.has(m.slug)) state.selectedModalitySlugs.delete(m.slug);
        else state.selectedModalitySlugs.add(m.slug);
        render();
      });
      opts.appendChild(btn);
    }
    wrap.appendChild(opts);
    return wrap;
  }

  function renderModelCard(m) {
    const url = hfUrl('models', m.id);
    const author = m.author || (m.id || '').split('/')[0] || '';
    const name = (m.id || '').split('/').slice(1).join('/') || m.id || '(unknown)';
    const fmt = (n) => n == null ? '—' : (n >= 1_000_000 ? (n/1_000_000).toFixed(1)+'M'
                                       : n >= 1_000 ? (n/1_000).toFixed(1)+'K'
                                       : String(n));
    const tagBadges = (m.tags || [])
      .filter(t => !t.startsWith('pipeline_tag:') && !t.startsWith('region:') && !t.startsWith('license:'))
      .slice(0, 6)
      .map(t => `<span class="model-tag">${escapeHtml(t)}</span>`)
      .join('');
    return `
      <article class="model-card">
        <div class="model-card-head">
          <a class="model-id" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">
            <span class="model-author">${escapeHtml(author)}</span><span class="model-slash">/</span><span class="model-name">${escapeHtml(name)}</span>
          </a>
          <a class="model-extlink" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="Open on Hugging Face">↗</a>
        </div>
        <div class="model-card-meta">
          <span title="Trending score">🔥 ${fmt(m.trendingScore)}</span>
          <span title="Likes">♥ ${fmt(m.likes)}</span>
          <span title="Downloads">↓ ${fmt(m.downloads)}</span>
          ${m.library_name ? `<span class="model-lib">${escapeHtml(m.library_name)}</span>` : ''}
        </div>
        ${tagBadges ? `<div class="model-tags">${tagBadges}</div>` : ''}
      </article>`;
  }

  function jumpToRelatedIdeas(plan) {
    for (const f of FACETS) state.filters[f].clear();
    for (const f of VOCAB_FACETS) state.vocabFilters[f].clear();
    const byFacet = {};
    for (const t of plan.tags) (byFacet[t.facet] = byFacet[t.facet] || []).push(t.value);
    const primary = (byFacet.industry && byFacet.industry.length) ? byFacet.industry : (byFacet.function || []);
    const filtered = primary.filter(v => !['cross-industry'].includes(v));
    for (const v of (filtered.length ? filtered : primary).slice(0, 3)) {
      state.filters[byFacet.industry ? 'industry' : 'function'].add(v);
    }
    state.query = '';
    state.searchHits = null;
    document.getElementById('search').value = '';
    setView('ideas');
  }

  // ====================================================================
  //  Plan detail modal
  // ====================================================================

  function openPlanModal(plan) {
    const modal = document.getElementById('planModal');
    const content = document.getElementById('planModalContent');

    const typeLabel = PLAN_TYPE_LABELS[plan.type] || plan.type || 'Plan';
    const meta = [];
    if (plan.source) meta.push(`<span>${escapeHtml(plan.source)}</span>`);
    if (plan.date) meta.push(`<span>${escapeHtml(String(plan.date))}</span>`);
    if (plan.sourceUrl) meta.push(`<a href="${escapeHtml(plan.sourceUrl)}" target="_blank" rel="noopener noreferrer">source ↗</a>`);
    const verifBadge = plan.verification
      ? `<span class="verif-badge verif-${plan.verification}">${escapeHtml(plan.verification.replace(/-/g, ' '))}</span>`
      : '';

    const tagsHtml = plan.tags.map(t =>
      `<button type="button" class="tag-chip facet-${t.facet}" data-facet="${t.facet}" data-value="${t.value}" title="${escapeHtml(t.full)}">${escapeHtml(t.value)}</button>`
    ).join('');

    const body = renderPlanBody(plan.body);

    const related = topRelatedIdeas(plan, 8);
    const relatedListHtml = related.length === 0 ? '' : `
      <section class="modal-related">
        <h3>Related ideas (${related.length})</h3>
        <ul class="related-idea-list">
          ${related.map(({ idea, score }) => `
            <li>
              <button type="button" class="related-idea-link" data-uuid="${idea.uuid}">
                <span class="related-idea-title">${escapeHtml(idea.title)}</span>
                <span class="related-idea-meta">${escapeHtml(idea.sectionName || '')} · score ${score}</span>
              </button>
            </li>`).join('')}
        </ul>
      </section>`;

    content.innerHTML = `
      <header class="modal-header">
        <div class="plan-badge type-${plan.type}">${typeLabel}</div>
        <h2 id="planModalTitle">${escapeHtml(plan.title)}</h2>
        <div class="modal-meta">${meta.join(' · ')} ${verifBadge}</div>
        <div class="idea-tags">${tagsHtml}</div>
      </header>
      <article class="plan-body">${body}</article>
      ${relatedListHtml}`;

    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    content.querySelectorAll('.idea-tags .tag-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const { facet, value } = chip.dataset;
        if (!facet || !value) return;
        if (state.filters[facet].has(value)) state.filters[facet].delete(value);
        else state.filters[facet].add(value);
        closePlanModal();
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
    content.querySelectorAll('.related-idea-link[data-uuid]').forEach(btn => {
      btn.addEventListener('click', () => {
        const uuid = btn.dataset.uuid;
        closePlanModal();
        setView('ideas');
        requestAnimationFrame(() => scrollToIdea(uuid));
      });
    });
  }

  function closePlanModal() {
    const modal = document.getElementById('planModal');
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  function scrollToIdea(uuid) {
    const idea = state.ideas.find(i => i.uuid === uuid);
    if (!idea) return;
    if (!matchesIdea(idea)) {
      for (const f of FACETS) state.filters[f].clear();
      for (const f of VOCAB_FACETS) state.vocabFilters[f].clear();
      state.kindFilter = 'all';
      state.query = '';
      state.searchHits = null;
      document.getElementById('search').value = '';
      render();
    }
    const card = document.querySelector(`.idea-card[data-uuid="${uuid}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 1400);
    }
  }

  function emptyState() {
    return `<div class="empty-state"><h3>No matches</h3><p>Try removing a filter or clearing the search.</p></div>`;
  }

  // ====================================================================
  //  View toggle + top-level render
  // ====================================================================

  function setView(view) {
    if (state.view === view) return;
    state.view = view;
    const ids = {
      ideas: 'viewIdeas', plans: 'viewPlans',
      requirements: 'viewRequirements', kpis: 'viewKpis',
      models: 'viewModels', datasets: 'viewDatasets',
      graph: 'viewGraph',
    };
    for (const [k, id] of Object.entries(ids)) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.classList.toggle('active', view === k);
      el.setAttribute('aria-selected', view === k ? 'true' : 'false');
    }
    // Filters persist across view changes — selecting "marketing" in Ideas,
    // then switching to Requirements/KPIs/Plans, keeps "marketing" sticky.
    // Each view applies the subset of filters it understands; the others
    // stay in state and re-engage when you switch back. To drop a filter,
    // use the chip's × in the filter strip or "Clear all".
    // Toggle visibility of the two top-level containers. Ideas/Plans/Requirements/
    // KPIs/Models/Datasets all render into #ideasContainer; the Graph view owns
    // its own pane (#graphContainer) with a Three.js canvas inside.
    const ideasC = document.getElementById('ideasContainer');
    const graphC = document.getElementById('graphContainer');
    const isGraph = view === 'graph';
    if (ideasC) ideasC.hidden = isGraph;
    if (graphC) graphC.hidden = !isGraph;
    document.body.classList.toggle('graph-view', isGraph);

    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Lazy-loader for the Graph view — vendored libs are ~1.1 MB total, no
  // sense in paying that on first paint of the Ideas tab.
  //
  // Load order matters:
  //   1. Three.js (ESM) → set window.THREE so the UMD bundles below find it.
  //   2. three-spritetext (UMD) → reads window.THREE, exports window.SpriteText.
  //   3. 3d-force-graph (UMD) → exports window.ForceGraph3D (ships its own
  //      bundled THREE internally; coexists fine with our window.THREE for
  //      Sprite rendering).
  //   4. graph.js → idealab's Graph view; reads window.{THREE, SpriteText,
  //      ForceGraph3D} and exposes window.idealabGraph.
  let _graphLoaded = null;
  function ensureGraphLoaded() {
    if (_graphLoaded) return _graphLoaded;
    _graphLoaded = (async () => {
      const THREE = await import('./vendor/three/three.module.min.js');
      window.THREE = THREE;
      await loadScript('vendor/three-spritetext/three-spritetext.min.js');
      await loadScript('vendor/3d-force-graph/3d-force-graph.min.js');
      await loadScript('graph.js');
      if (window.idealabGraph?.init) {
        await window.idealabGraph.init({
          stage:            document.getElementById('graphStage'),
          breadcrumb:       document.getElementById('graphBreadcrumb'),
          hudStatus:        document.getElementById('graphHudStatus'),
          showNodeLabels:   document.getElementById('graphShowNodeLabels'),
          showEdgeLabels:   document.getElementById('graphShowEdgeLabels'),
          showAll:          document.getElementById('graphShowAll'),
          showLegend:       document.getElementById('graphShowLegend'),
          legend:           document.getElementById('graphLegend'),
          settingsBtn:      document.getElementById('graphSettingsBtn'),
          settingsPanel:    document.getElementById('graphSettingsPanel'),
        });
      }
      // Scope the graph to the user's current sidebar filters so the
      // initial view reflects what they were exploring before switching.
      if (window.idealabGraph?.scopeTo) {
        window.idealabGraph.scopeTo(computeGraphSeedFromFilters());
      }
    })();
    return _graphLoaded;
  }
  // Build the seed set the Graph view starts with — derived from the
  // current sidebar filters so switching to Graph reflects "show me the
  // graph for what I have selected". Empty result → graph falls back to
  // its generic overview.
  function computeGraphSeedFromFilters() {
    const seed = new Set();
    // Selected ideas: any idea passing the current tag + kind + vocab predicates.
    for (const idea of state.ideas) {
      if (matchesIdea(idea)) seed.add('idea:' + idea.uuid);
    }
    // Selected vocab items themselves (so the user can SEE the
    // pain/KPI/entity they filtered on, plus its 1-hop neighborhood).
    for (const u of state.vocabFilters.requirement) seed.add('requirement:' + u);
    for (const u of state.vocabFilters.kpi)         seed.add('kpi:'         + u);
    for (const u of state.vocabFilters.entity)      seed.add('entity:'      + u);
    // If the user had NO ideas-side filters at all (just looking around),
    // the loop above added every idea (~300) which would dominate the
    // graph. In that case clear the seed and let scopeTo fall back to
    // the curated overview.
    const anyFilter =
      Object.values(state.filters).some(s => s.size > 0) ||
      Object.values(state.vocabFilters).some(s => s.size > 0) ||
      state.kindFilter !== 'all' ||
      (state.query && state.query.trim());
    if (!anyFilter) return new Set();
    return seed;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload  = () => resolve();
      s.onerror = () => reject(new Error('failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  // ====================================================================
  //  Mini graph preview (sits above the main list in non-Graph views)
  // ====================================================================
  // A small, simplified ForceGraph3D instance scoped to the current filter
  // selection. Collapsed by default; expand state persists per session.
  // Click any node → switch to the full Graph tab. No DOI / legend / etc.
  let _miniFg = null;
  let _miniGraphData = null;        // raw {nodes, links} from public/graph.json
  let _miniNodeById = null;
  // Mirrors graph.js ENTITY_STYLES — color + shape + relative size per type.
  const _miniStyles = {
    idea:          { color: '#2e7d32', size: 4, shape: 'sphere',      label: 'Idea' },
    plan:          { color: '#7b1fa2', size: 6, shape: 'cone',        label: 'Plan' },
    requirement:   { color: '#c2185b', size: 4, shape: 'octahedron',  label: 'Requirement' },
    kpi:           { color: '#1565c0', size: 4, shape: 'cylinder',    label: 'KPI' },
    kpi_category:  { color: '#0d47a1', size: 6, shape: 'cylinder',    label: 'KPI category' },
    entity:        { color: '#ef6c00', size: 4, shape: 'box',         label: 'Entity' },
    task:          { color: '#6a1b9a', size: 4, shape: 'tetrahedron', label: 'Task' },
    task_category: { color: '#4a148c', size: 6, shape: 'tetrahedron', label: 'Task category' },
    model:         { color: '#00695c', size: 3, shape: 'torus',       label: 'Model' },
    dataset:       { color: '#004d40', size: 3, shape: 'box',         label: 'Dataset' },
    modality:      { color: '#455a64', size: 5, shape: 'octahedron',  label: 'Modality' },
    format:        { color: '#37474f', size: 5, shape: 'octahedron',  label: 'Format' },
    _default:      { color: '#616161', size: 3, shape: 'sphere',      label: 'Node' },
  };
  const _miniGeomCache = new Map();
  const _miniNodeSpriteByNode = new WeakMap();
  const _miniSettings = {
    showNodeLabels: true,
    showEdgeLabels: false,
    showLegend: true,
  };
  function loadMiniSettings() {
    try {
      const s = JSON.parse(localStorage.getItem('idealab.miniGraph.settings') || '{}');
      Object.assign(_miniSettings, s);
    } catch {}
  }
  function persistMiniSettings() {
    try { localStorage.setItem('idealab.miniGraph.settings', JSON.stringify(_miniSettings)); } catch {}
  }
  function miniGeometry(shape, size) {
    const key = shape + ':' + size;
    if (_miniGeomCache.has(key)) return _miniGeomCache.get(key);
    const T = window.THREE;
    let g;
    switch (shape) {
      case 'box':         g = new T.BoxGeometry(size * 1.6, size * 1.6, size * 1.6); break;
      case 'cone':        g = new T.ConeGeometry(size, size * 2, 14); break;
      case 'cylinder':    g = new T.CylinderGeometry(size, size, size * 1.6, 14); break;
      case 'octahedron':  g = new T.OctahedronGeometry(size); break;
      case 'tetrahedron': g = new T.TetrahedronGeometry(size * 1.1); break;
      case 'torus':       g = new T.TorusGeometry(size, size * 0.38, 8, 14); break;
      case 'sphere':
      default:            g = new T.SphereGeometry(size, 14, 10); break;
    }
    _miniGeomCache.set(key, g);
    return g;
  }
  function buildMiniNode(node) {
    const style = _miniStyles[node.type] || _miniStyles._default;
    const T = window.THREE;
    const group = new T.Group();
    const mesh = new T.Mesh(
      miniGeometry(style.shape, style.size),
      new T.MeshLambertMaterial({ color: style.color, transparent: true, opacity: 0.95 }),
    );
    group.add(mesh);
    if (typeof window.SpriteText === 'function') {
      const sprite = new window.SpriteText((node.label || node.id).slice(0, 50));
      sprite.color = '#1a202c';
      sprite.backgroundColor = 'rgba(255, 255, 255, 0.82)';
      sprite.borderColor = style.color;
      sprite.borderWidth = 0.25;
      sprite.borderRadius = 1.5;
      sprite.padding = [1.5, 0.8];
      sprite.textHeight = 2;
      sprite.position.y = style.size + 2;
      sprite.material.depthTest = false;
      sprite.material.depthWrite = false;
      sprite.renderOrder = 999;
      sprite.visible = _miniSettings.showNodeLabels;
      _miniNodeSpriteByNode.set(node, sprite);
      group.add(sprite);
    }
    return group;
  }
  function buildMiniEdgeLabel(link) {
    const verb = link.relation || link.label;
    if (!verb || verb === 'in category') return null;
    if (typeof window.SpriteText !== 'function') return null;
    const sprite = new window.SpriteText(verb);
    sprite.color = '#475569';
    sprite.backgroundColor = 'rgba(255, 255, 255, 0.78)';
    sprite.textHeight = 1.5;
    sprite.padding = [0.8, 0.4];
    sprite.material.depthTest = false;
    sprite.material.depthWrite = false;
    sprite.renderOrder = 998;
    sprite.visible = _miniSettings.showEdgeLabels;
    sprite.userData.__isMiniEdgeLabel = true;
    return sprite;
  }
  function applyMiniNodeLabelVisibility() {
    if (!_miniFg) return;
    const { nodes } = _miniFg.graphData();
    for (const n of nodes) {
      const s = _miniNodeSpriteByNode.get(n);
      if (s) s.visible = _miniSettings.showNodeLabels;
    }
  }
  function applyMiniEdgeLabelVisibility() {
    if (!_miniFg) return;
    const scene = _miniFg.scene && _miniFg.scene();
    if (!scene) return;
    scene.traverse(obj => {
      if (obj.userData && obj.userData.__isMiniEdgeLabel) obj.visible = _miniSettings.showEdgeLabels;
    });
  }
  function renderMiniLegend() {
    const el = document.getElementById('miniGraphLegend');
    if (!el) return;
    el.hidden = !_miniSettings.showLegend;
    if (el.hidden) return;
    const rows = Object.entries(_miniStyles)
      .filter(([k]) => k !== '_default')
      .map(([_, s]) =>
        `<div class="mini-graph-legend-row">` +
          `<span class="mini-graph-legend-swatch" style="background:${s.color}"></span>` +
          `<span>${escapeHtml(s.label)}</span>` +
        `</div>`
      ).join('');
    el.innerHTML = `<div class="mini-graph-legend-title">Legend</div>${rows}`;
  }

  function isMiniGraphExpanded() {
    try { return localStorage.getItem('idealab.miniGraph.expanded') === '1'; }
    catch { return false; }
  }
  function setMiniGraphExpanded(v) {
    try { localStorage.setItem('idealab.miniGraph.expanded', v ? '1' : '0'); } catch {}
  }

  async function ensureMiniGraphLoaded(stage) {
    if (_miniFg) return _miniFg;
    loadMiniSettings();
    // Reuse the same vendor chain as the full graph view.
    if (!window.THREE) {
      const THREE = await import('./vendor/three/three.module.min.js');
      window.THREE = THREE;
    }
    if (typeof window.SpriteText !== 'function') {
      await loadScript('vendor/three-spritetext/three-spritetext.min.js');
    }
    if (typeof window.ForceGraph3D !== 'function') {
      await loadScript('vendor/3d-force-graph/3d-force-graph.min.js');
    }
    if (!_miniGraphData) {
      const r = await fetch('public/graph.json', { cache: 'force-cache' });
      _miniGraphData = await r.json();
      _miniNodeById = new Map(_miniGraphData.nodes.map(n => [n.id, n]));
    }
    _miniFg = window.ForceGraph3D()(stage)
      .backgroundColor('#ffffff')
      .nodeThreeObjectExtend(false)
      .nodeThreeObject(buildMiniNode)
      .nodeLabel(n => `<div style="font-family:sans-serif;font-size:11px;color:#1a202c;background:#fff;padding:3px 6px;border:1px solid #e3e6eb;border-radius:4px">${escapeHtml(n.label || n.id)}</div>`)
      .linkColor(() => 'rgba(108, 117, 125, 0.45)')
      .linkOpacity(0.6)
      .linkWidth(l => (l.relation ? 1.0 : 0.5))
      .linkThreeObjectExtend(true)
      .linkThreeObject(buildMiniEdgeLabel)
      .linkPositionUpdate((sprite, { start, end }) => {
        if (!sprite) return;
        sprite.position.set(
          (start.x + end.x) / 2,
          (start.y + end.y) / 2,
          ((start.z || 0) + (end.z || 0)) / 2,
        );
      })
      .cooldownTicks(40)
      .warmupTicks(20);
    // Resize with container.
    const ro = new ResizeObserver(() => {
      if (!_miniFg) return;
      const r = stage.getBoundingClientRect();
      _miniFg.width(r.width).height(r.height);
    });
    ro.observe(stage);
    renderMiniLegend();
    return _miniFg;
  }

  function applyMiniGraphScope() {
    if (!_miniFg || !_miniGraphData) return;
    let seed = computeGraphSeedFromFilters();
    const empty = (seed.size === 0);
    const stage = document.getElementById('miniGraphStage');
    let emptyHint = stage && stage.querySelector('.mini-graph-empty');
    if (empty) {
      // No filters → render an empty graph and surface a hint in the stage.
      // We intentionally do NOT show a "curated overview" here because the
      // widget's purpose is "graph of CURRENT selection" — showing 80+ nodes
      // when nothing's selected is misleading.
      _miniFg.graphData({ nodes: [], links: [] });
      if (stage && !emptyHint) {
        emptyHint = document.createElement('div');
        emptyHint.className = 'mini-graph-empty';
        emptyHint.textContent = 'Pick a filter in the sidebar to preview its graph here.';
        stage.appendChild(emptyHint);
      }
      const hint = document.getElementById('miniGraphHint');
      if (hint) hint.textContent = '';
      return;
    }
    if (emptyHint) emptyHint.remove();
    // Expand each seed by 1 hop so the user sees what their selection connects to.
    const expanded = new Set(seed);
    for (const l of _miniGraphData.links) {
      const s = (typeof l.source === 'object') ? l.source.id : l.source;
      const t = (typeof l.target === 'object') ? l.target.id : l.target;
      if (seed.has(s)) expanded.add(t);
      if (seed.has(t)) expanded.add(s);
    }
    seed = expanded;
    const nodes = [];
    for (const id of seed) {
      const n = _miniNodeById.get(id);
      if (n) nodes.push(n);
    }
    const links = _miniGraphData.links.filter(l => {
      const s = (typeof l.source === 'object') ? l.source.id : l.source;
      const t = (typeof l.target === 'object') ? l.target.id : l.target;
      return seed.has(s) && seed.has(t);
    });
    _miniFg.graphData({ nodes, links });
    const hint = document.getElementById('miniGraphHint');
    if (hint) hint.textContent = ` · ${nodes.length} nodes, ${links.length} edges`;
  }

  function attachMiniGraphHandlers() {
    const widget = document.getElementById('miniGraph');
    const toggle = document.getElementById('miniGraphToggle');
    const stage  = document.getElementById('miniGraphStage');
    const open   = document.getElementById('miniGraphOpenFull');
    const gear   = document.getElementById('miniGraphSettingsBtn');
    const panel  = document.getElementById('miniGraphSettingsPanel');
    const cbNL   = document.getElementById('miniGraphShowNodeLabels');
    const cbEL   = document.getElementById('miniGraphShowEdgeLabels');
    const cbLG   = document.getElementById('miniGraphShowLegend');
    if (!widget || !toggle || !stage) return;

    // Sync the panel checkboxes to persisted settings before any handler fires.
    loadMiniSettings();
    if (cbNL) cbNL.checked = !!_miniSettings.showNodeLabels;
    if (cbEL) cbEL.checked = !!_miniSettings.showEdgeLabels;
    if (cbLG) cbLG.checked = !!_miniSettings.showLegend;

    // Restore prior expand state.
    if (isMiniGraphExpanded()) {
      widget.classList.remove('collapsed');
      toggle.setAttribute('aria-expanded', 'true');
      requestAnimationFrame(() => ensureMiniGraphLoaded(stage).then(applyMiniGraphScope));
    }
    toggle.addEventListener('click', async () => {
      const willOpen = widget.classList.contains('collapsed');
      widget.classList.toggle('collapsed', !willOpen);
      toggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      setMiniGraphExpanded(willOpen);
      if (willOpen) {
        await ensureMiniGraphLoaded(stage);
        applyMiniGraphScope();
      }
    });
    if (open) {
      open.addEventListener('click', (e) => {
        e.preventDefault();
        setView('graph');
      });
    }

    // Settings popover — click gear to toggle, click outside to close.
    if (gear && panel) {
      const toggleSettings = (forceOpen) => {
        const willOpen = forceOpen === undefined ? panel.hidden : forceOpen;
        panel.hidden = !willOpen;
        gear.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      };
      gear.addEventListener('click', (e) => { e.stopPropagation(); toggleSettings(); });
      document.addEventListener('click', (e) => {
        if (panel.hidden) return;
        if (panel.contains(e.target) || gear.contains(e.target)) return;
        toggleSettings(false);
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !panel.hidden) toggleSettings(false);
      });
    }
    if (cbNL) cbNL.addEventListener('change', () => {
      _miniSettings.showNodeLabels = !!cbNL.checked;
      persistMiniSettings();
      applyMiniNodeLabelVisibility();
    });
    if (cbEL) cbEL.addEventListener('change', () => {
      _miniSettings.showEdgeLabels = !!cbEL.checked;
      persistMiniSettings();
      applyMiniEdgeLabelVisibility();
    });
    if (cbLG) cbLG.addEventListener('change', () => {
      _miniSettings.showLegend = !!cbLG.checked;
      persistMiniSettings();
      renderMiniLegend();
    });
  }

  function render() {
    renderFilters();
    if (state.view === 'ideas') renderIdeas();
    else if (state.view === 'plans') renderPlans();
    else if (state.view === 'requirements') renderIdeas();  // sidebar filters → main idea list
    else if (state.view === 'kpis') renderIdeas();
    else if (state.view === 'models') renderModels();
    else if (state.view === 'datasets') renderDatasets();
    else if (state.view === 'graph') {
      ensureGraphLoaded().then(() => {
        // Re-scope every time the user enters Graph — they may have
        // changed filters in another view since the last activation.
        if (window.idealabGraph?.scopeTo) {
          window.idealabGraph.scopeTo(computeGraphSeedFromFilters());
        }
      }).catch(err => {
        console.error('Graph view failed to load:', err);
        const hud = document.getElementById('graphHudStatus');
        if (hud) hud.textContent = 'Failed to load Graph view: ' + err.message;
      });
    }
    // If the mini graph is open, re-scope it to the current filters too.
    // Cheap when no filter changed (force-graph dedups by node identity).
    if (state.view !== 'graph' && _miniFg && isMiniGraphExpanded()) {
      applyMiniGraphScope();
    }
  }

  // ====================================================================
  //  Search
  // ====================================================================

  // FTS5 search via the official @sqlite.org/sqlite-wasm build (ships with
  // SQLITE_ENABLE_FTS5 defined). Returns a Set<idea_uuid> that matchesIdea()
  function applySearch(q) {
    state.query = q;
    // FTS5 only powers the Ideas view; Plans/Requirements/KPIs do substring
    // matching against their own fields, so we only set state.searchHits
    // when there's an idea-side query to run.
    if (!q || !q.trim()) {
      state.searchHits = null;
    } else {
      try {
        state.searchHits = state.db.searchIdeaUuids(q);
      } catch (err) {
        console.warn('FTS5 query failed:', err);
        state.searchHits = new Set();
      }
    }
    render();
  }

  function attachEvents() {
    const search = document.getElementById('search');
    let debounceTimer;
    search.addEventListener('input', e => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => applySearch(e.target.value), 120);
    });

    document.getElementById('clearFilters').addEventListener('click', () => {
      for (const facet of FACETS) state.filters[facet].clear();
      for (const facet of VOCAB_FACETS) state.vocabFilters[facet].clear();
      state.kindFilter = 'all';
      state.query = '';
      state.searchHits = null;
      state.selectedTaskSlugs.clear();
      state.selectedDatasetTaskSlugs.clear();
      state.selectedModalitySlugs.clear();
      search.value = '';
      render();
    });

    const sidebar = document.getElementById('sidebar');
    document.getElementById('sidebarToggle').addEventListener('click', () => sidebar.classList.toggle('open'));

    document.getElementById('viewIdeas').addEventListener('click', () => setView('ideas'));
    document.getElementById('viewPlans').addEventListener('click', () => setView('plans'));
    const viewReq = document.getElementById('viewRequirements');
    const viewKpis = document.getElementById('viewKpis');
    const viewModels = document.getElementById('viewModels');
    if (viewReq) viewReq.addEventListener('click', () => setView('requirements'));
    if (viewKpis) viewKpis.addEventListener('click', () => setView('kpis'));
    if (viewModels) viewModels.addEventListener('click', () => setView('models'));
    const viewDatasets = document.getElementById('viewDatasets');
    if (viewDatasets) viewDatasets.addEventListener('click', () => setView('datasets'));
    const viewGraph = document.getElementById('viewGraph');
    if (viewGraph) viewGraph.addEventListener('click', () => setView('graph'));

    document.getElementById('planModal').addEventListener('click', e => {
      if (e.target.matches('[data-close]')) closePlanModal();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !document.getElementById('planModal').hidden) closePlanModal();
    });
  }

  // ====================================================================
  //  Bootstrap: load DB + plans, then render
  // ====================================================================

  async function loadIdeasFromDb() {
    const db = await CatalogDb.open();   // fetches catalog.sqlite + sql-wasm
    state.db = db;

    const ideaRows = db.allIdeasJoined();
    const ideas = ideaRows.map(normalizeIdeaRow);

    const reqs = db.listRequirements();
    const kpis = db.listKpis();
    const ents = db.listEntities();
    for (const r of reqs) state.requirementsByUuid.set(r.uuid, r);
    for (const k of kpis) state.kpisByUuid.set(k.uuid, k);
    for (const e of ents) state.entitiesByUuid.set(e.uuid, e);
    state.requirements = reqs;
    state.kpis = kpis;

    // Pre-compute how many ideas address each requirement / move each KPI,
    // so the Requirements / KPIs views render instantly.
    for (const idea of ideas) {
      for (const u of idea.requirementUuids) {
        state.ideaCountByRequirementUuid.set(u, (state.ideaCountByRequirementUuid.get(u) || 0) + 1);
      }
      for (const u of idea.kpiUuids) {
        state.ideaCountByKpiUuid.set(u, (state.ideaCountByKpiUuid.get(u) || 0) + 1);
      }
    }

    return ideas;
  }

  async function loadModalities() {
    try {
      const res = await fetch('data/dataset_modalities.json', { cache: 'no-store' });
      if (!res.ok) return [];
      return await res.json();
    } catch (_e) { return []; }
  }

  async function loadTasks() {
    try {
      const res = await fetch('data/tasks.json', { cache: 'no-store' });
      if (!res.ok) return [];
      const arr = await res.json();
      // Pre-bucket by category for the picker; skip Models-irrelevant entries.
      const byCat = new Map();
      for (const t of arr) {
        if (!byCat.has(t.category)) byCat.set(t.category, []);
        byCat.get(t.category).push(t);
      }
      state.tasksByCategory = byCat;
      return arr;
    } catch (_e) {
      return [];
    }
  }

  async function loadPlans() {
    const idxRes = await fetch('plans/index.json', { cache: 'no-store' });
    if (!idxRes.ok) throw new Error(`plans/index.json: HTTP ${idxRes.status}`);
    const files = await idxRes.json();
    const fetches = files.map(async f => {
      const r = await fetch(`plans/${f}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`plans/${f}: HTTP ${r.status}`);
      const t = await r.text();
      return parsePlan(f, t);
    });
    return Promise.all(fetches);
  }

  async function load() {
    const loading = document.getElementById('loadingMsg');
    const errorBox = document.getElementById('errorMsg');
    try {
      const [ideas, plans, tasks, modalities] = await Promise.all([
        loadIdeasFromDb(), loadPlans(), loadTasks(), loadModalities(),
      ]);
      if (ideas.length === 0) throw new Error('Catalog database is empty.');
      state.ideas = ideas;
      state.plans = plans;
      state.tasks = tasks;
      state.modalities = modalities;
      loading.hidden = true;
      attachEvents();
      attachMiniGraphHandlers();
      render();
    } catch (err) {
      loading.hidden = true;
      errorBox.hidden = false;
      const isFileProtocol = window.location.protocol === 'file:';
      errorBox.innerHTML = `
        <strong>Could not load catalog data.</strong><br>
        ${escapeHtml(err.message)}
        ${isFileProtocol ? `<br><br>Open the app from <code>http://localhost:…</code>, not <code>file://</code> — browsers block local fetches. From the project folder:<br><code>python3 -m http.server 8000</code>` : ''}`;
    }
  }

  document.addEventListener('DOMContentLoaded', load);
})();
