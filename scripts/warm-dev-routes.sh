#!/bin/bash
# warm-dev-routes.sh — R130 OOM countermeasure.
# Root cause: a FRESH dev server compiling ~40 route files during the first
# e2e-smoke run spikes next-server RSS past the 4GB sandbox ceiling → kernel
# OOM-kill mid-battery (observed twice: 2.8GB anon-rss at ~40-50s in).
# Fix law: pre-compile every battery-touched route ONCE here (cheap 401/200/
# 422 responses still trigger the compile), so the battery itself rides the
# .next filesystem cache with near-zero compile memory.
set -u
cd "$(dirname "$0")/.."

BASE="http://localhost:3000"
paths=(
  "/api/health"
  "/"
  "/api/v1/businesses"
  "/api/v1/copilot"
  "/api/v1/copilot/sessions"
  "/api/v1/copilot/sessions/x"
  "/api/v1/copilot/sessions/x/messages"
  "/api/v1/copilot/stream"
  "/api/v1/products"
  "/api/v1/customers"
  "/api/v1/suppliers"
  "/api/v1/expenses"
  "/api/v1/sales"
  "/api/v1/payments"
  "/api/v1/purchases"
  "/api/v1/employees"
  "/api/v1/payroll/runs"
  "/api/v1/inventory/adjustments"
  "/api/v1/inventory/stocktakes"
  "/api/v1/reports/monthly?months=2"
  "/api/v1/reports/trial-balance"
  "/api/v1/reports/aging"
  "/api/v1/dashboard"
  "/api/v1/invites"
  "/api/v1/members"
  "/api/v1/audit-logs"
  "/api/v1/exports"
  "/api/v1/backup"
  "/api/v1/notifications"
  "/api/v1/low-stock"
  "/api/v1/cashflow"
  "/api/v1/plutus"
)

# No auth on purpose: 401 responses still force the module compile. Redirects
# (307 from middleware) also compile nothing harmful — either is fine.
for p in "${paths[@]}"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 25 "$BASE$p" 2>/dev/null || echo 000)
  echo "warm $p -> $code"
done

# One second pass to confirm everything now answers from cache (fast).
slow=0
for p in "${paths[@]}"; do
  t0=$(date +%s%N)
  curl -s -o /dev/null --max-time 10 "$BASE$p" 2>/dev/null || true
  t1=$(date +%s%N)
  ms=$(( (t1 - t0) / 1000000 ))
  if [ "$ms" -gt 900 ]; then slow=$((slow+1)); echo "SLOW(second pass): $p ${ms}ms"; fi
done
echo "warm-complete slow=$slow"
