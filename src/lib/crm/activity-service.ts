/**
 * Prompt 36 — Activity service (§18–§23).
 *
 * Every query is tenant-scoped by the SERVER-derived businessId. Lists are
 * paginated (25 default / 100 max; q ≤ 64 and NEVER logged — §76). Context
 * is exactly one of customer/lead/opportunity and must live in the same
 * business (§8/§9). Soft delete only — an activity never touches financial
 * records (§102). Audit payloads carry metadata only — the description is
 * NEVER copied into audit or logs (§59/§74).
 */
import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { parseInstant } from "./normalization";
import { resolveCrmContextInBusiness } from "./service";
import { mapActivity, type CrmActivityRow } from "./activity-dto";
import type { ActivityType, CrmContextType } from "./activity-types";
import type { Prisma } from "@prisma/client";

export const ACTIVITY_PAGE_SIZE_DEFAULT = 25;
export const ACTIVITY_PAGE_SIZE_MAX = 100;
export const ACTIVITY_Q_MAX = 64;

export type ActivityListFilters = {
  q?: string;
  type?: ActivityType | null;
  contextType?: CrmContextType | null;
  contextId?: string | null;
  createdByUserId?: string | null;
  from?: Date | null;
  to?: Date | null;
  page: number;
  pageSize: number;
};

/** Full activity select incl. context + creator refs (mirrors CrmActivityRow). */
function fullActivitySelect(businessId: string) {
  return {
    id: true,
    type: true,
    title: true,
    description: true,
    occurredAt: true,
    durationMinutes: true,
    leadId: true,
    lead: { select: { id: true, name: true, companyName: true } },
    opportunityId: true,
    opportunity: { select: { id: true, title: true } },
    customerId: true,
    customer: { select: { id: true, name: true } },
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
  } satisfies Prisma.CrmActivitySelect;
}

/**
 * Context filter (§20) — an explicit closed switch on contextType. NO
 * arbitrary model names, NO generic Prisma field construction from client
 * input. If a contextType is given the id must resolve in-business (404
 * read semantics — same as unknown).
 */
async function activityWhere(
  businessId: string,
  f: ActivityListFilters,
): Promise<Prisma.CrmActivityWhereInput> {
  const q = (f.q ?? "").trim().slice(0, ACTIVITY_Q_MAX);
  const where: Prisma.CrmActivityWhereInput = {
    businessId, // §15 — server-derived tenant scope only
    deletedAt: null, // soft-deleted activities vanish from every active view (§23)
    ...(q
      ? {
          OR: [{ title: { contains: q } }, { description: { contains: q } }],
        }
      : {}),
    ...(f.type ? { type: f.type } : {}),
    ...(f.createdByUserId ? { createdByUserId: f.createdByUserId } : {}),
    ...(f.from || f.to
      ? { occurredAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } }
      : {}),
  };
  if (f.contextType && f.contextId) {
    // §20 — validate the referenced context exists in THIS business, then
    // filter by the matching closed column.
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
    // Half-specified context pair → validation error, never a silent ignore.
    throw new ApiError(422, "VALIDATION_ERROR", "contextType and contextId must be provided together.", {
      field: "contextType",
    });
  }
  return where;
}

/** Bounded activity list (§19/§71) — count + page in parallel. */
export async function listActivities(businessId: string, f: ActivityListFilters) {
  const pageSize = Math.min(
    Math.max(1, f.pageSize || ACTIVITY_PAGE_SIZE_DEFAULT),
    ACTIVITY_PAGE_SIZE_MAX,
  );
  const page = Math.max(1, Math.trunc(f.page) || 1);
  const where = await activityWhere(businessId, { ...f, pageSize });
  const [rows, total] = await Promise.all([
    db.crmActivity.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: fullActivitySelect(businessId),
    }),
    db.crmActivity.count({ where }),
  ]);
  return {
    items: rows.map((row) => mapActivity(row as CrmActivityRow)),
    total,
    page,
    pageSize,
  };
}

/** Single activity (§18 GET/[id]) — 404 for foreign/deleted rows (§15). */
export async function getActivity(businessId: string, id: string): Promise<ReturnType<typeof mapActivity>> {
  const row = await db.crmActivity.findFirst({
    where: { id, businessId, deletedAt: null },
    select: fullActivitySelect(businessId),
  });
  if (!row) throw new ApiError(404, "NOT_FOUND", "Activity not found.");
  return mapActivity(row as CrmActivityRow);
}

/**
 * Create (§21) — the server sets businessId + createdByUserId; the client
 * controls only type/title/description/occurredAt/duration/context id.
 * Exactly one context, same-business validated. NO Notification is created
 * (§65) and NO automatic side effects occur.
 */
export async function createActivity(
  businessId: string,
  actorId: string,
  input: {
    type: ActivityType;
    title: string;
    description: string | null;
    occurredAt: string;
    durationMinutes: number | null;
    customerId?: string | null;
    leadId?: string | null;
    opportunityId?: string | null;
  },
  auditMeta: { ip: string | null; userAgent: string | null },
): Promise<string> {
  const occurredAt = parseInstant(input.occurredAt);
  if (!occurredAt) {
    throw new ApiError(422, "VALIDATION_ERROR", "occurredAt must be a valid datetime.", {
      field: "occurredAt",
    });
  }
  const context = await resolveCrmContextInBusiness(input, businessId);
  const created = await db.crmActivity.create({
    data: {
      businessId,
      type: input.type,
      title: input.title,
      description: input.description,
      occurredAt,
      durationMinutes: input.durationMinutes,
      customerId: context.customerId,
      leadId: context.leadId,
      opportunityId: context.opportunityId,
      createdByUserId: actorId,
    },
    select: { id: true },
  });
  // §59 — metadata-only audit payload (no description content).
  await audit({
    businessId,
    actorId,
    action: "crm.activity.create",
    entityType: "CrmActivity",
    entityId: created.id,
    after: {
      id: created.id,
      type: input.type,
      title: input.title,
      occurredAt: occurredAt.toISOString(),
      durationMinutes: input.durationMinutes,
      customerId: context.customerId,
      leadId: context.leadId,
      opportunityId: context.opportunityId,
    },
    ip: auditMeta.ip,
    userAgent: auditMeta.userAgent,
  });
  return created.id;
}

/**
 * Update (§22) — field edits only. The context is NEVER writable here (an
 * activity attached to the wrong entity must be deleted and re-created so
 * timeline semantics + audit stay clean).
 */
export async function updateActivity(
  businessId: string,
  actorId: string,
  id: string,
  input: {
    type?: ActivityType;
    title?: string;
    description?: string | null;
    occurredAt?: string;
    durationMinutes?: number | null;
  },
  auditMeta: { ip: string | null; userAgent: string | null },
): Promise<void> {
  const existing = await db.crmActivity.findFirst({
    where: { id, businessId, deletedAt: null },
    select: { id: true, type: true, title: true, occurredAt: true, durationMinutes: true },
  });
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Activity not found.");
  const occurredAt =
    input.occurredAt !== undefined ? parseInstant(input.occurredAt) : undefined;
  if (input.occurredAt !== undefined && !occurredAt) {
    throw new ApiError(422, "VALIDATION_ERROR", "occurredAt must be a valid datetime.", {
      field: "occurredAt",
    });
  }
  const data: Prisma.CrmActivityUpdateInput = {};
  if (input.type !== undefined) data.type = input.type;
  if (input.title !== undefined) data.title = input.title;
  if (input.description !== undefined) data.description = input.description;
  if (occurredAt) data.occurredAt = occurredAt;
  if (input.durationMinutes !== undefined) data.durationMinutes = input.durationMinutes;
  const updated = await db.crmActivity.update({
    where: { id: existing.id },
    data,
    select: { id: true, type: true, title: true, occurredAt: true, durationMinutes: true },
  });
  await audit({
    businessId,
    actorId,
    action: "crm.activity.update",
    entityType: "CrmActivity",
    entityId: existing.id,
    // §59 — safe before/after metadata; description never included.
    before: {
      type: existing.type,
      title: existing.title,
      occurredAt: existing.occurredAt.toISOString(),
      durationMinutes: existing.durationMinutes,
    },
    after: {
      type: updated.type,
      title: updated.title,
      occurredAt: updated.occurredAt.toISOString(),
      durationMinutes: updated.durationMinutes,
    },
    ip: auditMeta.ip,
    userAgent: auditMeta.userAgent,
  });
}

/** Soft delete (§23) — hidden from timeline/list/export-active; audit remains. */
export async function deleteActivity(
  businessId: string,
  actorId: string,
  id: string,
  auditMeta: { ip: string | null; userAgent: string | null },
): Promise<void> {
  const existing = await db.crmActivity.findFirst({
    where: { id, businessId, deletedAt: null },
    select: { id: true, title: true, type: true },
  });
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Activity not found.");
  await db.crmActivity.update({
    where: { id: existing.id },
    data: { deletedAt: new Date() },
    select: { id: true },
  });
  await audit({
    businessId,
    actorId,
    action: "crm.activity.delete",
    entityType: "CrmActivity",
    entityId: existing.id,
    before: { type: existing.type, title: existing.title },
    after: { deletedAt: new Date().toISOString() },
    ip: auditMeta.ip,
    userAgent: auditMeta.userAgent,
  });
}
