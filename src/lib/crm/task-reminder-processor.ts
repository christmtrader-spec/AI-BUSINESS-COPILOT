import "server-only";

/**
 * Prompt 37 — CRM TASK REMINDER PROCESSOR (§37–§45/§75/§76/§165–§168/§193–§196).
 *
 * The time-based brain of the first REAL scheduled CRM automation. It is
 * called by an EXTERNAL, operator-managed scheduler (cron/systemd/Windows
 * Task Scheduler — §2/§70–§72) through scripts/process-crm-task-reminders.mjs,
 * or by tests with an INJECTED clock (§182). It is NEVER wired into the
 * Next.js request lifecycle — no in-process timers, no polling (§2/§97).
 *
 * Laws:
 *  - DETERMINISTIC: fixed queries, fixed order (businessId → dueAt → id,
 *    §195/§196), fixed vocabulary classification (§75).
 *  - IDEMPOTENT: notification identity is (userId, type, sourceEventId)
 *    with sourceEventId = type-marker:taskId:dueAtISO:assigneeUserId
 *    (§25/§27/§28/§180/§181). Repeated runs dedupe on the existing
 *    Notification unique index — no second reminder history (§174).
 *  - BOUNDED: max notifications per run (default 100, hard 10–500, §40);
 *    due-soon horizon = 7 days = max offset (§42/§43); overdue lookback
 *    (default 168h, 1–720h, §41) is an OPERATIONAL scanning boundary, NOT
 *    a legal retention policy (§41).
 *  - NOTIFICATION-ONLY: tasks are never mutated (§167/§168) — no status
 *    change, no reassign, no reminder toggle. Task state is read-only.
 *  - ISOLATED: one bad candidate increments `failed` and the run continues
 *    (§67/§68); a systemic DB failure propagates to the caller (exit 1).
 *  - PRIVATE: no task description, no contact details, no emails and no
 *    notification bodies ever enter the result or logs (§39/§69).
 *
 * ONE alert per run per task (§76): a task whose dueAt has passed never
 * produces BOTH due-soon and overdue — the due-soon window is strictly
 * `now < dueAt`, so the two candidate sets are disjoint by construction.
 */

import { db } from "@/lib/db";
import { logInfo, logError } from "@/lib/observability/logger";
import { OPERATIONAL_EVENTS } from "@/lib/observability/events";
import { isDueSoonNow, isOverdueNow, type TaskPriority } from "./task-types";
import { readLiveTaskContext } from "./task-context-read";
import {
  isReminderCandidateStillEligible,
  type FreshReminderTaskState,
} from "./task-reminder-safety";

/* ------------------------------- configuration ---------------------------- */

/** Default maximum notifications per run (§40). */
export const CRM_REMINDER_MAX_PER_RUN_DEFAULT = 100;
export const CRM_REMINDER_MAX_PER_RUN_MIN = 10;
export const CRM_REMINDER_MAX_PER_RUN_MAX = 500;

/** Default overdue lookback in hours (§41). */
export const CRM_REMINDER_OVERDUE_LOOKBACK_HOURS_DEFAULT = 168;
export const CRM_REMINDER_OVERDUE_LOOKBACK_HOURS_MIN = 1;
export const CRM_REMINDER_OVERDUE_LOOKBACK_HOURS_MAX = 720;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = (process.env[name] ?? "").trim();
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Effective per-run cap (§40): option wins, then env, then default. */
export function reminderMaxPerRun(option?: number): number {
  const base = Number.isFinite(option)
    ? Math.trunc(option as number)
    : envInt(
        "CRM_REMINDER_MAX_PER_RUN",
        CRM_REMINDER_MAX_PER_RUN_DEFAULT,
        CRM_REMINDER_MAX_PER_RUN_MIN,
        CRM_REMINDER_MAX_PER_RUN_MAX,
      );
  return Math.min(
    CRM_REMINDER_MAX_PER_RUN_MAX,
    Math.max(CRM_REMINDER_MAX_PER_RUN_MIN, base),
  );
}

/** Effective overdue lookback in HOURS (§41). */
export function reminderOverdueLookbackHours(): number {
  return envInt(
    "CRM_REMINDER_OVERDUE_LOOKBACK_HOURS",
    CRM_REMINDER_OVERDUE_LOOKBACK_HOURS_DEFAULT,
    CRM_REMINDER_OVERDUE_LOOKBACK_HOURS_MIN,
    CRM_REMINDER_OVERDUE_LOOKBACK_HOURS_MAX,
  );
}

/* --------------------------------- types ---------------------------------- */

export type ReminderProcessorOptions = {
  /** Injectable clock (§182) — tests inject; production defaults to now(). */
  now?: Date;
  /** Optional single-business scope (§197 — validated, exact, injection-safe). */
  businessId?: string;
  /** DRY_RUN (default) never writes; APPLY creates notifications (§38/§166). */
  dryRun?: boolean;
  /** Optional explicit cap override (§40 — bounded 10–500). */
  maxTasks?: number;
};

export type ReminderProcessorResult = {
  mode: "DRY_RUN" | "APPLY";
  scanned: number;
  dueSoonCandidates: number;
  overdueCandidates: number;
  created: number;
  duplicates: number;
  skipped: number;
  failed: number;
};

/** Minimal candidate row — only fields needed for classification + data. */
type CandidateRow = {
  id: string;
  businessId: string;
  title: string;
  priority: string;
  dueAt: Date;
  reminderMinutesBefore: number | null;
  assignedToUserId: string | null;
  reminderEnabled: boolean;
  overdueAlertEnabled: boolean;
};

/* ------------------------------- queries (§43/§44) ------------------------ */

/** Explicit select — never full relations, never description/contact fields (§45). */
const candidateSelect = {
  id: true,
  businessId: true,
  title: true,
  priority: true,
  dueAt: true,
  reminderMinutesBefore: true,
  assignedToUserId: true,
  reminderEnabled: true,
  overdueAlertEnabled: true,
} as const;

/** §195 — deterministic in-query order: dueAt asc, id asc. */
const candidateOrder = [{ dueAt: "asc" }, { id: "asc" }] as const;

/* ------------------------------- classification --------------------------- */

type DueSoonCandidate = { row: CandidateRow; kind: "DUE_SOON" };
type OverdueCandidate = { row: CandidateRow; kind: "OVERDUE" };
type Candidate = DueSoonCandidate | OverdueCandidate;

/* -------------------------------- processor ------------------------------- */

export async function processCrmTaskReminders(
  options: ReminderProcessorOptions = {},
): Promise<ReminderProcessorResult> {
  const mode: "DRY_RUN" | "APPLY" = options.dryRun === false ? "APPLY" : "DRY_RUN";
  const max = reminderMaxPerRun(options.maxTasks);
  const lookbackHours = reminderOverdueLookbackHours();
  const now = options.now ?? new Date(); // §75 — server clock (or injected test clock)

  const businessScope = options.businessId?.trim() || null;
  if (businessScope && !/^[a-zA-Z0-9_-]{6,64}$/.test(businessScope)) {
    // §197 — an invalid scope is a caller error, not a partial run.
    throw new Error("crm-reminder: invalid businessId scope");
  }

  const activeStatuses = ["OPEN", "IN_PROGRESS"];
  const lookbackMs = lookbackHours * 3_600_000;

  // §43 — due-soon scan: future dueAt within the 7-day (= max offset)
  // horizon. Per-row window classification happens in app code below
  // (SQLite cannot compare dueAt - perRowOffset in one query).
  const dueSoonRows = (await db.crmTask.findMany({
    where: {
      ...(businessScope ? { businessId: businessScope } : {}),
      deletedAt: null,
      status: { in: activeStatuses },
      assignedToUserId: { not: null },
      dueAt: { gte: now, lte: new Date(now.getTime() + 7 * 86_400_000) },
      reminderEnabled: true,
    },
    orderBy: [...candidateOrder],
    take: max,
    select: candidateSelect,
  })) as CandidateRow[];

  // §44 — overdue scan: bounded lookback window.
  const overdueRows = (await db.crmTask.findMany({
    where: {
      ...(businessScope ? { businessId: businessScope } : {}),
      deletedAt: null,
      status: { in: activeStatuses },
      assignedToUserId: { not: null },
      dueAt: { lt: now, gte: new Date(now.getTime() - lookbackMs) },
      overdueAlertEnabled: true,
    },
    orderBy: [...candidateOrder],
    take: max,
    select: candidateSelect,
  })) as CandidateRow[];

  // §37 step 2/3 — classify the fetched rows against the exact window rules.
  const dueSoonCandidates: DueSoonCandidate[] = [];
  for (const row of dueSoonRows) {
    if (!row.assignedToUserId || !row.reminderMinutesBefore) continue;
    if (isDueSoonNow(row.dueAt, row.reminderMinutesBefore, now)) {
      dueSoonCandidates.push({ row, kind: "DUE_SOON" });
    }
  }
  const overdueCandidates: OverdueCandidate[] = [];
  for (const row of overdueRows) {
    if (!row.assignedToUserId) continue;
    if (isOverdueNow(row.dueAt, now)) {
      overdueCandidates.push({ row, kind: "OVERDUE" });
    }
  }

  // §196 — deterministic global order: businessId asc → dueAt asc → id asc.
  // The two kinds are disjoint per task (§76), so `id` never collides.
  const merged: Candidate[] = [...dueSoonCandidates, ...overdueCandidates].sort((a, b) => {
    if (a.row.businessId !== b.row.businessId) {
      return a.row.businessId < b.row.businessId ? -1 : 1;
    }
    const dueA = a.row.dueAt.getTime();
    const dueB = b.row.dueAt.getTime();
    if (dueA !== dueB) return dueA - dueB;
    return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0;
  });

  // §40 — hard stop after `max` candidates; the next run continues.
  const bounded = merged.slice(0, max);

  // §47 — resolve business timezones once per distinct business (bounded).
  const businessIds = [...new Set(bounded.map((c) => c.row.businessId))];
  const timezoneByBusiness = new Map<string, string>();
  for (const businessId of businessIds) {
    const tz = await db.business
      .findUnique({ where: { id: businessId }, select: { timezone: true } })
      .then((b) => b?.timezone ?? "UTC");
    timezoneByBusiness.set(businessId, tz || "UTC");
  }

  // Prompt 37-F (§10/§47) — the debug switch emits ONLY safe aggregate
  // metadata: counts and run configuration. NO task ids, business ids,
  // dueAt values, offsets, assignee ids, titles or bodies ever reach this
  // output (§11 safe logging law — enforced by crm-reminder-static-scan
  // rules 21–26 and the §47 safe-debug E2E/unit checks).
  if (process.env.CRM_REMINDER_DEBUG === "1") {
    console.log(
      JSON.stringify({
        debug: "crm-task-reminders",
        phase: "candidate-scan",
        dueSoonScanned: dueSoonRows.length,
        overdueScanned: overdueRows.length,
        max,
        mode,
      }),
    );
  }

  const result: ReminderProcessorResult = {
    mode,
    scanned: dueSoonRows.length + overdueRows.length,
    dueSoonCandidates: dueSoonCandidates.length,
    overdueCandidates: overdueCandidates.length,
    created: 0,
    duplicates: 0,
    skipped: 0,
    failed: 0,
  };

  // Defensive re-check data guard (§68/§31–§36): a candidate that no longer
  // satisfies its own precondition (completed, canceled, deleted, reassigned,
  // rescheduled, config flipped between query and processing, context gone)
  // is SKIPPED, never half-processed. The FRESH state is re-read from the
  // database immediately before notify — the scanned row alone is not
  // trusted (§35: minimal select, never the description).
  for (const candidate of bounded) {
    const row = candidate.row;
    try {
      const assigneeId = row.assignedToUserId;
      if (!assigneeId || !row.dueAt) {
        result.skipped += 1;
        continue;
      }
      if (candidate.kind === "DUE_SOON") {
        const offset = row.reminderMinutesBefore;
        if (!row.reminderEnabled || !offset || !isDueSoonNow(row.dueAt, offset, now)) {
          result.skipped += 1;
          continue;
        }
      } else if (!row.overdueAlertEnabled) {
        result.skipped += 1;
        continue;
      }

      // §35 — fresh minimal task state, re-read NOW (no description loaded).
      const fresh = (await db.crmTask.findFirst({
        where: { id: row.id, businessId: row.businessId },
        select: {
          id: true,
          businessId: true,
          status: true,
          deletedAt: true,
          dueAt: true,
          assignedToUserId: true,
          reminderEnabled: true,
          reminderMinutesBefore: true,
          overdueAlertEnabled: true,
        },
      })) as FreshReminderTaskState | null;
      if (
        !fresh ||
        !isReminderCandidateStillEligible(candidate.kind, fresh, assigneeId, row.dueAt, now)
      ) {
        // §31/§32/§33/§34 — completed/canceled/deleted/reassigned/rescheduled/
        // reconfigured between scan and notify ⇒ no notification.
        result.skipped += 1;
        continue;
      }

      // §36 — context re-check against CURRENT rows: the context must still
      // exist AND belong to the same business (deletedAt-filtered read). A
      // deleted context skips the notification entirely (no CUSTOMER/"").
      const freshContext = await readFreshContext(fresh);
      if (!freshContext) {
        result.skipped += 1;
        continue;
      }
      const context = freshContext;
      const businessTimezone = timezoneByBusiness.get(row.businessId) ?? "UTC";

      if (mode === "DRY_RUN") {
        // §66/§166 — no notify/notifyFailSafe/dispatch calls at all. The
        // duplicate estimate comes from an actual read-only existence check
        // against the same deterministic identity the APPLY path would use.
        const sourceEventId = dueSoonOrOverdueSourceEventId(candidate, assigneeId);
        const existing = await db.notification.findFirst({
          where: { userId: assigneeId, type: candidate.kind === "DUE_SOON" ? "BUSINESS_CRM_TASK_DUE_SOON" : "BUSINESS_CRM_TASK_OVERDUE", sourceEventId },
          select: { id: true },
        });
        if (existing) result.duplicates += 1;
        else result.created += 1; // wouldCreate
        continue;
      }

      // APPLY (§167) — notification writes only; task rows stay read-only.
      const { notifyCrmTaskDueSoon, notifyCrmTaskOverdue } = await import(
        "@/lib/notifications/event-mappers"
      );
      const outcome =
        candidate.kind === "DUE_SOON"
          ? await notifyCrmTaskDueSoon({
              businessId: row.businessId,
              taskId: row.id,
              assigneeUserId: assigneeId,
              taskTitle: row.title,
              priority: row.priority as TaskPriority,
              contextType: context.type,
              contextTitle: context.title,
              dueAt: row.dueAt,
              reminderMinutesBefore: row.reminderMinutesBefore as number,
              businessTimezone,
            })
          : await notifyCrmTaskOverdue({
              businessId: row.businessId,
              taskId: row.id,
              assigneeUserId: assigneeId,
              taskTitle: row.title,
              priority: row.priority as TaskPriority,
              contextType: context.type,
              contextTitle: context.title,
              dueAt: row.dueAt,
              businessTimezone,
            });
      if (outcome === null) result.failed += 1;
      else if (outcome.duplicate) result.duplicates += 1;
      else result.created += 1;
    } catch {
      // §67/§68 — one bad candidate never aborts the run. Safe log fields
      // only (kind/counter — no titles, ids beyond the run, no content).
      result.failed += 1;
      logError(OPERATIONAL_EVENTS.crmReminderProcessorFailed, {
        kind: candidate.kind,
        mode,
      });
    }
  }

  // §69/§170 — safe operational log: counts + mode only. No titles, no
  // context names, no emails, no description text.
  logInfo(OPERATIONAL_EVENTS.crmReminderProcessorCompleted, {
    mode,
    scanned: result.scanned,
    dueSoonCandidates: result.dueSoonCandidates,
    overdueCandidates: result.overdueCandidates,
    created: result.created,
    duplicates: result.duplicates,
    skipped: result.skipped,
    failed: result.failed,
    max,
    lookbackHours,
  });

  return result;
}

/**
 * §36 — re-read the candidate's context against CURRENT rows. The task row
 * itself must still be live, and the context row is read DIRECTLY with a
 * deletedAt filter (a relation include would NOT exclude soft-deleted
 * contexts). Returns null when the task or its context is gone — the caller
 * skips. Read-only; never mutates anything.
 */
async function readFreshContext(
  fresh: FreshReminderTaskState,
): Promise<{ type: "CUSTOMER" | "LEAD" | "OPPORTUNITY"; title: string } | null> {
  const refs = await db.crmTask.findFirst({
    where: { id: fresh.id, businessId: fresh.businessId, deletedAt: null },
    select: { customerId: true, leadId: true, opportunityId: true },
  });
  if (!refs) return null;
  return readLiveTaskContext(fresh.businessId, refs);
}

/** Deterministic identity mirror of the event mappers (§180/§181). */
function dueSoonOrOverdueSourceEventId(candidate: Candidate, assigneeUserId: string): string {
  const marker = candidate.kind === "DUE_SOON" ? "crm-task-due-soon" : "crm-task-overdue";
  const raw = `${marker}:${candidate.row.id}:${candidate.row.dueAt.toISOString()}:${assigneeUserId}`;
  return raw.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 300);
}
