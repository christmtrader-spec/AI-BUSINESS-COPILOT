import "server-only";

/**
 * Prompt 37 — CRM reminder summary (§63/§64).
 *
 * Small business-scoped aggregate for the CRM dashboard Work Queue card:
 * counts of ACTIVE tasks with reminder configuration — NOT notification
 * counts (§63/§64). All three counters are computed server-side over
 * OPEN/IN_PROGRESS, non-deleted tasks. Bounded count queries only.
 */

import { db } from "@/lib/db";
import { isDueSoonNow } from "./task-types";

export type CrmReminderSummary = {
  /** Active tasks with a due-soon reminder configured. */
  dueSoonEnabledCount: number;
  /** Active tasks with the overdue alert configured. */
  overdueAlertsEnabledCount: number;
  /** Active tasks whose reminder window starts within the next 24h (§63). */
  dueSoonNext24hCount: number;
};

const ACTIVE_STATUSES = ["OPEN", "IN_PROGRESS"];

export async function getCrmReminderSummary(businessId: string): Promise<CrmReminderSummary> {
  const base = {
    businessId,
    deletedAt: null,
    status: { in: ACTIVE_STATUSES },
    assignedToUserId: { not: null },
  };
  const now = new Date();
  const in24h = new Date(now.getTime() + 86_400_000);

  const [dueSoonEnabledCount, overdueAlertsEnabledCount] = await Promise.all([
    db.crmTask.count({ where: { ...base, reminderEnabled: true, dueAt: { not: null } } }),
    db.crmTask.count({ where: { ...base, overdueAlertEnabled: true, dueAt: { not: null } } }),
  ]);

  // §63 — "tasks with reminders in the next 24h": reminder windows that
  // START within the next 24h (dueAt - offset >= now) or are already open
  // and the task is not yet due. Computed over the bounded set of tasks
  // due in the next 24h + max offset (7d) — never an unbounded scan.
  const windowRows = await db.crmTask.findMany({
    where: {
      ...base,
      reminderEnabled: true,
      dueAt: { gte: now, lte: in24h },
    },
    select: { dueAt: true, reminderMinutesBefore: true },
    take: 500,
    orderBy: [{ dueAt: "asc" }, { id: "asc" }],
  });
  // A reminder whose window is ALREADY open (now >= dueAt - offset) and the
  // task is still active counts as "upcoming reminder" only while the task
  // is not yet due (dueAt > now — guaranteed by the query window).
  const dueSoonNext24hCount = windowRows.filter(
    (row) => row.dueAt && row.reminderMinutesBefore && isDueSoonNow(row.dueAt, row.reminderMinutesBefore, now),
  ).length;

  return { dueSoonEnabledCount, overdueAlertsEnabledCount, dueSoonNext24hCount };
}
