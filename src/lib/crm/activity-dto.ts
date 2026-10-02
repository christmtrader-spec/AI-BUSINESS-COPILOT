/**
 * Prompt 36 — Activity DTO mappers (§79 discipline carried over from 35).
 *
 * Prisma rows are NEVER serialized. Every mapper reads an explicitly
 * `select`ed structural row shape and emits an allowlisted DTO. Data
 * minimization: creator refs carry id/name/email only (never security,
 * session or MFA fields — §59/§66); descriptions are included in DTOs
 * because the authorized reader rendered the list, but are NEVER copied
 * into audit payloads or logs (§74).
 */
import { isActivityType, type ActivityType, type CrmContextType } from "./activity-types";
import type { CrmAssigneeRef } from "./types";
import type { AssigneeRow } from "./dto";
import { toIsoOrNull } from "./normalization";

/** Structural creator row (same shape as assignee rows in dto.ts). */
export type ActivityCreatorRow = AssigneeRow;

/** Activity row shape — mirrors the explicit Prisma select exactly. */
export type CrmActivityRow = {
  id: string;
  type: string;
  title: string;
  description: string | null;
  occurredAt: Date;
  durationMinutes: number | null;
  leadId: string | null;
  lead: { id: string; name: string; companyName: string | null } | null;
  opportunityId: string | null;
  opportunity: { id: string; title: string } | null;
  customerId: string | null;
  customer: { id: string; name: string } | null;
  createdByUserId: string;
  createdByUser: ActivityCreatorRow | null;
  createdAt: Date;
  updatedAt: Date;
};

/** The ONE context anchor of an activity/task (§8 — exactly one). */
export type CrmContextRef = {
  type: CrmContextType;
  id: string;
  title: string;
};

export type ActivityDTO = {
  id: string;
  type: ActivityType;
  title: string;
  description: string | null;
  occurredAt: string;
  durationMinutes: number | null;
  context: CrmContextRef;
  createdBy: CrmAssigneeRef | null;
  createdAt: string;
  updatedAt: string;
};

export type ActivityListResponse = {
  items: ActivityDTO[];
  total: number;
  page: number;
  pageSize: number;
};

function activityTypeOf(value: string): ActivityType {
  return isActivityType(value) ? value : "OTHER";
}

/** Resolve the single context ref from the three nullable columns (§8). */
export function contextRefOf(row: {
  leadId: string | null;
  lead: { id: string; name: string; companyName: string | null } | null;
  opportunityId: string | null;
  opportunity: { id: string; title: string } | null;
  customerId: string | null;
  customer: { id: string; name: string } | null;
}): CrmContextRef | null {
  if (row.customerId && row.customer) {
    return { type: "CUSTOMER", id: row.customer.id, title: row.customer.name };
  }
  if (row.leadId && row.lead) {
    return { type: "LEAD", id: row.lead.id, title: row.lead.companyName ?? row.lead.name };
  }
  if (row.opportunityId && row.opportunity) {
    return { type: "OPPORTUNITY", id: row.opportunity.id, title: row.opportunity.title };
  }
  return null;
}

export function mapActivity(row: CrmActivityRow): ActivityDTO {
  return {
    id: row.id,
    type: activityTypeOf(row.type),
    title: row.title,
    description: row.description,
    occurredAt: row.occurredAt.toISOString(),
    durationMinutes: row.durationMinutes,
    context: contextRefOf(row) ?? { type: "CUSTOMER", id: "", title: "" },
    createdBy: row.createdByUser
      ? {
          id: row.createdByUser.id,
          name: row.createdByUser.name,
          email: row.createdByUser.email,
          role: row.createdByUser.memberships[0]?.role ?? "",
        }
      : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
