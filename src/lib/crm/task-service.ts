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
import { parseInstant } from "./normalization";
import { resolveCrmContextInBusiness, assertAssigneeInBusiness } from "./service";
import { isTaskTransitionValid, isTaskStatus, type TaskStatus } from "./task-types";
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
    description: string | null;
    priority: TaskPriority;
    dueAt: string | null;
    assignedToUserId: string | null;
    customerId?: string | null;
    leadId?: string | null;
    opportunityId?: string | null;
  },
  auditMeta: { ip: string | null; userAgent: string | null },
): Promise<string> {
  const dueAt = input.dueAt ? parseInstant(input.dueAt) : null;
  if (input.dueAt && !dueAt) {
    throw new ApiError(422, "VALIDATION_ERROR", "dueAt must be a valid datetime.", {
      field: "dueAt",
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
    },
    select: { id: true },
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
    },
    ip: auditMeta.ip,
    userAgent: auditMeta.userAgent,
  });
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
  },
  auditMeta: { ip: string | null; userAgent: string | null },
): Promise<void> {
  const existing = await db.crmTask.findFirst({
    where: { id, businessId, deletedAt: null },
    select: { id: true, title: true, priority: true, dueAt: true, assignedToUserId: true },
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
  const updated = await db.crmTask.update({
    where: { id: existing.id },
    data,
    select: { id: true, title: true, priority: true, dueAt: true, assignedToUserId: true },
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
    },
    after: {
      title: updated.title,
      priority: updated.priority,
      dueAt: updated.dueAt ? updated.dueAt.toISOString() : null,
      assignedToUserId: updated.assignedToUserId,
    },
    ip: auditMeta.ip,
    userAgent: auditMeta.userAgent,
  });
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
