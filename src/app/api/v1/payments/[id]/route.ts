/**
 * DELETE /api/v1/payments/[id] — reverse a payment (finance:manage).
 * Reverses paidMinor/status on the target sale/expense in the same tx.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { statusOf } from "@/lib/money";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "finance:manage");

  const payment = await db.payment.findFirst({
    where: { id, businessId: ctx.businessId },
  });
  if (!payment) throw new ApiError(404, "NOT_FOUND", "Payment not found.");

  await db.$transaction(async (tx) => {
    if (payment.saleId) {
      const sale = await tx.sale.findFirst({ where: { id: payment.saleId } });
      if (sale) {
        const paidMinor = Math.max(sale.paidMinor - payment.amountMinor, 0);
        await tx.sale.update({
          where: { id: sale.id },
          data: { paidMinor, status: statusOf(sale.totalMinor, paidMinor) },
        });
      }
    } else if (payment.expenseId) {
      const expense = await tx.expense.findFirst({ where: { id: payment.expenseId } });
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
