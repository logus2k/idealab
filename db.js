// db.js — Official SQLite-Wasm loader + CatalogDb query API for catalog.sqlite.
//
// Uses @sqlite.org/sqlite-wasm (the SQLite team's official Wasm build), which
// ships with FTS5 enabled — unlike the more popular `sql.js`, whose default
// build does not include FTS5. The runtime cost is a ~1.5 MB .wasm payload
// fetched once and HTTP-cached after that.
//
// Loaded as a classic <script>; exposes `window.CatalogDb` with `.open(opts)`.
//
// Quick usage (browser console / app.js):
//   const cat = await CatalogDb.open();
//   cat.countIdeas();                                   // → 236
//   cat.searchIdeaUuids('agentic OR copilot');          // → Set<uuid>
//   cat.listIdeas({ tags: { industry: ['retail'] } });
//
(() => {
  'use strict';

  // Vendored locally under /vendor/sqlite-wasm/ so the app has zero external
  // runtime dependencies. To update: see vendor/sqlite-wasm/README.md.
  const DEFAULT_WASM_BASE = 'vendor/sqlite-wasm/';
  const DEFAULT_WASM_ENTRY = 'index.mjs';

  const VALID_FACETS = new Set([
    'function', 'industry', 'tech', 'audience', 'value', 'maturity',
  ]);

  // ---------- bootstrap ----------

  async function open(opts = {}) {
    const {
      wasmBase = DEFAULT_WASM_BASE,
      sqliteUrl = 'catalog.sqlite',
      fetchInit = { cache: 'force-cache' },
    } = opts;

    // Dynamic import works from a classic <script> in modern browsers, but
    // the specifier must be a real URL (a bare path like 'vendor/x.mjs' is
    // treated as a module identifier and rejected). Resolve against
    // document.baseURI so the resulting URL is always absolute.
    const baseUrl  = new URL(wasmBase, document.baseURI).href;
    const entryUrl = new URL(DEFAULT_WASM_ENTRY, baseUrl).href;
    const mod = await import(/* @vite-ignore */ entryUrl);
    const sqlite3 = await mod.default({
      // Tell Emscripten where to fetch sqlite3.wasm from — also as an
      // absolute URL so it resolves regardless of the page's location.
      locateFile: (filename) => baseUrl + filename,
      // Silence the default "OPFS not available" warning — we don't use OPFS.
      print: () => {},
      printErr: (m) => {
        if (typeof m === 'string' && m.includes('OPFS')) return;
        console.error('[sqlite-wasm]', m);
      },
    });

    // Production (Caddy) serves the DB at /catalog.sqlite. Dev (python -m
    // http.server from repo root) serves it under /public/. Try one, then
    // the other so the same code works both places.
    let res = await fetch(sqliteUrl, fetchInit);
    if (!res.ok && sqliteUrl === 'catalog.sqlite') {
      res = await fetch('public/catalog.sqlite', fetchInit);
    }
    if (!res.ok) {
      throw new Error('Failed to fetch catalog.sqlite: HTTP ' + res.status);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());

    // Open an empty in-memory DB, then deserialize the fetched bytes into it.
    // SQLITE_DESERIALIZE_FREEONCLOSE makes sqlite take ownership of the
    // allocated buffer so it's freed when we close the DB.
    const db = new sqlite3.oo1.DB();
    const ptr = sqlite3.wasm.allocFromTypedArray(bytes);
    const flags =
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE |
      sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE;
    const rc = sqlite3.capi.sqlite3_deserialize(
      db.pointer, 'main', ptr, bytes.length, bytes.length, flags
    );
    if (rc) {
      const msg = sqlite3.capi.sqlite3_errmsg(db.pointer) || ('rc=' + rc);
      throw new Error('sqlite3_deserialize failed: ' + msg);
    }

    return new CatalogDb(db, sqlite3);
  }

  // ---------- query helpers ----------

  function selectAll(db, sql, params) {
    // OO1's selectObjects accepts {$name: value} maps identical to the
    // placeholders we write in SQL, so we can keep the same call sites.
    return db.selectObjects(sql, params);
  }

  function selectOne(db, sql, params) {
    const rows = db.selectObjects(sql, params);
    return rows[0] || null;
  }

  // Convert a free-text query to a forgiving FTS5 MATCH expression. Each
  // whitespace-separated token is quoted and made a prefix; tokens are
  // implicitly AND-ed. Uppercase keywords (OR/AND/NOT/NEAR) pass through so
  // power users can compose them.
  function buildFtsQuery(q) {
    return q.split(/\s+/).filter(Boolean)
      .map(t => /^(OR|AND|NOT|NEAR)$/.test(t)
        ? t
        : '"' + t.replace(/"/g, '""') + '"*')
      .join(' ');
  }

  // ---------- CatalogDb ----------

  class CatalogDb {
    constructor(db, sqlite3) {
      this.db = db;
      this.sqlite3 = sqlite3;
    }

    close() {
      try { this.db.close(); } catch (_) {}
    }

    // ---------- Single-entity reads ----------

    countIdeas() {
      return selectOne(this.db, 'SELECT COUNT(*) AS n FROM ideas').n;
    }

    listSections() {
      return selectAll(this.db, `
        SELECT section_no, section_name, COUNT(*) AS n
        FROM ideas
        GROUP BY section_no, section_name
        ORDER BY section_no`);
    }

    listRequirements() {
      return selectAll(this.db, 'SELECT * FROM requirements ORDER BY label');
    }

    listKpis() {
      return selectAll(this.db, 'SELECT * FROM kpis ORDER BY label');
    }

    listEntities() {
      return selectAll(this.db, 'SELECT * FROM entities ORDER BY type, name');
    }

    listPlans() {
      return selectAll(this.db,
        'SELECT * FROM plans ORDER BY COALESCE(order_idx, 1e9), title');
    }

    tagCounts() {
      return selectAll(this.db, `
        SELECT facet, value, COUNT(DISTINCT idea_uuid) AS n
        FROM idea_tags
        GROUP BY facet, value
        ORDER BY facet, value`);
    }

    // Bulk-load every idea joined with its tags, requirements, KPIs, and
    // entities — concatenated into pipe-delimited strings so we get one row
    // per idea. Designed for an in-memory cache the UI then filters/sorts.
    allIdeasJoined() {
      return selectAll(this.db, `
        SELECT
          i.uuid, i.slug, i.title, i.section_no, i.section_name,
          i.description, i.source_md, i.is_sub, i.kind,
          (SELECT GROUP_CONCAT(facet || '/' || value, '|')
             FROM idea_tags WHERE idea_uuid = i.uuid) AS tags_concat,
          (SELECT GROUP_CONCAT(requirement_uuid, '|')
             FROM idea_requirements WHERE idea_uuid = i.uuid) AS req_uuids,
          (SELECT GROUP_CONCAT(kpi_uuid, '|')
             FROM idea_kpis WHERE idea_uuid = i.uuid) AS kpi_uuids,
          (SELECT GROUP_CONCAT(entity_uuid, '|')
             FROM idea_entities WHERE idea_uuid = i.uuid) AS ent_uuids
        FROM ideas i
        ORDER BY i.section_no, i.title`);
    }

    // Returns the Set of idea_uuids matching an FTS5 query. Caller intersects
    // with their in-memory list. Returns null on empty query.
    searchIdeaUuids(query) {
      if (!query || !query.trim()) return null;
      const rows = selectAll(this.db,
        'SELECT idea_uuid FROM ideas_fts WHERE ideas_fts MATCH $q',
        { $q: buildFtsQuery(query.trim()) });
      return new Set(rows.map(r => r.idea_uuid));
    }

    // ---------- Idea list with composable filters ----------

    listIdeas(opts = {}) {
      const {
        search, sectionNo, tags, requirements, kpis, entities, kind,
        limit = 1000, offset = 0,
      } = opts;

      const where = [];
      const params = {};

      if (sectionNo != null) {
        where.push('i.section_no = $sectionNo');
        params.$sectionNo = sectionNo;
      }

      if (kind) {
        where.push('i.kind = $kind');
        params.$kind = kind;
      }

      if (search && search.trim()) {
        where.push(
          'i.uuid IN (SELECT idea_uuid FROM ideas_fts WHERE ideas_fts MATCH $search)'
        );
        params.$search = buildFtsQuery(search.trim());
      }

      // Tags: AND across facets, OR within a facet.
      if (tags) {
        for (const facet of Object.keys(tags)) {
          if (!VALID_FACETS.has(facet)) continue;
          const values = tags[facet];
          if (!Array.isArray(values) || values.length === 0) continue;
          const placeholders = values.map((_, i) => `$tag_${facet}_${i}`);
          values.forEach((v, i) => { params[placeholders[i]] = v; });
          where.push(
            `i.uuid IN (SELECT idea_uuid FROM idea_tags ` +
            `WHERE facet = '${facet}' AND value IN (${placeholders.join(',')}))`
          );
        }
      }

      if (requirements && requirements.length) {
        const ph = requirements.map((_, i) => `$req_${i}`);
        requirements.forEach((v, i) => { params[ph[i]] = v; });
        where.push(
          `i.uuid IN (SELECT idea_uuid FROM idea_requirements ` +
          `WHERE requirement_uuid IN (${ph.join(',')}))`
        );
      }

      if (kpis && kpis.length) {
        const ph = kpis.map((_, i) => `$kpi_${i}`);
        kpis.forEach((v, i) => { params[ph[i]] = v; });
        where.push(
          `i.uuid IN (SELECT idea_uuid FROM idea_kpis ` +
          `WHERE kpi_uuid IN (${ph.join(',')}))`
        );
      }

      if (entities && entities.length) {
        const ph = entities.map((_, i) => `$ent_${i}`);
        entities.forEach((v, i) => { params[ph[i]] = v; });
        where.push(
          `i.uuid IN (SELECT idea_uuid FROM idea_entities ` +
          `WHERE entity_uuid IN (${ph.join(',')}))`
        );
      }

      const sql =
        'SELECT i.* FROM ideas i' +
        (where.length ? ' WHERE ' + where.join(' AND ') : '') +
        ' ORDER BY i.section_no, i.title' +
        ' LIMIT $limit OFFSET $offset';
      params.$limit = limit;
      params.$offset = offset;

      return selectAll(this.db, sql, params);
    }

    // ---------- Idea detail (joined view) ----------

    ideaDetails(ideaUuid) {
      const idea = selectOne(this.db,
        'SELECT * FROM ideas WHERE uuid = $u', { $u: ideaUuid });
      if (!idea) return null;
      idea.tags = selectAll(this.db,
        'SELECT facet, value FROM idea_tags WHERE idea_uuid = $u ORDER BY facet, value',
        { $u: ideaUuid });
      idea.requirements = selectAll(this.db, `
        SELECT r.uuid, r.slug, r.label, r.description
        FROM requirements r
        JOIN idea_requirements ir ON ir.requirement_uuid = r.uuid
        WHERE ir.idea_uuid = $u
        ORDER BY r.label`, { $u: ideaUuid });
      idea.kpis = selectAll(this.db, `
        SELECT k.uuid, k.slug, k.label, k.description
        FROM kpis k
        JOIN idea_kpis ik ON ik.kpi_uuid = k.uuid
        WHERE ik.idea_uuid = $u
        ORDER BY k.label`, { $u: ideaUuid });
      idea.entities = selectAll(this.db, `
        SELECT e.uuid, e.slug, e.name, e.type
        FROM entities e
        JOIN idea_entities ie ON ie.entity_uuid = e.uuid
        WHERE ie.idea_uuid = $u
        ORDER BY e.name`, { $u: ideaUuid });
      return idea;
    }

    // ---------- Demand-side matching ----------

    // Given a set of requirement UUIDs (the pain points a user describes),
    // return ideas ranked by how many of those requirements they address.
    ideasForRequirements(requirementUuids, { limit = 25 } = {}) {
      if (!requirementUuids || !requirementUuids.length) return [];
      const ph = requirementUuids.map((_, i) => `$r${i}`);
      const params = {};
      requirementUuids.forEach((v, i) => { params[ph[i]] = v; });
      params.$limit = limit;
      return selectAll(this.db, `
        SELECT i.*, COUNT(*) AS match_count
        FROM idea_requirements ir
        JOIN ideas i ON i.uuid = ir.idea_uuid
        WHERE ir.requirement_uuid IN (${ph.join(',')})
        GROUP BY i.uuid
        ORDER BY match_count DESC, i.section_no, i.title
        LIMIT $limit`, params);
    }

    // ---------- Metadata ----------

    meta() {
      const rows = selectAll(this.db, 'SELECT key, value FROM meta');
      return Object.fromEntries(rows.map(r => [r.key, r.value]));
    }
  }

  window.CatalogDb = { open, CatalogDb };
})();
