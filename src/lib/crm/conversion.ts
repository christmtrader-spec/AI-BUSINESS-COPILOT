/**
 * Prompt 35 — lead conversion (§23–§26/§68/§75).
 *
 * ONE serializable transaction: customer create-or-link + lead CONVERTED +
 * optional opportunity — or NOTHING changes (§26 atomicity). Creating a
 * customer passes the EXISTING CUSTOMERS_MAX entitlement gate INSIDE the
 * transaction (§75 — non-negotiable). CRM conversion NEVER touches
 * finance (no sale/payment/inventory/report changes — §1/§33).
 */
import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { assertWithinLimitIn, getEntitlementContextTx } from "@/lib/billing";
import { assertAssigneeInBusiness, loadCustomerForConversion, loadLeadOr404 } from "./service";
import { parseExpectedCloseDate } from "./normalization";
import { DEFAULT_STAGE_PROBABILITY } from "./constants";
import type { LeadConvertInput } from "./schemas";

export type ConvertAuditMeta = { ip: string | null; userAgent: string | null };

/**
 * Execute the conversion (§23).
 *
 * EXISTING_CUSTOMER: link + mark CONVERTED (+ optional opportunity).
 * CREATE_CUSTOMER: create the customer from lead-derived fields (only
 * fields the existing Customer model supports — §25), then the same.
 *
 * Returns the resulting customer id (and opportunity id when created).
 */
export async function convertLead(
  businessId: string,
  actorId: string,
  leadId: string,
  input: LeadConvertInput,
  meta: ConvertAuditMeta,
): Promise<{ customerId: string; opportunityId: string | null }> {
  const existing = await loadLeadOr404(businessId, leadId);

  // §22/§23 — only a not-yet-converted lead can convert. CONVERTED is
  // terminal (isLeadTransitionValid already encodes this), so converting a
  // CONVERTED lead must fail cleanly.
  if (existing.status === "CONVERTED") {
    throw new ApiError(
      422,
      "INVALID_STATUS_TRANSITION",
      "This lead has already been converted.",
      { from: "CONVERTED", to: "CONVERTED" },
    );
  }

  // Assignee snapshot rides along (no mutation) for the audit record.
  const assignedToUserId = await assertAssigneeInBusiness(
    existing.assignedToUserId,
    businessId,
  );

  const result = await db.$transaction(
    async (tx) => {
      let customerId: string;

      if (input.mode === "EXISTING_CUSTOMER") {
        // §24 — validate the customer belongs to THIS business, is alive;
        // never duplicate, never auto-modify the customer row (§24).
        const customer = await loadCustomerForConversion(
          businessId,
          input.customerId as string,
          tx,
        );
        customerId = customer.id;
      } else {
        // §25 — CREATE_CUSTOMER through the EXISTING entitlement gate.
        const bctx = await getEntitlementContextTx(tx, businessId);
        const usage = await tx.customer.count({
          where: { businessId, deletedAt: null },
        });
        // §75 — mandatory gate inside the SAME transaction. Limit reached →
        // 422 and the lead stays untouched (§26).
        assertWithinLimitIn(bctx, "CUSTOMERS_MAX", usage);

        const fields = input.customer!;
        const createdCustomer = await tx.customer.create({
          data: {
            businessId,
            name: fields.name,
            phone: fields.phone,
            email: fields.email,
            // NOTE (§25): the current Customer model has NO companyName
            // column — the lead keeps its companyName; nothing invented.
          },
          select: { id: true },
        });
        customerId = createdCustomer.id;
      }

      // Mark the lead CONVERTED (§23) — same transaction, atomic (§26).
      await tx.crmLead.update({
        where: { id: existing.id },
        data: {
          status: "CONVERTED",
          customerId,
          convertedAt: new Date(),
        },
        select: { id: true },
      });

      // Optional opportunity linked to the resulting customer (§23).
      let opportunityId: string | null = null;
      if (input.opportunityTitle) {
        const business = await tx.business.findUnique({
          where: { id: businessId },
          select: { currencyCode: true },
        });
        const opp = await tx.crmOpportunity.create({
          data: {
            businessId,
            title: input.opportunityTitle,
            leadId: existing.id,
            customerId,
            stage: "DISCOVERY",
            probabilityPct: DEFAULT_STAGE_PROBABILITY.DISCOVERY,
            expectedValueMinor: 0,
            currencyCode: business?.currencyCode ?? "USD",
            assignedToUserId: assignedToUserId ?? null,
          },
          select: { id: true },
        });
        opportunityId = opp.id;
      }

      return { customerId, opportunityId };
    },
    { isolationLevel: "Serializable" },
  );

  // §65 — audit after commit (safe fields only).
  await audit({
    businessId,
    actorId,
    action: "crm.lead.convert",
    entityType: "CrmLead",
    entityId: existing.id,
    before: { status: existing.status },
    after: {
      status: "CONVERTED",
      mode: input.mode,
      customerId: result.customerId,
      opportunityId: result.opportunityId,
    },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

  return result;
}


