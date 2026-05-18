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

  // ====================================================================
  //  State
  // ====================================================================

  const state = {
    view: 'ideas',                 // 'ideas' | 'plans'
    db: null,                      // CatalogDb instance

    ideas: [],                     // array of normalized idea objects
    plans: [],                     // parsed from plans/*.md
    requirementsByUuid: new Map(), // uuid → {uuid, slug, label, description}
    kpisByUuid: new Map(),
    entitiesByUuid: new Map(),

    filters: Object.fromEntries(FACETS.map(f => [f, new Set()])),     // tag facets
    vocabFilters: Object.fromEntries(VOCAB_FACETS.map(f => [f, new Set()])), // req/kpi/entity uuids
    kindFilter: 'all',             // 'all' | 'idea' | 'pattern'

    query: '',
    searchHits: null,              // Set<idea_uuid> from FTS5, or null
    collapsedFacets: new Set(),
    vocabFacetSearch: { requirement: '', kpi: '', entity: '' },
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
    return state.view === 'ideas' ? state.ideas : state.plans;
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
      { v: 'idea', label: 'Concrete ideas' },
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

    const options = document.createElement('div');
    options.className = 'vocab-options';
    for (const e of visible) {
      const isSelected = state.vocabFilters[facet].has(e.uuid);
      const liveCount = isSelected ? e.count : countWithVocab(facet, e.uuid);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'vocab-chip facet-' + facet + (isSelected ? ' selected' : '') + ((liveCount === 0 && !isSelected) ? ' zero' : '');
      const typeBadge = e.typeChip ? `<span class="vocab-type">${e.typeChip}</span>` : '';
      chip.innerHTML = `${typeBadge}<span class="vocab-label">${escapeHtml(e.displayName)}</span> <span class="count">${liveCount}</span>`;
      if (e.description) chip.title = e.description;
      chip.addEventListener('click', () => {
        if (state.vocabFilters[facet].has(e.uuid)) state.vocabFilters[facet].delete(e.uuid);
        else state.vocabFilters[facet].add(e.uuid);
        render();
      });
      options.appendChild(chip);
    }
    group.appendChild(options);

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

  function renderActiveSummary() {
    const root = document.getElementById('activeSummary');
    const parts = [];
    for (const facet of FACETS) {
      if (state.filters[facet].size > 0) {
        parts.push(`<strong>${FACET_LABELS[facet]}:</strong> ${[...state.filters[facet]].join(', ')}`);
      }
    }
    if (state.kindFilter !== 'all') {
      parts.push(`<strong>Kind:</strong> ${state.kindFilter}`);
    }
    for (const facet of VOCAB_FACETS) {
      const sel = state.vocabFilters[facet];
      if (sel.size === 0) continue;
      const map = facet === 'requirement' ? state.requirementsByUuid
                : facet === 'kpi' ? state.kpisByUuid
                : state.entitiesByUuid;
      const labels = [...sel].map(u => {
        const e = map.get(u);
        return e ? (e.label || e.name) : u;
      });
      parts.push(`<strong>${VOCAB_LABELS[facet]}:</strong> ${labels.join(', ')}`);
    }
    root.innerHTML = parts.join(' · ');
    const hasAny = parts.length > 0 || state.query;
    document.getElementById('clearFilters').disabled = !hasAny;
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

    const bySection = new Map();
    for (const idea of filtered) {
      const key = `${idea.sectionNo}|${idea.sectionName}`;
      if (!bySection.has(key)) bySection.set(key, { sectionNo: idea.sectionNo, sectionName: idea.sectionName, items: [] });
      bySection.get(key).items.push(idea);
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
        ${items.map(idea => renderIdeaCard(idea, q)).join('')}
      </section>`).join('');

    root.innerHTML = html;
    wireIdeaCardEvents(root);
  }

  function renderIdeaCard(idea, query) {
    const titleHtml = highlight(escapeHtml(idea.title), query);
    const descHtml = highlight(inlineMd(idea.descriptionMd), query);
    const sourceHtml = idea.sourceMd
      ? `<div class="idea-source">Source: ${highlight(inlineMd(idea.sourceMd), query)}</div>`
      : '';

    const kindBadge = idea.kind === 'pattern'
      ? `<span class="kind-badge kind-pattern" title="Cross-cutting capability / framework">pattern</span>`
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
        <h3 class="idea-title">${kindBadge}${titleHtml}</h3>
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
    document.getElementById('viewIdeas').classList.toggle('active', view === 'ideas');
    document.getElementById('viewPlans').classList.toggle('active', view === 'plans');
    document.getElementById('viewIdeas').setAttribute('aria-selected', view === 'ideas' ? 'true' : 'false');
    document.getElementById('viewPlans').setAttribute('aria-selected', view === 'plans' ? 'true' : 'false');
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function render() {
    renderFilters();
    if (state.view === 'ideas') renderIdeas();
    else renderPlans();
  }

  // ====================================================================
  //  Search
  // ====================================================================

  // FTS5 search via the official @sqlite.org/sqlite-wasm build (ships with
  // SQLITE_ENABLE_FTS5 defined). Returns a Set<idea_uuid> that matchesIdea()
  function applySearch(q) {
    state.query = q;
    if (!q || !q.trim()) {
      state.searchHits = null;
      render();
      return;
    }
    try {
      state.searchHits = state.db.searchIdeaUuids(q);
    } catch (err) {
      console.warn('FTS5 query failed:', err);
      state.searchHits = new Set();
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
      search.value = '';
      render();
    });

    const sidebar = document.getElementById('sidebar');
    document.getElementById('sidebarToggle').addEventListener('click', () => sidebar.classList.toggle('open'));

    document.getElementById('viewIdeas').addEventListener('click', () => setView('ideas'));
    document.getElementById('viewPlans').addEventListener('click', () => setView('plans'));

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

    for (const r of db.listRequirements()) state.requirementsByUuid.set(r.uuid, r);
    for (const k of db.listKpis()) state.kpisByUuid.set(k.uuid, k);
    for (const e of db.listEntities()) state.entitiesByUuid.set(e.uuid, e);

    return ideas;
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
      const [ideas, plans] = await Promise.all([loadIdeasFromDb(), loadPlans()]);
      if (ideas.length === 0) throw new Error('Catalog database is empty.');
      state.ideas = ideas;
      state.plans = plans;
      loading.hidden = true;
      attachEvents();
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
