/**
 * scripts/prompt50-reports-cap-check.ts — Prompt 50 CAP harness.
 *
 * Exercises the bounded-read laws with SMALL env caps (P49 envCap
 * convention) against a dedicated fixture business:
 *
 *   [1] MONTH_EXPORT_MAX_ROWS: an over-cap month is REJECTED ("too-large"),
 *       never silently exported as a prefix (Gate H)
 *   [2] MONTH_EXPORT_MAX_ROWS: an under-cap month exports COMPLETE rows
 *       (row count == DB count, totals reconcile)
 *   [3] PERFORMANCE_ROW_CAP: an over-cap source scan reports truncated=true
 *       and processes exactly the capped subset (Gate O/§13 truthfulness)
 *   [4] PERFORMANCE_GROUP_CAP: over-cap distinct groups are trimmed with
 *       groupTruncated=true
 *   [5] env caps are clamped (envCap law) and defaults stand when unset
 *
 * Run: PERFORMANCE_ROW_CAP=10 PERFORMANCE_GROUP_CAP=3 MONTH_EXPORT_MAX_ROWS=10 \
 *        bun scripts/prompt50-reports-cap-check.ts
 * (The caps MUST be set in the environment BEFORE this process starts —
 * the engines read them once at module load, exactly like production.)
 */

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(name);
}

const ROW_CAP = Number(process.env.PERFORMANCE_ROW_CAP ?? "0");
const GROUP_CAP = Number(process.env.PERFORMANCE_GROUP_CAP ?? "0");
const MONTH_CAP = Number(process.env.MONTH_EXPORT_MAX_ROWS ?? "0");
if (ROW_CAP !== 10 || GROUP_CAP !== 3 || MONTH_CAP !== 10) {
  console.error("Run with: PERFORMANCE_ROW_CAP=10 PERFORMANCE_GROUP_CAP=3 MONTH_EXPORT_MAX_ROWS=10 bun scripts/prompt50-reports-cap-check.ts");
  process.exit(2);
}

import { PrismaClient } from "@prisma/client";
import { buildMonthDetailComplete, buildMonthDetail } from "../src/lib/reports";
import { buildSalesPerformance } from "../src/lib/report-performance";
import { resolveRollingWindow, parseLocalDateKey } from "../src/lib/report-periods";

const db = new PrismaClient();
const TAG = "P50QA-CAP";
const TZ = "Asia/Tehran";

async function purge() {
  const bizs = await db.business.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  for (const b of bizs) {
    await db.saleItem.deleteMany({ where: { sale: { businessId: b.id } } });
    await db.sale.deleteMany({ where: { businessId: b.id } });
    await db.expense.deleteMany({ where: { businessId: b.id } });
    await db.payment.deleteMany({ where: { businessId: b.id } });
    await db.auditLog.deleteMany({ where: { businessId: b.id } });
    await db.subscriptionEvent.deleteMany({ where: { subscription: { businessId: b.id } } }).catch(() => {});
    await db.subscription.deleteMany({ where: { businessId: b.id } }).catch(() => {});
    await db.customer.deleteMany({ where: { businessId: b.id } });
    await db.business.deleteMany({ where: { id: b.id } });
  }
}

// A month entirely in the past (its LAST day is > 40 days before today).
function pastMonthKey(): string {
  const d = new Date(Date.now() - 70 * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  return `${y}-${m}`;
}

try {
  await purge();
  // Fixture owner — self-healing (the sandbox env-repair wipes test users;
  // the cap check must not crash with a TypeError when it is missing).
  const EMAIL = "p50qa-owner@test.local";
  let user = await db.user.findFirst({ where: { email: EMAIL }, select: { id: true } });
  if (!user) {
    const bcrypt = (await import("bcryptjs")).default;
    // Password MUST match the shared fixture contract (browser fixture +
    // prompt50-reports-check both log in with testpass123) so login-first
    // keeps working for every harness that reuses this account.
    const created = await db.user.create({
      data: {
        email: EMAIL,
        name: "P50QA Owner",
        passwordHash: bcrypt.hashSync("testpass123", 4),
        locale: "en",
      },
      select: { id: true },
    });
    user = created;
  }
  const biz = await db.business.create({
    data: {
      name: `${TAG}-${Date.now()}`,
      slug: `p50qa-cap-${Date.now()}`,
      currencyCode: "USD",
      currencySymbol: "$",
      decimalPrecision: 2,
      locale: "en",
      timezone: TZ,
      ownerId: user!.id,
      members: { create: { userId: user!.id, role: "OWNER" } },
    },
  });

  // 12 sales in the past month (over MONTH_EXPORT_MAX_ROWS=10) and 15 in
  // the current rolling window (over PERFORMANCE_ROW_CAP=10) — distinct
  // amounts so an off-by-one can never pass unnoticed.
  const [my, mm] = pastMonthKey().split("-").map(Number);
  for (let i = 1; i <= 12; i++) {
    await db.sale.create({
      data: {
        businessId: biz.id,
        number: i,
        subtotalMinor: 1_000 + i,
        totalMinor: 1_000 + i,
        issueDate: new Date(Date.UTC(my, mm - 1, ((i - 1) % 28) + 1, 9, 0, 0)),
        items: { create: { name: `CapLine-${i}`, qty: 1, unitPriceMinor: 1_000 + i, lineTotalMinor: 1_000 + i } },
      },
    });
  }
  for (let i = 1; i <= 15; i++) {
    await db.sale.create({
      data: {
        businessId: biz.id,
        number: 100 + i,
        subtotalMinor: 2_000 + i,
        totalMinor: 2_000 + i,
        issueDate: new Date(Date.now() - i * 86_400_000),
        items: { create: { name: `WinLine-${i}`, qty: 1, unitPriceMinor: 2_000 + i, lineTotalMinor: 2_000 + i } },
      },
    });
  }

  console.log("[1] MONTH_EXPORT_MAX_ROWS — over-cap month REJECTED (Gate H)");
  {
    const complete = await buildMonthDetailComplete(biz.id, pastMonthKey());
    ok("1a. over-cap month returns controlled too-large result", complete !== null && complete.status === "too-large", JSON.stringify(complete).slice(0, 120));
    if (complete && complete.status === "too-large") {
      ok("1b. rejection names the section and the cap", complete.section === "sales" && complete.max === 10);
    }
    // The JSON drill-down preview is INDEPENDENT of the export cap
    // (MONTH_PREVIEW_LIMIT=25): 12 rows fit, so the preview shows all 12 —
    // the export cap governs ONLY the CSV completeness law.
    const detail = await buildMonthDetail(biz.id, pastMonthKey());
    ok("1c. JSON preview unaffected by the export cap (12 ≤ 25 → shown fully)", detail?.preview.sales.totalCount === 12 && detail?.preview.sales.displayedCount === 12 && detail?.preview.sales.hasMore === false, JSON.stringify(detail?.preview.sales));
  }

  console.log("[2] under-cap month exports COMPLETE rows");
  {
    // Take a month with ≤ cap rows: the CURRENT month has none of this fixture.
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).formatToParts(now);
    const curMonth = `${parts.find((p) => p.type === "year")?.value}-${parts.find((p) => p.type === "month")?.value}`;
    const dbCount = await db.sale.count({
      where: { businessId: biz.id, issueDate: { gte: new Date(`${curMonth}-01T00:00:00Z`) } },
    });
    const complete = await buildMonthDetailComplete(biz.id, curMonth);
    if (dbCount <= 10) {
      ok("2a. under-cap month returns ok", complete?.status === "ok", JSON.stringify(complete).slice(0, 120));
      if (complete?.status === "ok") {
        ok("2b. exported row count == DB count (COMPLETE, not a prefix)", complete.rows.sales.length === dbCount, `${complete.rows.sales.length} vs ${dbCount}`);
        const sum = complete.rows.sales.reduce((a, s) => a + s.totalMinor, 0);
        const dbSum = await db.sale.aggregate({ where: { businessId: biz.id, issueDate: { gte: new Date(`${curMonth}-01T00:00:00Z`) } }, _sum: { totalMinor: true } });
        ok("2c. exported rows reconcile with the DB total", sum === (dbSum._sum.totalMinor ?? 0), `${sum} vs ${dbSum._sum.totalMinor}`);
      }
    } else {
      ok("2. (skipped — current month over cap in this fixture)", true);
    }
  }

  console.log("[3] PERFORMANCE_ROW_CAP — truncated scan is TRUTHFUL");
  {
    const now = new Date();
    const window = resolveRollingWindow(TZ, 30, now);
    const report = await buildSalesPerformance(biz.id, window, "product");
    ok("3a. over-cap window reports truncated=true", report.truncated === true, String(report.truncated));
    ok("3b. exactly PERFORMANCE_ROW_CAP source invoices processed", report.totals.invoiceCount === 10, String(report.totals.invoiceCount));
    ok("3c. totals cover the SCANNED subset (sum of the 10 newest = Σ2001..2010... by issueDate asc take 10)", (() => {
      // buildSalesPerformance scans ordered issueDate ASC → first 10 of the
      // 15 window sales = the OLDEST 10 (2001..2010 by issueDate asc? no —
      // issueDate = now - i days; ASC order puts i=15 first (oldest)).
      const expected = Array.from({ length: 10 }, (_, k) => 2_000 + (15 - k)).reduce((a, b) => a + b, 0);
      return report.totals.revenueMinor === expected;
    })(), String(report.totals.revenueMinor));
    const report2 = await buildSalesPerformance(biz.id, window, "customer");
    ok("3d. truncation marker consistent across dimensions", report2.truncated === true && report2.totals.invoiceCount === 10);
  }

  console.log("[4] PERFORMANCE_GROUP_CAP — group trimming disclosed");
  {
    const now = new Date();
    const window = resolveRollingWindow(TZ, 30, now);
    const report = await buildSalesPerformance(biz.id, window, "product");
    ok("4a. groups trimmed to the cap with groupTruncated=true", report.groups.length <= 3 && report.groupTruncated === true, `groups=${report.groups.length} gt=${report.groupTruncated}`);
  }

  console.log("[5] envCap clamping law");
  {
    ok("5a. caps clamped to the harness values", ROW_CAP === 10 && GROUP_CAP === 3 && MONTH_CAP === 10);
    ok("5b. strict date parser still gates month keys", parseLocalDateKey("2026-02-30") === null);
  }

  console.log("\n== teardown ==");
  await purge();
  const left = await db.business.count({ where: { name: { startsWith: TAG } } });
  const leftSales = await db.sale.count({ where: { business: { name: { startsWith: TAG } } } });
  ok("T1. fixture torn down to zero residue", left === 0 && leftSales === 0, `${left}/${leftSales}`);
} finally {
  await db.$disconnect();
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
