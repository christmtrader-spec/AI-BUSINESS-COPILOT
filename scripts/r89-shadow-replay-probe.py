#!/usr/bin/env python3
"""R89 diagnostic: replay every prisma migration into a scratch SQLite db,
one statement at a time, and report the FIRST failure (migration + statement).
Mirrors what `prisma migrate dev`'s shadow db does. Read-only wrt custom.db.
"""
import os
import re
import sqlite3
import sys

ROOT = "/home/z/my-project"
MIG_DIR = os.path.join(ROOT, "prisma", "migrations")
SCRATCH = os.path.join(ROOT, "db", "shadow-replay-probe.db")

def split_statements(sql: str):
    """Split a prisma migration.sql into executable statements using
    sqlite3.complete_statement — the same tokenizer sqlite itself uses, so
    strings and comments (even ones containing ';') are handled faithfully."""
    out, buf = [], []
    for line in sql.splitlines(keepends=True):
        buf.append(line)
        if sqlite3.complete_statement("".join(buf)):
            stmt = "".join(buf).strip()
            if stmt:
                out.append(stmt)
            buf = []
    tail = "".join(buf).strip()
    if tail:
        out.append(tail)
    return [s for s in out if s and not all(l.strip().startswith("--") or not l.strip() for l in s.splitlines())]


def main():
    if os.path.exists(SCRATCH):
        os.remove(SCRATCH)
    con = sqlite3.connect(SCRATCH, isolation_level=None)
    cur = con.cursor()
    dirs = sorted(
        d for d in os.listdir(MIG_DIR)
        if os.path.isdir(os.path.join(MIG_DIR, d)) and d != "migration_lock.toml"
    )
    print(f"{len(dirs)} migrations to replay")
    for d in dirs:
        path = os.path.join(MIG_DIR, d, "migration.sql")
        if not os.path.exists(path):
            print(f"  [skip] {d}: no migration.sql")
            continue
        sql = open(path, encoding="utf-8").read()
        for stmt in split_statements(sql):
            try:
                cur.execute(stmt)
            except sqlite3.Error as e:
                print(f"\nFAIL at {d}")
                print(f"  error: {e}")
                head = stmt if len(stmt) <= 300 else stmt[:300] + " …"
                print(f"  statement: {head}")
                con.close()
                sys.exit(1)
        print(f"  [ok] {d} ({len(split_statements(sql))} stmts)")
    con.close()
    print("\nALL REPLAY CLEAN")


if __name__ == "__main__":
    main()
