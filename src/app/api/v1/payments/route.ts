/**
 * GET  /api/v1/payments — list payments (direction filter + pagination).
 * POST /api/v1/payments — record a payment against one sale or one expense.
 *
 * This is the SINGLE writer of `paidMinor`/`status` on Sale/Expense —
 * always inside one transaction with the Payment row (A08/A09).
 * Permission: finance:manage (owner/admin/manager/accountant).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { listParams, paymentCreateSchema } from "@/lib/schemas";
import { statusOf } from "@/lib/money";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  const { page, pageSize } = listParams(new URL(req.url));
  const directionRaw = (new URL(req.url).searchParams.get("direction") ?? "")
    .trim()
    .toUpperCase();
  const direction = directionRaw === "IN" || directionRaw === "OUT" ? directionRaw : null;

  const where = {
    businessId: ctx.businessId,
    ...(direction ? { direction } : {}),
  };

  const [payments, total] = await Promise.all([
    db.payment.findMany({
      where,
      orderBy: { paidAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        sale: { select: { number: true, customer: { select: { name: true } } } },
        expense: { select: { category: true, supplier: { select: { name: true } } } },
        actor: { select: { name: true, email: true } },
      },
    }),
    db.payment.count({ where }),
  ]);

  return ok({
    items: payments.map((p) => ({
      id: p.id,
      direction: p.direction,
      saleId: p.saleId,
      saleNumber: p.sale?.number ?? null,
      customerName: p.sale?.customer?.name ?? null,
      expenseId: p.expenseId,
      expenseCategory: p.expense?.category ?? null,
      supplierName: p.expense?.supplier?.name ?? null,
      amountMinor: p.amountMinor,
      method: p.method,
      note: p.note,
      paidAt: p.paidAt.toISOString(),
      actorName: p.actor?.name ?? p.actor?.email ?? null,
    })),
    total,
    page,
    pageSize,
  });
});

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "finance:manage");

  const input = await parseBody(req, paymentCreateSchema);

  const payment = await db.$transaction(async (tx) => {
    let direction: "IN" | "OUT";
    let balanceMinor: number;
    let auditEntity: string;
    let auditExtra: Record<string, unknown> = {};

    if (input.saleId) {
      const sale = await tx.sale.findFirst({
        where: { id: input.saleId, businessId: ctx.businessId, deletedAt: null },
      });
      if (!sale) throw new ApiError(404, "NOT_FOUND", "Invoice not found.");
      direction = "IN";
      balanceMinor = sale.totalMinor - sale.paidMinor;
      auditEntity = "Sale";
      auditExtra = { saleNumber: sale.number };
      if (input.amountMinor > balanceMinor) {
        throw new ApiError(
          422,
          "OVERPAYMENT",
          `Payment exceeds the outstanding balance (${balanceMinor} minor units).`,
        );
      }
      await tx.sale.update({
        where: { id: sale.id },
        data: {
          paidMinor: { increment: input.amountMinor },
          status: statusOf(sale.totalMinor, sale.paidMinor + input.amountMinor),
        },
      });
    } else {
      const expense = await tx.expense.findFirst({
        where: { id: input.expenseId!, businessId: ctx.businessId, deletedAt: null },
      });
      if (!expense) throw new ApiError(404, "NOT_FOUND", "Expense not found.");
      direction = "OUT";
      balanceMinor = expense.amountMinor - expense.paidMinor;
      auditEntity = "Expense";
      auditExtra = { expenseCategory: expense.category };
      if (input.amountMinor > balanceMinor) {
        throw new ApiError(
          422,
          "OVERPAYMENT",
          `Payment exceeds the outstanding balance (${balanceMinor} minor units).`,
        );
      }
      await tx.expense.update({
        where: { id: expense.id },
        data: {
          paidMinor: { increment: input.amountMinor },
          status: statusOf(expense.amountMinor, expense.paidMinor + input.amountMinor),
        },
      });
    }

    const created = await tx.payment.create({
      data: {
        businessId: ctx.businessId,
        saleId: input.saleId,
        expenseId: input.expenseId,
        direction,
        amountMinor: input.amountMinor,
        method: input.method,
        note: input.note,
        paidAt: input.paidAt ?? new Date(),
        actorId: ctx.userId,
      },
    });

    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "payment.create",
        entityType: "Payment",
        entityId: created.id,
        after: { direction, amountMinor: input.amountMinor, method: input.method, ...auditExtra },
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );

    return created;
  });

  return ok(payment, 201);
});
