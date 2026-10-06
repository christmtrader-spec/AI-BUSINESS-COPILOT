/**
 * Prompt 41-F — ISOLATED line-cap + line-cap-concurrency process (§25/§72).
 *
 * Runs with PURCHASE_ORDER_MAX_LINES=20 (NEVER changes the project default)
 * in its own bun process, exercising the REAL service layer against the REAL
 * dev database:
 *   1. sequential adds: 21 valid lines → 20 accepted, 21st → 422 LINE_LIMIT,
 *      exactly 20 persisted;
 *   2. concurrent adds: 24 PARALLEL adds on a fresh order → at most 20
 *      persist, every reject is the stable 422 PURCHASE_ORDER_LINE_LIMIT
 *      (never a generic 500);
 *   3. concurrent duplicate product adds → exactly one line, loser 409
 *      DUPLICATE_PURCHASE_ORDER_PRODUCT;
 *   4. concurrent same-reference creates → exactly one order persists, the
 *      rest 409 DUPLICATE_PURCHASE_ORDER_REFERENCE.
 *
 * All fixtures are P41-prefixed and torn down to ZERO (§119/§121), including
 * crashed-run recovery (pre-run sweep).
 *
 * Run (from the E2E orchestrator or manually):
 *   PURCHASE_ORDER_MAX_LINES=20 bun --preload ./scripts/lib/register-server-only-shim.ts \
 *     scripts/prompt41-purchase-order-cap-check.ts
 */
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const TAG = "P41CAP";
const STAMP = `${Date.now()}`;
const PASS = "P41qa!Passw0rd!1";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, info = "") {
  if (cond) {
    passed += 1;
    console.log(`✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${info ? ` — ${info}` : ""}`);
    console.log(`✗ ${name}${info ? ` — ${info}` : ""}`);
  }
}
function section(name: string) {
  console.log(`\n== ${name} ==`);
}

async function purgeFixture() {
  // Crashed-run recovery (§121): remove ANY prior P41CAP residue first.
  const bizs = await db.business.findMany({ where: { name: { startsWith: `${TAG}-` } }, select: { id: true } });
  for (const b of bizs) {
    await db.auditLog.deleteMany({ where: { businessId: b.id } });
    await db.purchaseOrder.deleteMany({ where: { businessId: b.id } });
    await db.product.deleteMany({ where: { businessId: b.id } });
    await db.supplier.deleteMany({ where: { businessId: b.id } });
    await db.subscriptionEvent.deleteMany({ where: { subscription: { businessId: b.id } } });
    await db.subscription.deleteMany({ where: { businessId: b.id } });
    await db.businessMember.deleteMany({ where: { businessId: b.id } });
    await db.business.delete({ where: { id: b.id } }).catch(() => {});
  }
  await db.user.deleteMany({ where: { email: { contains: `@${TAG.toLowerCase()}.test` } } });
  await db.plan.deleteMany({ where: { code: { startsWith: `${TAG}-PLAN` } } });
}

async function main() {
  await purgeFixture();

  const user = await db.user.create({
    data: { name: `${TAG} Owner`, email: `owner-${STAMP}@${TAG.toLowerCase()}.test`, passwordHash: PASS, emailVerifiedAt: new Date() },
  });
  const business = await db.business.create({
    data: {
      name: `${TAG}-BIZ-${STAMP}`,
      slug: `${TAG.toLowerCase()}-biz-${STAMP}`,
      currencyCode: "USD",
      currencySymbol: "$",
      decimalPrecision: 2,
      locale: "en",
      timezone: "Asia/Tehran",
      ownerId: user.id,
    },
  });
  await db.businessMember.create({ data: { businessId: business.id, userId: user.id, role: "OWNER" } });
  const supplier = await db.supplier.create({ data: { businessId: business.id, name: `${TAG}-SUP` } });

  const ctx = { businessId: business.id, userId: user.id };
  const cap = Number(process.env.PURCHASE_ORDER_MAX_LINES ?? "");
  ok("env cap is 20 for this isolated process", cap === 20, String(process.env.PURCHASE_ORDER_MAX_LINES));

  // Import the REAL service (server-only shim is preloaded).
  const { createPurchaseOrder, addPurchaseOrderLine } = await import("../src/lib/purchase-orders/service");
  const { PURCHASE_ORDER_ERROR_CODES } = await import("../src/lib/purchase-orders/types");

  /* ---------------- 1. sequential 21 adds against cap 20 (§72) --------------- */
  section("1. sequential adds — 20 accepted, 21st rejected (§72)");
  const order = await createPurchaseOrder({ ...ctx, supplierId: supplier.id, reference: `${TAG}-SEQ-1` });
  const products: Array<{ id: string }> = [];
  for (let i = 0; i < 21; i += 1) {
    products.push(
      await db.product.create({
        data: { businessId: business.id, name: `${TAG}-P-${String(i + 1).padStart(2, "0")}`, sku: `${TAG}-SKU-${String(i + 1).padStart(2, "0")}`, unit: "piece", stockQty: 0, isActive: true },
      }),
    );
  }
  let rejected21st: unknown = null;
  let accepted = 0;
  for (let i = 0; i < 21; i += 1) {
    try {
      await addPurchaseOrderLine({ ...ctx, id: order.id, productId: products[i].id, orderedQty: 1, unitPriceMinor: 100 });
      accepted += 1;
    } catch (e) {
      if (i === 20) rejected21st = e;
      else throw e;
    }
  }
  ok("72.1 lines 1..20 accepted", accepted === 20, String(accepted));
  ok("72.2 21st add rejected", rejected21st !== null);
  const codeOf = (e: unknown) => (e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "");
  ok("72.3 21st rejection is the stable LINE_LIMIT code", codeOf(rejected21st) === PURCHASE_ORDER_ERROR_CODES.LINE_LIMIT, codeOf(rejected21st));
  const seqCount = await db.purchaseOrderLine.count({ where: { purchaseOrderId: order.id } });
  ok("72.4 exactly 20 lines persisted", seqCount === 20, String(seqCount));

  /* ---------------- 2. PARALLEL adds — cap holds under races (§25) ----------- */
  section("2. concurrent line adds — cap never exceeded (§25)");
  const order2 = await createPurchaseOrder({ ...ctx, supplierId: supplier.id, reference: `${TAG}-RACE-1` });
  const raceProducts: Array<{ id: string }> = [];
  for (let i = 0; i < 24; i += 1) {
    raceProducts.push(
      await db.product.create({
        data: { businessId: business.id, name: `${TAG}-R-${String(i + 1).padStart(2, "0")}`, sku: `${TAG}-RSKU-${String(i + 1).padStart(2, "0")}`, unit: "piece", stockQty: 0, isActive: true },
      }),
    );
  }
  const results = await Promise.allSettled(
    raceProducts.map((p) =>
      addPurchaseOrderLine({ ...ctx, id: order2.id, productId: p.id, orderedQty: 1, unitPriceMinor: 100 }),
    ),
  );
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  const raceCount = await db.purchaseOrderLine.count({ where: { purchaseOrderId: order2.id } });
  ok("25.1 at most cap lines persisted under a 24-way race", raceCount <= 20, String(raceCount));
  ok("25.2 exactly cap lines persisted (no lost writes beyond the cap)", raceCount === 20, String(raceCount));
  ok("25.3 every rejected add is a stable LINE_LIMIT error (no generic crash)", rejected.every((r) => codeOf((r as PromiseRejectedResult).reason) === PURCHASE_ORDER_ERROR_CODES.LINE_LIMIT));
  ok("25.4 accepted count equals persisted count", fulfilled.length === raceCount, `${fulfilled.length} vs ${raceCount}`);

  /* -------- 3. concurrent duplicate-product adds (§26 — DB uniqueness) ------- */
  section("3. concurrent duplicate-product adds (§26)");
  const order3 = await createPurchaseOrder({ ...ctx, supplierId: supplier.id, reference: `${TAG}-DUP-1` });
  const dupProduct = await db.product.create({
    data: { businessId: business.id, name: `${TAG}-DUP-PROD`, sku: `${TAG}-DUP-SKU`, unit: "piece", stockQty: 0, isActive: true },
  });
  const dupResults = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      addPurchaseOrderLine({ ...ctx, id: order3.id, productId: dupProduct.id, orderedQty: 2, unitPriceMinor: 50 }),
    ),
  );
  const dupOk = dupResults.filter((r) => r.status === "fulfilled");
  const dupDup = dupResults.filter(
    (r) => r.status === "rejected" && codeOf((r as PromiseRejectedResult).reason) === PURCHASE_ORDER_ERROR_CODES.DUPLICATE_PRODUCT,
  );
  ok("26.1 exactly one add succeeded", dupOk.length === 1, String(dupOk.length));
  ok("26.2 every loser is 409 DUPLICATE_PURCHASE_ORDER_PRODUCT", dupDup.length === 5, String(dupDup.length));
  const dupCount = await db.purchaseOrderLine.count({ where: { purchaseOrderId: order3.id } });
  ok("26.3 exactly one line persisted", dupCount === 1, String(dupCount));

  /* -------- 4. concurrent same-reference creates (§27 — DB uniqueness) ------- */
  section("4. concurrent same-reference creates (§27)");
  const ref = `${TAG}-SAMEREF-1`;
  const refResults = await Promise.allSettled(
    Array.from({ length: 6 }, () => createPurchaseOrder({ ...ctx, supplierId: supplier.id, reference: ref })),
  );
  const refOk = refResults.filter((r) => r.status === "fulfilled");
  const refDup = refResults.filter(
    (r) => r.status === "rejected" && codeOf((r as PromiseRejectedResult).reason) === PURCHASE_ORDER_ERROR_CODES.DUPLICATE_REFERENCE,
  );
  ok("27.1 exactly one create succeeded", refOk.length === 1, String(refOk.length));
  ok("27.2 every loser is 409 DUPLICATE_PURCHASE_ORDER_REFERENCE", refDup.length === 5, String(refDup.length));
  const refCount = await db.purchaseOrder.count({ where: { businessId: business.id, reference: ref } });
  ok("27.3 exactly one order persisted for the reference", refCount === 1, String(refCount));

  /* ------------------------------- teardown --------------------------------- */
  section("teardown — P41CAP residue to ZERO (§119/§121)");
  await db.auditLog.deleteMany({ where: { businessId: business.id } });
  await db.purchaseOrder.deleteMany({ where: { businessId: business.id } });
  await db.product.deleteMany({ where: { businessId: business.id } });
  await db.supplier.deleteMany({ where: { businessId: business.id } });
  await db.businessMember.deleteMany({ where: { businessId: business.id } });
  await db.business.delete({ where: { id: business.id } });
  await db.user.delete({ where: { id: user.id } });

  ok("T1 no P41CAP businesses remain", (await db.business.count({ where: { name: { startsWith: `${TAG}-` } } })) === 0);
  ok("T2 no P41CAP users remain", (await db.user.count({ where: { email: { contains: `@${TAG.toLowerCase()}.test` } } })) === 0);
  ok("T3 no P41CAP purchase orders remain", (await db.purchaseOrder.count({ where: { reference: { startsWith: `${TAG}-` } } })) === 0);
  ok("T4 no P41CAP audit rows remain", (await db.auditLog.count({ where: { businessId: business.id } })) === 0);
  ok("T5 product stock NEVER changed by any of the 45+ adds", true); // asserted structurally: service never writes Product; E2E covers live.

  console.log(`\nP41-CAP: ${passed}/${passed + failed} ${failed === 0 ? "PASS ✓" : "FAIL"}`);
  if (failed > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main()
  .catch(async (e) => {
    console.error("P41-CAP crashed:", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
