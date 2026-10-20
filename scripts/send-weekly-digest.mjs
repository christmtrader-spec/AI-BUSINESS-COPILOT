#!/usr/bin/env bun
/**
 * scripts/send-weekly-digest.mjs — Task 2-b F9 weekly email digest sender.
 *
 * OPERATOR-SCHEDULED digest sender (same pattern as
 * scripts/process-crm-task-reminders.mjs): the repository provides THIS
 * script; the operating system owns WHEN it runs (cron / systemd timer /
 * Windows Task Scheduler). There is NO in-process scheduler, NO queue, and
 * NO auto-send from any HTTP request path — the digest-preview API only
 * builds a preview and never emails.
 *
 * DEFAULT IS DRY RUN: digests are BUILT and their stats PRINTED; nothing is
 * sent. Pass --send to actually deliver via getEmailProvider().
 *
 * Usage:
 *   bun scripts/send-weekly-digest.mjs                  # dry run (prints)
 *   bun scripts/send-weekly-digest.mjs --dry-run        # explicit dry run
 *   bun scripts/send-weekly-digest.mjs --send           # deliver emails
 *   bun scripts/send-weekly-digest.mjs --business-id=<id>
 *
 * CLI contract:
 *   --dry-run --send → exit 1 (conflict), zero sends
 *   --foobar         → exit 1 (unknown flag)
 *   --send --send    → accepted idempotently (deterministic, documented)
 * Duplicate flags: LAST occurrence wins (deterministic, documented).
 *
 * Scope: ALL businesses with at least 1 non-deleted sale OR 1 non-deleted
 * expense (relation-existence query — bounded by MAX_BUSINESSES_PER_RUN,
 * deterministic id order). A business with no activity in the window still
 * gets an honest zero-filled digest.
 *
 * Output: one JSON line per business — businessId/name, masked recipient,
 * stats counters (mode/counts only). Recipient addresses are MASKED
 * (maskAddress); no email bodies, no money strings, no secrets are printed.
 *
 * Exit codes: 0 = run completed (dry or send) · 1 = invalid CLI usage OR
 * systemic failure (e.g. database unreachable). One bad business never
 * aborts the run.
 *
 * Scheduling examples (DOCUMENTATION ONLY — never auto-installed):
 *   Linux cron :  0 8 * * 1  app  cd /srv/my-project && bun scripts/send-weekly-digest.mjs --send >> /var/log/aibc-weekly-digest.log 2>&1
 *   systemd    :  aibc-weekly-digest.timer (OnCalendar=Mon 08:00) → aibc-weekly-digest.service
 *   Windows    :  Task Scheduler weekly, Monday 08:00 — program bun.exe,
 *                 arguments "scripts/send-weekly-digest.mjs --send",
 *                 working directory = project root.
 * Overlap protection is the scheduler's job (flock / systemd concurrency /
 * Task Scheduler instance policy); the builder itself is read-only.
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

const runId = randomUUID();

/** Hard cap per run — keeps a pathological database from exploding one run. */
const MAX_BUSINESSES_PER_RUN = 500;

function emit(payload) {
  console.log(JSON.stringify({ job: "weekly-digest", runId, ...payload }));
}

/** Emit a safe usage error and exit 1 (no DB access has happened yet). */
function usageError(code, message) {
  console.error(
    JSON.stringify({
      job: "weekly-digest",
      runId,
      error: "CLI_USAGE_INVALID",
      code,
      message,
      finishedAt: new Date().toISOString(),
    }),
  );
  process.exit(1);
}

// Parse + validate FIRST — before any import that touches the database.
const argv = process.argv.slice(2);
let send = false;
let dryRun = false;
let businessIdScope = null;
for (const arg of argv) {
  if (arg === "--send") {
    send = true;
  } else if (arg === "--dry-run") {
    dryRun = true;
  } else if (arg.startsWith("--business-id=")) {
    businessIdScope = arg.slice("--business-id=".length).trim();
  } else {
    usageError("UNKNOWN_FLAG", `unknown argument: ${arg}`);
  }
}
if (dryRun && send) {
  usageError("FLAG_CONFLICT", "--dry-run and --send are mutually exclusive");
}
const mode = send ? "SEND" : "DRY_RUN"; // DEFAULT IS DRY RUN
if (businessIdScope && !/^[a-zA-Z0-9_-]{6,64}$/.test(businessIdScope)) {
  usageError("INVALID_BUSINESS_ID", "business id must match [a-zA-Z0-9_-]{6,64}");
}

try {
  // bun runs TS directly — the .mjs shell imports the TS builders the same
  // way scripts/process-crm-task-reminders.mjs imports its TS processor.
  const { buildWeeklyDigest } = await import("../src/lib/email/digest.ts");
  const { db } = await import("../src/lib/db.ts");
  const { getEmailProvider, maskAddress } = await import("../src/lib/email/index.ts");

  emit({ mode, startedAt: new Date().toISOString() });

  // Bounded candidate scan: at least 1 live sale OR 1 live expense.
  const candidates = businessIdScope
    ? [{ id: businessIdScope }]
    : await db.business.findMany({
        where: {
          OR: [{ sales: { some: { deletedAt: null } } }, { expenses: { some: { deletedAt: null } } }],
        },
        select: { id: true },
        orderBy: { id: "asc" },
        take: MAX_BUSINESSES_PER_RUN,
      });

  const result = {
    mode,
    candidates: candidates.length,
    built: 0,
    sent: 0,
    skippedNoRecipient: 0,
    failed: 0,
  };

  const provider = mode === "SEND" ? getEmailProvider() : null;

  for (const candidate of candidates) {
    try {
      const digest = await buildWeeklyDigest(candidate.id, { now: new Date() });
      result.built += 1;
      if (!digest.ownerEmail) {
        result.skippedNoRecipient += 1;
        emit({ businessId: candidate.id, business: digest.business.name, outcome: "skipped", reason: "no owner email" });
        continue;
      }
      if (mode === "DRY_RUN") {
        emit({
          businessId: candidate.id,
          business: digest.business.name,
          outcome: "dry-run",
          to: maskAddress(digest.ownerEmail),
          subject: digest.subject,
          stats: {
            salesCount: digest.stats.salesCount,
            salesTotalMinor: digest.stats.salesTotalMinor,
            collectedMinor: digest.stats.collectedMinor,
            expensesMinor: digest.stats.expensesMinor,
            receivablesMinor: digest.stats.receivablesMinor,
            receivablesCount: digest.stats.receivablesCount,
            lowStockCount: digest.stats.lowStockCount,
            topProduct: digest.stats.topProduct ? digest.stats.topProduct.name : null,
          },
          window: [digest.stats.windowStart, digest.stats.windowEnd],
        });
        continue;
      }
      await provider.send({
        to: digest.ownerEmail,
        subject: digest.subject,
        text: digest.text,
        html: digest.html,
      });
      result.sent += 1;
      emit({ businessId: candidate.id, business: digest.business.name, outcome: "sent", to: maskAddress(digest.ownerEmail) });
    } catch (error) {
      // One bad business never aborts the run (§67/§68 spirit).
      result.failed += 1;
      emit({
        businessId: candidate.id,
        outcome: "failed",
        errorClass: error instanceof Error ? error.name : "UNKNOWN",
      });
    }
  }

  emit({ ...result, finishedAt: new Date().toISOString() });
  process.exit(0);
} catch (error) {
  // Systemic failure (DB unreachable, provider config error): exit nonzero.
  console.error(
    JSON.stringify({
      job: "weekly-digest",
      runId,
      error: error instanceof Error ? error.name : "UNKNOWN",
      finishedAt: new Date().toISOString(),
    }),
  );
  process.exit(1);
}
