/**
 * GET    /api/v1/payments/[id] — payment detail + related document (data:read).
 * DELETE /api/v1/payments/[id] — reverse a payment (finance:manage).
 *        Reverses paidMinor/status on the target sale/expense in the same tx.
 *
 * Prompt 34 (§19/§20/§21/§69/§85): tenant-scoped GET. The payment is a
 * TENANT payment — its response NEVER touches PaymentTransaction, gateway
 * or provider internals (§69). The related document is resolved server-side
 * to exactly one of {sale, expense}; invoice formatting reuses
 * formatInvoiceNumber (§17).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { statusOf } from "@/lib/money";
import { rateLimit } from "@/lib/rate-limit";
import { mapPaymentDetail } from "@/lib/entities";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // §20 — foreign record → 404 (same path as unknown id). Payment has no
  // deletedAt (hard-delete model), so no soft-delete filter applies.
  const payment = await db.payment.findFirst({
    where: { id, businessId: ctx.businessId },
    select: {
      id: true,
      direction: true,
      amountMinor: true,
      method: true,
      note: true,
      paidAt: true,
      createdAt: true,
      saleId: true,
      expenseId: true,
    },
  });
  if (!payment) throw new ApiError(404, "NOT_FOUND", "Payment not found.");

  // §85 — single related document only; both relations are same-business
  // by construction (created against this payment's business), and the
  // fetch is still explicitly scoped for defense-in-depth.
  const [relatedSale, relatedExpense] = await Promise.all([
    payment.saleId
      ? db.sale.findFirst({
          where: { id: payment.saleId, businessId: ctx.businessId },
          select: {
            id: true,
            number: true,
            customerId: true,
            customer: { select: { name: true } },
            totalMinor: true,
            paidMinor: true,
            status: true,
          },
        })
      : Promise.resolve(null),
    payment.expenseId
      ? db.expense.findFirst({
          where: { id: payment.expenseId, businessId: ctx.businessId },
          select: {
            id: true,
            category: true,
            supplierId: true,
            supplier: { select: { name: true } },
            amountMinor: true,
            paidMinor: true,
            status: true,
          },
        })
      : Promise.resolve(null),
  ]);

  return ok(
    mapPaymentDetail(
      payment,
      relatedSale
        ? {
            id: relatedSale.id,
            number: relatedSale.number,
            customerId: relatedSale.customerId,
            customerName: relatedSale.customer?.name ?? null,
            totalMinor: relatedSale.totalMinor,
            paidMinor: relatedSale.paidMinor,
            status: relatedSale.status,
          }
        : null,
      relatedExpense
        ? {
            id: relatedExpense.id,
            category: relatedExpense.category,
            supplierId: relatedExpense.supplierId,
            supplierName: relatedExpense.supplier?.name ?? null,
            amountMinor: relatedExpense.amountMinor,
            paidMinor: relatedExpense.paidMinor,
            status: relatedExpense.status,
          }
        : null,
    ),
  );
});

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "finance:manage");

  // Audit hardening: light limit on money reversals (in-memory MVP limiter).
  const rl = rateLimit(`payments:revert:${ctx.userId}:${ctx.businessId}`, 30, 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many payment operations. Please wait a moment.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const payment = await db.payment.findFirst({
    where: { id, businessId: ctx.businessId },
  });
  if (!payment) throw new ApiError(404, "NOT_FOUND", "Payment not found.");

  await db.$transaction(async (tx) => {
    if (payment.saleId) {
      const sale = await tx.sale.findFirst({ where: { id: payment.saleId, businessId: ctx.businessId } });
      if (sale) {
        const paidMinor = Math.max(sale.paidMinor - payment.amountMinor, 0);
        await tx.sale.update({
          where: { id: sale.id },
          data: { paidMinor, status: statusOf(sale.totalMinor, paidMinor) },
        });
      }
    } else if (payment.expenseId) {
      const expense = await tx.expense.findFirst({ where: { id: payment.expenseId, businessId: ctx.businessId } });
      if (expense) {
        const paidMinor = Math.max(expense.paidMinor - payment.amountMinor, 0);
        await tx.expense.update({
          where: { id: expense.id },
          data: { paidMinor, status: statusOf(expense.amountMinor, paidMinor) },
        });
      }
    }

    await tx.payment.delete({ where: { id: payment.id } });

    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "payment.delete",
        entityType: "Payment",
        entityId: payment.id,
        before: {
          direction: payment.direction,
          amountMinor: payment.amountMinor,
          method: payment.method,
        },
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
  });

  return ok({ deleted: true });
});
