/**
 * Prompt 36 — Work queue service (§29/§30/§32/§67/§88).
 *
 * "What do I need to do?" — a SERVER-driven, bounded view of the caller's
 * active tasks. Buckets (overdue / today / upcoming / unscheduled) are
 * classified SERVER-side with server `now` (UTC) and the BUSINESS timezone
 * (§32/§118 — the browser clock and browser locale are never authoritative).
 * Hard cap 50 rows (§29) — no unbounded queries.
 *
 * NO reminder delivery of any kind is built here (§33/§66): a due task is
 * only surfaced; scheduling/notifications are a future phase.
 */
import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-helpers";
import { safeTimeZone } from "./task-types";
import { compareWorkQueueItems, type WorkQueueBucket } from "./task-types";
import { taskPriorityOf, taskStatusOf } from "./task-dto";
import type { CrmContextType } from "./activity-types";
import type { WorkQueueTask, WorkQueueResponse } from "./work-queue-types";

/** Hard cap for the work queue (§29). */
export const WORK_QUEUE_MAX = 50;

/** Only active tasks appear in the queue (§29/§32). */
const QUEUE_STATUSES = ["OPEN", "IN_PROGRESS"] as const;

export type { WorkQueueTask, WorkQueueResponse } from "./work-queue-types";

/**
 * Build the work queue (§29). Default scope = the CALLING user's assigned
 * tasks. An explicit assignedToUserId is allowed only when that user is a
 * member of the current business (§29/§69) — validated here, never inferred.
 */
export async function getWorkQueue(
  businessId: string,
  viewerUserId: string,
  opts: { assignedToUserId?: string | null; businessTimezone?: string | null } = {},
): Promise<WorkQueueResponse> {
  let scopeUserId = viewerUserId;
  if (opts.assignedToUserId && opts.assignedToUserId !== viewerUserId) {
    const member = await db.businessMember.findUnique({
      where: {
        businessId_userId: { businessId, userId: opts.assignedToUserId },
      },
      select: { id: true },
    });
    if (!member) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "The requested assignee does not belong to this business.",
        { field: "assignedToUserId" },
      );
    }
    scopeUserId = opts.assignedToUserId;
  }

  const where = {
    businessId,
    deletedAt: null,
    status: { in: [...QUEUE_STATUSES] },
    assignedToUserId: scopeUserId,
  };

  const [rows, openCount, overdueCount, dueTodayCount] = await Promise.all([
    db.crmTask.findMany({
      where,
      // Rough pre-order only; the deterministic order is applied in app code
      // after bucket classification (§29/§124).
      orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: WORK_QUEUE_MAX,
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        dueAt: true,
        createdAt: true,
        assignedToUserId: true,
        assignedToUser: { select: { id: true, name: true, email: true } },
        leadId: true,
        lead: { select: { id: true, name: true, companyName: true } },
        opportunityId: true,
        opportunity: { select: { id: true, title: true } },
        customerId: true,
        customer: { select: { id: true, name: true } },
      },
    }),
    db.crmTask.count({ where }),
    db.crmTask.count({
      where: { ...where, dueAt: { lt: new Date() } },
    }),
    // "Due today" needs day boundaries in the business timezone; the exact
    // day window is computed below (count uses the same window).
    Promise.resolve(0),
  ]);

  const businessTimezone = await db.business
    .findUnique({ where: { id: businessId }, select: { timezone: true } })
    .then((b) => b?.timezone ?? "UTC");
  const tz = safeTimeZone(businessTimezone);
  const now = new Date(); // §67 — server clock, UTC instant

  const dayKey = (d: Date) => {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(d);
    } catch {
      return d.toISOString().slice(0, 10);
    }
  };
  const todayKey = dayKey(now);

  const items: WorkQueueTask[] = rows.map((row) => {
    let contextType: CrmContextType = "CUSTOMER";
    let contextId = "";
    let contextTitle = "";
    if (row.customerId && row.customer) {
      contextType = "CUSTOMER";
      contextId = row.customer.id;
      contextTitle = row.customer.name;
    } else if (row.leadId && row.lead) {
      contextType = "LEAD";
      contextId = row.lead.id;
      contextTitle = row.lead.companyName ?? row.lead.name;
    } else if (row.opportunityId && row.opportunity) {
      contextType = "OPPORTUNITY";
      contextId = row.opportunity.id;
      contextTitle = row.opportunity.title;
    }
    return {
      id: row.id,
      title: row.title,
      priority: taskPriorityOf(row.priority),
      status: taskStatusOf(row.status),
      dueAt: row.dueAt ? row.dueAt.toISOString() : null,
      assignedTo: row.assignedToUser
        ? { id: row.assignedToUser.id, name: row.assignedToUser.name, email: row.assignedToUser.email }
        : null,
      contextType,
      contextId,
      contextTitle,
    };
  });

  // §29/§124 — deterministic order: bucket → priority desc → dueAt asc →
  // createdAt asc → id. compareWorkQueueItems implements exactly this.
  const sorted = [...rows]
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const cmp = compareWorkQueueItems(
        {
          dueAt: a.row.dueAt,
          priority: a.row.priority,
          createdAt: a.row.createdAt,
          id: a.row.id,
        },
        {
          dueAt: b.row.dueAt,
          priority: b.row.priority,
          createdAt: b.row.createdAt,
          id: b.row.id,
        },
        now,
        tz,
      );
      return cmp !== 0 ? cmp : a.index - b.index;
    })
    .map((entry) => items[entry.index]);

  const buckets: Record<WorkQueueBucket, WorkQueueTask[]> = {
    overdue: [],
    today: [],
    upcoming: [],
    unscheduled: [],
  };
  for (const item of sorted) {
    const bucket = classifyIso(item.dueAt, now, dayKey, todayKey);
    buckets[bucket].push(item);
  }

  const dueTodayExact = rows.filter((row) => {
    if (!row.dueAt) return false;
    if (row.dueAt.getTime() < now.getTime()) return false;
    return dayKey(row.dueAt) === todayKey;
  }).length;

  return {
    overdue: buckets.overdue,
    today: buckets.today,
    upcoming: buckets.upcoming,
    unscheduled: buckets.unscheduled,
    counts: {
      myOpenTaskCount: openCount,
      myOverdueTaskCount: overdueCount,
      myDueTodayCount: dueTodayExact,
    },
    assignedToUserId: scopeUserId,
  };
}

function classifyIso(
  dueAtIso: string | null,
  now: Date,
  dayKey: (d: Date) => string,
  todayKey: string,
): WorkQueueBucket {
  if (!dueAtIso) return "unscheduled";
  const dueAt = new Date(dueAtIso);
  if (dueAt.getTime() < now.getTime()) return "overdue";
  if (dayKey(dueAt) === todayKey) return "today";
  return "upcoming";
}
