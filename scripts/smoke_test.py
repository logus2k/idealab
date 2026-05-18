#!/usr/bin/env python3
"""Smoke test the built public/catalog.sqlite.

Reads only — verifies key counts and join paths work, and exercises FTS5.
"""
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "public" / "catalog.sqlite"


def n(conn, sql, params=()):
    return conn.execute(sql, params).fetchone()[0]


def main():
    if not DB.exists():
        print(f"FAIL: {DB} not found — run scripts/build_sqlite.py first")
        return 1

    conn = sqlite3.connect(DB)

    schema_version = conn.execute(
        "SELECT value FROM meta WHERE key='schema_version'"
    ).fetchone()[0]
    built_at = conn.execute(
        "SELECT value FROM meta WHERE key='built_at'"
    ).fetchone()[0]
    print(f"DB: {DB}")
    print(f"  Schema version: {schema_version}")
    print(f"  Built at:       {built_at}")

    print("\nCounts:")
    print(f"  ideas:                  {n(conn, 'SELECT COUNT(*) FROM ideas')}")
    print(f"  ideas with description: {n(conn, 'SELECT COUNT(*) FROM ideas WHERE description IS NOT NULL')}")
    print(f"  ideas with source_md:   {n(conn, 'SELECT COUNT(*) FROM ideas WHERE source_md IS NOT NULL')}")
    n_concrete = n(conn, "SELECT COUNT(*) FROM ideas WHERE kind='idea'")
    n_pattern = n(conn, "SELECT COUNT(*) FROM ideas WHERE kind='pattern'")
    print(f"  ideas (kind=idea):      {n_concrete}")
    print(f"  ideas (kind=pattern):   {n_pattern}")
    print(f"  requirements:           {n(conn, 'SELECT COUNT(*) FROM requirements')}")
    print(f"  kpis:                   {n(conn, 'SELECT COUNT(*) FROM kpis')}")
    print(f"  entities:               {n(conn, 'SELECT COUNT(*) FROM entities')}")
    print(f"  plans:                  {n(conn, 'SELECT COUNT(*) FROM plans')}")
    print(f"  tags (distinct):        {n(conn, 'SELECT COUNT(*) FROM tags')}")
    print(f"  idea_tags rows:         {n(conn, 'SELECT COUNT(*) FROM idea_tags')}")
    print(f"  idea_requirements rows: {n(conn, 'SELECT COUNT(*) FROM idea_requirements')}")
    print(f"  idea_kpis rows:         {n(conn, 'SELECT COUNT(*) FROM idea_kpis')}")
    print(f"  idea_entities rows:     {n(conn, 'SELECT COUNT(*) FROM idea_entities')}")

    print("\nTag facet breakdown:")
    for facet, count in conn.execute(
        "SELECT facet, COUNT(*) FROM tags GROUP BY facet ORDER BY facet"
    ):
        print(f"  {facet:<10} {count}")

    print("\nSection breakdown:")
    for sno, sname, count in conn.execute(
        "SELECT section_no, section_name, COUNT(*) FROM ideas "
        "GROUP BY section_no, section_name ORDER BY section_no"
    ):
        print(f"  {sno or '-':>3} {sname or '(unsectioned)'} — {count}")

    print("\nSample query: top 5 requirements by # of ideas they cover")
    for slug, label, c in conn.execute(
        """SELECT r.slug, r.label, COUNT(*) AS c
           FROM idea_requirements ir
           JOIN requirements r ON r.uuid = ir.requirement_uuid
           GROUP BY r.uuid ORDER BY c DESC LIMIT 5"""
    ):
        print(f"  {c} × {label} ({slug})")

    print("\nSample query: top 5 KPIs by # of ideas they move")
    for slug, label, c in conn.execute(
        """SELECT k.slug, k.label, COUNT(*) AS c
           FROM idea_kpis ik
           JOIN kpis k ON k.uuid = ik.kpi_uuid
           GROUP BY k.uuid ORDER BY c DESC LIMIT 5"""
    ):
        print(f"  {c} × {label} ({slug})")

    print("\nFTS5 search: 'shopping'")
    for title in [
        r[0]
        for r in conn.execute(
            "SELECT title FROM ideas WHERE uuid IN "
            "(SELECT idea_uuid FROM ideas_fts WHERE ideas_fts MATCH 'shopping') "
            "ORDER BY section_no, title"
        )
    ]:
        print(f"  • {title}")

    print("\nFTS5 search: 'agentic OR copilot'")
    for title in [
        r[0]
        for r in conn.execute(
            "SELECT title FROM ideas WHERE uuid IN "
            "(SELECT idea_uuid FROM ideas_fts WHERE ideas_fts MATCH 'agentic OR copilot') "
            "ORDER BY section_no, title LIMIT 10"
        )
    ]:
        print(f"  • {title}")

    print("\nTop 5 entities by # of ideas referencing them")
    for slug, name, etype, c in conn.execute(
        """SELECT e.slug, e.name, e.type, COUNT(*) AS c
           FROM idea_entities ie
           JOIN entities e ON e.uuid = ie.entity_uuid
           GROUP BY e.uuid ORDER BY c DESC LIMIT 5"""
    ):
        print(f"  {c} × {name} [{etype}] ({slug})")

    print("\nDemand-side match: ideas that solve 'shopping-guidance-gap'")
    for slug, title in conn.execute(
        """SELECT i.slug, i.title
           FROM ideas i
           JOIN idea_requirements ir ON ir.idea_uuid = i.uuid
           JOIN requirements r ON r.uuid = ir.requirement_uuid
           WHERE r.slug = 'shopping-guidance-gap'
           ORDER BY i.title"""
    ):
        print(f"  • {title} ({slug})")

    conn.close()
    print("\nOK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
