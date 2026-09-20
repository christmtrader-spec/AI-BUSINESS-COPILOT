/**
 * GET   /api/v1/businesses/[id] — business details (member required).
 * PATCH /api/v1/businesses/[id] — update settings (settings:manage) + audit.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { findCurrency } from "@/lib/currencies";

export const dynamic = "force-dynamic";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  currencyCode: z.string().trim().length(3).optional(),
  currencySymbol: z.string().trim().min(1).max(8).optional(),
  decimalPrecision: z.number().int().min(0).max(4).optional(),
  locale: z.enum(["en", "fa"]).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
});

type RouteParams = { params: Promise<{ id: string }> };

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  if (ctx.businessId !== id) {
    throw new ApiError(403, "FORBIDDEN", "You do not have access to this business.");
  }
  requirePermission(ctx, "settings:read");
  return ok(ctx.business);
});

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  if (ctx.businessId !== id) {
    throw new ApiError(403, "FORBIDDEN", "You do not have access to this business.");
  }
  requirePermission(ctx, "settings:manage");

  const input = await parseBody(req, updateSchema);

  if (input.currencyCode) {
    const currency = findCurrency(input.currencyCode);
    if (!currency) {
      throw new ApiError(422, "INVALID_CURRENCY", "Unsupported currency code.");
    }
  }

  const before = { ...ctx.business };

  const updated = await db.$transaction(async (tx) => {
    const biz = await tx.business.update({
      where: { id: ctx.businessId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.currencyCode !== undefined ? { currencyCode: input.currencyCode } : {}),
        ...(input.currencySymbol !== undefined ? { currencySymbol: input.currencySymbol } : {}),
        ...(input.decimalPrecision !== undefined ? { decimalPrecision: input.decimalPrecision } : {}),
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
        ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
      },
    });

    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "business.update",
        entityType: "Business",
        entityId: biz.id,
        before,
        after: biz,
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );

    return biz;
  });

  return ok(updated);
});
