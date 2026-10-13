/**
 * GET /api/v1/businesses/[id]/export — full business data export (JSON).
 * Phase 06 hardening: the "backup story". Downloads every record of the
 * active business as one portable, schema-annotated JSON file.
 *
 * Law notes:
 * - Tenant: getAuthContext verifies session + membership; the id in the URL
 *   must match the session's active business (A01/A02).
 * - Permission: `settings:manage` (OWNER/ADMIN) — an export contains the
 *   complete financial history plus the audit trail.
 * - Privacy: actor password hashes and user emails of other members are
 *   reduced to ids/names; internal hashes never leave the server.
 * - Rate limited: 4 exports / 5 min / user (heavy query).
 * - Audited: "data.export".
 */
import { NextRequest, NextResponse } from "next/server";
import { ApiError, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type RouteParams = { params: Promise<{ id: string }> };

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  if (ctx.businessId !== id) {
    throw new ApiError(403, "FORBIDDEN", "You do not have access to this business.");
  }
  requirePermission(ctx, "settings:manage");

  const limit = rateLimit(`export:${ctx.userId}`, 4, 5 * 60_000);
  if (!limit.allowed) {
    throw new ApiError(
      429,
      "RATE_LIMITED",
      "Too many exports in a short time. Please wait a moment.",
      { retryAfterMs: limit.retryAfterMs },
    );
  }

  const businessId = ctx.businessId;

  // Every query is tenant-scoped by businessId (A01).
  // Prompt 48 (§7) — supplier-bill documents join the backup round-trip
  // (validate-for-fidelity, never re-imported — see backup-schema.ts).
  const [business, members, customers, suppliers, products, adjustments, sales, expenses, payments, auditLogs, supplierBills, supplierBillLines] =
    await Promise.all([
      db.business.findUnique({ where: { id: businessId } }),
      db.businessMember.findMany({
        where: { businessId },
        orderBy: { createdAt: "asc" },
        include: { user: { select: { id: true, name: true, email: true } } },
      }),
      db.customer.findMany({ where: { businessId }, orderBy: { createdAt: "asc" } }),
      db.supplier.findMany({ where: { businessId }, orderBy: { createdAt: "asc" } }),
      db.product.findMany({ where: { businessId }, orderBy: { createdAt: "asc" } }),
      db.inventoryAdjustment.findMany({
        where: { businessId },
        orderBy: { createdAt: "asc" },
        include: { actor: { select: { name: true, email: true } } },
      }),
      db.sale.findMany({
        where: { businessId },
        orderBy: [{ issueDate: "asc" }, { number: "asc" }],
        include: { items: { orderBy: { id: "asc" } } },
      }),
      db.expense.findMany({ where: { businessId }, orderBy: { spentAt: "asc" } }),
      db.payment.findMany({ where: { businessId }, orderBy: { paidAt: "asc" } }),
      db.auditLog.findMany({
        where: { businessId },
        orderBy: { createdAt: "asc" },
        include: { actor: { select: { name: true, email: true } } },
      }),
      // Prompt 48 (§7) — bills + lines (snapshots + relation ids; internalNotes
      // deliberately excluded — staff-only §16).
      db.supplierBill.findMany({
        where: { businessId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      db.supplierBillLine.findMany({
        where: { supplierBill: { businessId } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    ]);

  if (!business) {
    throw new ApiError(404, "NOT_FOUND", "Business not found.");
  }

  const payload = {
    $schema: "ai-business-copilot/backup@1",
    exportedAt: new Date().toISOString(),
    export: {
      version: 1,
      requestedBy: {
        id: ctx.userId,
        email:
          (ctx.session.user as { email?: string | null } | undefined)?.email ?? null,
      },
      counts: {
        members: members.length,
        customers: customers.length,
        suppliers: suppliers.length,
        products: products.length,
        inventoryAdjustments: adjustments.length,
        sales: sales.length,
        expenses: expenses.length,
        payments: payments.length,
        auditLogs: auditLogs.length,
        supplierBills: supplierBills.length,
        supplierBillLines: supplierBillLines.length,
      },
    },
    business: {
      id: business.id,
      name: business.name,
      slug: business.slug,
      currencyCode: business.currencyCode,
      currencySymbol: business.currencySymbol,
      decimalPrecision: business.decimalPrecision,
      locale: business.locale,
      timezone: business.timezone,
      createdAt: business.createdAt,
    },
    money: {
      convention:
        "All *Minor fields are integer minor units of business.currencyCode (A08). Divide by 10^decimalPrecision for display. Never floats.",
    },
    members: members.map((m) => ({
      id: m.id,
      role: m.role,
      createdAt: m.createdAt,
      user: { id: m.user.id, name: m.user.name, email: m.user.email },
    })),
    customers,
    suppliers,
    products,
    inventoryAdjustments: adjustments.map((a) => ({
      id: a.id,
      productId: a.productId,
      delta: a.delta,
      reason: a.reason,
      actor: a.actor ? { name: a.actor.name, email: a.actor.email } : null,
      createdAt: a.createdAt,
    })),
    sales: sales.map((s) => ({
      id: s.id,
      number: s.number,
      customerId: s.customerId,
      subtotalMinor: s.subtotalMinor,
      discountMinor: s.discountMinor,
      totalMinor: s.totalMinor,
      paidMinor: s.paidMinor,
      status: s.status,
      issueDate: s.issueDate,
      note: s.note,
      deletedAt: s.deletedAt,
      items: s.items.map((i) => ({
        name: i.name,
        unit: i.unit,
        qty: i.qty,
        unitPriceMinor: i.unitPriceMinor,
        lineTotalMinor: i.lineTotalMinor,
        productId: i.productId,
      })),
    })),
    expenses: expenses.map((e) => ({
      id: e.id,
      supplierId: e.supplierId,
      category: e.category,
      amountMinor: e.amountMinor,
      paidMinor: e.paidMinor,
      status: e.status,
      spentAt: e.spentAt,
      dueDate: e.dueDate,
      reference: e.reference,
      note: e.note,
      deletedAt: e.deletedAt,
    })),
    payments: payments.map((p) => ({
      id: p.id,
      saleId: p.saleId,
      expenseId: p.expenseId,
      direction: p.direction,
      amountMinor: p.amountMinor,
      method: p.method,
      note: p.note,
      paidAt: p.paidAt,
    })),
    // Prompt 48 (§7) — bill documents round-trip with the linked-Expense
    // identifier; internalNotes never leave the staff view (§16).
    supplierBills: supplierBills.map((b) => ({
      id: b.id,
      reference: b.reference,
      supplierInvoiceReference: b.supplierInvoiceReference,
      supplierId: b.supplierId,
      supplierNameAtBill: b.supplierNameAtBill,
      purchaseOrderId: b.purchaseOrderId,
      purchaseOrderReferenceAtBill: b.purchaseOrderReferenceAtBill,
      status: b.status,
      billDate: b.billDate,
      dueDate: b.dueDate,
      currencyCodeAtBill: b.currencyCodeAtBill,
      currencySymbolAtBill: b.currencySymbolAtBill,
      decimalPrecisionAtBill: b.decimalPrecisionAtBill,
      subtotalMinor: b.subtotalMinor,
      discountMinor: b.discountMinor,
      totalMinor: b.totalMinor,
      createdByUserId: b.createdByUserId,
      postedAt: b.postedAt,
      cancelledAt: b.cancelledAt,
      expenseId: b.expenseId,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    })),
    supplierBillLines: supplierBillLines.map((l) => ({
      id: l.id,
      supplierBillId: l.supplierBillId,
      purchaseOrderLineId: l.purchaseOrderLineId,
      productId: l.productId,
      productNameAtBill: l.productNameAtBill,
      skuAtBill: l.skuAtBill,
      unitAtBill: l.unitAtBill,
      billedQty: l.billedQty,
      unitPriceMinor: l.unitPriceMinor,
      purchaseOrderUnitPriceMinor: l.purchaseOrderUnitPriceMinor,
      lineTotalMinor: l.lineTotalMinor,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
    })),
    auditTrail: auditLogs.map((a) => ({
      id: a.id,
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId,
      actor: a.actor ? { name: a.actor.name, email: a.actor.email } : null,
      before: a.beforeJson ? safeJson(a.beforeJson) : null,
      after: a.afterJson ? safeJson(a.afterJson) : null,
      createdAt: a.createdAt,
    })),
  };

  await audit({
    businessId,
    actorId: ctx.userId,
    action: "data.export",
    entityType: "Business",
    entityId: businessId,
    before: null,
    after: payload.export.counts,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });

  const date = new Date().toISOString().slice(0, 10);
  const filename = `backup-${business.slug}-${date}.json`;

  return new NextResponse(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
});

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
