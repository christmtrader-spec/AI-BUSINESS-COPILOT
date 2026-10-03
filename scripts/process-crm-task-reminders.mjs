#!/usr/bin/env bun
/**
 * scripts/process-crm-task-reminders.mjs — Prompt 37 §65–§72, hardened by
 * Prompt 37-F §5–§11.
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
 *   bun scripts/process-crm-task-reminders.mjs --dry-run       # explicit dry run
 *   bun scripts/process-crm-task-reminders.mjs --business-id=<id>
 *   bun scripts/process-crm-task-reminders.mjs --max=<n>       # strict 10–500
 *
 * Prompt 37-F CLI contract (§5–§9) — ALL validation happens IMMEDIATELY
 * after parsing, BEFORE the processor import, BEFORE any database access,
 * BEFORE any write-capable operation:
 *   --apply --dry-run   → exit 1 (conflict), zero DB writes
 *   --foobar            → exit 1 (unknown flag)
 *   --apply --apply     → accepted idempotently (deterministic, documented)
 *   --max=<non-numeric> → exit 1     --max=<outside 10–500> → exit 1
 *   --business-id=<bad> → exit 1 (same safe ID law as the processor, §7)
 * Duplicate value flags: LAST occurrence wins (deterministic, documented).
 *
 * Output: safe operational fields only (mode/counts/runId/timestamps) —
 * NEVER task titles, descriptions, emails, phone numbers, per-task ids,
 * business ids, dueAt values, offsets or notification bodies (§66/§69/§11).
 *
 * Exit codes: 0 = run completed (dry or apply) · 1 = invalid CLI usage OR
 * systemic failure (e.g. database unreachable). A single bad candidate
 * never aborts the run and never changes the exit code by itself (§67/§68).
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

/**
 * Emit a safe usage error and exit 1 (§5/§7/§8/§45). No processor import,
 * no database access, no notification creation attempt has happened yet.
 */
function usageError(code, message) {
  console.error(
    JSON.stringify({
      job: "crm-task-reminders",
      runId,
      error: "CLI_USAGE_INVALID",
      code,
      message,
      finishedAt: new Date().toISOString(),
    }),
  );
  process.exit(1);
}

// §5/§9 — parse + validate FIRST. The parser is pure (no eval/Function,
// no dynamic execution) and its only outputs are the run options or a
// safe {code, message} rejection.
const parsed = parseReminderCliArgs(process.argv.slice(2));
if (!parsed.ok) {
  usageError(parsed.code, parsed.message);
}
const options = parsed.options;

try {
  const { processCrmTaskReminders } = await import("../src/lib/crm/task-reminder-processor.ts");
  console.log(JSON.stringify({ job: "crm-task-reminders", runId, startedAt: new Date().toISOString() }));
  const result = await processCrmTaskReminders(options);
  // §66 — safe output: counts only. `created` in DRY RUN means wouldCreate.
  console.log(JSON.stringify({ job: "crm-task-reminders", runId, result, finishedAt: new Date().toISOString() }));
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
