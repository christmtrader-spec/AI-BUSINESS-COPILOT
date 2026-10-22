/**
 * GET /api/v1/platform/overview — safe platform metrics (Prompt 28 §18/§88).
 *
 * Every card carries title/value/status data the server derived. HONESTY
 * LAWS: no net profit, no company valuation, no unverified revenue, no
 * provider secrets (§18). Cost VALUES (money) appear only for roles with
 * platform:ai-cost:read (§90) — counts/coverage are safe for every
 * platform role; monetary aggregation is per-currency, never mixed (§89).
 */
import { NextRequest } from "next/server";
import { route } from "@/lib/api-helpers";
import { getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { platformOk } from "@/lib/platform/http";
import { db } from "@/lib/db";
import { getAiCostHealth } from "@/lib/ai/cost/economics";
import { publicPlatformConfigSummary } from "@/lib/legal/public-config";
import { SUPPORT_TICKET_OPEN_STATUSES } from "@/lib/platform/support";
import { SECURITY_EVENTS } from "@/lib/auth/security-events/service";

export const dynamic = "force-dynamic";

export const GET = route(async (_req: NextRequest) => {
  const ctx = await getPlatformContext(_req);
  requirePlatformPermission(ctx, "platform:overview:read");

  const now = new Date();
  const windowDays = 30;
  const from = new Date(now.getTime() - windowDays * 86_400_000);

  const [
    users,
    businesses,
    subscriptionByStatus,
    subscriptionByPlan,
    pendingCheckouts,
    reconciliationRequired,
    paymentsTotal,
    aiRecordsByStatus,
    aiUsageEvents,
    openAnomalies,
    operators,
    trustConfig,
    supportOpen,
    supportAwaitingFirstResponse,
    supportUrgentOpen,
    securityLoginsWindow,
    securityFailedLoginsWindow,
    securitySuspendedUsers,
  ] = await Promise.all([
    db.user.count(),
    db.business.count(),
    db.subscription.groupBy({ by: ["status"], _count: { _all: true } }),
    db.subscription.groupBy({ by: ["planId"], _count: { _all: true } }),
    db.checkoutSession.count({ where: { status: "PENDING", expiresAt: { gt: now } } }),
    db.checkoutSession.count({ where: { status: "RECONCILIATION_REQUIRED" } }),
    db.paymentTransaction.count(),
    db.aiCostRecord.groupBy({
      by: ["costStatus"],
      where: { createdAt: { gte: from } },
      _count: { _all: true },
    }),
    db.usageEvent.count({ where: { metric: "AI_REQUESTS", createdAt: { gte: from } } }),
    db.aiCostAnomaly.count({ where: { status: "OPEN" } }),
    db.platformOperator.count({ where: { active: true } }),
    publicPlatformConfigSummary(),
    // Prompt 62 §7.2 — support-desk operational metrics (counts only; the
    // operator still needs platform:support:read to open any ticket).
    db.supportTicket.count({
      where: { status: { in: [...SUPPORT_TICKET_OPEN_STATUSES] } },
    }),
    db.supportTicket.count({
      where: {
        status: { in: [...SUPPORT_TICKET_OPEN_STATUSES] },
        firstResponseAt: null,
      },
    }),
    db.supportTicket.count({
      where: {
        status: { in: [...SUPPORT_TICKET_OPEN_STATUSES] },
        priority: "URGENT",
      },
    }),
    // R63-P — Security Center headline (counts only, safe for every
    // platform role; the feed itself stays behind platform:security:read).
    db.securityEvent.count({
      where: { eventType: SECURITY_EVENTS.loginSuccess, createdAt: { gte: from } },
    }),
    db.securityEvent.count({
      where: { eventType: SECURITY_EVENTS.loginFailed, createdAt: { gte: from } },
    }),
    db.user.count({ where: { suspendedAt: { not: null } } }),
  ]);

  const byStatus = Object.fromEntries(
    subscriptionByStatus.map((g) => [g.status, g._count._all]),
  ) as Record<string, number>;

  // businessesByPlan — resolve plan codes for the grouped ids.
  const planIds = subscriptionByPlan.map((g) => g.planId);
  const plans = planIds.length
    ? await db.plan.findMany({ where: { id: { in: planIds } }, select: { id: true, code: true } })
    : [];
  const planCodeById = new Map(plans.map((p) => [p.id, p.code]));
  const byPlan = Object.fromEntries(
    subscriptionByPlan.map((g) => [planCodeById.get(g.planId) ?? "unknown", g._count._all]),
  );

  const aiKnown = aiRecordsByStatus.find((g) => g.costStatus === "KNOWN")?._count._all ?? 0;
  const aiUnknown = aiRecordsByStatus.find((g) => g.costStatus === "UNKNOWN")?._count._all ?? 0;
  const attributable = aiKnown + aiUnknown;
  const costCoverageBps = attributable > 0 ? Math.round((aiKnown / attributable) * 10_000) : null;

  // Cost VALUES only for ai-cost readers (§90) — per-currency, never mixed.
  let knownCostByCurrency: Record<string, string> | null = null;
  let guardStatus: string | null = null;
  if (ctx.permissions.includes("platform:ai-cost:read")) {
    const health = await getAiCostHealth(windowDays);
    knownCostByCurrency = health.knownCostNanoMinorByCurrency;
    guardStatus = health.guardStatus;
  }

  const readinessBlockers = Object.entries(trustConfig)
    .filter(([, v]) => v.status !== "CONFIGURED")
    .map(([k, v]) => ({ key: k, status: v.status }));

  return platformOk({
    generatedAt: now.toISOString(),
    windowDays,
    users,
    businesses,
    activeOperators: operators,
    subscriptions: {
      byStatus,
      byPlan,
      trialing: byStatus.TRIALING ?? 0,
      active: byStatus.ACTIVE ?? 0,
      canceled: byStatus.CANCELED ?? 0,
      expired: byStatus.EXPIRED ?? 0,
      paused: byStatus.PAUSED ?? 0,
      pastDue: byStatus.PAST_DUE ?? 0,
    },
    payments: {
      pendingCheckouts,
      reconciliationRequired,
      transactionsTotal: paymentsTotal,
    },
    ai: {
      requestsWindow: aiUsageEvents,
      knownRecords: aiKnown,
      unknownRecords: aiUnknown,
      costCoverageBps,
      openAnomalies,
      // Money values: null unless platform:ai-cost:read (§90).
      knownCostNanoMinorByCurrency: knownCostByCurrency,
      guardStatus,
    },
    trust: {
      readinessBlockers,
      /** The honest headline: NOT ready while any category is unconfigured. */
      verdict: readinessBlockers.length === 0 ? "READY" : "PARTIALLY_READY",
    },
    support: {
      open: supportOpen,
      awaitingFirstResponse: supportAwaitingFirstResponse,
      urgentOpen: supportUrgentOpen,
    },
    security: {
      /** Counts over the SAME windowDays as every other overview card (30d). */
      loginsWindow: securityLoginsWindow,
      failedLoginsWindow: securityFailedLoginsWindow,
      suspendedUsers: securitySuspendedUsers,
    },
  });
});
