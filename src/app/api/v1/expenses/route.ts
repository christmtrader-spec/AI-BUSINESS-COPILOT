/**
 * GET  /api/v1/expenses — list expenses (search + status filter + pagination).
 * POST /api/v1/expenses — record an expense (data:write, audited).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { expenseCreateSchema, listParams, statusParam } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  const { q, page, pageSize } = listParams(new URL(req.url));
  const status = statusParam(new URL(req.url));

  const where = {
    businessId: ctx.businessId,
    deletedAt: null,
    ...(status ? { status } : {}),
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

  return ok({
    items: expenses.map((e) => ({
      id: e.id,
      supplierId: e.supplierId,
      supplierName: e.supplier?.name ?? null,
      category: e.category,
      amountMinor: e.amountMinor,
      paidMinor: e.paidMinor,
      status: e.status,
      balanceMinor: e.amountMinor - e.paidMinor,
      spentAt: e.spentAt.toISOString(),
      note: e.note,
      createdAt: e.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
  });
});

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
        after: { category: created.category, amountMinor: created.amountMinor },
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );

    return created;
  });

  return ok(expense, 201);
});
