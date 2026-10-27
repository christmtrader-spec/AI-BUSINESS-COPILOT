#!/usr/bin/env python3
"""R89 one-shot FK repair: a raw sweep ran with foreign_keys OFF, so deletes
did not cascade and child rows now reference dead parents. This repairs to
the state Prisma's cascade WOULD have produced, driven by the SCHEMA's own
onDelete rules (Cascade → delete the orphan; SetNull → null the column),
iterated to a fixed point so transitive orphans (Customer → Sale → …) heal
too. Read-only with respect to live parents.
"""
import re
import sqlite3

DB = "/home/z/my-project/db/custom.db"
SCHEMA = open("/home/z/my-project/prisma/schema.prisma").read()

con = sqlite3.connect(DB, isolation_level=None)
cur = con.cursor()

# 1) Parse every relation: (child_table, child_col, parent_table, rule)
relations = []
model_names = set(re.findall(r"model (\w+) \{", SCHEMA))
for m in re.finditer(r"model (\w+) \{([^}]*)\}", SCHEMA):
    child, body = m.group(1), m.group(2)
    for line in body.splitlines():
        line = line.split("//")[0].strip()
        args = re.search(r"@relation\(([^)]*)\)", line)
        if not args:
            continue
        # field line: `customer Customer? @relation(...)` — parent = the TYPE token
        type_tok = re.match(r"\w+\s+(\w+)\??\s+@relation", line)
        if not type_tok:
            continue
        parent = type_tok.group(1)
        if parent not in model_names:
            continue
        f = re.search(r"fields:\s*\[(\w+)\]", args.group(1))
        r = re.search(r"references:\s*\[(\w+)\]", args.group(1))
        if not f or not r:
            continue
        rule = "Cascade" if "onDelete: Cascade" in args.group(1) else ("SetNull" if "onDelete: SetNull" in args.group(1) else "Restrict")
        relations.append((child, f.group(1), parent, r.group(1), rule))

print(f"{len(relations)} relations parsed")

total_deleted = 0
total_nulled = 0
for round_no in range(6):  # transitive closure
    actions = 0
    for child, col, parent, _ref, rule in relations:
        ptable = parent[0].lower() + parent[1:]
        try:
            cur.execute(f"SELECT name FROM sqlite_master WHERE type='table' AND name='{ptable}'")
            if not cur.fetchone():
                ptable = parent
                cur.execute(f"SELECT name FROM sqlite_master WHERE type='table' AND name='{ptable}'")
                if not cur.fetchone():
                    continue
        except sqlite3.Error:
            continue
        if rule == "Cascade":
            n = cur.execute(
                f"DELETE FROM {child} WHERE {col} IS NOT NULL AND {col} NOT IN (SELECT id FROM {ptable})"
            ).rowcount
            if n:
                print(f"  r{round_no} DELETE {child}.{col} → {n} orphan(s) ({rule})")
                total_deleted += n
        else:  # SetNull
            n = cur.execute(
                f"UPDATE {child} SET {col}=NULL WHERE {col} IS NOT NULL AND {col} NOT IN (SELECT id FROM {ptable})"
            ).rowcount
            if n:
                print(f"  r{round_no} SETNULL {child}.{col} → {n} row(s) ({rule})")
                total_nulled += n
        actions += n
    if actions == 0:
        print(f"fixed point at round {round_no}")
        break

violations = cur.execute("PRAGMA foreign_key_check").fetchall()
print(f"deleted {total_deleted} orphan row(s), nulled {total_nulled} column(s)")
print("foreign_key_check:", "CLEAN" if not violations else f"{len(violations)} VIOLATIONS remain: {violations[:8]}")
print("users:", cur.execute("SELECT COUNT(*) FROM User").fetchone()[0])
print("businesses:", cur.execute("SELECT COUNT(*) FROM Business").fetchone()[0])
con.close()
