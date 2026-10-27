#!/bin/bash
# restart-dev.sh — force a FRESH dev-server process (R130 OOM protocol).
# Root cause (R130): next-server RSS grows with accumulated HMR recompiles;
# on this 4GB sandbox the kernel OOM-killer reaps it mid-battery
# (observed: 2.8GB anon-rss → SIGKILL during e2e-smoke).
# Protocol: call this BEFORE heavy battery runs (e2e-smoke, r-batteries)
# so every regression starts on a fresh, low-RSS server process.
set -u
cd "$(dirname "$0")/.."

pkill -f "next dev -p 3000" 2>/dev/null
pkill -f "next-server" 2>/dev/null
sleep 2
rm -f .next/dev-server-info 2>/dev/null

setsid nohup bun run dev >> dev.log 2>&1 < /dev/null &
disown 2>/dev/null || true

for i in $(seq 1 40); do
  sleep 1
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:3000/api/health 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then
    echo "READY(fresh):$code after ${i}s"
    exit 0
  fi
done
echo "FAILED:$code"
exit 1
