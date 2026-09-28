/**
 * GET  /api/v1/platform/pricing — price books + plan prices (§34).
 * POST /api/v1/platform/pricing — create a NEW immutable book version (§35).
 *
 * Pricing administration flows exclusively through PricingService additions
 * (createPriceBookVersion). No hard-coded price values anywhere (§34), no
 * IRR book is invented (§37 — the UI shows the honest NOT CONFIGURED state
 * while no IRR book exists), activation is a separate audited step.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { route } from "@/lib/api-helpers";
import { assertPlatformReauth, getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { parsePlatformBody, platformOk } from "@/lib/platform/http";
import { platformAudit, requestIdOf } from "@/lib/platform/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { platformPriceBookDto } from "@/lib/platform/serializers";
import { createPriceBookVersion } from "@/lib/payments/pricing-service";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:pricing:read");

  const books = await db.priceBook.findMany({
    orderBy: [{ currency: "asc" }, { effectiveFrom: "desc" }],
    include: { prices: { orderBy: [{ planCode: "asc" }, { billingPeriod: "asc" }] } },
  });

  // Currency coverage — the honest IRR SAFETY view (§37): a supported
  // currency with no active book is reported as NOT_CONFIGURED.
  const currencies = [...new Set(books.map((b) => b.currency))];
  const coverage = currencies.map((c) => ({
    currency: c,
    activeBook: books.some((b) => b.currency === c && b.active),
  }));

  return platformOk({
    books: books.map((b) => platformPriceBookDto(b)),
    currencyCoverage: coverage,
  });
});

const bodySchema = z.object({
  code: z.string().trim().min(2).max(64),
  version: z.string().trim().min(2).max(64),
  currency: z.string().trim().length(3),
  description: z.string().trim().max(300).optional(),
  effectiveFrom: z.string().datetime({ offset: true }),
  effectiveTo: z.string().datetime({ offset: true }).nullable().optional(),
  prices: z
    .array(
      z.object({
        planCode: z.string().trim().min(2).max(32),
        billingPeriod: z.enum(["MONTHLY", "YEARLY"]),
        amountMinor: z.number().int().positive(),
      }),
    )
    .min(1),
  reason: z.string().trim().min(3).max(300),
  password: z.string().min(1).max(200).optional(),
});

export const POST = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:pricing:manage");
  const body = await parsePlatformBody(req, bodySchema);

  const rl = rateLimit(`platform:${ctx.operatorId}:pricebook-create`, 10, 15 * 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: { code: "PLATFORM_INVALID_OPERATION", message: "Too many attempts. Try again later." } },
      { status: 429 },
    );
  }

  await assertPlatformReauth(ctx, body.password);

  const requestId = requestIdOf(req);
  const created = await createPriceBookVersion({
    code: body.code,
    version: body.version,
    currency: body.currency,
    description: body.description,
    effectiveFrom: new Date(body.effectiveFrom),
    effectiveTo: body.effectiveTo ? new Date(body.effectiveTo) : null,
    prices: body.prices,
  });

  await platformAudit({
    operatorId: ctx.operatorId,
    operatorRole: ctx.role,
    action: "pricing.book_created",
    entityType: "PriceBook",
    entityId: created.id,
    reason: body.reason,
    after: {
      code: created.code,
      version: created.version,
      currency: created.currency,
      priceRowCount: body.prices.length,
    },
    requestId,
    ip: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });

  return platformOk({ priceBook: created, requestId }, 201);
});
