#!/usr/bin/env bun
/**
 * scripts/process-crm-task-reminders.mjs — Prompt 37 §65–§72.
 *
 * OPERATOR-SCHEDULED CRM reminder processor. The repository provides THIS
 * script; the operating system owns WHEN it runs (cron / systemd timer /
 * Windows Task Scheduler — §2/§70–§72). There is NO in-process scheduler,
 * NO queue, NO public HTTP endpoint (§2/§4/§158/§171).
 *
 * DEFAULT IS DRY RUN (§65): candidates are counted, nothing is written.
 * Pass --apply to actually create notifications (§67).
 *
 * Usage:
 *   bun scripts/process-crm-task-reminders.mjs                 # dry run
 *   bun scripts/process-crm-task-reminders.mjs --apply         # apply
 *   bun scripts/process-crm-task-reminders.mjs --business-id=<id>
 *   bun scripts/process-crm-task-reminders.mjs --max=<n>       # bounded 10–500
 *
 * Output: safe operational fields only (mode/counts) — NEVER task titles,
 * descriptions, emails, phone numbers or notification bodies (§66/§69).
 *
 * Exit codes: 0 = run completed (dry or apply) · 1 = systemic failure
 * (e.g. database unreachable). A single bad candidate never aborts the run
 * and never changes the exit code by itself (§67/§68).
 *
 * Scheduling examples (DOCUMENTATION ONLY — never auto-installed, §70–§72):
 *   Linux cron :  *\/5 * * * *  app  cd /srv/my-project && bun scripts/process-crm-task-reminders.mjs --apply >> /var/log/aibc-crm-reminders.log 2>&1
 *   systemd    :  aibc-crm-reminders.timer (OnUnitInactiveSec=5min) → aibc-crm-reminders.service
 *   Windows    :  Task Scheduler every 5 minutes — program bun.exe,
 *                 arguments "scripts/process-crm-task-reminders.mjs --apply",
 *                 working directory = project root, "Do not start a new instance".
 * Overlap protection is the scheduler's job (flock / systemd concurrency /
 * Task Scheduler instance policy, §73); the processor itself stays
 * idempotent because Notification (userId, type, sourceEventId) dedupes.
 */

Bun.plugin({
  name: "server-only-shim",
  setup(build) {
    build.module("server-only", () => ({ exports: {}, loader: "object" }));
  },
});

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

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

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const dryRunFlag = args.includes("--dry-run");
const maxArg = args.find((a) => a.startsWith("--max="));
const businessArg = args.find((a) => a.startsWith("--business-id="));

const options = {
  dryRun: apply ? false : true,
  ...(maxArg ? { maxTasks: Number.parseInt(maxArg.slice("--max=".length), 10) } : {}),
  ...(businessArg ? { businessId: businessArg.slice("--business-id=".length) } : {}),
};

if (!Number.isFinite(options.maxTasks)) delete options.maxTasks;

const runId = randomUUID();

try {
  const { processCrmTaskReminders } = await import("../src/lib/crm/task-reminder-processor.ts");
  console.log(JSON.stringify({ job: "crm-task-reminders", runId, startedAt: new Date().toISOString() }));
  const result = await processCrmTaskReminders(options);
  // §66 — safe output: counts only. `created` in DRY RUN means wouldCreate.
  console.log(JSON.stringify({ job: "crm-task-reminders", runId, result, finishedAt: new Date().toISOString() }));
  if (dryRunFlag && apply) {
    console.error("conflicting flags: --apply and --dry-run");
    process.exit(1);
  }
  process.exit(0);
} catch (error) {
  // §68 — systemic failure (DB unreachable, invalid scope): exit nonzero.
  console.error(
    JSON.stringify({
      job: "crm-task-reminders",
      runId,
      error: error instanceof Error ? error.name : "UNKNOWN",
      finishedAt: new Date().toISOString(),
    }),
  );
  process.exit(1);
}
