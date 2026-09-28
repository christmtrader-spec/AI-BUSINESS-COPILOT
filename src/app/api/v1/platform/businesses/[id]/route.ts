/**
 * GET /api/v1/platform/businesses/[id] — operator business detail (§20).
 *
 * Shows business, owner, member count, plan/subscription state, trial
 * state, billing period, currency/timezone, usage summary, payment
 * summary — and an AI cost summary ONLY for platform:ai-cost:read roles
 * (§20/§90). NEVER returns passwordHash, tokens, provider credentials or
 * raw AI transcripts.
 */
import { NextRequest } from "next/server";
import { route } from "@/lib/api-helpers";
import { platformError, getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { platformOk } from "@/lib/platform/http";
import { platformBusinessDto, platformSubscriptionDto } from "@/lib/platform/serializers";
import { db } from "@/lib/db";
import { getAiCostHealth } from "@/lib/ai/cost/economics";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:businesses:read");
  const { id } = await params;

  const business = await db.business.findUnique({
    where: { id },
    select: {
      id: true, name: true, slug: true, currencyCode: true, locale: true, timezone: true,
      ownerId: true, createdAt: true, updatedAt: true,
      owner: { select: { email: true, name: true } },
      _count: { select: { members: true } },
    },
  });
  if (!business) {
    throw platformError(404, "PLATFORM_INVALID_OPERATION", "Business not found.");
  }

  const [subscription, usageAgg, payments, aiCost] = await Promise.all([
    db.subscription.findUnique({
      where: { businessId: id },
      include: { plan: { select: { code: true, name: true } }, business: { select: { name: true } } },
    }),
    db.usageCounter.aggregate({ _sum: { used: true }, where: { usagePeriod: { businessId: id } } }),
    db.paymentTransaction.findMany({
      where: { checkoutSession: { businessId: id } },
      orderBy: { processedAt: "desc" },
      take: 10,
      select: { id: true, provider: true, status: true, amountMinor: true, currency: true, processedAt: true },
    }),
    db.aiCostRecord.groupBy({
      by: ["costStatus"],
      where: { businessId: id },
      _count: { _all: true },
    }),
  ]);

  const usageEvents = await db.usageEvent.count({ where: { businessId: id } });
  const aiKnown = aiCost.find((g) => g.costStatus === "KNOWN")?._count._all ?? 0;
  const aiUnknown = aiCost.find((g) => g.costStatus === "UNKNOWN")?._count._all ?? 0;
  const attributable = aiKnown + aiUnknown;

  let aiCostSummary: Record<string, unknown> | null = null;
  if (ctx.permissions.includes("platform:ai-cost:read")) {
    const health = await getAiCostHealth(30);
    aiCostSummary = {
      knownRecords: aiKnown,
      unknownRecords: aiUnknown,
      costCoverageBps: attributable > 0 ? Math.round((aiKnown / attributable) * 10_000) : null,
      knownCostNanoMinorByCurrency: health.knownCostNanoMinorByCurrency,
    };
  }

  return platformOk({
    business: platformBusinessDto(business, business.owner, business._count.members),
    subscription: subscription ? platformSubscriptionDto(subscription) : null,
    usage: {
      totalMeteredUnits: usageAgg._sum.used ?? 0,
      usageEvents,
    },
    payments: payments.map((t) => ({
      id: t.id,
      provider: t.provider,
      status: t.status,
      amountMinor: t.amountMinor,
      currency: t.currency,
      processedAt: t.processedAt.toISOString(),
    })),
    aiCost: aiCostSummary,
  });
});
