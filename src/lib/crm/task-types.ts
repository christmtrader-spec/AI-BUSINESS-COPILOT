/**
 * Prompt 36 — CRM Task vocabulary + pure task rules (§12/§13/§31/§32/§67).
 *
 * A CRM Task is a future/current action someone in the business must
 * perform. It is NOT a Notification, NOT a CalendarEvent and NOT an
 * Activity (§3). Statuses and priorities are CLOSED vocabularies stored as
 * validated strings (SQLite has no enums — same law as Prompt 35 §6).
 *
 * CLIENT-SAFE: pure constants/guards/pure classification only. The DB
 * service lives in task-service.ts / work-queue.ts (server-only).
 */

export const TASK_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELED",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;

export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

export function isTaskPriority(value: string): value is TaskPriority {
  return (TASK_PRIORITIES as readonly string[]).includes(value);
}

/**
 * Task state machine (§13). Allowed transitions — anything not listed here
 * is rejected by the server with 422. The server is authoritative; the
 * generic PATCH endpoint can never change status (§26).
 */
const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  OPEN: ["IN_PROGRESS", "COMPLETED", "CANCELED"],
  IN_PROGRESS: ["COMPLETED", "OPEN", "CANCELED"],
  COMPLETED: ["OPEN", "CANCELED"],
  CANCELED: ["OPEN", "COMPLETED"],
};

export function isTaskTransitionValid(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/** Exposed for tests/docs — the full transition map (read-only). */
export function taskTransitionsOf(from: TaskStatus): readonly TaskStatus[] {
  return TASK_TRANSITIONS[from];
}

/**
 * Priority ordering (§31) — deterministic SERVER vocabulary order, never
 * localized labels. Lower rank sorts first (URGENT before HIGH before
 * NORMAL before LOW).
 */
export const PRIORITY_RANK: Readonly<Record<TaskPriority, number>> = {
  URGENT: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
};

/**
 * Work-queue buckets (§29/§30) in their fixed display order.
 */
export const WORK_QUEUE_BUCKETS = ["overdue", "today", "upcoming", "unscheduled"] as const;

export type WorkQueueBucket = (typeof WORK_QUEUE_BUCKETS)[number];

const BUCKET_RANK: Readonly<Record<WorkQueueBucket, number>> = {
  overdue: 0,
  today: 1,
  upcoming: 2,
  unscheduled: 3,
};

/**
 * Day key ("YYYY-MM-DD") of an instant in a SPECIFIC IANA timezone (§16 —
 * "due today" means today in the BUSINESS timezone, never the browser's).
 * Uses Intl (no dependency); invalid timezones fall back to UTC.
 */
export function dayKeyInTz(date: Date, timeZone: string): string {
  let tz = timeZone;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
  } catch {
    tz = "UTC";
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Safe IANA timezone fallback (invalid business tz → UTC, never throw). */
export function safeTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/**
 * Bucket classification for a task (§32/§67/§120) — SERVER semantics.
 *
 *  - overdue:     dueAt !== null && dueAt < now   (strict instant compare,
 *                 UTC `now` from the server — browser clock never used)
 *  - today:       not overdue && same business-tz day as now
 *  - upcoming:    not overdue/today && dueAt in the future
 *  - unscheduled: dueAt === null
 *
 * Only OPEN / IN_PROGRESS tasks are ever classified (completed/canceled do
 * not appear in the queue — §29 "What do I need to do?").
 */
export function classifyDueBucket(
  dueAt: Date | null,
  now: Date,
  timeZone: string,
): WorkQueueBucket {
  if (!dueAt) return "unscheduled";
  if (dueAt.getTime() < now.getTime()) return "overdue";
  if (dayKeyInTz(dueAt, timeZone) === dayKeyInTz(now, timeZone)) return "today";
  return "upcoming";
}

/**
 * Deterministic work-queue / list comparator (§29/§31/§73/§124):
 *   1. bucket (overdue → today → upcoming → unscheduled)
 *   2. priority rank ascending (URGENT first)
 *   3. dueAt ascending (nulls last — only in the unscheduled bucket anyway)
 *   4. createdAt ascending
 *   5. id ascending (final tie-break so two rows created in the same
 *      millisecond still order deterministically)
 */
export type QueueSortable = {
  dueAt: Date | null;
  priority: string;
  createdAt: Date;
  id: string;
};

export function compareWorkQueueItems<T extends QueueSortable>(
  a: T,
  b: T,
  now: Date,
  timeZone: string,
): number {
  const bucketA = BUCKET_RANK[classifyDueBucket(a.dueAt, now, timeZone)];
  const bucketB = BUCKET_RANK[classifyDueBucket(b.dueAt, now, timeZone)];
  if (bucketA !== bucketB) return bucketA - bucketB;
  const rankA = PRIORITY_RANK[(isTaskPriority(a.priority) ? a.priority : "NORMAL") as TaskPriority];
  const rankB = PRIORITY_RANK[(isTaskPriority(b.priority) ? b.priority : "NORMAL") as TaskPriority];
  if (rankA !== rankB) return rankA - rankB;
  const dueA = a.dueAt ? a.dueAt.getTime() : Number.POSITIVE_INFINITY;
  const dueB = b.dueAt ? b.dueAt.getTime() : Number.POSITIVE_INFINITY;
  if (dueA !== dueB) return dueA - dueB;
  if (a.createdAt.getTime() !== b.createdAt.getTime()) {
    return a.createdAt.getTime() - b.createdAt.getTime();
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Is a task "active" (appears in work queues / active-task lists)?
 * OPEN + IN_PROGRESS only (§32 — COMPLETED/CANCELED are settled).
 */
export const ACTIVE_TASK_STATUSES = ["OPEN", "IN_PROGRESS"] as const;

export function isActiveTaskStatus(status: string): boolean {
  return status === "OPEN" || status === "IN_PROGRESS";
}

/* ------------------------------------------------------------------------ */
/* Prompt 37 — per-task reminder configuration (§5–§9).                      */
/* ------------------------------------------------------------------------ */

/**
 * Closed reminder-offset vocabulary (§7). Minutes BEFORE dueAt for the ONE
 * due-soon notification. No arbitrary integers — 0/1/3/999999 are rejected.
 * 10080 = 7 days (the maximum, §42).
 */
export const REMINDER_OFFSET_MINUTES = [5, 10, 15, 30, 60, 120, 240, 1440, 2880, 10080] as const;

export type ReminderOffsetMinutes = (typeof REMINDER_OFFSET_MINUTES)[number];

export function isReminderOffset(value: unknown): value is ReminderOffsetMinutes {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (REMINDER_OFFSET_MINUTES as readonly number[]).includes(value)
  );
}

/** Maximum reminder offset — also the due-soon scan horizon (§42/§43). */
export const REMINDER_MAX_OFFSET_MINUTES: ReminderOffsetMinutes = 10080;
export const REMINDER_MAX_LOOKAHEAD_MS = REMINDER_MAX_OFFSET_MINUTES * 60_000;

/**
 * Reminder configuration consistency for a task whose dueAt is (or would
 * become) `dueAt` (§8). Returns the NORMALIZED config:
 *
 *  - reminderEnabled=false ⇒ reminderMinutesBefore MUST be null
 *  - reminderEnabled=true  ⇒ dueAt MUST exist AND the offset MUST be in the
 *    closed vocabulary
 *  - overdueAlertEnabled=true ⇒ dueAt MUST exist
 *  - dueAt=null ⇒ everything resets (prevents invalid persisted state)
 *
 * `invalid` marks a request the server must reject with 422 (an explicit
 * reminder setting that contradicts reality); `reset` marks the silent
 * server-side reset that happens when dueAt disappears (§8).
 */
export type ReminderConfigInput = {
  reminderEnabled?: boolean | null | undefined;
  reminderMinutesBefore?: number | null | undefined;
  overdueAlertEnabled?: boolean | null | undefined;
};

export type NormalizedReminderConfig = {
  reminderEnabled: boolean;
  reminderMinutesBefore: number | null;
  overdueAlertEnabled: boolean;
  invalid: boolean;
  invalidReason: string | null;
  reset: boolean;
};

export function normalizeReminderConfig(
  input: ReminderConfigInput,
  dueAtExists: boolean,
  current?: {
    reminderEnabled: boolean;
    overdueAlertEnabled: boolean;
    reminderMinutesBefore?: number | null;
  },
): NormalizedReminderConfig {
  // dueAt disappears ⇒ server automatically resets everything (§8).
  if (!dueAtExists) {
    return {
      reminderEnabled: false,
      reminderMinutesBefore: null,
      overdueAlertEnabled: false,
      invalid: false,
      invalidReason: null,
      reset: true,
    };
  }
  const reminderEnabled = input.reminderEnabled ?? current?.reminderEnabled ?? false;
  const overdueAlertEnabled = input.overdueAlertEnabled ?? current?.overdueAlertEnabled ?? false;
  const offsetProvided = input.reminderMinutesBefore !== undefined && input.reminderMinutesBefore !== null;
  // §164 — an offset ABSENT from the request falls back to the STORED one so
  // an unrelated PATCH (title change) on a reminder-configured task keeps its
  // configuration instead of failing validation.
  const offset = offsetProvided
    ? (input.reminderMinutesBefore as number)
    : (current?.reminderMinutesBefore ?? null);

  if (!reminderEnabled && offsetProvided) {
    // An orphaned offset without reminderEnabled is inconsistent (§8).
    return {
      reminderEnabled,
      reminderMinutesBefore: null,
      overdueAlertEnabled,
      invalid: true,
      invalidReason: "REMINDER_OFFSET_WITHOUT_ENABLED",
      reset: false,
    };
  }
  if (reminderEnabled) {
    if (offset === null) {
      return {
        reminderEnabled,
        reminderMinutesBefore: null,
        overdueAlertEnabled,
        invalid: true,
        invalidReason: "REMINDER_OFFSET_REQUIRED",
        reset: false,
      };
    }
    if (!isReminderOffset(offset)) {
      return {
        reminderEnabled,
        reminderMinutesBefore: null,
        overdueAlertEnabled,
        invalid: true,
        invalidReason: "REMINDER_OFFSET_INVALID",
        reset: false,
      };
    }
  }
  return {
    reminderEnabled,
    reminderMinutesBefore: reminderEnabled ? (offset as ReminderOffsetMinutes) : null,
    overdueAlertEnabled,
    invalid: false,
    invalidReason: null,
    reset: false,
  };
}

/**
 * DUE-SOON window (§75): the processor may notify when
 *   now >= dueAt - reminderMinutesBefore  AND  now < dueAt
 * Strict boundaries: dueAt == now is NOT due-soon (it is overdue — §76
 * prevents a same-run double alert); now == dueAt - offset IS due-soon
 * (inclusive lower bound — §117 threshold semantics).
 */
export function isDueSoonNow(dueAt: Date, reminderMinutesBefore: number, now: Date): boolean {
  if (!isReminderOffset(reminderMinutesBefore)) return false;
  const t = dueAt.getTime();
  const n = now.getTime();
  return n >= t - reminderMinutesBefore * 60_000 && n < t;
}

/** OVERDUE instant (§75): now >= dueAt, active statuses only (query filters). */
export function isOverdueNow(dueAt: Date, now: Date): boolean {
  return now.getTime() >= dueAt.getTime();
}
