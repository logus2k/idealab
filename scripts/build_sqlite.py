#!/usr/bin/env python3
"""Build public/catalog.sqlite from data/*.json + ideas_catalog.md + plans/.

READ-ONLY against the data layer: this script never modifies data/*.json,
ideas_catalog.md, or plans/*.md. The SQLite file is a derived artifact.

Schema highlights (UUID-keyed, per data-relational-model memory):
  - ideas / requirements / kpis / plans       — entities
  - idea_tags                                 — markdown facets (function/industry/...)
  - idea_requirements / idea_kpis             — joins from data/links.json
  - plan_ideas / plan_requirements / plan_kpis — joins from data/links.json
  - ideas_fts / requirements_fts / kpis_fts   — FTS5 search

Markdown enriches each idea row with description, source_md, and the 6 tag
facets — looked up by exact title match against data/ideas.json. Ideas with
no markdown match still get a row (just without description/tags), so the
DB always reflects the JSON source of truth.

Plans are only inserted if data/plans.json exists (currently pending — see
the data-relational-model memory note).
"""
import json
import re
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
MD_PATH = ROOT / "ideas_catalog.md"
PLANS_DIR = ROOT / "plans"
OUT_DIR = ROOT / "public"
OUT_PATH = OUT_DIR / "catalog.sqlite"

SCHEMA = """
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE ideas (
  uuid          TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  section_no    INTEGER,
  section_name  TEXT,
  description   TEXT,
  source_md     TEXT,
  is_sub        INTEGER NOT NULL DEFAULT 0,
  kind          TEXT NOT NULL DEFAULT 'idea'  -- 'idea' | 'pattern'
);

CREATE TABLE requirements (
  uuid        TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  description TEXT,
  category    TEXT
);
CREATE INDEX idx_requirements_category ON requirements(category);

CREATE TABLE kpis (
  uuid        TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  description TEXT,
  category    TEXT
);

CREATE TABLE entities (
  uuid  TEXT PRIMARY KEY,
  slug  TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL,
  type  TEXT NOT NULL                          -- 'company' | 'vendor'
);

CREATE TABLE plans (
  uuid       TEXT PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  type       TEXT,
  file       TEXT,
  order_idx  INTEGER
);

CREATE TABLE tags (
  facet TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (facet, value)
);

CREATE TABLE idea_tags (
  idea_uuid TEXT NOT NULL REFERENCES ideas(uuid),
  facet     TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (idea_uuid, facet, value),
  FOREIGN KEY (facet, value) REFERENCES tags(facet, value)
);

CREATE TABLE idea_requirements (
  idea_uuid        TEXT NOT NULL REFERENCES ideas(uuid),
  requirement_uuid TEXT NOT NULL REFERENCES requirements(uuid),
  PRIMARY KEY (idea_uuid, requirement_uuid)
);

CREATE TABLE idea_kpis (
  idea_uuid TEXT NOT NULL REFERENCES ideas(uuid),
  kpi_uuid  TEXT NOT NULL REFERENCES kpis(uuid),
  PRIMARY KEY (idea_uuid, kpi_uuid)
);

CREATE TABLE idea_entities (
  idea_uuid   TEXT NOT NULL REFERENCES ideas(uuid),
  entity_uuid TEXT NOT NULL REFERENCES entities(uuid),
  PRIMARY KEY (idea_uuid, entity_uuid)
);

CREATE TABLE tasks (
  uuid        TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  category    TEXT,
  applies_to  TEXT             -- JSON-encoded ["models","datasets"]
);

CREATE TABLE idea_tasks (
  idea_uuid TEXT NOT NULL REFERENCES ideas(uuid),
  task_uuid TEXT NOT NULL REFERENCES tasks(uuid),
  PRIMARY KEY (idea_uuid, task_uuid)
);

CREATE TABLE idea_models (
  idea_uuid TEXT NOT NULL REFERENCES ideas(uuid),
  model_id  TEXT NOT NULL,        -- HF id string (e.g. "meta-llama/Llama-3.1-8B-Instruct")
  PRIMARY KEY (idea_uuid, model_id)
);

CREATE TABLE idea_datasets (
  idea_uuid  TEXT NOT NULL REFERENCES ideas(uuid),
  dataset_id TEXT NOT NULL,       -- HF id string
  PRIMARY KEY (idea_uuid, dataset_id)
);

CREATE TABLE plan_models (
  plan_uuid TEXT NOT NULL REFERENCES plans(uuid),
  model_id  TEXT NOT NULL,
  PRIMARY KEY (plan_uuid, model_id)
);

CREATE TABLE plan_datasets (
  plan_uuid  TEXT NOT NULL REFERENCES plans(uuid),
  dataset_id TEXT NOT NULL,
  PRIMARY KEY (plan_uuid, dataset_id)
);

CREATE TABLE plan_ideas (
  plan_uuid TEXT NOT NULL REFERENCES plans(uuid),
  idea_uuid TEXT NOT NULL REFERENCES ideas(uuid),
  PRIMARY KEY (plan_uuid, idea_uuid)
);

CREATE TABLE plan_requirements (
  plan_uuid        TEXT NOT NULL REFERENCES plans(uuid),
  requirement_uuid TEXT NOT NULL REFERENCES requirements(uuid),
  PRIMARY KEY (plan_uuid, requirement_uuid)
);

CREATE TABLE plan_kpis (
  plan_uuid TEXT NOT NULL REFERENCES plans(uuid),
  kpi_uuid  TEXT NOT NULL REFERENCES kpis(uuid),
  PRIMARY KEY (plan_uuid, kpi_uuid)
);

CREATE INDEX idx_idea_tags_facet_value     ON idea_tags(facet, value);
CREATE INDEX idx_idea_tags_idea            ON idea_tags(idea_uuid);
CREATE INDEX idx_idea_requirements_req     ON idea_requirements(requirement_uuid);
CREATE INDEX idx_idea_kpis_kpi             ON idea_kpis(kpi_uuid);
CREATE INDEX idx_idea_entities_entity      ON idea_entities(entity_uuid);
CREATE INDEX idx_ideas_section             ON ideas(section_no);
CREATE INDEX idx_ideas_kind                ON ideas(kind);
CREATE INDEX idx_entities_type             ON entities(type);
CREATE INDEX idx_plans_type                ON plans(type);
CREATE INDEX idx_kpis_category             ON kpis(category);
CREATE INDEX idx_idea_tasks_task           ON idea_tasks(task_uuid);
CREATE INDEX idx_idea_tasks_idea           ON idea_tasks(idea_uuid);
CREATE INDEX idx_idea_models_idea          ON idea_models(idea_uuid);
CREATE INDEX idx_idea_models_model         ON idea_models(model_id);
CREATE INDEX idx_idea_datasets_idea        ON idea_datasets(idea_uuid);
CREATE INDEX idx_idea_datasets_dataset     ON idea_datasets(dataset_id);
CREATE INDEX idx_plan_models_plan          ON plan_models(plan_uuid);
CREATE INDEX idx_plan_datasets_plan        ON plan_datasets(plan_uuid);

CREATE VIRTUAL TABLE ideas_fts USING fts5(
  idea_uuid UNINDEXED,
  title,
  description,
  source_md,
  tag_values,
  tokenize = 'porter unicode61'
);

CREATE VIRTUAL TABLE requirements_fts USING fts5(
  requirement_uuid UNINDEXED,
  label,
  description,
  tokenize = 'porter unicode61'
);

CREATE VIRTUAL TABLE kpis_fts USING fts5(
  kpi_uuid UNINDEXED,
  label,
  description,
  tokenize = 'porter unicode61'
);

CREATE VIRTUAL TABLE entities_fts USING fts5(
  entity_uuid UNINDEXED,
  name,
  tokenize = 'porter unicode61'
);
"""


def parse_markdown(text):
    """Return {title: {description, source_md, tags, section_no, section_name, is_sub}}.

    Bullet form: `- **Title** — Desc … *Source: …* **Tags:** `facet/value` …`
    Sub-bullet form (no bold title): `  - Desc … *Source: …* **Tags:** …`
    """
    out = {}
    section_no = None
    section_name = None
    skip = True

    for line in text.split("\n"):
        h = re.match(r"^##\s+(.+?)\s*$", line)
        if h:
            num = re.match(r"^(\d+)\.\s+(.+)$", h.group(1))
            if num:
                section_no = int(num.group(1))
                section_name = num.group(2)
                skip = False
            else:
                skip = True
                section_no = None
                section_name = None
            continue

        if skip or section_no is None:
            continue

        bold = re.match(r"^(\s*)-\s+\*\*(.+?)\*\*\s*(.*)$", line)
        plain = re.match(r"^(\s+)-\s+(.+)$", line) if not bold else None
        if not bold and not plain:
            continue

        if bold:
            indent = bold.group(1)
            title = bold.group(2)
            rest = bold.group(3)
            paren = re.match(r"^\s*\(([^)]+)\)\s*(.*)$", rest)
            if paren:
                title = f"{title} ({paren.group(1)})"
                rest = paren.group(2)
            rest = re.sub(r"^[—–-]+\s*", "", rest)
        else:
            indent = plain.group(1)
            rest = plain.group(2)
            first = re.match(r"^([^.(]+)", rest)
            title = (first.group(1).strip() if first else rest[:60]).strip()

        tags_idx = rest.find("**Tags:**")
        if tags_idx < 0:
            continue

        before_tags = rest[:tags_idx].strip()
        tags_blob = rest[tags_idx + len("**Tags:**") :]

        source_md = ""
        description = before_tags
        m = re.search(r"\*Source:\s*([\s\S]+?)\.\*", before_tags)
        if m:
            source_md = m.group(1).strip()
            description = before_tags[: m.start()].strip()

        tags = [
            (mm.group(1), mm.group(2))
            for mm in re.finditer(r"`([a-z0-9-]+)/([a-z0-9-]+)`", tags_blob)
        ]

        out[title] = {
            "description": description,
            "source_md": source_md,
            "tags": tags,
            "section_no": section_no,
            "section_name": section_name,
            "is_sub": len(indent) > 0,
        }

    return out


def section_from_string(s):
    if not s:
        return None, None
    m = re.match(r"^\s*(\d+)\.\s+(.+)$", s)
    if not m:
        return None, s
    return int(m.group(1)), m.group(2)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if OUT_PATH.exists():
        OUT_PATH.unlink()

    ideas = json.loads((DATA / "ideas.json").read_text())
    requirements = json.loads((DATA / "requirements.json").read_text())
    kpis = json.loads((DATA / "kpis.json").read_text())
    entities = (
        json.loads((DATA / "entities.json").read_text())
        if (DATA / "entities.json").exists()
        else []
    )
    tasks = (
        json.loads((DATA / "tasks.json").read_text())
        if (DATA / "tasks.json").exists()
        else []
    )
    links = json.loads((DATA / "links.json").read_text())

    plans_index_path = PLANS_DIR / "index.json"
    plans_index = (
        json.loads(plans_index_path.read_text()) if plans_index_path.exists() else []
    )

    md = parse_markdown(MD_PATH.read_text()) if MD_PATH.exists() else {}

    conn = sqlite3.connect(OUT_PATH)
    conn.executescript("PRAGMA foreign_keys = ON;")
    conn.executescript(SCHEMA)

    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?)", ("schema_version", "1")
    )
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?)",
        ("built_at", datetime.now(timezone.utc).isoformat()),
    )

    matched = 0
    unmatched = []
    for idea in ideas:
        m = md.get(idea["title"])
        if m:
            matched += 1
            section_no = m["section_no"]
            section_name = m["section_name"]
            description = m["description"]
            source_md = m["source_md"]
            is_sub = m["is_sub"]
        else:
            unmatched.append(idea["title"])
            section_no, section_name = section_from_string(idea.get("section"))
            description = None
            source_md = None
            is_sub = 0

        conn.execute(
            """INSERT INTO ideas
               (uuid, slug, title, section_no, section_name, description, source_md, is_sub, kind)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                idea["uuid"],
                idea["slug"],
                idea["title"],
                section_no,
                section_name,
                description,
                source_md,
                int(bool(is_sub)),
                idea.get("kind") or "idea",
            ),
        )

        if m:
            for facet, value in m["tags"]:
                conn.execute(
                    "INSERT OR IGNORE INTO tags (facet, value) VALUES (?, ?)",
                    (facet, value),
                )
                conn.execute(
                    "INSERT OR IGNORE INTO idea_tags (idea_uuid, facet, value) VALUES (?, ?, ?)",
                    (idea["uuid"], facet, value),
                )

    for r in requirements:
        conn.execute(
            "INSERT INTO requirements (uuid, slug, label, description, category) VALUES (?, ?, ?, ?, ?)",
            (r["uuid"], r["slug"], r["label"], r.get("description"), r.get("category")),
        )
    for k in kpis:
        conn.execute(
            "INSERT INTO kpis (uuid, slug, label, description, category) VALUES (?, ?, ?, ?, ?)",
            (k["uuid"], k["slug"], k["label"], k.get("description"), k.get("category")),
        )
    for t in tasks:
        applies = json.dumps(t.get("applies_to") or [])
        conn.execute(
            "INSERT INTO tasks (uuid, slug, label, category, applies_to) VALUES (?, ?, ?, ?, ?)",
            (t["uuid"], t["slug"], t["label"], t.get("category"), applies),
        )
    for e in entities:
        conn.execute(
            "INSERT INTO entities (uuid, slug, name, type) VALUES (?, ?, ?, ?)",
            (e["uuid"], e["slug"], e["name"], e["type"]),
        )

    for row in links.get("idea_requirements", []):
        for ruid in row.get("requirements", []):
            conn.execute(
                "INSERT INTO idea_requirements (idea_uuid, requirement_uuid) VALUES (?, ?)",
                (row["idea"], ruid),
            )
    for row in links.get("idea_kpis", []):
        for kuid in row.get("kpis", []):
            conn.execute(
                "INSERT INTO idea_kpis (idea_uuid, kpi_uuid) VALUES (?, ?)",
                (row["idea"], kuid),
            )
    for row in links.get("idea_entities", []):
        for euid in row.get("entities", []):
            conn.execute(
                "INSERT INTO idea_entities (idea_uuid, entity_uuid) VALUES (?, ?)",
                (row["idea"], euid),
            )
    for row in links.get("idea_tasks", []):
        for tuid in row.get("tasks", []):
            conn.execute(
                "INSERT OR IGNORE INTO idea_tasks (idea_uuid, task_uuid) VALUES (?, ?)",
                (row["idea"], tuid),
            )
    for row in links.get("idea_models", []):
        for mid in row.get("model_ids", []):
            conn.execute(
                "INSERT OR IGNORE INTO idea_models (idea_uuid, model_id) VALUES (?, ?)",
                (row["idea"], mid),
            )
    for row in links.get("idea_datasets", []):
        for did in row.get("dataset_ids", []):
            conn.execute(
                "INSERT OR IGNORE INTO idea_datasets (idea_uuid, dataset_id) VALUES (?, ?)",
                (row["idea"], did),
            )

    plans_path = DATA / "plans.json"
    plan_rows = 0
    if plans_path.exists():
        plans = json.loads(plans_path.read_text())
        for p in plans:
            conn.execute(
                "INSERT INTO plans (uuid, slug, title, type, file, order_idx) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    p["uuid"],
                    p["slug"],
                    p["title"],
                    p.get("type"),
                    p.get("file"),
                    p.get("order_idx"),
                ),
            )
            plan_rows += 1
        for row in links.get("plan_ideas", []):
            for iuid in row.get("ideas", []):
                conn.execute(
                    "INSERT INTO plan_ideas (plan_uuid, idea_uuid) VALUES (?, ?)",
                    (row["plan"], iuid),
                )
        for row in links.get("plan_requirements", []):
            for ruid in row.get("requirements", []):
                conn.execute(
                    "INSERT INTO plan_requirements (plan_uuid, requirement_uuid) VALUES (?, ?)",
                    (row["plan"], ruid),
                )
        for row in links.get("plan_kpis", []):
            for kuid in row.get("kpis", []):
                conn.execute(
                    "INSERT INTO plan_kpis (plan_uuid, kpi_uuid) VALUES (?, ?)",
                    (row["plan"], kuid),
                )
        for row in links.get("plan_models", []):
            for mid in row.get("model_ids", []):
                conn.execute(
                    "INSERT OR IGNORE INTO plan_models (plan_uuid, model_id) VALUES (?, ?)",
                    (row["plan"], mid),
                )
        for row in links.get("plan_datasets", []):
            for did in row.get("dataset_ids", []):
                conn.execute(
                    "INSERT OR IGNORE INTO plan_datasets (plan_uuid, dataset_id) VALUES (?, ?)",
                    (row["plan"], did),
                )

    # FTS5
    for idea in ideas:
        m = md.get(idea["title"])
        tag_values = " ".join(v for _, v in m["tags"]) if m else ""
        conn.execute(
            "INSERT INTO ideas_fts (idea_uuid, title, description, source_md, tag_values) "
            "VALUES (?, ?, ?, ?, ?)",
            (
                idea["uuid"],
                idea["title"],
                (m["description"] if m else "") or "",
                (m["source_md"] if m else "") or "",
                tag_values,
            ),
        )
    for r in requirements:
        conn.execute(
            "INSERT INTO requirements_fts (requirement_uuid, label, description) VALUES (?, ?, ?)",
            (r["uuid"], r["label"], r.get("description") or ""),
        )
    for k in kpis:
        conn.execute(
            "INSERT INTO kpis_fts (kpi_uuid, label, description) VALUES (?, ?, ?)",
            (k["uuid"], k["label"], k.get("description") or ""),
        )
    for e in entities:
        conn.execute(
            "INSERT INTO entities_fts (entity_uuid, name) VALUES (?, ?)",
            (e["uuid"], e["name"]),
        )

    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?)",
        ("plans_index_count", str(len(plans_index))),
    )
    conn.commit()
    conn.execute("PRAGMA optimize")
    conn.close()

    print(f"Wrote {OUT_PATH}")
    print(f"  ideas:                   {len(ideas)} (markdown-matched: {matched})")
    by_kind = {}
    for i in ideas:
        by_kind[i.get("kind") or "idea"] = by_kind.get(i.get("kind") or "idea", 0) + 1
    print(f"    by kind:               {by_kind}")
    print(f"  requirements:            {len(requirements)}")
    print(f"  kpis:                    {len(kpis)}")
    print(f"  entities:                {len(entities)}")
    print(
        f"  idea→requirement links:  "
        f"{sum(len(r['requirements']) for r in links.get('idea_requirements', []))}"
    )
    print(
        f"  idea→kpi links:          "
        f"{sum(len(r['kpis']) for r in links.get('idea_kpis', []))}"
    )
    print(
        f"  idea→entity links:       "
        f"{sum(len(r['entities']) for r in links.get('idea_entities', []))}"
    )
    print(f"  plans inserted:          {plan_rows}")
    print(f"  plans/index.json entries:{len(plans_index)} (not inserted: awaiting data/plans.json)")
    if unmatched:
        print(
            f"  WARNING: {len(unmatched)} idea(s) had no markdown title match. "
            f"Their description/tags are empty in the DB:"
        )
        for t in unmatched:
            print(f"    - {t}")


if __name__ == "__main__":
    sys.exit(main() or 0)
