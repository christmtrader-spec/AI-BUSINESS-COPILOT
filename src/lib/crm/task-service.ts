/**
 * Prompt 36 — Task service (§24–§28/§121).
 *
 * Server-authoritative state machine: the generic PATCH never touches
 * status (§26) — status changes ride the dedicated transition function
 * which validates against the closed state machine and maintains
 * completedAt (§13: non-null iff COMPLETED). Context is exactly one
 * same-business entity (§8/§9). Soft delete only (§28). Audit payloads
 * are metadata-only — task descriptions are NEVER logged (§75).
 */
import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { logError } from "@/lib/observability/logger";
import { OPERATIONAL_EVENTS } from "@/lib/observability/events";
import { parseInstant } from "./normalization";
import { resolveCrmContextInBusiness, assertAssigneeInBusiness } from "./service";
import { isTaskTransitionValid, isTaskStatus, normalizeReminderConfig, type TaskStatus } from "./task-types";
import { isAssignmentRowEligible } from "./task-reminder-safety";
import { readLiveTaskContext } from "./task-context-read";
import { mapTask, type CrmTaskRow } from "./task-dto";
import type { TaskPriority } from "./task-types";
import type { Prisma } from "@prisma/client";

export const TASK_PAGE_SIZE_DEFAULT = 25;
export const TASK_PAGE_SIZE_MAX = 100;
export const TASK_Q_MAX = 64;

export type TaskListFilters = {
  q?: string;
  status?: TaskStatus | null;
  priority?: TaskPriority | null;
  assignedToUserId?: string | null;
  contextType?: "CUSTOMER" | "LEAD" | "OPPORTUNITY" | null;
  contextId?: string | null;
  page: number;
  pageSize: number;
};

/** Full task select incl. context + assignee + creator refs (mirrors CrmTaskRow). */
function fullTaskSelect(businessId: string) {
  return {
    id: true,
    title: true,
    description: true,
    status: true,
    priority: true,
    dueAt: true,
    completedAt: true,
    leadId: true,
    lead: { select: { id: true, name: true, companyName: true } },
    opportunityId: true,
    opportunity: { select: { id: true, title: true } },
    customerId: true,
    customer: { select: { id: true, name: true } },
    assignedToUserId: true,
    assignedToUser: {
      select: {
        id: true,
        name: true,
        email: true,
        memberships: { where: { businessId }, select: { role: true }, take: 1 },
      },
    },
    createdByUserId: true,
    createdByUser: {
      select: {
        id: true,
        name: true,
        email: true,
        memberships: { where: { businessId }, select: { role: true }, take: 1 },
      },
    },
    createdAt: true,
    updatedAt: true,
    // Prompt 37 (§93) — safe reminder configuration fields.
    reminderEnabled: true,
    reminderMinutesBefore: true,
    overdueAlertEnabled: true,
  } satisfies Prisma.CrmTaskSelect;
}

async function taskWhere(businessId: string, f: TaskListFilters): Promise<Prisma.CrmTaskWhereInput> {
  const q = (f.q ?? "").trim().slice(0, TASK_Q_MAX);
  const where: Prisma.CrmTaskWhereInput = {
    businessId,
    deletedAt: null,
    ...(q ? { OR: [{ title: { contains: q } }, { description: { contains: q } }] } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.priority ? { priority: f.priority } : {}),
    ...(f.assignedToUserId ? { assignedToUserId: f.assignedToUserId } : {}),
  };
  if (f.contextType && f.contextId) {
    if (f.contextType === "CUSTOMER") {
      const customer = await db.customer.findFirst({
        where: { id: f.contextId, businessId, deletedAt: null },
        select: { id: true },
      });
      if (!customer) throw new ApiError(404, "NOT_FOUND", "Customer not found.");
      where.customerId = f.contextId;
    } else if (f.contextType === "LEAD") {
      const lead = await db.crmLead.findFirst({
        where: { id: f.contextId, businessId, deletedAt: null },
        select: { id: true },
      });
      if (!lead) throw new ApiError(404, "NOT_FOUND", "Lead not found.");
      where.leadId = f.contextId;
    } else {
      const opportunity = await db.crmOpportunity.findFirst({
        where: { id: f.contextId, businessId, deletedAt: null },
        select: { id: true },
      });
      if (!opportunity) throw new ApiError(404, "NOT_FOUND", "Opportunity not found.");
      where.opportunityId = f.contextId;
    }
  } else if (f.contextType || f.contextId) {
    throw new ApiError(422, "VALIDATION_ERROR", "contextType and contextId must be provided together.", {
      field: "contextType",
    });
  }
  return where;
}

/** Bounded task list (§24/§71) — newest created first, deterministic tie-break. */
export async function listTasks(businessId: string, f: TaskListFilters) {
  const pageSize = Math.min(Math.max(1, f.pageSize || TASK_PAGE_SIZE_DEFAULT), TASK_PAGE_SIZE_MAX);
  const page = Math.max(1, Math.trunc(f.page) || 1);
  const where = await taskWhere(businessId, { ...f, pageSize });
  const [rows, total] = await Promise.all([
    db.crmTask.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: fullTaskSelect(businessId),
    }),
    db.crmTask.count({ where }),
  ]);
  return {
    items: rows.map((row) => mapTask(row as CrmTaskRow)),
    total,
    page,
    pageSize,
  };
}

/** Single task (§24 GET/[id]) — 404 for foreign/deleted rows. */
export async function getTask(businessId: string, id: string): Promise<ReturnType<typeof mapTask>> {
  const row = await db.crmTask.findFirst({
    where: { id, businessId, deletedAt: null },
    select: fullTaskSelect(businessId),
  });
  if (!row) throw new ApiError(404, "NOT_FOUND", "Task not found.");
  return mapTask(row as CrmTaskRow);
}

/** Create (§25) — status OPEN is forced; businessId/creator are server-set. */
export async function createTask(
  businessId: string,
  actorId: string,
  input: {
    title: string;
    description?: string | null;
    priority: TaskPriority;
    dueAt?: string | null;
    assignedToUserId?: string | null;
    customerId?: string | null;
    leadId?: string | null;
    opportunityId?: string | null;
    // Prompt 37 (§163) — optional; defaults false/null/false when absent.
    reminderEnabled?: boolean | null;
    reminderMinutesBefore?: number | null;
    overdueAlertEnabled?: boolean | null;
  },
  auditMeta: { ip: string | null; userAgent: string | null },
): Promise<string> {
  const dueAt = input.dueAt ? parseInstant(input.dueAt) : null;
  if (input.dueAt && !dueAt) {
    throw new ApiError(422, "VALIDATION_ERROR", "dueAt must be a valid datetime.", {
      field: "dueAt",
    });
  }
  // §8 — server-authoritative reminder consistency (dueAt dependency,
  // closed offset vocabulary, offset requires reminderEnabled).
  const reminder = normalizeReminderConfig(input, Boolean(dueAt));
  if (reminder.invalid) {
    throw new ApiError(422, "VALIDATION_ERROR", reminderErrorMessage(reminder.invalidReason), {
      field: "reminder",
    });
  }
  const context = await resolveCrmContextInBusiness(input, businessId);
  const assignedToUserId = await assertAssigneeInBusiness(input.assignedToUserId, businessId);
  const created = await db.crmTask.create({
    data: {
      businessId,
      title: input.title,
      description: input.description,
      priority: input.priority,
      dueAt,
      assignedToUserId,
      customerId: context.customerId,
      leadId: context.leadId,
      opportunityId: context.opportunityId,
      createdByUserId: actorId,
      status: "OPEN", // §25 — server sets the initial status
      reminderEnabled: reminder.reminderEnabled,
      reminderMinutesBefore: reminder.reminderMinutesBefore,
      overdueAlertEnabled: reminder.overdueAlertEnabled,
    },
    select: { id: true, updatedAt: true },
  });
  await audit({
    businessId,
    actorId,
    action: "crm.task.create",
    entityType: "CrmTask",
    entityId: created.id,
    after: {
      id: created.id,
      title: input.title,
      priority: input.priority,
      status: "OPEN",
      dueAt: dueAt ? dueAt.toISOString() : null,
      assignedToUserId,
      customerId: context.customerId,
      leadId: context.leadId,
      opportunityId: context.opportunityId,
      reminderEnabled: reminder.reminderEnabled,
      overdueAlertEnabled: reminder.overdueAlertEnabled,
    },
    ip: auditMeta.ip,
    userAgent: auditMeta.userAgent,
  });
  // §34 — assignment notification AFTER commit; creation with another user
  // assigned notifies the assignee (never the actor self-assigning).
  // AWAITED (Prompt 37-F §14/§15): the helper is fire-safe (never throws),
  // so awaiting makes the request deterministic — the notification attempt
  // completes before control returns — while a notification failure never
  // rolls back the committed task (§36).
  if (assignedToUserId && assignedToUserId !== actorId) {
    await notifyAssignmentSafe(businessId, created.id, assignedToUserId, created.updatedAt);
  }
  return created.id;
}

/** Generic update (§26) — never status, never context. */
export async function updateTask(
  businessId: string,
  actorId: string,
  id: string,
  input: {
    title?: string;
    description?: string | null;
    priority?: TaskPriority;
    dueAt?: string | null;
    assignedToUserId?: string | null;
    // Prompt 37 (§164) — optional; absent fields behave exactly as before.
    reminderEnabled?: boolean | null;
    reminderMinutesBefore?: number | null;
    overdueAlertEnabled?: boolean | null;
  },
  auditMeta: { ip: string | null; userAgent: string | null },
): Promise<void> {
  const existing = await db.crmTask.findFirst({
    where: { id, businessId, deletedAt: null },
    select: {
      id: true,
      title: true,
      priority: true,
      dueAt: true,
      assignedToUserId: true,
      reminderEnabled: true,
      reminderMinutesBefore: true,
      overdueAlertEnabled: true,
    },
  });
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Task not found.");
  let dueAt: Date | null | undefined;
  if (input.dueAt !== undefined) {
    dueAt = input.dueAt ? parseInstant(input.dueAt) : null;
    if (input.dueAt && !dueAt) {
      throw new ApiError(422, "VALIDATION_ERROR", "dueAt must be a valid datetime.", {
        field: "dueAt",
      });
    }
  }
  // §8 — reminder consistency for the resulting dueAt. When dueAt becomes
  // null the server automatically resets all reminder fields; when a
  // request explicitly enables a reminder without a viable dueAt it is a 422.
  const effectiveDueAtExists = dueAt !== undefined ? Boolean(dueAt) : Boolean(existing.dueAt);
  const reminder = normalizeReminderConfig(
    input,
    effectiveDueAtExists,
    {
      reminderEnabled: existing.reminderEnabled,
      overdueAlertEnabled: existing.overdueAlertEnabled,
      reminderMinutesBefore: existing.reminderMinutesBefore,
    },
  );
  if (reminder.invalid) {
    throw new ApiError(422, "VALIDATION_ERROR", reminderErrorMessage(reminder.invalidReason), {
      field: "reminder",
    });
  }
  const assignedToUserId =
    "assignedToUserId" in input
      ? await assertAssigneeInBusiness(input.assignedToUserId, businessId)
      : undefined;
  const data: Prisma.CrmTaskUpdateInput = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.description !== undefined) data.description = input.description;
  if (input.priority !== undefined) data.priority = input.priority;
  if (dueAt !== undefined) data.dueAt = dueAt;
  if (assignedToUserId !== undefined) {
    data.assignedToUser =
      assignedToUserId === null ? { disconnect: true } : { connect: { id: assignedToUserId } };
  }
  // §8 — reminder fields always written from the normalized config: a
  // dueAt reset clears them; explicit values persist; absent values keep
  // the stored ones (§164 backward compatibility).
  data.reminderEnabled = reminder.reminderEnabled;
  data.reminderMinutesBefore = reminder.reminderMinutesBefore;
  data.overdueAlertEnabled = reminder.overdueAlertEnabled;
  const updated = await db.crmTask.update({
    where: { id: existing.id },
    data,
    select: { id: true, title: true, priority: true, dueAt: true, assignedToUserId: true, updatedAt: true },
  });
  await audit({
    businessId,
    actorId,
    action: "crm.task.update",
    entityType: "CrmTask",
    entityId: existing.id,
    before: {
      title: existing.title,
      priority: existing.priority,
      dueAt: existing.dueAt ? existing.dueAt.toISOString() : null,
      assignedToUserId: existing.assignedToUserId,
      reminderEnabled: existing.reminderEnabled,
      overdueAlertEnabled: existing.overdueAlertEnabled,
    },
    after: {
      title: updated.title,
      priority: updated.priority,
      dueAt: updated.dueAt ? updated.dueAt.toISOString() : null,
      assignedToUserId: updated.assignedToUserId,
      reminderEnabled: reminder.reminderEnabled,
      overdueAlertEnabled: reminder.overdueAlertEnabled,
    },
    ip: auditMeta.ip,
    userAgent: auditMeta.userAgent,
  });
  // §35 — reassignment notification strictly AFTER the DB update commits:
  // oldAssignee !== newAssignee AND newAssignee !== null AND newAssignee !==
  // actor. AWAITED (Prompt 37-F §14/§15) and fire-safe (§36); a failure
  // never rolls back the update.
  if (
    assignedToUserId !== undefined &&
    assignedToUserId !== null &&
    assignedToUserId !== existing.assignedToUserId &&
    assignedToUserId !== actorId
  ) {
    await notifyAssignmentSafe(businessId, updated.id, assignedToUserId, updated.updatedAt);
  }
}

/**
 * Status transition (§27/§13/§121) — the ONLY generic status path.
 * Vocabulary + transition validated server-side; completedAt maintained:
 * COMPLETED → now(), everything else → null (reopen/cancel clears it).
 */
export async function changeTaskStatus(
  businessId: string,
  actorId: string,
  id: string,
  targetRaw: string,
  auditMeta: { ip: string | null; userAgent: string | null },
): Promise<TaskStatus> {
  const existing = await db.crmTask.findFirst({
    where: { id, businessId, deletedAt: null },
    select: { id: true, status: true, completedAt: true },
  });
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Task not found.");
  if (!isTaskStatus(targetRaw)) {
    throw new ApiError(422, "VALIDATION_ERROR", "Unknown task status.", { field: "status" });
  }
  const from = existing.status as TaskStatus;
  const to = targetRaw;
  if (!isTaskTransitionValid(from, to)) {
    throw new ApiError(422, "INVALID_STATUS_TRANSITION", `Cannot change task status from ${from} to ${to}.`, {
      from,
      to,
    });
  }
  const now = new Date();
  const updated = await db.crmTask.update({
    where: { id: existing.id },
    data: {
      status: to,
      // §13 — completedAt non-null iff COMPLETED; reopen/cancel clears it.
      completedAt: to === "COMPLETED" ? now : null,
    },
    select: { id: true, status: true, completedAt: true },
  });
  await audit({
    businessId,
    actorId,
    action: "crm.task.status_change",
    entityType: "CrmTask",
    entityId: existing.id,
    before: { status: from },
    after: {
      status: to,
      completedAt: updated.completedAt ? updated.completedAt.toISOString() : null,
    },
    ip: auditMeta.ip,
    userAgent: auditMeta.userAgent,
  });
  return updated.status as TaskStatus;
}

/** Soft delete (§28) — the task alone; never its context or any finance row. */
export async function deleteTask(
  businessId: string,
  actorId: string,
  id: string,
  auditMeta: { ip: string | null; userAgent: string | null },
): Promise<void> {
  const existing = await db.crmTask.findFirst({
    where: { id, businessId, deletedAt: null },
    select: { id: true, title: true, status: true },
  });
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Task not found.");
  await db.crmTask.update({
    where: { id: existing.id },
    data: { deletedAt: new Date() },
    select: { id: true },
  });
  await audit({
    businessId,
    actorId,
    action: "crm.task.delete",
    entityType: "CrmTask",
    entityId: existing.id,
    before: { title: existing.title, status: existing.status },
    after: { deletedAt: new Date().toISOString() },
    ip: auditMeta.ip,
    userAgent: auditMeta.userAgent,
  });
}

/* ------------------------------------------------------------------------ */
/* Prompt 37 — assignment notification plumbing (§34/§35/§36/§48/§179).      */
/* ------------------------------------------------------------------------ */

/** Stable 422 messages for reminder-consistency failures (§8). */
function reminderErrorMessage(reason: string | null): string {
  switch (reason) {
    case "REMINDER_OFFSET_REQUIRED":
      return "A reminder offset is required when the due reminder is enabled.";
    case "REMINDER_OFFSET_INVALID":
      return "The reminder offset must be one of the supported values.";
    case "REMINDER_OFFSET_WITHOUT_ENABLED":
      return "A reminder offset cannot be set while the due reminder is disabled.";
    default:
      return "The reminder configuration is invalid.";
  }
}

/**
 * Post-commit assignment notification (§34/§35/§48/§179) — Prompt 37-F
 * hardened (§13–§20):
 *
 *  - AWAITABLE and fire-safe: the caller awaits this helper (deterministic
 *    request completion, §14/§15) and the helper itself swallows every
 *    failure, so a notification problem can never roll back the committed
 *    task mutation (§36). Never wrapped in the task's transaction.
 *  - RELOADS the committed task and re-verifies eligibility BEFORE sending
 *    (§16/§18/§20): task exists in THIS business, NOT soft-deleted, the
 *    current assignee STILL equals the intended recipient (a concurrent
 *    reassignment B→C must never notify B), and the exactly-one context is
 *    still resolvable (§17 — no CUSTOMER/"" fallback).
 *  - Recipient remains task.assignedToUserId — server-authoritative (§19).
 */
async function notifyAssignmentSafe(
  businessId: string,
  taskId: string,
  assigneeUserId: string,
  updatedAt: Date,
): Promise<void> {
  try {
    const { notifyCrmTaskAssigned } = await import("@/lib/notifications/event-mappers");
    // §16/§18/§20 — fresh post-commit read: id + businessId scope; the row
    // predicate re-checks deletedAt + current assignee (reassignment race).
    const task = (await db.crmTask.findFirst({
      where: { id: taskId, businessId },
      select: {
        id: true,
        businessId: true,
        deletedAt: true,
        assignedToUserId: true,
        title: true,
        priority: true,
        dueAt: true,
        customerId: true,
        leadId: true,
        opportunityId: true,
      },
    })) as {
      id: string;
      businessId: string;
      deletedAt: Date | null;
      assignedToUserId: string | null;
      title: string;
      priority: string;
      dueAt: Date | null;
      customerId: string | null;
      leadId: string | null;
      opportunityId: string | null;
    } | null;
    if (!task || !isAssignmentRowEligible(task, businessId, assigneeUserId)) {
      // §16/§18/§20 — gone/reassigned: skip quietly. Only a SAFE error
      // category is logged (no ids, no titles, §11).
      logError(OPERATIONAL_EVENTS.crmAssignmentNotifySkipped, { reason: "NOT_DELIVERABLE" });
      return;
    }
    // §17/§36 — the context is re-read DIRECTLY against CURRENT rows
    // (deletedAt-filtered, business-scoped). A deleted/missing context skips
    // the notification — never a CUSTOMER/"" fallback.
    const context = await readLiveTaskContext(businessId, task);
    if (!context) {
      logError(OPERATIONAL_EVENTS.crmAssignmentNotifySkipped, { reason: "CONTEXT_UNRESOLVABLE" });
      return;
    }
    const timezone = await db.business
      .findUnique({ where: { id: businessId }, select: { timezone: true } })
      .then((b) => b?.timezone ?? "UTC");
    await notifyCrmTaskAssigned({
      businessId,
      taskId,
      assigneeUserId,
      taskTitle: task.title,
      priority: task.priority as TaskPriority,
      contextType: context.type,
      contextTitle: context.title,
      dueAt: task.dueAt,
      businessTimezone: timezone,
      sourceEventId: composeAssignmentSourceEventId(taskId, assigneeUserId, updatedAt),
    });
  } catch {
    // Swallowed by design (§36) — the notifyFailSafe inside the mapper
    // already records the failure; nothing here may break the task flow.
  }
}

/** §179 — deterministic assignment event identity (task, assignee, updatedAt). */
function composeAssignmentSourceEventId(
  taskId: string,
  assigneeUserId: string,
  updatedAt: Date,
): string {
  // Composed from durable server identifiers only (§169/§179). The mapper
  // sanitizes the string again before persistence.
  const raw = `crm-task-assigned:${taskId}:${assigneeUserId}:${updatedAt.toISOString()}`;
  return raw.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 300);
}
