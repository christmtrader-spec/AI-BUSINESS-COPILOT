#!/bin/bash
# run-family.sh — R170: ONE command for the round-opening/closing regression
# family (the R169 §3 priority #3). Before this script the family was 30+
# hand-typed commands; the r156 lapse proved hand-typing hides lapses (a
# battery skipped is a battery failed — but nobody notices a skipped one).
#
# What it runs (in order):
#   1. The 21 static check batteries — 19 via `npx tsx` (r139..r169 except
#      the two TLA-pinned ones) + r138/r141 via `bun` (their top-level
#      await breaks tsx's CJS transform — the R168 documented convention,
#      a runner quirk, NOT a battery failure).
#   2. The 5 REAL-HTTP api-proofs via `bun --conditions react-server`
#      (the R169 runner law — resolves the server-only guard). These hit
#      dev:3000, so the script bootstraps the server via ensure-dev.sh
#      unless --skip-proofs.
#   3. The two audits: i18n (bun) + motion v1 and --deep (python).
#   4. With --with-smoke: the 90-assertion e2e-smoke against dev:3000.
#   5. With --with-types: tsc --noEmit + eslint .  (--all enables both).
#
# Usage:
#   bash scripts/run-family.sh                  # batteries + proofs + audits
#   bash scripts/run-family.sh --skip-proofs    # no server needed
#   bash scripts/run-family.sh --with-smoke     # + e2e-smoke (needs server)
#   bash scripts/run-family.sh --with-types     # + tsc + eslint
#   bash scripts/run-family.sh --all            # everything
#   bash scripts/run-family.sh --list           # print the RESOLVED suite
#                                               # manifest for the given flags
#                                               # and run NOTHING (R171: the
#                                               # round-opening spot check —
#                                               # see the manifest a growing
#                                               # family would run, catch a
#                                               # mis-registered battery before
#                                               # a 6-minute run starts)
#
# Exit 0 only when EVERY selected suite passed. The summary table prints
# one line per suite (exit code + the suite's own last "passed" summary
# line) so a failure is attributable at a glance.
set -u
cd "$(dirname "$0")/.."

SKIP_PROOFS=0
WITH_SMOKE=0
WITH_TYPES=0
LIST_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --skip-proofs) SKIP_PROOFS=1 ;;
    --with-smoke)  WITH_SMOKE=1 ;;
    --with-types)  WITH_TYPES=1 ;;
    --all)         WITH_SMOKE=1; WITH_TYPES=1 ;;
    --list)        LIST_ONLY=1 ;;
    *) echo "unknown flag: $arg"; exit 2 ;;
  esac
done

# ---- the suite manifest (keep alphabetical WITHIN each runner group) -------
# Static batteries via tsx (client-safe source scans + unit laws).
BATTERIES_TSX=(
  r139-regenerate-check.ts
  r140-welcome-usage-check.ts
  r143-perf-chips-check.ts
  r144-ask-deeplink-check.ts
  r145-ask-producers-check.ts
  r146-ask-valuation-check.ts
  r147-outstanding-drill-check.ts
  r148-valuation-seed-check.ts
  r149-dashboard-ask-check.ts
  r150-search-ask-check.ts
  r151-lowstock-drill-check.ts
  r152-reorder-drill-check.ts
  r153-product-drill-check.ts
  r154-onboarding-check.ts
  r155-category-drill-check.ts
  r156-month-drill-check.ts
  r167-expense-facet-check.ts
  r168-prod-build-check.ts
  r169-apiproofs-archaeology-check.ts
  r170-repeat-family-check.ts
  r171-duplicate-placement-check.ts
  r172-quick-create-check.ts
  r173-quick-product-check.ts
  r174-palette-quick-create-check.ts
)
# TLA-pinned batteries — bun ONLY (the R168 convention).
BATTERIES_BUN=(
  r138-copilot-time-check.ts
  r141-search-highlight-check.ts
)
# REAL-HTTP proofs — the R169 runner law (`bun --conditions react-server`).
PROOFS=(
  r95-leaders-api-proofs.ts
  r96-leader-api-proofs.ts
  r97-podium-api-proofs.ts
  r98-merch-api-proofs.ts
  r101-leader-api-proofs.ts
)

declare -a SUITE_NAMES=()
declare -a SUITE_CMDS=()
declare -a SUITE_RESULTS=()

run_suite() {
  local name="$1"; shift
  local out rc
  out=$("$@" 2>&1); rc=$?
  SUITE_NAMES+=("$name")
  SUITE_CMDS+=("$*")
  # The suite's own verdict line (last "passed" summary or a known banner).
  local verdict
  verdict=$(printf '%s\n' "$out" | grep -E "passed|ALL GREEN|AUDIT CLEAN|FIXABLE|DEEP" | tail -1)
  [ -z "$verdict" ] && verdict="(no summary line)"
  if [ $rc -eq 0 ]; then
    SUITE_RESULTS+=("PASS")
    printf '  ✓ %-42s %s\n' "$name" "$verdict"
  else
    SUITE_RESULTS+=("FAIL")
    printf '  ✗ %-42s %s (exit %d)\n' "$name" "$verdict" "$rc"
    # Echo the tail so the failure is diagnosable without a re-run.
    printf '%s\n' "$out" | tail -12 | sed 's/^/      | /'
  fi
}

# ---- resolved manifest (R171 --list) ---------------------------------------
# Print EXACTLY what the given flags would run, numbered and runner-tagged,
# then exit 0 without executing anything. The same arrays and conditionals
# as the execution path below — a manifest that could drift from reality
# would be a dishonest manifest, so there is ONE source: these arrays.
print_manifest() {
  echo "== run-family.sh — RESOLVED SUITE MANIFEST (nothing will run) =="
  echo "   flags: skip-proofs=$SKIP_PROOFS with-smoke=$WITH_SMOKE with-types=$WITH_TYPES"
  local n=0
  for b in "${BATTERIES_TSX[@]}"; do n=$((n+1)); printf '  %2d. tsx-battery   %s\n' "$n" "$b"; done
  for b in "${BATTERIES_BUN[@]}"; do n=$((n+1)); printf '  %2d. bun-battery   %s  (TLA-pinned)\n' "$n" "$b"; done
  if [ $SKIP_PROOFS -eq 0 ]; then
    for p in "${PROOFS[@]}"; do n=$((n+1)); printf '  %2d. api-proof     %s  (REAL-HTTP)\n' "$n" "$p"; done
  fi
  n=$((n+1)); printf '  %2d. audit         i18n-audit\n' "$n"
  n=$((n+1)); printf '  %2d. audit         motion-audit (v1)\n' "$n"
  n=$((n+1)); printf '  %2d. audit         motion-audit (--deep, v2 placement law)\n' "$n"
  if [ $WITH_SMOKE -eq 1 ]; then
    n=$((n+1)); printf '  %2d. real-http     e2e-smoke  (needs dev:3000)\n' "$n"
  fi
  if [ $WITH_TYPES -eq 1 ]; then
    n=$((n+1)); printf '  %2d. types         tsc --noEmit\n' "$n"
    n=$((n+1)); printf '  %2d. lint          eslint .\n' "$n"
  fi
  echo "   total: $n suites"
  if [ $WITH_SMOKE -eq 1 ]; then
    echo "   note: --with-smoke bootstraps the dev server regardless of --skip-proofs"
  fi
}

if [ $LIST_ONLY -eq 1 ]; then
  print_manifest
  exit 0
fi

echo "== run-family.sh — the regression family =="
echo "   flags: skip-proofs=$SKIP_PROOFS with-smoke=$WITH_SMOKE with-types=$WITH_TYPES"

if [ $SKIP_PROOFS -eq 0 ] || [ $WITH_SMOKE -eq 1 ]; then
  echo "-- bootstrap dev:3000 (proofs/smoke are REAL-HTTP) --"
  bash scripts/ensure-dev.sh || { echo "FATAL: dev server not READY"; exit 1; }
fi

echo "-- static batteries (tsx) --"
for b in "${BATTERIES_TSX[@]}"; do
  run_suite "$b" npx tsx "scripts/$b"
done

echo "-- static batteries (bun, TLA-pinned) --"
for b in "${BATTERIES_BUN[@]}"; do
  run_suite "$b" bun "scripts/$b"
done

if [ $SKIP_PROOFS -eq 0 ]; then
  echo "-- api-proofs (bun --conditions react-server) --"
  for p in "${PROOFS[@]}"; do
    run_suite "$p" bun --conditions react-server "scripts/$p"
  done
fi

echo "-- audits --"
run_suite "i18n-audit" bun scripts/i18n-audit.ts
run_suite "motion-audit (v1)" python3 scripts/r156-motion-audit.py
run_suite "motion-audit (--deep)" python3 scripts/r156-motion-audit.py --deep

if [ $WITH_SMOKE -eq 1 ]; then
  echo "-- e2e-smoke (90 assertions, REAL-HTTP) --"
  run_suite "e2e-smoke" bun scripts/e2e-smoke.ts
fi

if [ $WITH_TYPES -eq 1 ]; then
  echo "-- types + lint --"
  run_suite "tsc --noEmit" bunx tsc --noEmit
  run_suite "eslint ." bun run lint
fi

# ---- summary ---------------------------------------------------------------
total=${#SUITE_NAMES[@]}
failed=0
echo ""
echo "== SUMMARY ($total suites) =="
for i in "${!SUITE_NAMES[@]}"; do
  printf '  %-4s %s\n' "${SUITE_RESULTS[$i]}" "${SUITE_NAMES[$i]}"
  [ "${SUITE_RESULTS[$i]}" = "FAIL" ] && failed=$((failed + 1))
done
echo ""
if [ $failed -eq 0 ]; then
  echo "FAMILY GREEN ✓ — $total suites, 0 failures"
  exit 0
fi
echo "FAMILY RED ✗ — $failed of $total suites failed"
exit 1
