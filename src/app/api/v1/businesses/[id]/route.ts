/**
 * GET    /api/v1/businesses/[id] — business details (member required).
 * PATCH  /api/v1/businesses/[id] — update settings (settings:manage) + audit.
 * DELETE /api/v1/businesses/[id] — OWNER-only danger zone. Requires the
 *         exact business name as typed confirmation; hard-deletes the
 *         business and every related record (FK cascade).
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

// ---- DELETE — danger zone (OWNER-only) --------------------------------------

const deleteSchema = z.object({
  // Typed confirmation: must equal the CURRENT business name exactly.
  confirmName: z.string().trim().min(1).max(120),
});

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  if (ctx.businessId !== id) {
    throw new ApiError(403, "FORBIDDEN", "You do not have access to this business.");
  }
  requirePermission(ctx, "business:delete"); // OWNER only (rbac.ts)

  const { confirmName } = await parseBody(req, deleteSchema);
  if (confirmName !== ctx.business.name) {
    throw new ApiError(
      422,
      "CONFIRM_MISMATCH",
      "The typed name does not match this business.",
      { expected: ctx.business.name },
    );
  }

  // Transparency: counts returned to the caller before deletion. The audit
  // trail is deleted WITH the business (cascade), so no audit row can
  // outlive the business it describes.
  const [customers, suppliers, products, sales, expenses, payments, members, auditLogs] =
    await Promise.all([
      db.customer.count({ where: { businessId: ctx.businessId } }),
      db.supplier.count({ where: { businessId: ctx.businessId } }),
      db.product.count({ where: { businessId: ctx.businessId } }),
      db.sale.count({ where: { businessId: ctx.businessId } }),
      db.expense.count({ where: { businessId: ctx.businessId } }),
      db.payment.count({ where: { businessId: ctx.businessId } }),
      db.businessMember.count({ where: { businessId: ctx.businessId } }),
      db.auditLog.count({ where: { businessId: ctx.businessId } }),
    ]);

  const counts = {
    customers,
    suppliers,
    products,
    sales,
    expenses,
    payments,
    members,
    auditLogs,
  };

  // Single delete — every business-scoped table cascades (schema.prisma).
  await db.business.delete({ where: { id: ctx.businessId } });

  return ok({ deleted: true, businessId: ctx.businessId, counts });
});
