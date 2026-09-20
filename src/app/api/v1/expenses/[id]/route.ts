/**
 * PATCH  /api/v1/expenses/[id] — update (data:write, audited). Amount may
 * never drop below what has already been paid (kept consistent with payments).
 * DELETE /api/v1/expenses/[id] — soft delete (data:write). Blocked while
 * payments exist.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { expenseUpdateSchema } from "@/lib/schemas";
import { statusOf } from "@/lib/money";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

async function loadExpense(businessId: string, id: string) {
  const expense = await db.expense.findFirst({
    where: { id, businessId, deletedAt: null },
  });
  if (!expense) throw new ApiError(404, "NOT_FOUND", "Expense not found.");
  return expense;
}

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const before = await loadExpense(ctx.businessId, id);
  const input = await parseBody(req, expenseUpdateSchema);

  if (
    input.amountMinor !== undefined &&
    input.amountMinor < before.paidMinor
  ) {
    throw new ApiError(
      422,
      "AMOUNT_BELOW_PAID",
      `Amount cannot be lower than what has already been paid (${before.paidMinor} minor units).`,
    );
  }
  if (input.supplierId) {
    const supplier = await db.supplier.findFirst({
      where: { id: input.supplierId, businessId: ctx.businessId, deletedAt: null },
    });
    if (!supplier) {
      throw new ApiError(422, "INVALID_SUPPLIER", "Supplier not found in this business.");
    }
  }

  const updated = await db.$transaction(async (tx) => {
    const data = {
      ...input,
      ...(input.amountMinor !== undefined
        ? { status: statusOf(input.amountMinor, before.paidMinor) }
        : {}),
    };
    const e = await tx.expense.update({ where: { id: before.id }, data });
    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "expense.update",
        entityType: "Expense",
        entityId: e.id,
        before,
        after: e,
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
    return e;
  });

  return ok(updated);
});

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const before = await loadExpense(ctx.businessId, id);
  const paymentCount = await db.payment.count({ where: { expenseId: before.id } });
  if (paymentCount > 0 || before.paidMinor !== 0) {
    throw new ApiError(
      422,
      "EXPENSE_HAS_PAYMENTS",
      "This expense has payments recorded. Delete its payments first to keep the money history consistent.",
    );
  }

  await db.$transaction(async (tx) => {
    await tx.expense.update({ where: { id: before.id }, data: { deletedAt: new Date() } });
    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "expense.delete",
        entityType: "Expense",
        entityId: before.id,
        before,
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
  });

  return ok({ deleted: true });
});
