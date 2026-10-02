/**
 * Prompt 36 — Unified CRM timeline service (§34/§35/§36/§73).
 *
 * Combines Activities (by occurredAt) + active Tasks (by createdAt) for ONE
 * context into a newest-first feed. Deliberately EXCLUDES AuditLog rows,
 * security events, notification deliveries and financial transactions
 * (§34/§108/§110 — separate records, separate semantics).
 *
 * Bounded candidate window (§36/§73): at most 50 candidates per source are
 * fetched, merged deterministically in application code, paginated to ≤100
 * (default 25). NO load-everything-then-sort; Prisma-only (no raw SQL).
 *
 * Tie-break (§73): timestamp descending, then id ascending.
 */
import "server-only";
import { db } from "@/lib/db";
import { loadCrmContextOr404 } from "./service";
import { isActivityType, type ActivityType, type CrmContextType } from "./activity-types";
import { taskPriorityOf, taskStatusOf } from "./task-dto";
import type { TaskPriority, TaskStatus } from "./task-types";
import type { TimelineItem, TimelineResponse, TimelineFilters } from "./timeline-types";

/** Candidate window per source (§36/§73). */
export const TIMELINE_CANDIDATES_PER_SOURCE = 50;
export const TIMELINE_PAGE_SIZE_DEFAULT = 25;
export const TIMELINE_PAGE_SIZE_MAX = 100;

export type { TimelineItem, TimelineResponse, TimelineFilters } from "./timeline-types";

export async function getTimeline(
  businessId: string,
  f: TimelineFilters,
): Promise<TimelineResponse> {
  // §20/§34 — contextType resolves ONLY to its own closed model; foreign or
  // soft-deleted contexts behave exactly like unknown ids (404).
  await loadCrmContextOr404(f.contextType, f.contextId, businessId);

  const contextWhere =
    f.contextType === "CUSTOMER"
      ? { customerId: f.contextId }
      : f.contextType === "LEAD"
        ? { leadId: f.contextId }
        : { opportunityId: f.contextId };

  const [activities, tasks] = await Promise.all([
    db.crmActivity.findMany({
      where: { businessId, deletedAt: null, ...contextWhere },
      orderBy: [{ occurredAt: "desc" }, { id: "asc" }],
      take: TIMELINE_CANDIDATES_PER_SOURCE,
      select: {
        id: true,
        type: true,
        title: true,
        description: true,
        occurredAt: true,
        durationMinutes: true,
        createdByUserId: true,
        createdByUser: { select: { id: true, name: true } },
      },
    }),
    db.crmTask.findMany({
      where: { businessId, deletedAt: null, ...contextWhere },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: TIMELINE_CANDIDATES_PER_SOURCE,
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        dueAt: true,
        completedAt: true,
        createdAt: true,
        assignedToUserId: true,
        assignedToUser: { select: { id: true, name: true } },
      },
    }),
  ]);

  const items: TimelineItem[] = [
    ...activities.map((a) => ({
      kind: "ACTIVITY" as const,
      id: a.id,
      title: a.title,
      description: a.description,
      timestamp: a.occurredAt.toISOString(),
      activityType: (isActivityType(a.type) ? a.type : "OTHER") as ActivityType,
      taskStatus: null,
      priority: null,
      dueAt: null,
      completedAt: null,
      durationMinutes: a.durationMinutes,
      actor: a.createdByUser
        ? { id: a.createdByUser.id, name: a.createdByUser.name }
        : null,
      assignee: null,
    })),
    ...tasks.map((t) => ({
      kind: "TASK" as const,
      id: t.id,
      title: t.title,
      description: t.description,
      timestamp: t.createdAt.toISOString(),
      activityType: null,
      taskStatus: taskStatusOf(t.status),
      priority: taskPriorityOf(t.priority),
      dueAt: t.dueAt ? t.dueAt.toISOString() : null,
      completedAt: t.completedAt ? t.completedAt.toISOString() : null,
      durationMinutes: null,
      actor: null,
      assignee: t.assignedToUser
        ? { id: t.assignedToUser.id, name: t.assignedToUser.name }
        : null,
    })),
  ];

  // §73 — timestamp descending, then id ascending (deterministic merge).
  items.sort((a, b) => {
    const ta = a.timestamp;
    const tb = b.timestamp;
    if (ta !== tb) return ta < tb ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const pageSize = Math.min(
    Math.max(1, f.pageSize || TIMELINE_PAGE_SIZE_DEFAULT),
    TIMELINE_PAGE_SIZE_MAX,
  );
  const page = Math.max(1, Math.trunc(f.page) || 1);
  const start = (page - 1) * pageSize;

  return {
    items: items.slice(start, start + pageSize),
    page,
    pageSize,
    windowSize: items.length,
    hasMore:
      activities.length === TIMELINE_CANDIDATES_PER_SOURCE ||
      tasks.length === TIMELINE_CANDIDATES_PER_SOURCE ||
      start + pageSize < items.length,
  };
}
