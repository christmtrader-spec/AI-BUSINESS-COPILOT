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
