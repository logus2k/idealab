# Parallel population guide

For the thread responsible for **growing the catalog** while the graph-development thread builds the graph layer in parallel. Target: **3,000–5,000 ideas** (currently 236).

This document is what you need to know to add data without stepping on the graph thread's work and without breaking the build. It's intentionally self-contained — the only other thing worth reading first is [`MEMORY.md`](../../../../.claude/projects/-home-logus-env-labs-idealab/memory/MEMORY.md) for the high-level architecture pointers.

Related but optional: [`graph_planning.md`](graph_planning.md) — what the graph thread is doing, for context only. You don't need to read it to do your work.

---

## Ownership boundary

| You own (write & grow) | Graph thread owns (don't touch) |
|---|---|
| New ideas in `data/ideas.json` | `data/tasks.json` (HF-derived, regenerable) |
| New entries in `data/requirements.json` (where genuinely new) | `data/dataset_modalities.json`, `data/dataset_formats.json` (HF-derived) |
| New entries in `data/kpis.json` (where genuinely new) | `data/fetched/`, `data/raw/` (fetcher output, gitignored) |
| New companies/vendors in `data/entities.json` | `vendor/`, `services/hf-fetcher/` |
| Prose in `ideas_catalog.md` (append-only — see §Markdown below) | `scripts/build_graph.py` (not yet created — will be) |
| New plan markdowns in `plans/` + `plans/index.json` | `data/plans.json` (graph thread will create this with `uuidgen` UUIDs) |
| **In `data/links.json`** — `idea_requirements`, `idea_kpis`, `idea_entities` arrays | **In `data/links.json`** — `idea_tasks`, `idea_models`, `idea_datasets`, `plan_models`, `plan_datasets`, `plan_ideas`, `plan_requirements`, `plan_kpis` (graph thread will populate these) |

**Conflict-avoidance rule:** `data/links.json` is shared but partitioned by *key*. As long as both threads only touch their own keys, JSON merges are clean. If you ever need to *delete* an idea, coordinate first — its UUID may be referenced from a key the graph thread owns.

---

## Conventions you must follow

These are non-negotiable because the SQLite build pipeline and the eventual graph rely on them.

### UUIDs

- Every entity (idea, requirement, kpi, entity, plan) has a `uuid` field — **random UUIDv4**, generated with `uuidgen`. Never regenerate or rewrite an existing UUID. References would silently break.
- Slugs (`slug` field) are stable handles too — once committed, don't rename. If a slug was a typo and is unreferenced, you may correct it; otherwise leave it.

### Slug shape

- Lowercase, kebab-case, ASCII only. Derived from the label/title but de-duplicated when collisions happen.
- Slugs are unique *within* their entity type. Cross-type collisions are fine (an idea and a requirement can share a slug; they're disambiguated by UUID + type).

### Titles / labels

- Idea `title` must **exactly match** the bullet text in `ideas_catalog.md` (excluding the `**` markers, but **including** any parenthetical right after the bold title). The build script joins markdown to JSON by title string. Rename in either place → silent desync.
- Three known examples of titles with parentheticals already handled correctly: `Self-service commerce bot (Walmart pattern)`, `Marketing throughput multiplier (Newman's Own pattern)`, `Proprietary information-agent platform (à la Bain's "Sage")`. Follow that pattern when needed.

### Idea `kind`

- Either `"idea"` (concrete deployable solution) or `"pattern"` (cross-cutting capability / framework / market-stat entry). Default to `"idea"`. Use `"pattern"` for cross-section bullets that describe a *capability* rather than an *implementation* (e.g. "Internal MyGPT marketplace" is a pattern; "Self-service commerce bot" is an idea). Patterns are exempt from `idea_requirements` / `idea_kpis` coverage by design — the validator won't warn on them.

### Vocabulary discipline

- Before adding a new requirement / KPI / entity / vendor, **reuse an existing one if it fits**. The whole point of the controlled vocabulary is cross-idea matchability. Vocabulary sprawl breaks the graph and the navigation experience.
- Only add a new vocab entry when nothing existing matches the concept genuinely.
- Same goes for entities: one canonical entry per real-world company/vendor. Don't create `Walmart` and `Walmart Inc.` and `walmart-corp`.

### KPI categories (incoming change)

- The graph thread is adding a `category` field to every KPI in `data/kpis.json`. Buckets: `revenue-and-growth`, `operational-efficiency`, `customer-experience`, `cost-and-margin`, `risk-and-compliance`, `talent-and-productivity`, `quality-and-accuracy`.
- **You should NOT add this field to new KPIs you create** — leave it out, and the graph thread will sweep through and classify in batch. This avoids two threads disagreeing on the same KPI's category.

---

## Data file shapes (quick reference)

```jsonc
// data/ideas.json — one entry per idea concept
{
  "uuid": "0275f620-75ea-42ed-ba71-a1204708de98",
  "slug": "conversational-shopping-assistant",
  "title": "Conversational shopping assistant",     // EXACT match to markdown bullet
  "section": "1. Sales, Marketing & Customer Experience",
  "kind": "idea"                                    // "idea" | "pattern"
}

// data/requirements.json — controlled vocabulary of pain points
{
  "uuid": "...",
  "slug": "shopping-guidance-gap",
  "label": "Shopping guidance gap",
  "description": "Buyers can't easily compare options …"
}

// data/kpis.json — controlled vocabulary of metrics (category field coming)
{
  "uuid": "...",
  "slug": "conversion-rate",
  "label": "Conversion rate",
  "description": "Share of visitors / leads / sessions that complete a target action."
  // "category": <NOT YOU — graph thread adds this in a sweep>
}

// data/entities.json — companies + vendors
{
  "uuid": "...",
  "slug": "carrefour",
  "name": "Carrefour",
  "type": "company"             // "company" | "vendor"
}
```

```jsonc
// data/links.json — shared file, partitioned by key
{
  "idea_requirements":  [...],   // YOU touch
  "idea_kpis":          [...],   // YOU touch
  "idea_entities":      [...],   // YOU touch
  "idea_tasks":         [...],   // graph thread — DO NOT TOUCH
  "idea_models":        [...],   // graph thread — DO NOT TOUCH
  "idea_datasets":      [...],   // graph thread — DO NOT TOUCH
  "plan_ideas":         [...],   // graph thread (once plans.json lands) — DO NOT TOUCH
  "plan_requirements":  [...],   // graph thread — DO NOT TOUCH
  "plan_kpis":          [...],   // graph thread — DO NOT TOUCH
  "plan_models":        [...],   // graph thread — DO NOT TOUCH
  "plan_datasets":      [...]    // graph thread — DO NOT TOUCH
}
```

Row shape inside `idea_requirements` / `idea_kpis` / `idea_entities`:
```json
{ "idea": "<idea-uuid>", "requirements": ["<req-uuid>", "<req-uuid>", …] }
{ "idea": "<idea-uuid>", "kpis":         ["<kpi-uuid>", …] }
{ "idea": "<idea-uuid>", "entities":     ["<entity-uuid>", …] }
```

---

## Markdown integration (`ideas_catalog.md`)

`ideas_catalog.md` is the **prose source of truth** for an idea's description, source citation, and the six tag facets. The build pipeline joins it to `data/ideas.json` by **exact title match**.

For each new idea you add to `data/ideas.json`, add a matching bullet to `ideas_catalog.md` under the right `## N. <section name>` section:

```markdown
- **Exact title from data/ideas.json** — Description sentence. *Source: Publisher "Article title" ([link](https://...)).* **Tags:** `function/<value>` `industry/<value>` `tech/<value>` `audience/<value>` `value/<value>` `maturity/<value>`
```

**Rules:**

- Title in markdown (between `**...**` and the em-dash) must **match the JSON `title` exactly** — including any parenthetical after the title.
- The 6 tag facets (function/industry/tech/audience/value/maturity) are inline backtick-wrapped values after `**Tags:**`. Their canonical vocabularies are in the markdown's Taxonomy section at the top; reuse those values when possible.
- One source citation per bullet (multiple sources separated by `;` inside the `*Source: …*` block is fine).
- **DO NOT renumber sections** in `ideas_catalog.md`. If you need a new section beyond what exists, append it numbered next (the catalog goes up through 32 today; new sections start at 33 onwards).
- **DO NOT embed UUIDs in markdown** — that's a memory-rule violation. The markdown stays prose-only; UUIDs live exclusively in `data/`.

The section name in `data/ideas.json` field is the `"N. Name"` text (e.g. `"1. Sales, Marketing & Customer Experience"`) — match this to the `##` header in markdown.

---

## New entries: minimum required links

When you add a new idea (kind=`idea`, not pattern):

- **At least 1 `idea_requirements` entry** — what pain does it solve? Reuse vocabulary aggressively.
- **At least 1 `idea_kpis` entry** — what does it move? Same.
- **0-N `idea_entities` entries** — only when the idea cites specific companies / vendors as proof points.

When you add a new idea with kind=`pattern`: req/kpi links are optional. Patterns are exempt from coverage warnings.

The validator (`scripts/validate_data.py`) will warn (not error) if a concrete `idea` lacks requirement or KPI links — you'll see those warnings in the output but the build still succeeds. Aim for zero warnings on your additions.

---

## Plans

Plans live as markdown files under `plans/`, with YAML frontmatter (see existing files for the shape). Order is controlled by `plans/index.json`.

- You can add new plan markdowns and append the filename to `plans/index.json`.
- The graph thread will create `data/plans.json` (a UUID-keyed registry) — until then, plans are markdown-only and the SQLite `plans` table builds empty (that's expected).
- **Once `data/plans.json` exists, DO NOT modify it from this thread** — the graph thread owns that file and the corresponding `plan_*` links in `data/links.json`. Coordinate over chat first.

---

## Validation & build (always run before committing)

```bash
# from project root
python3 scripts/validate_data.py        # 0 errors required; warnings tolerable for in-progress entries
python3 scripts/build_sqlite.py         # produces public/catalog.sqlite — must succeed
python3 scripts/smoke_test.py           # confirms counts + FTS5 + sample joins
```

If `validate_data.py` reports errors, fix them before committing:
- "duplicate uuid / slug" → you probably copy-pasted; regenerate the UUID with `uuidgen`.
- "unknown idea/requirement/kpi" in a link → typo in the UUID reference.
- "no markdown match" warnings during build → the title in JSON doesn't match the markdown bullet; fix one of them.

---

## Things to flag back to chat (not blocking — just FYI)

- You added more than ~5 new vocab entries (requirements / KPIs / entities) in one batch — worth a sanity-check that you're not re-introducing things that already exist.
- You added a new section to `ideas_catalog.md` (33+) — let the graph thread know so the build's section-by-section indexes get updated.
- You hit a slug collision that needed disambiguation — what suffix you chose.
- You're adding so many plans you want the plans.json registry created sooner — say so.

---

## Quick fingertip references

| What | Where |
|---|---|
| Source of truth for an idea's prose | `ideas_catalog.md` (matched by title) |
| Source of truth for vocab | `data/{ideas,requirements,kpis,entities}.json` (UUID-keyed) |
| Cross-references | `data/links.json` (partitioned by key) |
| Build artifact | `public/catalog.sqlite` (gitignored) |
| Live data the fetcher writes | `data/fetched/` (gitignored) |
| Project memory | `~/.claude/projects/-home-logus-env-labs-idealab/memory/MEMORY.md` |
| Architecture overview | `MEMORY.md` + the 3 memory notes it indexes |
| Graph plan | `documents/graph_planning.md` (optional context) |

---

*Last revised: 2026-05-19. Update inline as conventions evolve. Cross-thread coordination notes go in chat, not in this file.*
