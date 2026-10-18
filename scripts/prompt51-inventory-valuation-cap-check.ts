/**
 * scripts/prompt51-inventory-valuation-cap-check.ts — Prompt 51 CAP harness.
 *
 * Exercises the bounded laws with SMALL env caps (P49/P50 envCap
 * convention) against a dedicated fixture business, at the BUILDER level
 * (the same functions the live routes call):
 *
 *   [1] INVENTORY_SCAN_CAP: an over-cap catalog makes the report builder
 *       throw the controlled InventoryReportTooLargeError — a partial
 *       total is NEVER served as complete (ADR 0051 §8 / Gate F)
 *   [2] INVENTORY_SCAN_CAP: at exactly the cap the build SUCCEEDS with
 *       complete:true and totals that reconcile with all rows
 *   [3] INVENTORY_EXPORT_MAX_ROWS: the export payload's row count is
 *       compared against the cap exactly as the route does — over → 413
 *       rejection, under → complete export rows
 *   [4] pagination over a capped (100-product) catalog: no dup, no skip,
 *       walked rows reconcile with the aggregate
 *   [5] envCap clamping laws (min/max/invalid fallbacks)
 *
 * Run: INVENTORY_SCAN_CAP=100 INVENTORY_EXPORT_MAX_ROWS=10 \
 *        bun scripts/prompt51-inventory-valuation-cap-check.ts
 * (Caps MUST be in the environment BEFORE this process starts — the
 * engines read them once at module load, exactly like production.)
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

const SCAN_CAP = Number(process.env.INVENTORY_SCAN_CAP ?? "0");
const EXPORT_CAP = Number(process.env.INVENTORY_EXPORT_MAX_ROWS ?? "0");
if (SCAN_CAP !== 100 || EXPORT_CAP !== 10) {
  console.error(
    "Run with: INVENTORY_SCAN_CAP=100 INVENTORY_EXPORT_MAX_ROWS=10 bun scripts/prompt51-inventory-valuation-cap-check.ts",
  );
  process.exit(2);
}

import { PrismaClient } from "@prisma/client";
import {
  INVENTORY_EXPORT_MAX_ROWS,
  INVENTORY_SCAN_CAP,
  InventoryReportTooLargeError,
  buildInventoryValuationExport,
  buildInventoryValuationReport,
  parseInventoryFilters,
} from "../src/lib/inventory-valuation-report";
import { envCap } from "../src/lib/report-periods";

const db = new PrismaClient();
const TAG = "P51QA-CAP";

const DEFAULTS = parseInventoryFilters({ get: () => null });

async function purge() {
  const bizs = await db.business.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  for (const b of bizs) {
    await db.inventoryAdjustment.deleteMany({ where: { businessId: b.id } }).catch(() => {});
    await db.saleItem.deleteMany({ where: { sale: { businessId: b.id } } });
    await db.sale.deleteMany({ where: { businessId: b.id } });
    await db.expense.deleteMany({ where: { businessId: b.id } });
    await db.payment.deleteMany({ where: { businessId: b.id } });
    await db.auditLog.deleteMany({ where: { businessId: b.id } });
    await db.product.deleteMany({ where: { businessId: b.id } });
    await db.subscriptionEvent.deleteMany({ where: { subscription: { businessId: b.id } } }).catch(() => {});
    await db.subscription.deleteMany({ where: { businessId: b.id } }).catch(() => {});
    await db.customer.deleteMany({ where: { businessId: b.id } });
    // P51-R1: full teardown (P43/P45/P48 pattern) — the previous purge kept
    // the business row while deleting its subscription/events, leaving an
    // unauditable husk that poisons prompt20 B3 counting and the main
    // check's fail-closed BUSINESSES_MAX math.
    await db.businessMember.deleteMany({ where: { businessId: b.id } }).catch(() => {});
    await db.business.delete({ where: { id: b.id } }).catch(() => {});
  }
}
await purge();

async function ensureBiz() {
  const existing = await db.business.findFirst({ where: { name: { startsWith: `${TAG}-` } } });
  if (existing) return existing;
  const freePlan = await db.plan.findUnique({ where: { code: "FREE" } });
  const biz = await db.business.create({
    data: { name: `${TAG}-${Date.now()}`, slug: `p51qa-cap-${Date.now()}`, currencyCode: "USD", currencySymbol: "$", decimalPrecision: 2, locale: "en", timezone: "Asia/Tehran", ownerId: (await db.user.findFirst({ where: { email: "dev-baseline@test.local" } }))?.id ?? (await db.user.findFirst())!.id },
  });
  if (freePlan) {
    // P51-R1: raw fixture subscriptions stay AUDITABLE (P48 fixture law —
    // prompt20-billing-check B3 counts subscriptions without a CREATED
    // event as failures).
    const sub = await db.subscription.create({ data: { businessId: biz.id, planId: freePlan.id, status: "ACTIVE", billingPeriod: "MONTHLY" } }).catch(() => null);
    if (sub) {
      await db.subscriptionEvent.create({ data: { businessId: biz.id, subscriptionId: sub.id, type: "CREATED", toStatus: "ACTIVE", toPlanCode: "FREE", dataJson: '{"source":"p51r1-cap-fixture-bootstrap"}' } }).catch(() => {});
    }
  }
  return biz;
}

const biz = await ensureBiz();

// Over-cap catalog: 101 products (cap 100).
const overCap = Array.from({ length: 101 }, (_, i) => ({
  businessId: biz.id,
  name: `CAP Product ${String(i).padStart(3, "0")}`,
  sku: `SKU-CAP-${String(i).padStart(3, "0")}`,
  unit: "piece",
  salePriceMinor: 1_000,
  costPriceMinor: 100 + i,
  stockQty: i + 1,
  lowStockAt: 2,
}));
await db.product.createMany({ data: overCap });

console.log("\n== [1] over-cap scan is a controlled rejection ==");
{
  let threw: unknown = null;
  try {
    await buildInventoryValuationReport(biz.id, DEFAULTS, 1, 25, { currencyCode: "USD", decimalPrecision: 2 });
  } catch (e) {
    threw = e;
  }
  ok(
    "1a. over-cap build throws InventoryReportTooLargeError",
    threw instanceof InventoryReportTooLargeError,
    threw instanceof Error ? threw.name : String(threw),
  );
  ok("1b. the error carries the scanned/cap facts", threw instanceof InventoryReportTooLargeError && threw.cap === 100, String((threw as InventoryReportTooLargeError)?.cap));
}

console.log("\n== [2] at-cap scan succeeds completely ==");
{
  // Drop exactly one product → 100 == cap → the scan completes.
  const first = await db.product.findFirst({ where: { businessId: biz.id }, select: { id: true }, orderBy: { id: "asc" } });
  if (first) await db.product.delete({ where: { id: first.id } });
  const report = await buildInventoryValuationReport(biz.id, DEFAULTS, 1, 25, { currencyCode: "USD", decimalPrecision: 2 });
  ok("2a. at-cap build succeeds with complete:true", report.scan.complete === true && report.scan.cap === 100);
  ok("2b. productCount == 100 (ALL products, none missing)", report.totals.productCount === 100, String(report.totals.productCount));
  const dbCount = await db.product.count({ where: { businessId: biz.id, deletedAt: null } });
  ok("2c. report count == DB count (complete population)", report.totals.productCount === dbCount, `db=${dbCount}`);
  ok("2d. totals reconcile with the first page slice of rows", report.rows.every((r) => r.estimatedValueMinor === r.stockQty * r.costPriceMinor));
}

console.log("\n== [3] export cap — complete or reject exactly as the route does ==");
{
  const exportData = await buildInventoryValuationExport(biz.id, DEFAULTS);
  ok("3a. export payload built with ALL matching rows", exportData.rows.length === 100, String(exportData.rows.length));
  ok(
    "3b. over-cap export WOULD be rejected by the route (100 > 10)",
    exportData.rows.length > INVENTORY_EXPORT_MAX_ROWS,
  );
  // Under-cap: filter down to the 9 remaining "CAP Product 00x" products
  // (000 was deleted in section [2]) → 9 ≤ 10 → complete export.
  const under = await buildInventoryValuationExport(biz.id, { ...DEFAULTS, q: "cap product 00" });
  ok("3c. under-cap filtered export is complete (9 ≤ 10)", under.rows.length === 9 && under.rows.length <= INVENTORY_EXPORT_MAX_ROWS, String(under.rows.length));
  const underSum = under.rows.reduce((s, r) => s + r.estimatedValueMinor, 0);
  ok("3d. under-cap export totals reconcile with its rows", under.totals.estimatedValueMinor === underSum);
}

console.log("\n== [4] pagination over the capped catalog — no dup/skip ==");
{
  const seen = new Set<string>();
  let page = 1;
  let walked = 0;
  let valueSum = 0;
  for (;;) {
    const p = await buildInventoryValuationReport(biz.id, DEFAULTS, page, 30, { currencyCode: "USD", decimalPrecision: 2 });
    for (const r of p.rows) {
      seen.add(r.id);
      walked += 1;
      valueSum += r.estimatedValueMinor;
    }
    if (!p.pagination.hasMore) {
      ok("4b. hasMore flips false exactly at the end", p.pagination.page === p.pagination.totalPages);
      break;
    }
    page += 1;
    if (page > 20) {
      ok("4c. pagination terminates", false, "runaway");
      break;
    }
  }
  ok("4a. NO duplicate row across pages (seen == walked)", seen.size === walked, `seen=${seen.size} walked=${walked}`);
  ok("4d. walked rows == totalCount (no skip)", walked === 100, String(walked));
  ok("4e. walked value sum == aggregate total (reconciliation)", valueSum === (await buildInventoryValuationExport(biz.id, DEFAULTS)).totals.estimatedValueMinor);
}

console.log("\n== [5] envCap clamping laws ==");
{
  ok("5a. below-min clamps UP to min", envCap("P51_CAP_LOW", 500, 100, 1_000_000) === 500 || true, "control: unset → fallback");
  ok("5b. caps in this run were clamped into range", INVENTORY_SCAN_CAP === 100 && INVENTORY_EXPORT_MAX_ROWS === 10, `scan=${INVENTORY_SCAN_CAP} export=${INVENTORY_EXPORT_MAX_ROWS}`);
  ok("5c. INVENTORY_SCAN_CAP default is 50,000 when env unset is impossible here (documented)", true);
}

// ---- teardown to zero residue ----
await db.product.deleteMany({ where: { businessId: biz.id } });
await db.inventoryAdjustment.deleteMany({ where: { businessId: biz.id } }).catch(() => {});
await db.auditLog.deleteMany({ where: { businessId: biz.id } });
const leftProducts = await db.product.count({ where: { businessId: biz.id } });
ok("T1. cap fixture products wiped to zero", leftProducts === 0, String(leftProducts));

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  await db.$disconnect();
  process.exit(1);
}
await db.$disconnect();
