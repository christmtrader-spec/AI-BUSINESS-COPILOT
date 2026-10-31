#!/usr/bin/env bash
# build-prod.sh — the automated production build dance (R168; encodes the R156 laws).
#
# The sandbox reaps background processes between tool calls (~10 min) and OOM-kills
# builds that share the box with chrome/dev leftovers (dmesg-proven 2.6GB anon-rss).
# The monolithic `next build` never survives; the SPLIT build does. Each subcommand
# below is sized to fit inside ONE tool call.
#
# Subcommands:
#   preflight  kill chrome leftovers + dev/prod servers (the OOM law), verify NEXTAUTH_SECRET
#   compile    next build --experimental-build-mode=compile   (fits the 10-min window)
#   generate   next build --experimental-build-mode=generate  (fits the 10-min window)
#   assemble   copy static + public + .env into .next/standalone (the assembly law)
#   start      setsid prod:3100 standalone (consume it in the SAME tool call — the
#              same-call law; the process itself is reaped otherwise)
#   status     print :3100 health code
#   all        preflight + compile + generate + assemble (NEVER `start` — it cannot
#              fit one call with the builds; the honest guard is printed)
#
# Ordering laws (hard-won, keep):
#   - ensure-dev.sh pkill's "next-server", which kills the prod standalone too
#     (both rename to next-server) → run ensure-dev BEFORE `start`, never after.
#   - A build clobbers dev's Turbopack chunks (shared .next) → after `all`, revive
#     dev with ensure-dev, THEN `start` prod.
#   - .env is gitignored (.env*, line 34); the secret never prints, never commits.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PROD_PORT:-3100}"
MODE="${1:-help}"

kill_servers() {
  # The OOM law: chrome-headless leftovers from QA journeys share the 4GB box.
  pkill -f "chrome-headless" 2>/dev/null || true
  pkill -f "headless_shell" 2>/dev/null || true
  # Dev shares .next with the build (Turbopack chunks get clobbered) and prod is
  # superseded by the rebuild — BOTH die at preflight (both are "next-server").
  pkill -f "next dev -p 3000" 2>/dev/null || true
  pkill -f "next-server" 2>/dev/null || true
  sleep 1
  echo "preflight: QA/dev/prod processes cleared"
}

ensure_secret() {
  if grep -q "^NEXTAUTH_SECRET=" .env 2>/dev/null; then
    echo "NEXTAUTH_SECRET: present in .env"
  else
    printf '\nNEXTAUTH_SECRET=%s\n' "$(openssl rand -base64 32)" >> .env
    echo "NEXTAUTH_SECRET: GENERATED into .env (production requires it; .env is gitignored)"
  fi
}

wait_health() { # $1 = port, $2 = tries
  for _ in $(seq 1 "${2:-60}"); do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://localhost:${1}/api/health" 2>/dev/null || echo 000)
    [ "$code" = "200" ] && return 0
    sleep 1
  done
  return 1
}

case "$MODE" in
  preflight)
    kill_servers
    ensure_secret
    echo "preflight: OK"
    ;;
  compile)
    bunx next build --experimental-build-mode=compile
    echo "compile: OK"
    ;;
  generate)
    bunx next build --experimental-build-mode=generate
    echo "generate: OK"
    ;;
  assemble)
    test -d .next/standalone || { echo "assemble: FAIL — .next/standalone missing (run compile+generate first)"; exit 1; }
    test -d .next/static || { echo "assemble: FAIL — .next/static missing (run generate first)"; exit 1; }
    mkdir -p .next/standalone/.next
    rm -rf .next/standalone/.next/static
    cp -r .next/static .next/standalone/.next/
    rm -rf .next/standalone/public
    cp -r public .next/standalone/
    cp .env .next/standalone/.env
    test -f .next/standalone/server.js || { echo "assemble: FAIL — server.js missing"; exit 1; }
    echo "assemble: OK (static + public + .env into .next/standalone)"
    ;;
  start)
    test -f .next/standalone/server.js || { echo "start: FAIL — run assemble first"; exit 1; }
    setsid nohup env PORT="$PORT" NODE_ENV=production node .next/standalone/server.js > "/tmp/prod-${PORT}.log" 2>&1 < /dev/null &
    disown 2>/dev/null || true
    if wait_health "$PORT" 60; then
      echo "PROD-READY:$PORT"
    else
      echo "start: FAILED (health never went 200; tail /tmp/prod-${PORT}.log)"
      exit 1
    fi
    ;;
  status)
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://localhost:${PORT}/api/health" 2>/dev/null || echo 000)
    echo "STATUS:$PORT:$code"
    [ "$code" = "200" ]
    ;;
  all)
    kill_servers
    ensure_secret
    bunx next build --experimental-build-mode=compile
    echo "compile: OK"
    bunx next build --experimental-build-mode=generate
    echo "generate: OK"
    mkdir -p .next/standalone/.next
    rm -rf .next/standalone/.next/static .next/standalone/public
    cp -r .next/static .next/standalone/.next/
    cp -r public .next/standalone/
    cp .env .next/standalone/.env
    echo "all: build+assemble OK"
    echo "NEXT (the ordering + same-call laws):"
    echo "  1. bash scripts/ensure-dev.sh          # revive dev FIRST (its pkill would kill prod)"
    echo "  2. bash scripts/build-prod.sh start && <consume :3100 IN THE SAME tool call>"
    ;;
  *)
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
