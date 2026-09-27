/**
 * GET /api/v1/onboarding/status — Prompt 25.
 *
 * Session-scoped onboarding state for the signed-in user. Works BOTH before
 * a business exists (checklist empty, hasBusiness=false) and after (the
 * checklist is derived from REAL server data — never from client-asserted
 * progress):
 *   - customers / products / sales created (authoritative table counts)
 *   - team members beyond the owner
 *   - AI copilot used at least once (UsageEvent, Prompt 21 ledger)
 *   - trial state (TRIALING with a live trialEnd — never guessed)
 *   - onboarding completion marker (once per business, server-recorded)
 *
 * No customer names, no sales amounts, no emails in the checklist — counts
 * only (data minimization).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertFreshSession } from "@/lib/auth-security";
import { recordCommercialEvent } from "@/lib/billing/events";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const session = await getServerSession(authOptions);
  const userId = await assertFreshSession(session);

  const memberships = await db.businessMember.findMany({
    where: { userId },
    select: { businessId: true, role: true, business: { select: { id: true, name: true } } },
    orderBy: { business: { createdAt: "asc" } },
  });

  // Funnel: a user reaching onboarding without a business (once per user).
  if (memberships.length === 0) {
    void recordCommercialEvent({
      eventType: "ONBOARDING_STARTED",
      userId,
      dedupeKey: `onb-start:${userId}`,
    });
  }

  const requestedId = new URL(req.url).searchParams.get("businessId");
  const active = requestedId
    ? memberships.find((m) => m.businessId === requestedId)
    : memberships[0];
  if (requestedId && !active) {
    throw new ApiError(403, "FORBIDDEN", "You do not have access to this business.");
  }

  if (!active) {
    return ok({
      hasBusiness: false,
      memberships: memberships.map((m) => ({
        businessId: m.businessId,
        name: m.business.name,
        role: m.role,
      })),
      checklist: null,
      trial: null,
      onboardingCompleted: false,
    });
  }

  const businessId = active.businessId;

  // Authoritative existence checks — counts/probes against the real tables.
  const [customers, products, sales, extraMembers, copilotUsage] = await Promise.all([
    db.customer.findFirst({ where: { businessId }, select: { id: true } }),
    db.product.findFirst({ where: { businessId }, select: { id: true } }),
    db.sale.findFirst({ where: { businessId }, select: { id: true } }),
    db.businessMember.count({ where: { businessId, userId: { not: userId } } }).then((n) => n > 0),
    db.usageEvent.findFirst({
      where: { businessId, metric: "AI_MESSAGES", status: "COMMITTED" },
      select: { id: true },
    }),
  ]);

  const sub = await db.subscription.findUnique({
    where: { businessId },
    include: { plan: { select: { code: true } } },
  });
  const trialActive =
    !!sub &&
    sub.status === "TRIALING" &&
    !!sub.trialEnd &&
    sub.trialEnd.getTime() > Date.now();

  const completion = await db.commercialEvent.findUnique({
    where: {
      eventType_dedupeKey: {
        eventType: "ONBOARDING_COMPLETED",
        dedupeKey: `onb-done:${businessId}`,
      },
    },
    select: { id: true },
  });

  return ok({
    hasBusiness: true,
    memberships: memberships.map((m) => ({
      businessId: m.businessId,
      name: m.business.name,
      role: m.role,
    })),
    businessId,
    checklist: {
      customersCreated: customers !== null,
      productsCreated: products !== null,
      salesCreated: sales !== null,
      teamInvited: extraMembers,
      copilotUsed: copilotUsage !== null,
    },
    trial: sub
      ? {
          active: trialActive,
          planCode: sub.plan.code,
          status: sub.status,
          trialStart: sub.trialStart?.toISOString() ?? null,
          trialEnd: sub.trialEnd?.toISOString() ?? null,
        }
      : null,
    onboardingCompleted: completion !== null,
  });
});
