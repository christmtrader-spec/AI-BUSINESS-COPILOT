/**
 * Prompt 35 — explicit DTO mappers (§79/§80/§81).
 *
 * Full Prisma rows are NEVER serialized (§79). Every mapper pulls from an
 * explicitly `select`ed row shape and emits only the allowlisted fields.
 * Data-minimization: customer refs carry id/name/phone/email only (§80);
 * assignee refs carry id/name/email/role only (§81) — never password,
 * session or security fields (§66/§133).
 */
import {
  stageOf,
  leadSourceOf,
  leadStatusOf,
  toIsoOrNull,
} from "./normalization";
import type {
  CrmAssigneeRef,
  CrmCustomerRef,
  CrmLeadRef,
  CrmOpportunityRef,
  LeadDTO,
  LeadDetail,
  OpportunityDTO,
  OpportunityDetail,
} from "./types";
import { stageCategory } from "./types";
import { DEFAULT_STAGE_PROBABILITY } from "./constants";
import { weightedValue } from "./normalization";

/* ------------------------------ row shapes -------------------------------- */
/* Structural (Prisma-free) so pure units and the static scanner can verify
   exactly which fields can reach a response (§78 rule 8). */

/** Assignee row shape — role resolved through the business membership. */
export type AssigneeRow = {
  id: string;
  name: string | null;
  email: string;
  memberships: { role: string }[];
};

export type LeadRow = {
  id: string;
  name: string;
  companyName: string | null;
  phone: string | null;
  email: string | null;
  source: string;
  sourceDetail: string | null;
  status: string;
  note: string | null;
  assignedToUserId: string | null;
  assignedToUser: AssigneeRow | null;
  customerId: string | null;
  customer: { id: string; name: string; phone: string | null; email: string | null } | null;
  convertedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type OpportunityRow = {
  id: string;
  title: string;
  description: string | null;
  stage: string;
  probabilityPct: number;
  expectedValueMinor: number;
  currencyCode: string;
  expectedCloseDate: Date | null;
  assignedToUserId: string | null;
  assignedToUser: AssigneeRow | null;
  customerId: string | null;
  customer: { id: string; name: string; phone: string | null; email: string | null } | null;
  leadId: string | null;
  lead: { id: string; name: string; companyName: string | null; status: string } | null;
  lostReason: string | null;
  wonAt: Date | null;
  lostAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type OpportunityRefRow = {
  id: string;
  title: string;
  stage: string;
  probabilityPct: number;
  expectedValueMinor: number;
  currencyCode: string;
  expectedCloseDate: Date | null;
  createdAt: Date;
};

/* -------------------------------- mappers --------------------------------- */

export function mapAssignee(user: AssigneeRow | null): CrmAssigneeRef | null {
  if (!user) return null;
  // Role = the assignee's role in THIS business (§81); no membership → no
  // role shown rather than a wrong one.
  const role = user.memberships[0]?.role ?? "";
  return { id: user.id, name: user.name, email: user.email, role };
}

export function mapCustomerRef(
  customer: { id: string; name: string; phone: string | null; email: string | null } | null,
): CrmCustomerRef | null {
  if (!customer) return null;
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
  };
}

export function mapLeadRef(lead: OpportunityRow["lead"]): CrmLeadRef | null {
  if (!lead) return null;
  return {
    id: lead.id,
    name: lead.name,
    companyName: lead.companyName,
    status: leadStatusOf(lead.status),
  };
}

export function mapLead(row: LeadRow): LeadDTO {
  return {
    id: row.id,
    name: row.name,
    companyName: row.companyName,
    phone: row.phone,
    email: row.email,
    source: leadSourceOf(row.source),
    sourceDetail: row.sourceDetail,
    status: leadStatusOf(row.status),
    note: row.note,
    assignedTo: mapAssignee(row.assignedToUser),
    customer: mapCustomerRef(row.customer),
    convertedAt: toIsoOrNull(row.convertedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function mapOpportunityRef(row: OpportunityRefRow): CrmOpportunityRef {
  return {
    id: row.id,
    title: row.title,
    stage: stageOf(row.stage),
    probabilityPct: row.probabilityPct,
    expectedValueMinor: row.expectedValueMinor,
    currencyCode: row.currencyCode,
    expectedCloseDate: toIsoOrNull(row.expectedCloseDate),
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapOpportunity(row: OpportunityRow): OpportunityDTO {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    stage: stageOf(row.stage),
    probabilityPct: row.probabilityPct,
    expectedValueMinor: row.expectedValueMinor,
    currencyCode: row.currencyCode,
    expectedCloseDate: toIsoOrNull(row.expectedCloseDate),
    assignedTo: mapAssignee(row.assignedToUser),
    customer: mapCustomerRef(row.customer),
    lead: mapLeadRef(row.lead),
    lostReason: row.lostReason,
    wonAt: toIsoOrNull(row.wonAt),
    lostAt: toIsoOrNull(row.lostAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Weighted value derivation lives with the mapper so it can never drift. */
export function withWeightedValue(dto: OpportunityDTO): OpportunityDetail {
  return {
    ...dto,
    weightedValueMinor: weightedValue(dto.expectedValueMinor, dto.probabilityPct),
  };
}

/** Lead detail assembly — counts + bounded opportunities come from the caller. */
export function mapLeadDetail(
  row: LeadRow,
  related: {
    openOpportunityCount: number;
    opportunityCount: number;
    recentOpportunities: CrmOpportunityRef[];
  },
): LeadDetail {
  return { ...mapLead(row), ...related };
}

/** Stage default probability for OPEN stages (WON/LOST forced upstream). */
export function defaultProbabilityFor(stage: string): number {
  return DEFAULT_STAGE_PROBABILITY[stageOf(stage)];
}

export { stageCategory };
