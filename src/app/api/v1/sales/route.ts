/**
 * GET  /api/v1/sales — list invoices (search + status filter + pagination).
 * POST /api/v1/sales — create an invoice with line items (data:write).
 *
 * Constitution: A02 (RBAC), A08 (integer minor units, totals recomputed
 * server-side), A09 (audit), product items decrement stock transactionally.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { listParams, saleCreateSchema, statusParam } from "@/lib/schemas";
import { formatInvoiceNumber } from "@/lib/finance";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  const { q, page, pageSize } = listParams(new URL(req.url));
  const status = statusParam(new URL(req.url));

  const numberEq = /^\d+$/.test(q) ? Number(q) : null;
  const where = {
    businessId: ctx.businessId,
    deletedAt: null,
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            ...(numberEq !== null ? [{ number: numberEq }] : []),
            { note: { contains: q } },
            { customer: { is: { name: { contains: q } } } },
          ],
        }
      : {}),
  };

  const [sales, total] = await Promise.all([
    db.sale.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { customer: { select: { name: true } } },
    }),
    db.sale.count({ where }),
  ]);

  return ok({
    items: sales.map((s) => ({
      id: s.id,
      number: s.number,
      customerId: s.customerId,
      customerName: s.customer?.name ?? null,
      issueDate: s.issueDate.toISOString(),
      subtotalMinor: s.subtotalMinor,
      discountMinor: s.discountMinor,
      totalMinor: s.totalMinor,
      paidMinor: s.paidMinor,
      status: s.status,
      balanceMinor: s.totalMinor - s.paidMinor,
      note: s.note,
      createdAt: s.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
  });
});

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const input = await parseBody(req, saleCreateSchema);

  const sale = await db.$transaction(async (tx) => {
    // Customer must exist in THIS business (tenant law A01).
    if (input.customerId) {
      const customer = await tx.customer.findFirst({
        where: { id: input.customerId, businessId: ctx.businessId, deletedAt: null },
      });
      if (!customer) {
        throw new ApiError(422, "INVALID_CUSTOMER", "Customer not found in this business.");
      }
    }

    // Validate every referenced product against this business and compute
    // line totals with integer math — client totals are never trusted (A08).
    const productIds = [
      ...new Set(input.items.map((i) => i.productId).filter((v): v is string => Boolean(v))),
    ];
    const products = await tx.product.findMany({
      where: { id: { in: productIds }, businessId: ctx.businessId, deletedAt: null },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

    let subtotalMinor = 0;
    const lines = input.items.map((item) => {
      if (item.productId && !productMap.has(item.productId)) {
        throw new ApiError(422, "INVALID_PRODUCT", "One of the products was not found.");
      }
      const lineTotalMinor = item.qty * item.unitPriceMinor; // integers only
      subtotalMinor += lineTotalMinor;
      return { ...item, lineTotalMinor };
    });

    if (input.discountMinor > subtotalMinor) {
      throw new ApiError(422, "INVALID_DISCOUNT", "Discount cannot exceed the invoice subtotal.");
    }
    const totalMinor = subtotalMinor - input.discountMinor;

    // Next per-business sequential number.
    const last = await tx.sale.findFirst({
      where: { businessId: ctx.businessId },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const number = (last?.number ?? 0) + 1;
    const display = formatInvoiceNumber(number);

    const created = await tx.sale.create({
      data: {
        businessId: ctx.businessId,
        number,
        customerId: input.customerId,
        subtotalMinor,
        discountMinor: input.discountMinor,
        totalMinor,
        status: "UNPAID",
        paidMinor: 0,
        issueDate: input.issueDate ?? new Date(),
        note: input.note,
        items: {
          create: lines.map((l) => ({
            productId: l.productId,
            name: l.name,
            unit: l.unit,
            qty: l.qty,
            unitPriceMinor: l.unitPriceMinor,
            lineTotalMinor: l.lineTotalMinor,
          })),
        },
      },
      include: { items: true },
    });

    // Stock movement for product-backed lines (same tx — all-or-nothing).
    for (const line of lines) {
      if (!line.productId) continue;
      const product = productMap.get(line.productId)!;
      if (product.stockQty < line.qty) {
        throw new ApiError(
          422,
          "INSUFFICIENT_STOCK",
          `Not enough stock for "${product.name}" (have ${product.stockQty}, need ${line.qty}).`,
        );
      }
      await tx.product.update({
        where: { id: product.id },
        data: { stockQty: { decrement: line.qty } },
      });
      await tx.inventoryAdjustment.create({
        data: {
          businessId: ctx.businessId,
          productId: product.id,
          delta: -line.qty,
          reason: `Sale ${display}`,
          actorId: ctx.userId,
        },
      });
    }

    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "sale.create",
        entityType: "Sale",
        entityId: created.id,
        after: { number, totalMinor, items: created.items.length, customerId: input.customerId },
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );

    return created;
  });

  return ok({ id: sale.id, number: sale.number, totalMinor: sale.totalMinor }, 201);
});
