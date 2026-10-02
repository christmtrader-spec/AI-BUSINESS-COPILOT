/**
 * Prompt 35 — lead service (§19–§22/§41/§65/§67).
 *
 * Every query is tenant-scoped by the caller-supplied SERVER-derived
 * businessId. Lists are paginated (never unbounded). Soft delete only —
 * CRM deletion never touches Customer/Sale/Payment/Expense (§1/§67/§68).
 * Audit payloads carry explicit safe fields only (§65/§66).
 */
import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { assertAssigneeInBusiness } from "./service";
import { mapLead, mapLeadDetail, mapOpportunityRef, type LeadRow } from "./dto";
import { isLeadTransitionValid } from "./constants";
import { leadStatusOf } from "./normalization";
import type { LeadSource, LeadStatus } from "./types";
import type { Prisma } from "@prisma/client";

/** List bounds (§19): pageSize default 25, max 100; q ≤ 64 chars. */
export const LEAD_PAGE_SIZE_DEFAULT = 25;
export const LEAD_PAGE_SIZE_MAX = 100;

export type LeadListFilters = {
  q?: string;
  status?: LeadStatus | null;
  source?: LeadSource | null;
  assignedToUserId?: string | null;
  page: number;
  pageSize: number;
};

function leadWhere(businessId: string, f: LeadListFilters): Prisma.CrmLeadWhereInput {
  const q = (f.q ?? "").trim().slice(0, 64);
  return {
    businessId, // §15 — server-derived tenant scope only
    deletedAt: null, // §16 — active lists never show deleted leads
    ...(q
      ? {
          OR: [
            { name: { contains: q } },
            { companyName: { contains: q } },
            { email: { contains: q } },
            { phone: { contains: q } },
          ],
        }
      : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.source ? { source: f.source } : {}),
    ...(f.assignedToUserId ? { assignedToUserId: f.assignedToUserId } : {}),
  };
}

/** Bounded lead list (§19/§63/§127) — count + page in parallel. */
export async function listLeads(businessId: string, f: LeadListFilters) {
  const pageSize = Math.min(Math.max(1, f.pageSize || LEAD_PAGE_SIZE_DEFAULT), LEAD_PAGE_SIZE_MAX);
  const page = Math.max(1, Math.trunc(f.page) || 1);
  const where = leadWhere(businessId, { ...f, pageSize });
  const [rows, total] = await Promise.all([
    db.crmLead.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        name: true,
        companyName: true,
        phone: true,
        email: true,
        source: true,
        sourceDetail: true,
        status: true,
        note: true,
        assignedToUserId: true,
        assignedToUser: { select: { id: true, name: true, email: true, memberships: { where: { businessId }, select: { role: true }, take: 1 } } },
        customerId: true,
        customer: { select: { id: true, name: true, phone: true, email: true } },
        convertedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    db.crmLead.count({ where }),
  ]);
  return {
    items: rows.map((row) => mapLead(row as LeadRow)),
    total,
    page,
    pageSize,
  };
}

/** Full lead select incl. relations — mirrors LeadRow exactly. */
function fullLeadSelect(businessId: string) {
  return {
    id: true,
    name: true,
    companyName: true,
    phone: true,
    email: true,
    source: true,
    sourceDetail: true,
    status: true,
    note: true,
    assignedToUserId: true,
    assignedToUser: { select: { id: true, name: true, email: true, memberships: { where: { businessId }, select: { role: true }, take: 1 } } },
    customerId: true,
    customer: { select: { id: true, name: true, phone: true, email: true } },
    convertedAt: true,
    createdAt: true,
    updatedAt: true,
  } satisfies Prisma.CrmLeadSelect;
}

/** Lead detail (§41) — bounded opportunity aggregates (take ≤ 10). */
export async function getLeadDetail(businessId: string, id: string) {
  const lead = await db.crmLead.findFirst({
    where: { id, businessId, deletedAt: null },
    select: fullLeadSelect(businessId),
  });
  if (!lead) throw new ApiError(404, "NOT_FOUND", "Lead not found.");
  const [openCount, totalCount, recentRows] = await Promise.all([
    db.crmOpportunity.count({
      where: {
        businessId,
        leadId: id,
        deletedAt: null,
        stage: { in: ["DISCOVERY", "QUALIFIED", "PROPOSAL", "NEGOTIATION"] },
      },
    }),
    db.crmOpportunity.count({
      where: { businessId, leadId: id, deletedAt: null },
    }),
    db.crmOpportunity.findMany({
      where: { businessId, leadId: id, deletedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 10,
      select: {
        id: true,
        title: true,
        stage: true,
        probabilityPct: true,
        expectedValueMinor: true,
        currencyCode: true,
        expectedCloseDate: true,
        createdAt: true,
      },
    }),
  ]);
  return mapLeadDetail(lead as LeadRow, {
    openOpportunityCount: openCount,
    opportunityCount: totalCount,
    recentOpportunities: recentRows.map(mapOpportunityRef),
  });
}

/** Lead create (§20) — status NEW, membership-validated assignee, audited. */
export async function createLead(
  businessId: string,
  actorId: string,
  input: {
    name: string;
    companyName?: string | null;
    phone?: string | null;
    email?: string | null;
    source: LeadSource;
    sourceDetail?: string | null;
    note?: string | null;
    assignedToUserId: string | null;
  },
  auditMeta: { ip: string | null; userAgent: string | null },
) {
  const assignedToUserId = await assertAssigneeInBusiness(input.assignedToUserId, businessId);
  const created = await db.crmLead.create({
    data: {
      businessId,
      name: input.name,
      companyName: input.companyName,
      phone: input.phone,
      email: input.email,
      source: input.source,
      sourceDetail: input.sourceDetail,
      note: input.note,
      assignedToUserId,
      status: "NEW", // §20 — server sets the initial status
    },
    select: { id: true },
  });
  // §65 — safe audit payload (explicit fields; never raw request bodies).
  await audit({
    businessId,
    actorId,
    action: "crm.lead.create",
    entityType: "CrmLead",
    entityId: created.id,
    after: {
      id: created.id,
      name: input.name,
      source: input.source,
      status: "NEW",
    },
    ip: auditMeta.ip,
    userAgent: auditMeta.userAgent,
  });
  return created.id;
}

/**
 * Generic lead PATCH (§21) — field edits only. Status / customerId /
 * convertedAt are NEVER writable here (§21/§22: dedicated endpoints own
 * those transitions).
 */
export async function updateLead(
  businessId: string,
  actorId: string,
  id: string,
  input: {
    name?: string;
    companyName?: string | null;
    phone?: string | null;
    email?: string | null;
    source?: LeadSource;
    sourceDetail?: string | null;
    note?: string | null;
    assignedToUserId?: string | null;
  },
  auditMeta: { ip: string | null; userAgent: string | null },
) {
  const existing = await db.crmLead.findFirst({
    where: { id, businessId, deletedAt: null },
    select: { id: true, name: true, status: true, source: true, assignedToUserId: true },
  });
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Lead not found.");
  const assignedToUserId =
    "assignedToUserId" in input
      ? await assertAssigneeInBusiness(input.assignedToUserId, businessId)
      : undefined;
  const data: Prisma.CrmLeadUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.companyName !== undefined) data.companyName = input.companyName;
  if (input.phone !== undefined) data.phone = input.phone;
  if (input.email !== undefined) data.email = input.email;
  if (input.source !== undefined) data.source = input.source;
  if (input.sourceDetail !== undefined) data.sourceDetail = input.sourceDetail;
  if (input.note !== undefined) data.note = input.note;
  if (assignedToUserId !== undefined) {
    data.assignedToUser = assignedToUserId === null ? { disconnect: true } : { connect: { id: assignedToUserId } };
  }

  const updated = await db.crmLead.update({
    where: { id: existing.id },
    data,
    select: {
      id: true,
      name: true,
      status: true,
      assignedToUserId: true,
      source: true,
    },
  });
  await audit({
    businessId,
    actorId,
    action: "crm.lead.update",
    entityType: "CrmLead",
    entityId: existing.id,
    before: { name: existing.name, status: existing.status, source: existing.source, assignedToUserId: existing.assignedToUserId },
    after: { id: updated.id, name: updated.name, status: updated.status, source: updated.source, assignedToUserId: updated.assignedToUserId },
    ip: auditMeta.ip,
    userAgent: auditMeta.userAgent,
  });
  return updated.id;
}

/**
 * Dedicated status transition (§22) — the ONLY generic path a status can
 * change through (conversion sets CONVERTED inside its own transaction).
 * Invalid transitions → 422 INVALID_STATUS_TRANSITION.
 */
export async function changeLeadStatus(
  businessId: string,
  actorId: string,
  id: string,
  targetStatusRaw: string,
  auditMeta: { ip: string | null; userAgent: string | null },
) {
  const existing = await db.crmLead.findFirst({
    where: { id, businessId, deletedAt: null },
    select: { id: true, status: true },
  });
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Lead not found.");
  const from = leadStatusOf(existing.status);
  if (!["NEW", "CONTACTED", "QUALIFIED", "DISQUALIFIED", "CONVERTED"].includes(targetStatusRaw)) {
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "Unknown lead status.",
      { field: "status" },
    );
  }
  const to = targetStatusRaw as LeadStatus;
  if (!isLeadTransitionValid(from, to)) {
    throw new ApiError(
      422,
      "INVALID_STATUS_TRANSITION",
      `Cannot change lead status from ${from} to ${to}.`,
      { from, to },
    );
  }
  const updated = await db.crmLead.update({
    where: { id: existing.id },
    data: { status: to },
    select: { id: true, status: true },
  });
  await audit({
    businessId,
    actorId,
    action: "crm.lead.status_change",
    entityType: "CrmLead",
    entityId: existing.id,
    before: { status: from },
    after: { status: to },
    ip: auditMeta.ip,
    userAgent: auditMeta.userAgent,
  });
  return updated.status as LeadStatus;
}

/**
 * Soft delete (§67) — hides the lead from active CRM. Related
 * opportunities keep their leadId (the lead row REMAINS — just hidden) so
 * no data is silently destroyed; customer conversion survives (§68).
 */
export async function deleteLead(
  businessId: string,
  actorId: string,
  id: string,
  auditMeta: { ip: string | null; userAgent: string | null },
) {
  const existing = await db.crmLead.findFirst({
    where: { id, businessId, deletedAt: null },
    select: { id: true, status: true, name: true },
  });
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Lead not found.");
  await db.crmLead.update({
    where: { id: existing.id },
    data: { deletedAt: new Date() },
    select: { id: true },
  });
  await audit({
    businessId,
    actorId,
    action: "crm.lead.delete",
    entityType: "CrmLead",
    entityId: existing.id,
    before: { status: existing.status, name: existing.name },
    after: { deletedAt: new Date().toISOString() },
    ip: auditMeta.ip,
    userAgent: auditMeta.userAgent,
  });
}
