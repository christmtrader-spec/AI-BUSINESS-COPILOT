#!/bin/bash
# r105-rss-guard-e2e.sh — REAL recycle test for scripts/dev-rss-guard.cjs.
#
# Stops the production guard, runs a TEST daemon with a deliberately low
# water (RSS_GUARD_WATER_MB=100, consecutive=2, interval=3s) so the healthy
# server (~0.6-0.9GB) counts as "over water", and verifies the FULL loop:
#   high-rss streak → RECYCLE start → SIGTERM → respawn → new server READY.
# Restarts the production guard afterwards and prints PASS/FAIL.
set -u
cd /home/z/my-project

FAIL=0
note() { echo "  $1"; }

echo "== 0. baseline =="
bash scripts/ensure-dev.sh >/dev/null
BEFORE_PID=$(pgrep -f "next-server" | head -1)
BEFORE_RSS=$(ps -o rss= -p "$BEFORE_PID" 2>/dev/null | awk '{print int($1/1024)}')
note "server pid=$BEFORE_PID rss=${BEFORE_RSS}MB"

echo "== 1. stop production guard =="
pkill -f "dev-rss-guard[.]cjs --daemon-stage2" || true
sleep 1
pgrep -f "dev-rss-guard[.]cjs --daemon-stage2" && { note "production guard still alive — abort"; exit 1; }
note "production guard stopped"

echo "== 2. run TEST guard (water=100MB, consecutive=2, interval=3s) =="
GUARD_LOG_LINES_BEFORE=$(wc -l < dev-rss-guard.log 2>/dev/null || echo 0)
RSS_GUARD_WATER_MB=100 RSS_GUARD_CONSECUTIVE=2 RSS_GUARD_INTERVAL_MS=3000 \
  node scripts/dev-rss-guard.cjs >/dev/null 2>&1 &
sleep 2
TEST_GUARD_PID=$(pgrep -f "dev-rss-guard[.]cjs --daemon-stage2" | head -1)
[ -n "$TEST_GUARD_PID" ] || { note "FAIL: test guard did not start"; exit 1; }
note "test guard pid=$TEST_GUARD_PID"

echo "== 3. wait for recycle (≤25s) =="
RECYCLED=0
for i in $(seq 1 25); do
  sleep 1
  NOW_PID=$(pgrep -f "next-server" | head -1)
  if [ -n "$NOW_PID" ] && [ "$NOW_PID" != "$BEFORE_PID" ]; then
    RECYCLED=1
    note "server pid changed: $BEFORE_PID → $NOW_PID after ~${i}s"
    break
  fi
done
[ "$RECYCLED" = "1" ] || { note "FAIL: server was never recycled"; FAIL=1; }

echo "== 4. guard log evidence =="
TAILN=$(( $(wc -l < dev-rss-guard.log) - GUARD_LOG_LINES_BEFORE ))
tail -n "$TAILN" dev-rss-guard.log | while read -r l; do note "$l"; done
tail -n "$TAILN" dev-rss-guard.log | rg -q "RECYCLE start" || { note "FAIL: no 'RECYCLE start' log"; FAIL=1; }
# 'RECYCLE done' is appended by the daemon AFTER the respawn's health wait —
# poll briefly instead of racing it (functional evidence is checked below).
DONE_OK=0
for i in $(seq 1 10); do
  tail -n "$TAILN" dev-rss-guard.log | rg -q "RECYCLE done" && { DONE_OK=1; break; }
  sleep 1
done
[ "$DONE_OK" = "1" ] || { note "FAIL: no 'RECYCLE done' log"; FAIL=1; }

echo "== 5. server healthy again =="
CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 30 http://localhost:3000/api/health || echo 000)
note "health: $CODE"
[ "$CODE" = "200" ] || FAIL=1
NEW_RSS=$(ps -o rss= -p "$(pgrep -f next-server | head -1)" | awk '{print int($1/1024)}')
note "new server rss=${NEW_RSS}MB (reclaimed from ${BEFORE_RSS}MB)"

echo "== 6. stop test guard, restart production guard =="
pkill -f "dev-rss-guard[.]cjs --daemon-stage2" || true
sleep 1
rm -f .dev-rss-guard.lock
node scripts/dev-rss-guard.cjs >/dev/null 2>&1 &
sleep 2
pgrep -fc "dev-rss-guard[.]cjs --daemon-stage2" | rg -q "^1$" && note "production guard restarted (1 instance)" || { note "FAIL: production guard count != 1"; FAIL=1; }

echo "== RESULT =="
[ "$FAIL" = "0" ] && echo "R105 RSS-GUARD E2E: PASS" || echo "R105 RSS-GUARD E2E: FAIL"
exit $FAIL
