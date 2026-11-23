#!/usr/bin/env bash
# recover-dev-data.sh — R177: the fixture contract as ONE command.
#
# WHY (R176 §3 risk #3): the sandbox DB revert wiped EVERYTHING again —
# personas, business, seeded data. Recovery was scripted but split across
# two invocations with a strict ORDER contract; a round in a hurry could
# run them swapped and chase 404s that the second script would have fixed.
# This file is the runbook entry: one command, the order encoded, each
# stage honest about what it did.
#
# THE CONTRACT (run this after ANY sandbox DB revert, before QA or smoke):
#   Stage 1  scripts/e2e-smoke-fixture.mjs   — the PERSONA contract
#            (Prisma-direct, idempotent, rate-limit-free):
#            sara@copilot.dev OWNER ×1 business "Sara Copilot Business"
#            (FREE plan, sits at her FREE limits by contract), eve VIEWER,
#            ali ADMIN, rep owner, catalog 5×9, FREE backfill.
#   Stage 2  scripts/r156-qa-fixture.mjs     — the QA SHOP data
#            (through the app's OWN APIs, never Prisma-direct):
#            invoices/expenses/products the perf-panel QA needs, in the
#            documented windows. Assumes stage 1 (order matters — the QA
#            seed signs in as sara).
#
# CENSUS LAW: stage 2's seeding is the DOCUMENTED expected drift (the
# smoke's own customer +1, the QA shop's invoices/expenses/products) —
# any other delta between PlatformSetupKey comparisons is a real leak.
#
# Usage:  bash scripts/recover-dev-data.sh
set -euo pipefail

cd "$(dirname "$0")/.."

say() { printf '\n=== %s ===\n' "$1"; }

say "Stage 1/2 — persona contract (e2e-smoke-fixture.mjs)"
node scripts/e2e-smoke-fixture.mjs

say "Stage 2/2 — QA shop data (r156-qa-fixture.mjs)"
node scripts/r156-qa-fixture.mjs

say "Recovery complete"
echo "Sign in as sara@copilot.dev / testpass123 (OWNER, FREE by contract)."
