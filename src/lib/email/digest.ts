import "server-only";

/**
 * Weekly email digest builder (Task 2-b F9) — OPERATOR-SCHEDULED pattern.
 *
 * This module NEVER schedules and NEVER sends on its own: it is a pure
 * read-only builder called by
 *   - scripts/send-weekly-digest.mjs (operator cron — weekly, e.g. Monday
 *     08:00 UTC; the OS owns the schedule, there is NO in-process timer),
 *   - the digest-preview API route (owner preview; never sends).
 * It follows src/lib/crm/task-reminder-processor.ts's law: deterministic
 * queries, injected clock for tests, bounded reads, no request-lifecycle
 * wiring.
 *
 * Money law (A08): every figure is INTEGER MINOR UNITS end-to-end. Aggregates
 * sum minor units; the ONLY conversion is display formatting through
 * src/lib/money.ts (formatMoney → fromMinor(business.decimalPrecision)).
 *
 * Honesty law: the email states the exact UTC window and "computed at"
 * timestamp, shows real zeros when there was no activity, and carries a
 * footer noting it is an informational summary — NOT a financial statement.
 * No figures are ever invented (e.g. no "projected" or "avg" fillers).
 *
 * Window: last 7 days, UTC half-open interval [now − 7d, now) — matching the
 * reports engine's window conventions (sale.issueDate / expense.spentAt /
 * payment.paidAt, soft-delete filtered).
 */

import { db } from "@/lib/db";
import { formatMoney, type CurrencyConfig } from "@/lib/money";

export const DIGEST_WINDOW_DAYS = 7;

export type WeeklyDigestStats = {
  /** ISO timestamps of the half-open UTC window [start, end). */
  windowStart: string;
  windowEnd: string;
  /** When the digest was computed (ISO) — shown as "last computed". */
  computedAt: string;
  /** Invoices issued in the window (soft-delete filtered). */
  salesCount: number;
  /** SUM(totalMinor) of those invoices. */
  salesTotalMinor: number;
  /** SUM(amountMinor) of IN payments received in the window. */
  collectedMinor: number;
  /** SUM(amountMinor) of expenses recorded in the window. */
  expensesMinor: number;
  /** Open receivables: SUM(totalMinor − paidMinor) over status != PAID. */
  receivablesMinor: number;
  /** How many invoices are currently open (status != PAID). */
  receivablesCount: number;
  /** Products at/below their own low-stock threshold (whole snapshot). */
  lowStockCount: number;
  /** First 5 low-stock product names (deterministic name order). */
  lowStockNames: string[];
  /** Best-selling item in the window by line total, or null. */
  topProduct: { name: string; revenueMinor: number } | null;
};

export type WeeklyDigest = {
  business: {
    id: string;
    name: string;
    locale: string;
    currencyCode: string;
    currencySymbol: string;
    decimalPrecision: number;
  };
  /** Owner email (the digest recipient). Empty when the owner has no email. */
  ownerEmail: string;
  ownerName: string | null;
  /** Email language — the BUSINESS locale ("fa" → RTL Persian layout). */
  locale: "en" | "fa";
  subject: string;
  html: string;
  text: string;
  stats: WeeklyDigestStats;
  /** Server-formatted money strings (business currency config + locale). */
  formatted: {
    revenue: string;
    collected: string;
    expenses: string;
    receivables: string;
    topProductRevenue: string;
  };
};

/** Minimal HTML escaper — identical discipline to email/index.ts templates. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function integerAdd(...values: number[]): number {
  return values.reduce<number>((acc, v) => {
    if (!Number.isInteger(v)) throw new Error("Digest money must be integer minor units");
    return acc + v;
  }, 0);
}

/**
 * Build the weekly digest for ONE business. Read-only: no sends, no writes,
 * no scheduling. Throws a plain Error when the business does not exist (the
 * caller — script or preview route — decides how to surface it).
 */
export async function buildWeeklyDigest(
  businessId: string,
  opts: { now?: Date } = {},
): Promise<WeeklyDigest> {
  const now = opts.now ?? new Date(); // injected clock for tests (§182 spirit)
  const windowStart = new Date(now.getTime() - DIGEST_WINDOW_DAYS * 86_400_000);

  const business = await db.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      name: true,
      locale: true,
      currencyCode: true,
      currencySymbol: true,
      decimalPrecision: true,
      ownerId: true,
    },
  });
  if (!business) {
    // Caller error, not a partial digest — never build for a ghost tenant.
    throw new Error("digest: business not found");
  }
  const owner = await db.user.findUnique({
    where: { id: business.ownerId },
    select: { email: true, name: true },
  });

  // Window aggregates — parallel, all business-scoped (A01/A02), soft-delete
  // filtered, mirroring src/lib/reports.ts query conventions exactly.
  const [salesInWindow, collectedInWindow, expensesInWindow, openReceivables, products, topItems] =
    await Promise.all([
      db.sale.aggregate({
        where: {
          businessId,
          deletedAt: null,
          issueDate: { gte: windowStart, lt: now },
        },
        _count: true,
        _sum: { totalMinor: true },
      }),
      db.payment.aggregate({
        where: {
          businessId,
          direction: "IN",
          paidAt: { gte: windowStart, lt: now },
        },
        _sum: { amountMinor: true },
      }),
      db.expense.aggregate({
        where: {
          businessId,
          deletedAt: null,
          spentAt: { gte: windowStart, lt: now },
        },
        _sum: { amountMinor: true },
      }),
      // Open receivables = SUM(total) − SUM(paid) over open invoices — exact
      // integer math via two aggregates (no row streaming, no floats).
      db.sale.aggregate({
        where: { businessId, deletedAt: null, status: { not: "PAID" } },
        _count: true,
        _sum: { totalMinor: true, paidMinor: true },
      }),
      // Low stock needs the per-row threshold comparison (stockQty ≤
      // lowStockAt) — same minimal-select scan the reports engine uses.
      db.product.findMany({
        where: { businessId, deletedAt: null },
        select: { name: true, stockQty: true, lowStockAt: true },
        orderBy: { name: "asc" },
      }),
      db.saleItem.groupBy({
        by: ["name"],
        where: {
          sale: {
            businessId,
            deletedAt: null,
            issueDate: { gte: windowStart, lt: now },
          },
        },
        _sum: { lineTotalMinor: true },
        orderBy: { _sum: { lineTotalMinor: "desc" } },
        take: 1,
      }),
    ]);

  const lowStock = products
    .filter((p) => p.stockQty <= p.lowStockAt)
    .map((p) => p.name);

  const stats: WeeklyDigestStats = {
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    computedAt: now.toISOString(),
    salesCount: salesInWindow._count,
    salesTotalMinor: integerAdd(salesInWindow._sum.totalMinor ?? 0),
    collectedMinor: integerAdd(collectedInWindow._sum.amountMinor ?? 0),
    expensesMinor: integerAdd(expensesInWindow._sum.amountMinor ?? 0),
    receivablesMinor: integerAdd(
      openReceivables._sum.totalMinor ?? 0,
      -(openReceivables._sum.paidMinor ?? 0),
    ),
    receivablesCount: openReceivables._count,
    lowStockCount: lowStock.length,
    lowStockNames: lowStock.slice(0, 5),
    topProduct:
      topItems.length > 0 && topItems[0]._sum.lineTotalMinor !== null
        ? { name: topItems[0].name, revenueMinor: integerAdd(topItems[0]._sum.lineTotalMinor ?? 0) }
        : null,
  };

  const locale: "en" | "fa" = business.locale === "fa" ? "fa" : "en";
  const fa = locale === "fa";
  const currencyConfig: CurrencyConfig = {
    currencyCode: business.currencyCode,
    currencySymbol: business.currencySymbol,
    decimalPrecision: business.decimalPrecision,
    locale,
  };
  const fmt = (minor: number) => formatMoney(minor, currencyConfig);

  const formatted = {
    revenue: fmt(stats.salesTotalMinor),
    collected: fmt(stats.collectedMinor),
    expenses: fmt(stats.expensesMinor),
    receivables: fmt(stats.receivablesMinor),
    topProductRevenue: stats.topProduct ? fmt(stats.topProduct.revenueMinor) : "—",
  };

  const subject = fa
    ? `${business.name} — خلاصه هفتگی`
    : `${business.name} — Weekly digest`;

  // Deterministic UTC date-only labels for the disclosure footer.
  const startDate = stats.windowStart.slice(0, 10);
  const endDate = stats.windowEnd.slice(0, 10);
  const computedAt = stats.computedAt;

  const rows: Array<{ label: string; value: string }> = [
    { label: fa ? "تعداد فاکتور" : "Invoices", value: String(stats.salesCount) },
    { label: fa ? "درآمد" : "Revenue", value: formatted.revenue },
    { label: fa ? "دریافتی" : "Collected", value: formatted.collected },
    { label: fa ? "هزینه‌ها" : "Expenses", value: formatted.expenses },
    {
      label: fa
        ? `مطالبات باز (${stats.receivablesCount} فاکتور)`
        : `Open receivables (${stats.receivablesCount} invoices)`,
      value: formatted.receivables,
    },
    {
      label: fa
        ? `کالاهای رو به اتمام (${stats.lowStockCount})`
        : `Low-stock items (${stats.lowStockCount})`,
      value:
        stats.lowStockNames.length > 0
          ? stats.lowStockNames.map((n) => escapeHtml(n)).join("، ")
          : fa
            ? "موردی نیست"
            : "none",
    },
    {
      label: fa ? "پرفروش‌ترین" : "Top product",
      value: stats.topProduct
        ? `${escapeHtml(stats.topProduct.name)} — ${formatted.topProductRevenue}`
        : fa
          ? "موردی نیست"
          : "none",
    },
  ];

  const windowLine = fa
    ? `بازه: ${startDate} تا ${endDate} (UTC)`
    : `Window: ${startDate} to ${endDate} (UTC)`;

  const disclosure = fa
    ? `این خلاصه فقط اطلاع‌رسانی است و صورت مالی رسمی نیست. آمار مربوط به ${DIGEST_WINDOW_DAYS} روز گذشته (UTC) است و در ${computedAt} محاسبه شده.`
    : `This summary is informational and is not a financial statement. Figures cover the last ${DIGEST_WINDOW_DAYS} days (UTC) and were computed at ${computedAt}.`;

  const textRows = rows.map((r) => `${r.label}: ${r.value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")}`);

  const text = fa
    ? [
        `${business.name} — خلاصه هفتگی`,
        "",
        windowLine,
        "",
        ...textRows,
        "",
        disclosure,
      ].join("\n")
    : [
        `${business.name} — Weekly digest`,
        "",
        windowLine,
        "",
        ...textRows,
        "",
        disclosure,
      ].join("\n");

  // Structure/style mirrors buildPasswordResetEmail (email/index.ts):
  // 520px card, system-ui stack, RTL <html dir> for fa, escaped values only.
  const tableRowsHtml = rows
    .map(
      (r) =>
        `<tr><td style="padding:8px 12px;font-size:13px;color:#374151;border-top:1px solid #e5e7eb;">${r.label}</td>` +
        `<td style="padding:8px 12px;font-size:13px;color:#111827;border-top:1px solid #e5e7eb;text-align:${fa ? "left" : "right"};font-variant-numeric:tabular-nums;" dir="ltr">${r.value}</td></tr>`,
    )
    .join("");

  const html = `<!doctype html><html dir="${fa ? "rtl" : "ltr"}" lang="${fa ? "fa" : "en"}"><body style="font-family:system-ui,-apple-system,Segoe UI,Tahoma,sans-serif;background:#f6f7f9;padding:24px;">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;padding:28px;">
  <h1 style="font-size:18px;margin:0 0 12px;">${escapeHtml(subject)}</h1>
  <p style="font-size:14px;line-height:1.7;color:#374151;">${fa
    ? `خلاصه هفتگی کسب‌وکار شما برای ${escapeHtml(business.name)}.`
    : `Your weekly business summary for ${escapeHtml(business.name)}.`}</p>
  <p style="font-size:12px;line-height:1.7;color:#6b7280;" dir="ltr">${escapeHtml(windowLine)}</p>
  <table style="width:100%;border-collapse:collapse;margin:16px 0;" role="presentation">
    ${tableRowsHtml}
  </table>
  <p style="font-size:12px;line-height:1.7;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:12px;margin-top:18px;">${escapeHtml(disclosure)}</p>
</div>
</body></html>`;

  return {
    business: {
      id: business.id,
      name: business.name,
      locale: business.locale,
      currencyCode: business.currencyCode,
      currencySymbol: business.currencySymbol,
      decimalPrecision: business.decimalPrecision,
    },
    ownerEmail: owner?.email ?? "",
    ownerName: owner?.name ?? null,
    locale,
    subject,
    html,
    text,
    stats,
    formatted,
  };
}
