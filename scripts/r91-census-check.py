#!/usr/bin/env python3
"""R91 quick census + hygiene check (read-only)."""
import sqlite3, sys

DB = "/home/z/my-project/db/custom.db"
con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
cur = con.cursor()
for label, sql in [
    ("users", "SELECT COUNT(*) FROM User"),
    ("businesses", "SELECT COUNT(*) FROM Business"),
    ("sales", "SELECT COUNT(*) FROM Sale"),
    ("draft_sales", "SELECT COUNT(*) FROM Sale WHERE status='DRAFT'"),
    ("setupkeys", "SELECT COUNT(*) FROM PlatformSetupKey"),
]:
    print(f"{label}: {cur.execute(sql).fetchone()[0]}")
fk = cur.execute("PRAGMA foreign_key_check").fetchall()
print(f"foreign_key_check violations: {len(fk)}")
if fk:
    for row in fk[:5]:
        print("  ", row)
        sys.exit(1)
print("integrity:", cur.execute("PRAGMA quick_check").fetchone()[0])
con.close()
