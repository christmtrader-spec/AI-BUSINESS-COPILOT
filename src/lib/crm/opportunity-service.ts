/**
 * Prompt 35 — opportunity service (§27–§33/§42/§67/§69).
 *
 * Stage transitions are TRANSACTIONAL and the ONLY way stage changes
 * (§31: generic PATCH never touches stage). WON forces probability 100 +
 * customerId; LOST forces probability 0 + lostReason; reopening clears
 * terminal fields (§32). Stage changes NEVER touch finance (§33 — tested
 * by prompt35-crm-check §O/§108).
 */
import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import {
  assertAssigneeInBusiness,
  assertCustomerInBusiness,
  assertLeadInBusiness,
} from "./service";
import { mapOpportunity, withWeightedValue, type OpportunityRow } from "./dto";
import {
  DEFAULT_STAGE_PROBABILITY,
  isOpportunityTransitionValid,
} from "./constants";
import { parseExpectedCloseDate, stageOf, weightedValue } from "./normalization";
import type { OpportunityStage, OpportunityStageCategory } from "./types";
import type { Prisma } from "@prisma/client";

/** List bounds (§28). */
export const OPPORTUNITY_PAGE_SIZE_DEFAULT = 25;
export const OPPORTUNITY_PAGE_SIZE_MAX = 100;

const OPEN_STAGES: readonly OpportunityStage[] = ["DISCOVERY", "QUALIFIED", "PROPOSAL", "NEGOTIATION"];

export type OpportunityListFilters = {
  q?: string;
  stage?: OpportunityStage | null;
  assignedToUserId?: string | null;
  customerId?: string | null;
  leadId?: string | null;
  closeBefore?: string | null;
  closeAfter?: string | null;
  page: number;
  pageSize: number;
};

export function stageCategoryOf(stage: OpportunityStage): OpportunityStageCategory {
  return stage === "WON" ? "WON" : stage === "LOST" ? "LOST" : "OPEN";
}

function opportunityWhere(
  businessId: string,
  f: OpportunityListFilters,
): Prisma.CrmOpportunityWhereInput {
  const q = (f.q ?? "").trim().slice(0, 64);
  return {
    businessId, // §15 — server-derived tenant scope only
    deletedAt: null, // §16
    ...(q
      ? {
          OR: [
            { title: { contains: q } },
            { description: { contains: q } },
            { customer: { is: { name: { contains: q } } } },
            { lead: { is: { name: { contains: q } } } },
          ],
        }
      : {}),
    ...(f.stage ? { stage: f.stage } : {}),
    ...(f.assignedToUserId ? { assignedToUserId: f.assignedToUserId } : {}),
    ...(f.customerId ? { customerId: f.customerId } : {}),
    ...(f.leadId ? { leadId: f.leadId } : {}),
    ...(f.closeBefore ? { expectedCloseDate: { lte: parseExpectedCloseDate(f.closeBefore) ?? undefined } } : {}),
    ...(f.closeAfter ? { expectedCloseDate: { gte: parseExpectedCloseDate(f.closeAfter) ?? undefined } } : {}),
  };
}

function opportunityRowSelect(businessId: string) {
  return {
    id: true,
    title: true,
    description: true,
    stage: true,
    probabilityPct: true,
    expectedValueMinor: true,
    currencyCode: true,
    expectedCloseDate: true,
    assignedToUserId: true,
    assignedToUser: { select: { id: true, name: true, email: true, memberships: { where: { businessId }, select: { role: true }, take: 1 } } },
    customerId: true,
    customer: { select: { id: true, name: true, phone: true, email: true } },
    leadId: true,
    lead: { select: { id: true, name: true, companyName: true, status: true } },
    lostReason: true,
    wonAt: true,
    lostAt: true,
    createdAt: true,
    updatedAt: true,
  } satisfies Prisma.CrmOpportunitySelect;
}

/** Bounded opportunity list (§28/§63/§127). */
export async function listOpportunities(businessId: string, f: OpportunityListFilters) {
  const pageSize = Math.min(
    Math.max(1, f.pageSize || OPPORTUNITY_PAGE_SIZE_DEFAULT),
    OPPORTUNITY_PAGE_SIZE_MAX,
  );
  const page = Math.max(1, Math.trunc(f.page) || 1);
  const where = opportunityWhere(businessId, { ...f, pageSize });
  const [rows, total] = await Promise.all([
    db.crmOpportunity.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: opportunityRowSelect(businessId),
    }),
    db.crmOpportunity.count({ where }),
  ]);
  return {
    items: rows.map((row) => mapOpportunity(row as OpportunityRow)),
    total,
    page,
    pageSize,
  };
}

/** Opportunity detail (§42) with server-derived weighted value. */
export async function getOpportunityDetail(businessId: string, id: string) {
  const row = await db.crmOpportunity.findFirst({
    where: { id, businessId, deletedAt: null },
    select: opportunityRowSelect(businessId),
  });
  if (!row) throw new ApiError(404, "NOT_FOUND", "Opportunity not found.");
  const dto = mapOpportunity(row as OpportunityRow);
  return withWeightedValue(dto);
}

/** Opportunity create (§29) — same-business relations, audited. */
export async function createOpportunity(
  businessId: string,
  actorId: string,
  input: {
    title: string;
    description: string | null;
    leadId: string | null;
    customerId: string | null;
    stage: OpportunityStage;
    probabilityPct?: number;
    expectedValueMinor?: number;
    expectedCloseDate: string | null;
    assignedToUserId: string | null;
  },
  auditMeta: { ip: string | null; userAgent: string | null },
) {
  // Relation validation (§78 rules 5–7) — same business, not deleted.
  const assignedToUserId = await assertAssigneeInBusiness(input.assignedToUserId, businessId);
  const customerId = await assertCustomerInBusiness(input.customerId, businessId);
  const leadId = await assertLeadInBusiness(input.leadId, businessId);

  // §29 — defaults: DISCOVERY / 10 / 0; currency captured from business (§85).
  const business = await db.business.findUnique({
    where: { id: businessId },
    select: { currencyCode: true },
  });
  if (!business) throw new ApiError(404, "NOT_FOUND", "Business not found.");

  const stage = input.stage;
  const probability =
    stage === "WON" ? 100 : stage === "LOST" ? 0 : (input.probabilityPct ?? DEFAULT_STAGE_PROBABILITY[stage]);

  // §30 — a WON opportunity requires a customer, even at creation time.
  if (stage === "WON" && !customerId) {
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "A WON opportunity must be linked to a customer.",
      { field: "customerId" },
    );
  }

  const created = await db.crmOpportunity.create({
    data: {
      businessId,
      title: input.title,
      description: input.description,
      leadId,
      customerId,
      stage,
      probabilityPct: probability,
      expectedValueMinor: input.expectedValueMinor ?? 0,
      currencyCode: business.currencyCode,
      expectedCloseDate: parseExpectedCloseDate(input.expectedCloseDate),
      assignedToUserId,
      wonAt: stage === "WON" ? new Date() : null,
      lostAt: stage === "LOST" ? new Date() : null,
      lostReason: null, // create never carries a lost reason (§32)
    },
    select: { id: true },
  });
  await audit({
    businessId,
    actorId,
    action: "crm.opportunity.create",
    entityType: "CrmOpportunity",
    entityId: created.id,
    after: {
      id: created.id,
      title: input.title,
      stage,
      expectedValueMinor: input.expectedValueMinor ?? 0,
    },
    ip: auditMeta.ip,
    userAgent: auditMeta.userAgent,
  });
  return created.id;
}

/**
 * Generic opportunity PATCH (§31) — stage is NOT patchable (dedicated
 * /stage endpoint owns transitions).
 */
export async function updateOpportunity(
  businessId: string,
  actorId: string,
  id: string,
  input: {
    title?: string;
    description?: string | null;
    leadId?: string | null;
    customerId?: string | null;
    probabilityPct?: number;
    expectedValueMinor?: number;
    expectedCloseDate?: string | null;
    assignedToUserId?: string | null;
  },
  auditMeta: { ip: string | null; userAgent: string | null },
) {
  const existing = await db.crmOpportunity.findFirst({
    where: { id, businessId, deletedAt: null },
    select: { id: true, title: true, stage: true, probabilityPct: true },
  });
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Opportunity not found.");

  // Same-business relation validation for any CHANGED relation.
  const customerId =
    "customerId" in input
      ? await assertCustomerInBusiness(input.customerId, businessId)
      : undefined;
  const leadId =
    "leadId" in input ? await assertLeadInBusiness(input.leadId, businessId) : undefined;
  const assignedToUserId =
    "assignedToUserId" in input
      ? await assertAssigneeInBusiness(input.assignedToUserId, businessId)
      : undefined;

  const data: Prisma.CrmOpportunityUpdateInput = {};
  if (input.title !== undefined) data.title = input.title;
  if (input.description !== undefined) data.description = input.description;
  if (input.expectedValueMinor !== undefined) data.expectedValueMinor = input.expectedValueMinor;
  if (input.probabilityPct !== undefined) {
    // §31 — probability editable for OPEN stages; terminal stages forced.
    if (stageCategoryOf(stageOf(existing.stage)) !== "OPEN") {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Probability is fixed for WON/LOST opportunities.",
        { field: "probabilityPct" },
      );
    }
    data.probabilityPct = input.probabilityPct;
  }
  if (input.expectedCloseDate !== undefined) {
    data.expectedCloseDate = parseExpectedCloseDate(input.expectedCloseDate);
  }
  if (customerId !== undefined) {
    data.customer = customerId === null ? { disconnect: true } : { connect: { id: customerId } };
  }
  if (leadId !== undefined) {
    data.lead = leadId === null ? { disconnect: true } : { connect: { id: leadId } };
  }
  if (assignedToUserId !== undefined) {
    data.assignedToUser =
      assignedToUserId === null ? { disconnect: true } : { connect: { id: assignedToUserId } };
  }

  const updated = await db.crmOpportunity.update({
    where: { id: existing.id },
    data,
    select: { id: true, title: true, stage: true, probabilityPct: true, expectedValueMinor: true },
  });
  await audit({
    businessId,
    actorId,
    action: "crm.opportunity.update",
    entityType: "CrmOpportunity",
    entityId: existing.id,
    before: { title: existing.title, stage: existing.stage, probabilityPct: existing.probabilityPct },
    after: { id: updated.id, title: updated.title, stage: updated.stage, probabilityPct: updated.probabilityPct },
    ip: auditMeta.ip,
    userAgent: auditMeta.userAgent,
  });
  return updated.id;
}

/**
 * Stage transition (§32) — transactional; server-authoritative probability
 * and terminal timestamps. WON requires a same-business live customer (§30/
 * §69). NO finance side effects of any kind (§33).
 */
export async function changeOpportunityStage(
  businessId: string,
  actorId: string,
  id: string,
  input: {
    stage: OpportunityStage;
    probabilityPct?: number;
    lostReason: string | null;
  },
  auditMeta: { ip: string | null; userAgent: string | null },
) {
  const existing = await db.crmOpportunity.findFirst({
    where: { id, businessId, deletedAt: null },
    select: { id: true, stage: true, probabilityPct: true, customerId: true },
  });
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Opportunity not found.");
  const from = stageOf(existing.stage);
  const to = input.stage;
  if (!isOpportunityTransitionValid(from, to)) {
    throw new ApiError(
      422,
      "INVALID_STATUS_TRANSITION",
      `Cannot move opportunity from ${from} to ${to}.`,
      { from, to },
    );
  }

  const fromCat = stageCategoryOf(from);
  const toCat = stageCategoryOf(to);

  // §32 — WON: customer required (same business, not deleted).
  if (to === "WON") {
    const customerId = existing.customerId;
    if (!customerId) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Link the opportunity to a customer before marking it WON.",
        { field: "customerId" },
      );
    }
    await assertCustomerInBusiness(customerId, businessId);
  }

  // Probability: WON=100, LOST=0 (forced). OPEN: client value allowed in the
  // same transition; reopening without one resets to the stage default (§32).
  let probability: number;
  if (to === "WON") probability = 100;
  else if (to === "LOST") probability = 0;
  else probability = input.probabilityPct ?? DEFAULT_STAGE_PROBABILITY[to];

  const now = new Date();
  const updated = await db.$transaction(
    async (tx) => {
      const row = await tx.crmOpportunity.update({
        where: { id: existing.id },
        data: {
          stage: to,
          probabilityPct: probability,
          wonAt: to === "WON" ? now : null,
          lostAt: to === "LOST" ? now : null,
          lostReason: to === "LOST" ? input.lostReason : null,
        },
        select: { id: true, stage: true, probabilityPct: true },
      });
      return row;
    },
    { isolationLevel: "Serializable" },
  );

  await audit({
    businessId,
    actorId,
    action: "crm.opportunity.stage_change",
    entityType: "CrmOpportunity",
    entityId: existing.id,
    before: { stage: from, probabilityPct: existing.probabilityPct },
    after: { stage: to, probabilityPct: updated.probabilityPct },
    ip: auditMeta.ip,
    userAgent: auditMeta.userAgent,
  });
  return { stage: to, probabilityPct: updated.probabilityPct };
}

/** Soft delete (§67) — never cascades to Customer/Lead (§68). */
export async function deleteOpportunity(
  businessId: string,
  actorId: string,
  id: string,
  auditMeta: { ip: string | null; userAgent: string | null },
) {
  const existing = await db.crmOpportunity.findFirst({
    where: { id, businessId, deletedAt: null },
    select: { id: true, title: true, stage: true },
  });
  if (!existing) throw new ApiError(404, "NOT_FOUND", "Opportunity not found.");
  await db.crmOpportunity.update({
    where: { id: existing.id },
    data: { deletedAt: new Date() },
    select: { id: true },
  });
  await audit({
    businessId,
    actorId,
    action: "crm.opportunity.delete",
    entityType: "CrmOpportunity",
    entityId: existing.id,
    before: { title: existing.title, stage: existing.stage },
    after: { deletedAt: new Date().toISOString() },
    ip: auditMeta.ip,
    userAgent: auditMeta.userAgent,
  });
}

export { OPEN_STAGES };
