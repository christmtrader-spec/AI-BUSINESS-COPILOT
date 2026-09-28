/**
 * GET /api/v1/platform/payments — paginated payment overview (§30/§69).
 *
 * READ-ONLY list over CheckoutSession + PaymentTransaction +
 * ProcessedWebhookEvent. Filters: provider, status, businessId, currency,
 * date range. NO payment credentials, NO raw webhook signatures, NO
 * sensitive gateway payloads (§30/§91) — the DTOs below are the allowlist.
 */
import { NextRequest } from "next/server";
import { route } from "@/lib/api-helpers";
import { getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { pageMeta, parsePagination, platformOk, queryDate, queryFilter } from "@/lib/platform/http";
import type { PlatformPaymentDTO } from "@/lib/platform/serializers";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:payments:read");

  const sp = req.nextUrl.searchParams;
  const p = parsePagination(sp);

  const provider = queryFilter(sp, "provider", 32);
  const status = queryFilter(sp, "status", 32);
  const businessId = queryFilter(sp, "businessId", 64);
  const currency = queryFilter(sp, "currency", 8)?.toUpperCase();
  const createdFrom = queryDate(sp, "createdFrom");
  const createdTo = queryDate(sp, "createdTo", true);

  const sessionWhere = {
    ...(provider ? { provider } : {}),
    ...(status ? { status } : {}),
    ...(businessId ? { businessId } : {}),
    ...(currency ? { currency } : {}),
    ...(createdFrom || createdTo
      ? { createdAt: { ...(createdFrom ? { gte: createdFrom } : {}), ...(createdTo ? { lte: createdTo } : {}) } }
      : {}),
  };

  const [sessions, sessionTotal, transactions, webhookEvents] = await Promise.all([
    db.checkoutSession.findMany({
      where: sessionWhere,
      orderBy: { createdAt: "desc" },
      take: p.pageSize,
      skip: p.skip,
      select: {
        id: true, businessId: true, planCode: true, provider: true, providerRef: true,
        status: true, amountMinor: true, currency: true, reconciliationReason: true,
        createdAt: true, expiresAt: true, initiatedByUserId: true,
        business: { select: { name: true } },
      },
    }),
    db.checkoutSession.count({ where: sessionWhere }),
    db.paymentTransaction.findMany({
      where: {
        ...(provider ? { provider } : {}),
        ...(status ? { status } : {}),
        ...(createdFrom || createdTo
          ? { processedAt: { ...(createdFrom ? { gte: createdFrom } : {}), ...(createdTo ? { lte: createdTo } : {}) } }
          : {}),
        ...(businessId || currency
          ? {
              checkoutSession: {
                ...(businessId ? { businessId } : {}),
                ...(currency ? { currency } : {}),
              },
            }
          : {}),
      },
      orderBy: { processedAt: "desc" },
      take: Math.min(p.pageSize, 50),
      skip: p.skip,
      select: {
        id: true, checkoutSessionId: true, provider: true, status: true,
        amountMinor: true, currency: true, processedAt: true,
        checkoutSession: {
          select: {
            businessId: true,
            planCode: true,
            business: { select: { name: true } },
          },
        },
      },
    }),
    db.processedWebhookEvent.findMany({
      where: {
        ...(provider ? { provider } : {}),
        ...(createdFrom || createdTo
          ? { receivedAt: { ...(createdFrom ? { gte: createdFrom } : {}), ...(createdTo ? { lte: createdTo } : {}) } }
          : {}),
      },
      orderBy: { receivedAt: "desc" },
      take: Math.min(p.pageSize, 50),
      skip: p.skip,
      select: { id: true, provider: true, eventId: true, eventType: true, receivedAt: true },
    }),
  ]);

  // initiatedByUserId is a plain reference (no relation) — resolve emails
  // separately, bounded to the page size.
  const initiatorIds = [...new Set(sessions.map((s) => s.initiatedByUserId).filter((v): v is string => !!v))];
  const initiators = initiatorIds.length
    ? await db.user.findMany({ where: { id: { in: initiatorIds } }, select: { id: true, email: true } })
    : [];
  const emailById = new Map(initiators.map((u) => [u.id, u.email]));

  const items: PlatformPaymentDTO[] = [
    ...sessions.map((s): PlatformPaymentDTO => ({
      kind: "checkout_session",
      id: s.id,
      businessId: s.businessId,
      businessName: s.business?.name ?? null,
      planCode: s.planCode,
      provider: s.provider,
      providerRef: s.providerRef,
      status: s.status,
      amountMinor: s.amountMinor,
      currency: s.currency,
      reconciliationReason: s.reconciliationReason,
      initiatedByEmail: s.initiatedByUserId ? emailById.get(s.initiatedByUserId) ?? null : null,
      expiresAt: s.expiresAt.toISOString(),
      createdAt: s.createdAt.toISOString(),
    })),
    ...transactions.map((t): PlatformPaymentDTO => ({
      kind: "payment_transaction",
      id: t.id,
      checkoutSessionId: t.checkoutSessionId,
      businessId: t.checkoutSession.businessId,
      businessName: t.checkoutSession.business?.name ?? null,
      planCode: t.checkoutSession.planCode,
      provider: t.provider,
      status: t.status,
      amountMinor: t.amountMinor,
      currency: t.currency,
      processedAt: t.processedAt.toISOString(),
      createdAt: t.processedAt.toISOString(),
    })),
    ...webhookEvents.map((w): PlatformPaymentDTO => ({
      kind: "processed_webhook_event",
      id: w.id,
      provider: w.provider,
      status: w.eventType,
      businessId: null,
      businessName: null,
      planCode: null,
      amountMinor: null,
      currency: null,
      createdAt: w.receivedAt.toISOString(),
    })),
  ];

  return platformOk({
    items,
    counts: {
      checkoutSessions: sessionTotal,
      transactions: transactions.length,
      webhookEvents: webhookEvents.length,
    },
    page: pageMeta(p, sessionTotal),
  });
});
