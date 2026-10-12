#!/bin/bash
# session-guard.sh — session-start guard for agent tool sessions.
#
# Worklog "Next-Phase Priorities" #3 (sanctioned post-P47): the sandbox
# revert disease keeps recurring across rounds — (a) the dev server is
# killed mid-suite (E2E fetches die with "other side closed"), and (b) the
# environment reverts (the _prisma_migrations ledger is emptied, db/backups
# wiped). This guard runs the CHEAP probes first and escalates to the
# sanctioned repair tools ONLY when a probe fails, so a normal healthy
# session pays ~1s and a diseased session self-heals before any suite:
#
#   1. DB integrity (read-only node:sqlite)  — quick_check + foreign_key_check
#   2. Migration ledger count                — re-baseline via env-repair ONLY
#                                              when it differs from $1
#   3. Dev server health                     — scripts/ensure-dev.sh restart
#
# Usage: bash scripts/session-guard.sh [expected-applied-migration-count]
#        (omit $1 to skip the ledger assertion — probe-only mode)
# Prints GUARD-OK:<details> / GUARD-REPAIRED:<details> / GUARD-FAILED:<reason>
# Exit codes: 0 = healthy or self-repaired · 1 = failed (do NOT run suites).
set -u
cd "$(dirname "$0")/.."

EXPECTED="${1:-}"
repaired=0

fail() { echo "GUARD-FAILED:$1"; exit 1; }

# --- 1+2. DB integrity + ledger probe (single read-only node:sqlite call) ---
probe=$(node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('db/custom.db', { readOnly: true });
const q = db.prepare('PRAGMA quick_check').get();
const fk = db.prepare('PRAGMA foreign_key_check').all().length;
const led = db.prepare(\"SELECT COUNT(*) AS c FROM _prisma_migrations WHERE finished_at IS NOT NULL\").get().c;
console.log(JSON.stringify({ quick: q.quick_check, fk, led }));
db.close();
" 2>&1) || fail "db-probe-crashed: $probe"

quick=$(node -e 'console.log(JSON.parse(process.argv[1]).quick)' "$probe") || fail "probe-parse"
fkv=$(node -e 'console.log(JSON.parse(process.argv[1]).fk)' "$probe") || fail "probe-parse"
led=$(node -e 'console.log(JSON.parse(process.argv[1]).led)' "$probe") || fail "probe-parse"

[ "$quick" = "ok" ] || fail "quick_check=$quick"
[ "$fkv" = "0" ] || fail "foreign_key_check=$fkv violations"

if [ -n "$EXPECTED" ] && [ "$led" != "$EXPECTED" ]; then
  repaired=1
  echo "guard: ledger rows=$led expected=$EXPECTED -> env-repair"
  node scripts/env-repair.mjs >/tmp/session-guard-env-repair.log 2>&1 \
    || fail "env-repair-crashed (log: /tmp/session-guard-env-repair.log)"
  led=$(node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('db/custom.db', { readOnly: true });
console.log(db.prepare(\"SELECT COUNT(*) AS c FROM _prisma_migrations WHERE finished_at IS NOT NULL\").get().c);
db.close();") || fail "post-repair-probe"
  [ "$led" = "$EXPECTED" ] || fail "ledger=$led after env-repair (expected $EXPECTED)"
fi

# --- 3. Dev server health (restart when down) ---
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:3000/api/health 2>/dev/null || echo 000)
if [ "$code" != "200" ]; then
  repaired=1
  echo "guard: dev server down (health=$code) -> ensure-dev"
  bash scripts/ensure-dev.sh >/tmp/session-guard-ensure-dev.log 2>&1 || true
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:3000/api/health 2>/dev/null || echo 000)
  [ "$code" = "200" ] || fail "dev-server=$code after ensure-dev"
fi

if [ "$repaired" = "1" ]; then
  echo "GUARD-REPAIRED (health=$code ledger=$led quick=$quick fk=$fkv)"
else
  echo "GUARD-OK (health=$code ledger=$led quick=$quick fk=$fkv)"
fi
exit 0
