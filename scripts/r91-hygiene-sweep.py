#!/usr/bin/env python3
"""R91 end-of-round hygiene sweep — restore the documented R90 census baseline.

Removes (FK-safe, dependency order):
  1. The two EMPTY P50QA-BIZ-* rows my battery run created (p50's check
     self-heals them on the next run — its purge() recreates/keeps as needed).
  2. The two p49qa stable fixture users (p49's own --full-teardown ritual;
     its next run re-registers them).

Keeps: the 7 documented baseline users + p50qa-owner (the recorded
by-design resident) + the 3 baseline businesses.
"""
import sqlite3

DB = "/home/z/my-project/db/custom.db"
con = sqlite3.connect(DB)
con.execute("PRAGMA foreign_keys = ON")
cur = con.cursor()

# 1. p50 businesses (empty; cascade per schema onDelete rules)
bizs = cur.execute(
    "SELECT id, name FROM Business WHERE name LIKE 'P50QA-%'"
).fetchall()
for bid, name in bizs:
    cur.execute("DELETE FROM Business WHERE id = ?", (bid,))
    print(f"removed business {name} (cascade)")

# 2. p49qa stable users (sessions → audit → user)
users = cur.execute(
    "SELECT id, email FROM User WHERE email LIKE 'p49qa-%'"
).fetchall()
for uid, email in users:
    cur.execute("DELETE FROM UserSession WHERE userId = ?", (uid,))
    cur.execute("DELETE FROM AuditLog WHERE actorId = ?", (uid,))
    cur.execute("DELETE FROM ChatSession WHERE userId = ?", (uid,))
    cur.execute("DELETE FROM User WHERE id = ?", (uid,))
    print(f"removed user {email} (sessions+audit+chat first)")

con.commit()
fk = cur.execute("PRAGMA foreign_key_check").fetchall()
print(f"foreign_key_check violations: {len(fk)}")
if fk:
    for row in fk[:5]:
        print("  ", row)
    raise SystemExit(1)
print("users:", cur.execute("SELECT COUNT(*) FROM User").fetchone()[0])
print("businesses:", cur.execute("SELECT COUNT(*) FROM Business").fetchone()[0])
print("sales:", cur.execute("SELECT COUNT(*) FROM Sale").fetchone()[0])
print("setupkeys:", cur.execute("SELECT COUNT(*) FROM PlatformSetupKey").fetchone()[0])
print("integrity:", cur.execute("PRAGMA quick_check").fetchone()[0])
con.close()
