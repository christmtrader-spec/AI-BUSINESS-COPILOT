/**
 * Prompt 35 — CRM data-access services: shared tenant-scoped validation
 * helpers used by the route layer (§15/§82).
 *
 * Law (§15 — absolute):
 * - `ctx.businessId` (server-derived from the verified membership) is the
 *   ONLY business key every query uses. Body/query businessId/tenantId/
 *   ownerId/userId are never read.
 * - Foreign-tenant and soft-deleted records resolve to 404 NOT_FOUND —
 *   never 403 — so existence is never leaked across tenants (§15/§82).
 * - Relations (assignee / customer / lead) must belong to the SAME
 *   business or they are rejected (422) at write time (§78 rules 5–7).
 */
import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-helpers";

/** Bounded relation select — the minimal columns any CRM path needs. */
export const CRM_CUSTOMER_SELECT = {
  id: true,
  name: true,
  phone: true,
  email: true,
} as const;

export const CRM_LEAD_REF_SELECT = {
  id: true,
  name: true,
  companyName: true,
  status: true,
} as const;

/**
 * Validate an assignee (§13/§14/§78 rule 5): the user must be a CURRENT
 * member of the caller's business. Returns the validated id or null.
 */
export async function assertAssigneeInBusiness(
  userId: string | null | undefined,
  businessId: string,
): Promise<string | null> {
  if (!userId) return null;
  const member = await db.businessMember.findUnique({
    where: { businessId_userId: { businessId, userId } },
    select: { id: true },
  });
  if (!member) {
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "The assigned member does not belong to this business.",
      { field: "assignedToUserId" },
    );
  }
  return userId;
}

/**
 * Load a tenant-scoped lead or throw 404 (§15/§82). deletedAt filter makes
 * soft-deleted leads behave exactly like unknown ids.
 */
export async function loadLeadOr404(businessId: string, id: string) {
  const lead = await db.crmLead.findFirst({
    where: { id, businessId, deletedAt: null },
  });
  if (!lead) throw new ApiError(404, "NOT_FOUND", "Lead not found.");
  return lead;
}

/** Load a tenant-scoped opportunity or throw 404 (§15/§82). */
export async function loadOpportunityOr404(businessId: string, id: string) {
  const opportunity = await db.crmOpportunity.findFirst({
    where: { id, businessId, deletedAt: null },
  });
  if (!opportunity) {
    throw new ApiError(404, "NOT_FOUND", "Opportunity not found.");
  }
  return opportunity;
}

/**
 * Validate a customer relation (§78 rule 6): must exist in the SAME
 * business and not be soft-deleted. Foreign/deleted → 404-shaped ApiError
 * is intentionally avoided at WRITE time: the client supplied the id, so a
 * 422 validation error is the honest response (the record is not reachable
 * through this path — no existence leak either way).
 */
export async function assertCustomerInBusiness(
  customerId: string | null | undefined,
  businessId: string,
  tx: Pick<typeof db, "customer"> = db,
): Promise<string | null> {
  if (!customerId) return null;
  const customer = await tx.customer.findFirst({
    where: { id: customerId, businessId, deletedAt: null },
    select: { id: true },
  });
  if (!customer) {
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "The referenced customer does not exist in this business.",
      { field: "customerId" },
    );
  }
  return customerId;
}

/**
 * Validate a lead relation (§78 rule 7): must exist in the SAME business
 * and not be soft-deleted.
 */
export async function assertLeadInBusiness(
  leadId: string | null | undefined,
  businessId: string,
  tx: Pick<typeof db, "crmLead"> = db,
): Promise<string | null> {
  if (!leadId) return null;
  const lead = await tx.crmLead.findFirst({
    where: { id: leadId, businessId, deletedAt: null },
    select: { id: true },
  });
  if (!lead) {
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "The referenced lead does not exist in this business.",
      { field: "leadId" },
    );
  }
  return leadId;
}

/**
 * Load a customer for CONVERSION (§24): foreign/deleted customer resolves
 * to 404 — same observable behavior as an unknown id, no leak (§15).
 */
export async function loadCustomerForConversion(
  businessId: string,
  customerId: string,
  tx: Pick<typeof db, "customer"> = db,
) {
  const customer = await tx.customer.findFirst({
    where: { id: customerId, businessId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!customer) {
    throw new ApiError(404, "NOT_FOUND", "Customer not found.");
  }
  return customer;
}

/** Load the business currency snapshot (§85) — creation-time capture. */
export async function businessCurrencyOf(businessId: string): Promise<string> {
  const business = await db.business.findUnique({
    where: { id: businessId },
    select: { currencyCode: true },
  });
  if (!business) throw new ApiError(404, "NOT_FOUND", "Business not found.");
  return business.currencyCode;
}
