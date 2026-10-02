/**
 * Prompt 36 — Task DTO mappers (§30/§35/§79 discipline).
 *
 * Allowlisted fields only — no businessId, no internal flags, no raw
 * Prisma relations. The work-queue row carries exactly what §30 lists:
 * id/title/priority/status/dueAt/assignedTo/contextType/contextId/
 * contextTitle.
 */
import { isTaskPriority, isTaskStatus, type TaskPriority, type TaskStatus } from "./task-types";
import type { CrmAssigneeRef } from "./types";
import type { AssigneeRow } from "./dto";
import type { CrmContextRef } from "./activity-dto";
import { contextRefOf } from "./activity-dto";
import { toIsoOrNull } from "./normalization";

export type CrmTaskRow = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueAt: Date | null;
  completedAt: Date | null;
  leadId: string | null;
  lead: { id: string; name: string; companyName: string | null } | null;
  opportunityId: string | null;
  opportunity: { id: string; title: string } | null;
  customerId: string | null;
  customer: { id: string; name: string } | null;
  assignedToUserId: string | null;
  assignedToUser: AssigneeRow | null;
  createdByUserId: string;
  createdByUser: AssigneeRow | null;
  createdAt: Date;
  updatedAt: Date;
};

export type TaskDTO = {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: string | null;
  completedAt: string | null;
  context: CrmContextRef;
  assignedTo: CrmAssigneeRef | null;
  createdBy: CrmAssigneeRef | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskListResponse = {
  items: TaskDTO[];
  total: number;
  page: number;
  pageSize: number;
};

export function taskStatusOf(value: string): TaskStatus {
  return isTaskStatus(value) ? value : "OPEN";
}

export function taskPriorityOf(value: string): TaskPriority {
  return isTaskPriority(value) ? value : "NORMAL";
}

function mapUserRef(user: AssigneeRow | null): CrmAssigneeRef | null {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.memberships[0]?.role ?? "",
  };
}

export function mapTask(row: CrmTaskRow): TaskDTO {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: taskStatusOf(row.status),
    priority: taskPriorityOf(row.priority),
    dueAt: toIsoOrNull(row.dueAt),
    completedAt: toIsoOrNull(row.completedAt),
    context: contextRefOf(row) ?? { type: "CUSTOMER", id: "", title: "" },
    assignedTo: mapUserRef(row.assignedToUser),
    createdBy: mapUserRef(row.createdByUser),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
