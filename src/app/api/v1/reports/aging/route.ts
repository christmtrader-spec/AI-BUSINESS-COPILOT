/**
 * GET /api/v1/reports/aging — receivables/payables AGING (§2 row 15).
 *
 * Server-authoritative aggregation over ALL open items (≤ AGING_SCAN_CAP per
 * side). Anchors: receivables → issueDate; payables → dueDate ?? spentAt.
 * Day math in the business timezone (A07); integer minor units only (A08).
 * Response shape: { ok, data: { generatedAt, timezone, asOf, truncated,
 * receivables, payables } } — the standard API envelope.
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { db } from "@/lib/db";
import {
  AGING_SCAN_CAP,
  buildAgingSide,
  localDayKey,
  type AgingItem,
} from "@/lib/aging";

export const dynamic = "force-dynamic";

export const GET = route(async (_req: NextRequest) => {
  const ctx = await getAuthContext(_req);
  requirePermission(ctx, "data:read");

  const business = await db.business.findUnique({
    where: { id: ctx.businessId },
    select: { timezone: true },
  });
  const tz = business?.timezone || "UTC";
  const now = new Date();

  const [sales, expenses] = await Promise.all([
    db.sale.findMany({
      where: { businessId: ctx.businessId, deletedAt: null, status: { not: "PAID" } },
      orderBy: { issueDate: "asc" },
      take: AGING_SCAN_CAP,
      select: {
        totalMinor: true,
        paidMinor: true,
        issueDate: true,
        customer: { select: { name: true } },
      },
    }),
    db.expense.findMany({
      where: { businessId: ctx.businessId, deletedAt: null, status: { not: "PAID" } },
      orderBy: { spentAt: "asc" },
      take: AGING_SCAN_CAP,
      select: {
        amountMinor: true,
        paidMinor: true,
        spentAt: true,
        dueDate: true,
        supplier: { select: { name: true } },
      },
    }),
  ]);

  const receivableItems: AgingItem[] = sales.map((s) => ({
    anchor: s.issueDate,
    balanceMinor: s.totalMinor - s.paidMinor,
    party: s.customer?.name ?? null,
  }));

  const payableItems: AgingItem[] = expenses.map((e) => ({
    anchor: e.dueDate ?? e.spentAt,
    balanceMinor: e.amountMinor - e.paidMinor,
    party: e.supplier?.name ?? null,
    dueDate: e.dueDate,
  }));

  const receivables = buildAgingSide(receivableItems, { timeZone: tz, now });
  const payables = buildAgingSide(payableItems, { timeZone: tz, now, withPastDue: true });

  return ok({
    generatedAt: now.toISOString(),
    timezone: tz,
    asOf: localDayKey(now, tz),
    truncated: sales.length >= AGING_SCAN_CAP || expenses.length >= AGING_SCAN_CAP,
    receivables,
    payables,
  });
});
