#!/usr/bin/env bun
/**
 * scripts/process-inventory-low-stock.mjs — Prompt 38 (§38-a).
 *
 * OPERATOR-SCHEDULED low-stock alert processor. The repository provides
 * THIS script; the operating system owns WHEN it runs (cron / systemd
 * timer / Windows Task Scheduler). There is NO in-process scheduler, NO
 * queue, NO public HTTP endpoint. It reuses the audited Prompt 37-F CLI
 * contract (scripts/lib/crm-reminder-cli.mjs) verbatim — identical flag
 * matrix, identical exit-code semantics, identical safe output law.
 *
 * DEFAULT IS DRY RUN: candidates are counted, nothing is written.
 * Pass --apply to actually create notifications.
 *
 * Usage:
 *   bun scripts/process-inventory-low-stock.mjs                 # dry run
 *   bun scripts/process-inventory-low-stock.mjs --apply         # apply
 *   bun scripts/process-inventory-low-stock.mjs --dry-run       # explicit
 *   bun scripts/process-inventory-low-stock.mjs --business-id=<id>
 *   bun scripts/process-inventory-low-stock.mjs --max=<n>       # strict 10–500
 *
 * CLI contract (ALL validation BEFORE the processor import / any DB access):
 *   --apply --dry-run   → exit 1 (CONFLICTING_FLAGS), zero DB writes
 *   --foobar            → exit 1 (UNKNOWN_FLAG)
 *   --max=<non-numeric> → exit 1     --max=<outside 10–500> → exit 1
 *   --business-id=<bad> → exit 1 (INVALID_BUSINESS_ID)
 * Duplicate value flags: LAST occurrence wins (deterministic, documented).
 *
 * 38-F SEMANTICS:
 *   --max caps NEW notifications CREATED per run (default 100, hard
 *   10–500) — NOT the products scanned. Duplicates never consume the
 *   budget; when the cap is hit the result reports truncated=true and the
 *   remaining eligible combinations are reached on the NEXT run (no
 *   starvation). Product rows are read in bounded cursor pages of
 *   INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE (default 250, 50–500) — never one
 *   unbounded query. In DRY RUN the reported `created` means wouldCreate.
 *
 * SINGLE-NODE SCHEDULER (§65): this is an operator-managed single-node
 * job — idempotency (Notification userId+type+sourceEventId uniqueness)
 * protects against overlapping/duplicate EXECUTION; it is NOT distributed
 * scheduling and does not coordinate multiple scheduler hosts.
 *
 * Output: safe operational fields only (mode/counts/runId/timestamps) —
 * NEVER product names, SKUs, prices, quantities, per-product ids, business
 * ids or notification bodies (P37 §66/§69/§11 safe-log law applies).
 *
 * Exit codes: 0 = run completed (dry or apply) · 1 = invalid CLI usage OR
 * systemic failure. A single bad candidate never aborts the run.
 *
 * Scheduling examples (DOCUMENTATION ONLY — never auto-installed; NOTE: the
 * cron hour spec below is written as 0,6,12,18 — an "asterisk-slash-6"
 * literal here would terminate this block comment and break the script):
 *   Linux cron :  0 0,6,12,18 * * *  app  cd /srv/my-project && bun scripts/process-inventory-low-stock.mjs --apply >> /var/log/aibc-inventory-alerts.log 2>&1
 *   systemd    :  aibc-inventory-alerts.timer (OnCalendar=*-*-* 0/6:00:00) → aibc-inventory-alerts.service
 *   Windows    :  Task Scheduler every 6 hours — program bun.exe, arguments
 *                 "scripts/process-inventory-low-stock.mjs --apply", working
 *                 directory = project root, "Do not start a new instance".
 * Overlap protection is the scheduler's job (flock / systemd concurrency /
 * Task Scheduler instance policy); the processor itself stays idempotent
 * because Notification (userId, type, sourceEventId) dedupes.
 */

Bun.plugin({
  name: "server-only-shim",
  setup(build) {
    build.module("server-only", () => ({ exports: {}, loader: "object" }));
  },
});

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseReminderCliArgs } from "./lib/crm-reminder-cli.mjs";

/* Load the project .env (DATABASE_URL) without overwriting real env vars. */
function loadProjectEnv() {
  try {
    const raw = readFileSync(new URL("../.env", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* .env is optional when real env vars are present */
  }
}
loadProjectEnv();

const runId = randomUUID();

/** Emit a safe usage error and exit 1 — before any processor import/DB access. */
function usageError(code, message) {
  console.error(
    JSON.stringify({
      job: "inventory-low-stock",
      runId,
      error: "CLI_USAGE_INVALID",
      code,
      message,
      finishedAt: new Date().toISOString(),
    }),
  );
  process.exit(1);
}

const parsed = parseReminderCliArgs(process.argv.slice(2));
if (!parsed.ok) {
  usageError(parsed.code, parsed.message);
}
const options = { dryRun: parsed.options.dryRun, businessId: parsed.options.businessId, max: parsed.options.maxTasks };

try {
  const { processInventoryLowStock } = await import("../src/lib/inventory/low-stock-processor.ts");
  console.log(JSON.stringify({ job: "inventory-low-stock", runId, startedAt: new Date().toISOString() }));
  const result = await processInventoryLowStock(options);
  // Safe output: counts only. `created` in DRY RUN means wouldCreate.
  console.log(JSON.stringify({ job: "inventory-low-stock", runId, result, finishedAt: new Date().toISOString() }));
  process.exit(0);
} catch (error) {
  console.error(
    JSON.stringify({
      job: "inventory-low-stock",
      runId,
      error: error instanceof Error ? error.name : "UNKNOWN",
      finishedAt: new Date().toISOString(),
    }),
  );
  process.exit(1);
}
