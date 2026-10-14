/**
 * GET    /api/v1/customers/[id] — customer detail + 360 summary (data:read).
 * PATCH  /api/v1/customers/[id] — update (data:write, audited).
 * DELETE /api/v1/customers/[id] — soft delete (data:write, audited).
 *
 * Prompt 34 (§11/§12/§20/§21/§40): the GET is tenant-scoped by the
 * SERVER-derived businessId, filters soft deletes, aggregates the 360
 * summary through a single groupBy (no N+1, no full-history loads) and
 * bounds both recent lists to 10. Foreign-tenant and deleted records
 * return 404 — never a existence leak (§20). The response is an explicit
 * DTO (§22) with integer minor units (§43).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { partyUpdateSchema } from "@/lib/schemas";
import { listRecentDispatchesForCustomer } from "@/lib/inventory/goods-dispatch/service";
import { listRecentOrdersForCustomer } from "@/lib/sales-orders/service";
import { recentQuotationsForCustomer } from "@/lib/sales-quotations/service";
import {
  compute360Summary,
  mapCustomerCrm,
  mapCustomerDetail,
  toStatusToken,
} from "@/lib/entities";
import { buildCustomerAgingSummary } from "@/lib/party-aging";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

/** Bounded recent-record caps (§12/§40/§85). */
const RECENT_SALES_TAKE = 10;
const RECENT_PAYMENTS_TAKE = 10;

async function loadCustomer(businessId: string, id: string) {
  const customer = await db.customer.findFirst({
    where: { id, businessId, deletedAt: null },
  });
  if (!customer) throw new ApiError(404, "NOT_FOUND", "Customer not found.");
  return customer;
}

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  // §20 — foreign/deleted record → 404 (same path as unknown id).
  const customer = await loadCustomer(ctx.businessId, id);

  // §40 — independent bounded queries in parallel; aggregates via groupBy
  // (one round trip, no N+1); recent lists take ≤10 with deterministic
  // ordering; explicit select everywhere (§86).
  const [statusBuckets, recentSales, recentPayments, openOppCount, recentOpps, leadOrigin, recentGoodsDispatches, recentSalesOrders, recentSalesQuotations, receivablesAging] = await Promise.all([
    db.sale.groupBy({
      by: ["status"],
      where: { businessId: ctx.businessId, customerId: id, deletedAt: null },
      _count: { _all: true },
      _sum: { totalMinor: true, paidMinor: true },
    }),
    db.sale.findMany({
      where: { businessId: ctx.businessId, customerId: id, deletedAt: null },
      orderBy: [{ issueDate: "desc" }, { id: "desc" }],
      take: RECENT_SALES_TAKE,
      select: {
        id: true,
        number: true,
        issueDate: true,
        totalMinor: true,
        paidMinor: true,
        status: true,
      },
    }),
    db.payment.findMany({
      where: { businessId: ctx.businessId, sale: { customerId: id } },
      orderBy: [{ paidAt: "desc" }, { id: "desc" }],
      take: RECENT_PAYMENTS_TAKE,
      select: {
        id: true,
        amountMinor: true,
        method: true,
        paidAt: true,
        note: true,
      },
    }),
    // Prompt 35 (§44) — CRM section: open-opportunity count + bounded ≤10
    // recent opportunities + the converting lead origin. Tenant-scoped and
    // soft-delete aware; the customer's financial aggregates above are
    // UNTOUCHED (§45).
    db.crmOpportunity.count({
      where: {
        businessId: ctx.businessId,
        customerId: id,
        deletedAt: null,
        stage: { in: ["DISCOVERY", "QUALIFIED", "PROPOSAL", "NEGOTIATION"] },
      },
    }),
    db.crmOpportunity.findMany({
      where: { businessId: ctx.businessId, customerId: id, deletedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 10,
      select: {
        id: true,
        title: true,
        stage: true,
        probabilityPct: true,
        expectedValueMinor: true,
        expectedCloseDate: true,
      },
    }),
    db.crmLead.findFirst({
      where: { businessId: ctx.businessId, customerId: id, deletedAt: null },
      orderBy: [{ convertedAt: "desc" }, { id: "desc" }],
      select: { id: true, name: true, convertedAt: true },
    }),
    // Prompt 44 — ≤10 recent goods-dispatch documents for this customer
    // (NO money; quantity only — dispatches are inventory events).
    listRecentDispatchesForCustomer({ businessId: ctx.businessId, customerId: id, take: 10 }),
    // Prompt 45 (§71) — ≤10 recent sales orders (commitment data, never
    // added to receivables — §92).
    listRecentOrdersForCustomer({ businessId: ctx.businessId, customerId: id, take: 10 }),
    // Prompt 47 (§19) — ≤10 recent quotations (commercial offers, never
    // added to receivables or any financial summary §19).
    recentQuotationsForCustomer(ctx.businessId, id, 10),
    // Prompt 49 (§17) — canonical receivables-aging overview for this exact
    // customer (bounded scan, business timezone, integer money).
    buildCustomerAgingSummary(ctx.businessId, id, ctx.business.timezone || "UTC"),
  ]);

  const summary = compute360Summary(
    statusBuckets.map((bucket) => ({
      status: toStatusToken(bucket.status),
      count: bucket._count._all,
      totalMinor: bucket._sum.totalMinor ?? 0,
      paidMinor: bucket._sum.paidMinor ?? 0,
    })),
  );

  return ok(
    mapCustomerDetail(
      customer,
      summary,
      recentSales,
      recentPayments,
      mapCustomerCrm({
        openOpportunityCount: openOppCount,
        recentOpportunities: recentOpps,
        leadOrigin,
      }),
      recentGoodsDispatches,
      recentSalesOrders,
      recentSalesQuotations.map((qt) => ({
        id: qt.id,
        reference: qt.reference,
        status: qt.persistedStatus,
        effectiveStatus: qt.effectiveStatus,
        quotationDate: qt.quotationDate,
        currencyCodeAtQuotation: qt.currencyCodeAtQuotation,
        currencySymbolAtQuotation: qt.currencySymbolAtQuotation,
        decimalPrecisionAtQuotation: qt.decimalPrecisionAtQuotation,
        totalMinor: qt.totalMinor,
        totalQty: qt.totalQty,
        convertedOrderReference: qt.convertedOrderReference,
      })),
      receivablesAging,
    ),
  );
});

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const before = await loadCustomer(ctx.businessId, id);
  const input = await parseBody(req, partyUpdateSchema);

  const updated = await db.$transaction(async (tx) => {
    const c = await tx.customer.update({ where: { id: before.id }, data: input });
    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "customer.update",
        entityType: "Customer",
        entityId: c.id,
        before,
        after: c,
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
    return c;
  });

  return ok(updated);
});

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const before = await loadCustomer(ctx.businessId, id);

  await db.$transaction(async (tx) => {
    await tx.customer.update({
      where: { id: before.id },
      data: { deletedAt: new Date() },
    });
    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "customer.delete",
        entityType: "Customer",
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
