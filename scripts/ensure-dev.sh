#!/bin/bash
# ensure-dev.sh — idempotent dev-server bootstrap for agent tool sessions.
# The sandbox reaps agent-spawned background processes when a tool session
# ends, so every long tool call must (re)start the server itself. This script
# is safe to call repeatedly: if :3000 already answers, it does nothing.
# Usage: bash scripts/ensure-dev.sh   (prints READY + http code, exit 0/1)
#
# R178 self-scheduling law: a READY outcome ALSO ensures the dev-watchdog
# supervisor is on duty (it keeps the rss-guard daemon alive, which keeps
# this server lean — the R177 OOM chain: watchdog 10min → rss-guard 30s →
# server). The ensure step is idempotent: a LIVE supervisor (pid + fresh
# heartbeat) is left alone; a dead/wedged/stale one is re-spawned detached.
# Spawning goes through `node scripts/dev-watchdog.cjs` in daemon mode —
# the script double-forks itself, so this shell does not wait on it.
set -u
cd "$(dirname "$0")/.."

WATCHDOG_LOCK=".dev-supervisor.lock"

# ensure_watchdog — idempotent supervisor presence. Print one line either way.
ensure_watchdog() {
  local ok="no"
  if [ -f "$WATCHDOG_LOCK" ]; then
    local pid
    pid=$(node -e '
      try {
        const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        if (typeof l.pid === "number" && Date.now() - l.at < 10*60*1000) {
          try { process.kill(l.pid, 0); console.log(String(l.pid)); } catch {}
        }
      } catch {}
    ' "$WATCHDOG_LOCK" 2>/dev/null || true)
    if [ -n "$pid" ]; then
      ok="yes"
      echo "WATCHDOG(alive):pid=$pid"
    fi
  fi
  if [ "$ok" = "no" ]; then
    setsid nohup node scripts/dev-watchdog.cjs >/dev/null 2>&1 < /dev/null &
    disown 2>/dev/null || true
    # The double-fork writes its heartbeat within ~1s; verify presence.
    local waited=0
    while [ "$waited" -lt 8 ]; do
      sleep 1; waited=$((waited+1))
      if [ -f "$WATCHDOG_LOCK" ]; then
        echo "WATCHDOG(revived):after=${waited}s"
        return 0
      fi
    done
    echo "WATCHDOG(missing):dev-watchdog did not write its heartbeat — check dev-watchdog.log"
    return 1
  fi
}

code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:3000/api/health 2>/dev/null || echo 000)
if [ "$code" = "200" ]; then
  echo "READY(existing):$code"
  ensure_watchdog || true
  exit 0
fi

# Clean any half-dead chain, then start fully detached for THIS session.
pkill -f "next dev -p 3000" 2>/dev/null
pkill -f "next-server" 2>/dev/null
sleep 1
rm -f .next/dev-server-info 2>/dev/null

setsid nohup bun run dev >> dev.log 2>&1 < /dev/null &
disown 2>/dev/null || true

for i in $(seq 1 40); do
  sleep 1
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:3000/api/health 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then
    echo "READY(new):$code after ${i}s"
    ensure_watchdog || true
    exit 0
  fi
done
echo "FAILED:$code"
exit 1
