import "server-only";
import { db } from "@/lib/db";

/**
 * Prompt 37-F — LIVE CONTEXT READER (§17/§36).
 *
 * Reads a task's CURRENT context row DIRECTLY (deletedAt-filtered,
 * business-scoped) instead of trusting a relation include, which does NOT
 * filter soft-deleted rows. Used by BOTH the reminder processor and the
 * post-commit assignment notification so a deleted/foreign context can
 * never produce a notification.
 *
 * Laws:
 *  - EXACTLY-ONE context (§8 of prompt 36): the task carries at most one of
 *    customerId / leadId / opportunityId.
 *  - A context id whose row is missing, soft-deleted or foreign ⇒ null —
 *    the caller SKIPS the notification. There is NO default and NO
 *    `CUSTOMER`/`""` fallback (§17).
 *  - Titles are bounded to the notification schema limit (160 chars, §18).
 */

export type LiveContext = {
  type: "CUSTOMER" | "LEAD" | "OPPORTUNITY";
  title: string;
};

export type TaskContextRefs = {
  customerId: string | null;
  leadId: string | null;
  opportunityId: string | null;
};

export async function readLiveTaskContext(
  businessId: string,
  refs: TaskContextRefs,
): Promise<LiveContext | null> {
  if (refs.customerId) {
    const customer = await db.customer.findFirst({
      where: { id: refs.customerId, businessId, deletedAt: null },
      select: { name: true },
    });
    if (!customer?.name) return null;
    return { type: "CUSTOMER", title: customer.name.slice(0, 160) };
  }
  if (refs.leadId) {
    const lead = await db.crmLead.findFirst({
      where: { id: refs.leadId, businessId, deletedAt: null },
      select: { name: true, companyName: true },
    });
    const title = (lead?.companyName ?? lead?.name ?? "").trim();
    if (!title) return null;
    return { type: "LEAD", title: title.slice(0, 160) };
  }
  if (refs.opportunityId) {
    const opportunity = await db.crmOpportunity.findFirst({
      where: { id: refs.opportunityId, businessId, deletedAt: null },
      select: { title: true },
    });
    if (!opportunity?.title) return null;
    return { type: "OPPORTUNITY", title: opportunity.title.slice(0, 160) };
  }
  return null; // no context at all — exactly-one law violated ⇒ skip (§17)
}
