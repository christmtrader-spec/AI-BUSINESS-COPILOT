/**
 * GET  /api/v1/expenses — list expenses (search + status filter + pagination).
 * POST /api/v1/expenses — record an expense (data:write, audited).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { dispatchWebhooks } from "@/lib/webhooks";
import { expenseCreateSchema, listParams, statusParam } from "@/lib/schemas";
import { localMonthKey, monthWindow } from "@/lib/reports";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  const { q, page, pageSize } = listParams(new URL(req.url));
  const status = statusParam(new URL(req.url));

  // Optional month drill-down (?month=YYYY-MM): "Open in Expenses" from the
  // reports month dialog — SAME business-timezone bucket as the MoM table.
  const monthRaw = new URL(req.url).searchParams.get("month");
  const month = monthRaw ? monthWindow(monthRaw) ? monthRaw : null : null;
  if (monthRaw && !month) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid month. Use YYYY-MM.");
  }

  const where = {
    businessId: ctx.businessId,
    deletedAt: null,
    ...(status ? { status } : {}),
    ...(month
      ? { spentAt: { gte: monthWindow(month)!.from, lt: monthWindow(month)!.until } }
      : {}),
    ...(q
      ? {
          OR: [
            { category: { contains: q } },
            { note: { contains: q } },
            { supplier: { is: { name: { contains: q } } } },
          ],
        }
      : {}),
  };

  if (!month) {
    const [expenses, total] = await Promise.all([
      db.expense.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { supplier: { select: { name: true } } },
      }),
      db.expense.count({ where }),
    ]);
    return ok({ items: expenses.map(toRow), total, page, pageSize });
  }

  // Month filter: widened UTC window + authoritative localMonthKey re-filter
  // (identical bucketing to buildMonthDetail), in-memory pagination.
  const business = await db.business.findUnique({
    where: { id: ctx.businessId },
    select: { timezone: true },
  });
  const tz = business?.timezone || "UTC";
  const all = await db.expense.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: { supplier: { select: { name: true } } },
  });
  const inMonth = all.filter((e) => localMonthKey(e.spentAt, tz) === month);
  const total = inMonth.length;
  const pageRows = inMonth.slice((page - 1) * pageSize, page * pageSize);
  return ok({ items: pageRows.map(toRow), total, page, pageSize });
});

type ExpenseRowInput = {
  id: string;
  supplierId: string | null;
  category: string;
  amountMinor: number;
  paidMinor: number;
  status: string;
  spentAt: Date;
  dueDate: Date | null;
  reference: string | null;
  note: string | null;
  createdAt: Date;
  supplier: { name: string } | null;
};

function toRow(e: ExpenseRowInput) {
  return {
    id: e.id,
    supplierId: e.supplierId,
    supplierName: e.supplier?.name ?? null,
    category: e.category,
    amountMinor: e.amountMinor,
    paidMinor: e.paidMinor,
    status: e.status,
    balanceMinor: e.amountMinor - e.paidMinor,
    spentAt: e.spentAt.toISOString(),
    dueDate: e.dueDate ? e.dueDate.toISOString() : null,
    reference: e.reference,
    note: e.note,
    createdAt: e.createdAt.toISOString(),
  };
}

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const input = await parseBody(req, expenseCreateSchema);

  const expense = await db.$transaction(async (tx) => {
    if (input.supplierId) {
      const supplier = await tx.supplier.findFirst({
        where: { id: input.supplierId, businessId: ctx.businessId, deletedAt: null },
      });
      if (!supplier) {
        throw new ApiError(422, "INVALID_SUPPLIER", "Supplier not found in this business.");
      }
    }

    const created = await tx.expense.create({
      data: {
        businessId: ctx.businessId,
        supplierId: input.supplierId,
        category: input.category,
        amountMinor: input.amountMinor,
        status: "UNPAID",
        spentAt: input.spentAt ?? new Date(),
        dueDate: input.dueDate ?? null,
        reference: input.reference ?? null,
        note: input.note,
      },
    });

    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "expense.create",
        entityType: "Expense",
        entityId: created.id,
        after: {
          category: created.category,
          amountMinor: created.amountMinor,
          dueDate: created.dueDate ? created.dueDate.toISOString() : null,
          reference: created.reference,
        },
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );

    return created;
  });

  // §W — fire-and-forget AFTER commit; a webhook can never break an expense.
  void dispatchWebhooks(ctx.businessId, "expense.created", {
    id: expense.id,
    category: expense.category,
    amountMinor: expense.amountMinor,
    supplierId: expense.supplierId ?? null,
    dueDate: expense.dueDate ? expense.dueDate.toISOString() : null,
  });

  return ok(expense, 201);
});
