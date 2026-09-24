#!/bin/bash
# ensure-dev.sh — idempotent dev-server bootstrap for agent tool sessions.
# The sandbox reaps agent-spawned background processes when a tool session
# ends, so every long tool call must (re)start the server itself. This script
# is safe to call repeatedly: if :3000 already answers, it does nothing.
# Usage: bash scripts/ensure-dev.sh   (prints READY + http code, exit 0/1)
set -u
cd "$(dirname "$0")/.."

code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:3000/api/health 2>/dev/null || echo 000)
if [ "$code" = "200" ]; then
  echo "READY(existing):$code"
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
    exit 0
  fi
done
echo "FAILED:$code"
exit 1
