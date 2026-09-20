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
import { localMonthKey, monthWindow } from "@/lib/reports";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  const { q, page, pageSize } = listParams(new URL(req.url));
  const status = statusParam(new URL(req.url));

  // Optional month drill-down (?month=YYYY-MM): "Open in Sales" from the
  // reports month dialog. Uses the SAME business-timezone month bucket as
  // the MoM table — the dialog figures and this list can never disagree.
  const monthRaw = new URL(req.url).searchParams.get("month");
  const month = monthRaw ? monthWindow(monthRaw) ? monthRaw : null : null;
  if (monthRaw && !month) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid month. Use YYYY-MM.");
  }

  const numberEq = /^\d+$/.test(q) ? Number(q) : null;
  const where = {
    businessId: ctx.businessId,
    deletedAt: null,
    ...(status ? { status } : {}),
    ...(month
      ? { issueDate: { gte: monthWindow(month)!.from, lt: monthWindow(month)!.until } }
      : {}),
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

  // Without a month filter: normal DB pagination. With one: the UTC window
  // is intentionally widened (±2 days) for timezone safety, so rows are
  // re-filtered by the authoritative local month key and paginated in
  // memory — identical bucketing to buildMonthDetail, tiny datasets.
  if (!month) {
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
    return ok({ items: sales.map(toRow), total, page, pageSize });
  }

  const business = await db.business.findUnique({
    where: { id: ctx.businessId },
    select: { timezone: true },
  });
  const tz = business?.timezone || "UTC";
  const all = await db.sale.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: { customer: { select: { name: true } } },
  });
  const inMonth = all.filter((s) => localMonthKey(s.issueDate, tz) === month);
  const total = inMonth.length;
  const pageRows = inMonth.slice((page - 1) * pageSize, page * pageSize);
  return ok({ items: pageRows.map(toRow), total, page, pageSize });
});

type SaleRowInput = {
  id: string;
  number: number;
  customerId: string | null;
  issueDate: Date;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  paidMinor: number;
  status: string;
  note: string | null;
  createdAt: Date;
  customer: { name: string } | null;
};

function toRow(s: SaleRowInput) {
  return {
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
  };
}

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
