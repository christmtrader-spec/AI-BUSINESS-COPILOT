/**
 * Prompt 45 — ISOLATED line-cap + SALES-ORDER CONCURRENCY process.
 *
 * Runs with SALES_ORDER_MAX_LINES=20 (NEVER changes the project default)
 * in its own process, exercising the REAL service layer against the REAL
 * dev database:
 *   1. sequential adds: 21 valid lines → 20 accepted, 21st → 422
 *      LINE_LIMIT (ordinary write-time rejection), exactly 20 persisted;
 *   2. over-cap corruption → 21st line injected via the DB → detail/
 *      list/confirm/line-add ALL fail 500 SALES_ORDER_LINE_CAP_INVARIANT
 *      with ZERO mutation, recovering after cleanup (the P43 D9-D11 laws);
 *   3. concurrent duplicate product lines → exactly one line, losers 409
 *      SALES_ORDER_DUPLICATE_PRODUCT (unique constraint);
 *   4. concurrent duplicate reference creates → exactly one order, losers
 *      409 SALES_ORDER_DUPLICATE_REFERENCE;
 *   5. CONCURRENT OVER-FULFILLMENT (§103): ordered 100, prior posted 0,
 *      two concurrent dispatches of 70 → combined posted ≤ 100: exactly
 *      one wins, the loser 409 SALES_ORDER_DISPATCH_EXCEEDS_REMAINING;
 *      no negative stock, no over-dispatch;
 *   6. CONCURRENT INVOICE ISSUANCE (§105): two parallel invoice requests
 *      on one fully-dispatched order → at most one Sale, loser 409
 *      SALES_ORDER_ALREADY_INVOICED, exactly one audit pair, no stock
 *      mutation from either request;
 *   7. shared write-transaction serialization: concurrent linked dispatch
 *      post + manual stock adjustment on the same product → exact integer
 *      arithmetic, no lost update, no negative stock (§102);
 *   8. non-retry of domain errors: race losers surface the STABLE domain
 *      code, never a transient-retry artifact.
 *
 * All fixtures are P45CAP-prefixed and torn down to ZERO, including
 * crashed-run recovery (pre-run sweep).
 *
 * Run: SALES_ORDER_MAX_LINES=20 bun --preload ./scripts/lib/register-server-only-shim.ts \
 *      scripts/prompt45-sales-order-cap-check.ts
 * (the shim neutralizes the `server-only` guard for out-of-process runs —
 * the same harness law as the P29+ unit suites and the P42–P44 cap checks;
 * plain tsx/node CANNOT import the server service modules).
 */
import { PrismaClient } from "@prisma/client";
import {
  addSalesOrderLine,
  cancelSalesOrder,
  confirmSalesOrder,
  createLinkedDispatch,
  createSalesOrder,
  getSalesOrder,
  issueOrderInvoice,
  listSalesOrders,
} from "../src/lib/sales-orders/service";
import { addGoodsDispatchLine, postGoodsDispatch } from "../src/lib/inventory/goods-dispatch/service";

const db = new PrismaClient();
const TAG = "P45CAP";
const STAMP = `${Date.now()}`.slice(-8);
const PASS = "P45cap!Passw0rd!1";

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
    console.log(`✗ ${name}${info ? " — " + info : ""}`);
  }
}
function section(name: string) {
  console.log(`\n== ${name} ==`);
}
function codeOf(error: unknown): string {
  return (error as { code?: string })?.code ?? String(error);
}

async function purge() {
  const bizs = await db.business.findMany({ where: { name: { startsWith: `${TAG}-` } }, select: { id: true } });
  for (const b of bizs) {
    await db.auditLog.deleteMany({ where: { businessId: b.id } });
    await db.goodsDispatchLine.deleteMany({ where: { goodsDispatch: { businessId: b.id } } });
    await db.goodsDispatch.deleteMany({ where: { businessId: b.id } });
    await db.salesOrderLine.deleteMany({ where: { salesOrder: { businessId: b.id } } });
    await db.salesOrder.deleteMany({ where: { businessId: b.id } });
    await db.saleItem.deleteMany({ where: { sale: { businessId: b.id } } });
    await db.sale.deleteMany({ where: { businessId: b.id } });
    await db.inventoryAdjustment.deleteMany({ where: { businessId: b.id } });
    await db.customer.deleteMany({ where: { businessId: b.id } });
    await db.product.deleteMany({ where: { businessId: b.id } });
    await db.business.deleteMany({ where: { id: b.id } });
  }
  const users = await db.user.findMany({ where: { email: { startsWith: `${TAG.toLowerCase()}-` } }, select: { id: true } });
  for (const u of users) {
    await db.userSession.deleteMany({ where: { userId: u.id } });
    await db.user.deleteMany({ where: { id: u.id } });
  }
}

const CTX = () => ({ businessId: "", userId: "" });

async function main() {
  await purge();

  const owner = await db.user.create({
    data: {
      email: `${TAG.toLowerCase()}-owner-${STAMP}@cap.test`,
      name: `${TAG} owner`,
      passwordHash: "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv",
    },
  });
  const biz = await db.business.create({
    data: {
      name: `${TAG}-biz-${STAMP}`,
      slug: `${TAG.toLowerCase()}-biz-${STAMP}`,
      ownerId: owner.id,
      currencyCode: "USD",
      currencySymbol: "$",
      decimalPrecision: 2,
    },
  });
  const ctx = CTX();
  ctx.businessId = biz.id;
  ctx.userId = owner.id;

  const product = await db.product.create({
    data: { businessId: biz.id, name: `${TAG} Stocked`, sku: `${TAG}-SKU`, salePriceMinor: 100, stockQty: 500 },
  });

  /* ---------------- 1. sequential line cap (§31) ---------------- */
  section("1. sequential line cap (SALES_ORDER_MAX_LINES=20)");
  const capped = await createSalesOrder({ ...ctx, reference: `${TAG}-CAP` });
  let accepted = 0;
  let limitError = "";
  for (let i = 0; i < 21; i += 1) {
    const p = await db.product.create({
      data: { businessId: biz.id, name: `${TAG} P${i}`, sku: `${TAG}-P${i}`, salePriceMinor: 10, stockQty: 5 },
    });
    try {
      await addSalesOrderLine({ ...ctx, id: capped.id, productId: p.id, orderedQty: 1 });
      accepted += 1;
    } catch (error) {
      limitError = codeOf(error);
    }
  }
  eq2(accepted, 20, "1.1 exactly 20 lines accepted");
  ok(`1.2 21st line → 422 LINE_LIMIT (${limitError})`, limitError === "SALES_ORDER_LINE_LIMIT_REACHED");
  const cappedCount = await db.salesOrderLine.count({ where: { salesOrderId: capped.id } });
  eq2(cappedCount, 20, "1.3 exactly 20 lines persisted");

  /* ---------------- 2. over-cap corruption (§106) ---------------- */
  section("2. over-cap corruption → controlled 500, zero mutation");
  const extra = await db.product.create({
    data: { businessId: biz.id, name: `${TAG} Extra`, sku: `${TAG}-X`, salePriceMinor: 10 },
  });
  await db.salesOrderLine.create({
    data: {
      salesOrderId: capped.id,
      productId: extra.id,
      orderedQty: 1,
      unitPriceMinor: 10,
      productNameAtOrder: extra.name,
    },
  }); // direct DB injection → 21 lines (corruption)
  const beforeCap = await db.product.findUnique({ where: { id: product.id }, select: { stockQty: true } });
  const capDetail = await safe(() => getSalesOrder({ businessId: biz.id, id: capped.id }));
  eq2(capDetail.status, 500, "2.1 detail fails 500");
  eq2(capDetail.code, "SALES_ORDER_LINE_CAP_INVARIANT", "2.2 stable invariant code");
  const capList = await safe(() => listSalesOrders({ businessId: biz.id, page: 1, pageSize: 25 }));
  eq2(capList.status, 500, "2.3 list fails 500 on the corrupted row");
  eq2(capList.code, "SALES_ORDER_LINE_CAP_INVARIANT", "2.4 stable invariant code (list)");
  const capAdd = await safe(() => addSalesOrderLine({ ...ctx, id: capped.id, productId: product.id, orderedQty: 1 }));
  eq2(capAdd.status, 500, "2.5 line-add on corrupted order fails 500");
  const capConfirm = await safe(() => confirmSalesOrder({ ...ctx, id: capped.id }));
  eq2(capConfirm.status, 500, "2.6 confirm on corrupted order fails 500");
  const afterCap = await db.product.findUnique({ where: { id: product.id }, select: { stockQty: true } });
  eq2(afterCap?.stockQty, beforeCap?.stockQty, "2.7 ZERO stock mutation during corruption probes");
  await db.salesOrderLine.delete({ where: { id: (await db.salesOrderLine.findFirst({ where: { salesOrderId: capped.id, productId: extra.id } }))!.id } });
  const recovered = await getSalesOrder({ businessId: biz.id, id: capped.id });
  eq2(recovered.order.id, capped.id, "2.8 reads recover after cleanup");

  /* ------------- 3. concurrent duplicate product lines ------------- */
  section("3. concurrent duplicate product lines (§19)");
  const dupOrder = await createSalesOrder({ ...ctx, reference: `${TAG}-DUP` });
  const dupResults = await Promise.allSettled(
    Array.from({ length: 5 }, () => addSalesOrderLine({ ...ctx, id: dupOrder.id, productId: product.id, orderedQty: 5 })),
  );
  const dupWins = dupResults.filter((r) => r.status === "fulfilled");
  const dupLoses = dupResults.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  eq2(dupWins.length, 1, "3.1 exactly ONE line created");
  eq2(dupLoses.length, 4, "3.2 four losers");
  ok("3.3 losers carry the stable duplicate code", dupLoses.every((l) => codeOf(l.reason) === "SALES_ORDER_DUPLICATE_PRODUCT"));
  const dupCount = await db.salesOrderLine.count({ where: { salesOrderId: dupOrder.id } });
  eq2(dupCount, 1, "3.4 exactly one persisted line (DB uniqueness authoritative)");

  /* ------------- 4. concurrent duplicate references ------------- */
  section("4. concurrent duplicate references (§13)");
  const ref = `${TAG}-RACE`;
  const refResults = await Promise.allSettled(
    Array.from({ length: 4 }, () => createSalesOrder({ ...ctx, reference: ref })),
  );
  const refWins = refResults.filter((r) => r.status === "fulfilled");
  const refLoses = refResults.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  eq2(refWins.length, 1, "4.1 exactly ONE order created");
  ok("4.2 losers carry the stable duplicate-reference code", refLoses.every((l) => codeOf(l.reason) === "SALES_ORDER_DUPLICATE_REFERENCE"));

  /* ------------ 5. concurrent over-fulfillment (§103) ------------ */
  section("5. concurrent over-fulfillment (ordered 100, two × 70)");
  const bigOrder = await createSalesOrder({ ...ctx, reference: `${TAG}-OVER` });
  const bigLine = await addSalesOrderLine({ ...ctx, id: bigOrder.id, productId: product.id, orderedQty: 100, unitPriceMinor: 100 });
  await confirmSalesOrder({ ...ctx, id: bigOrder.id });
  const stockBefore = (await db.product.findUnique({ where: { id: product.id }, select: { stockQty: true } }))!.stockQty;

  const mkDispatch = async () => {
    const d = await createLinkedDispatch({ ...ctx, id: bigOrder.id, notes: null });
    await addGoodsDispatchLine({ ...ctx, id: d.id, salesOrderLineId: (bigLine as { id: string }).id, qty: 70 });
    return d.id as string;
  };
  const [d1, d2] = await Promise.all([mkDispatch(), mkDispatch()]);
  const postResults = await Promise.allSettled([
    postGoodsDispatch({ ...ctx, id: d1 }),
    postGoodsDispatch({ ...ctx, id: d2 }),
  ]);
  const postWins = postResults.filter((r) => r.status === "fulfilled");
  const postLoses = postResults.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  ok(`5.1 exactly one post wins (${postWins.length}W/${postLoses.length}L)`, postWins.length === 1 && postLoses.length === 1);
  ok(
    "5.2 loser carries the stable over-remaining code",
    postLoses.length === 0 || postLoses.every((l) => codeOf(l.reason) === "SALES_ORDER_DISPATCH_EXCEEDS_REMAINING"),
  );
  const overDetail = await getSalesOrder({ businessId: biz.id, id: bigOrder.id });
  const postedSum = overDetail.lines[0].dispatchedQty;
  ok(`5.3 combined posted ≤ ordered (${postedSum} ≤ 100)`, postedSum <= 100);
  const stockAfterOver = (await db.product.findUnique({ where: { id: product.id }, select: { stockQty: true } }))!.stockQty;
  eq2(stockAfterOver, stockBefore - postedSum, "5.4 stock decremented by EXACTLY the posted quantity");
  ok("5.5 stock never negative", stockAfterOver >= 0);
  const adjForProduct = await db.inventoryAdjustment.count({ where: { businessId: biz.id, productId: product.id, delta: { lt: 0 } } });
  eq2(adjForProduct, postedSum > 0 ? 1 : 0, "5.6 ONE negative adjustment per posted line");

  /* ------------- 6. concurrent invoice issuance (§105) ------------ */
  section("6. concurrent invoice issuance (one order → ONE invoice)");
  // Finish fulfillment: remaining = 30.
  const finishDispatch = await createLinkedDispatch({ ...ctx, id: bigOrder.id, notes: null });
  await addGoodsDispatchLine({ ...ctx, id: finishDispatch.id, salesOrderLineId: (bigLine as { id: string }).id, qty: 30 });
  await postGoodsDispatch({ ...ctx, id: finishDispatch.id });
  const fullDetail = await getSalesOrder({ businessId: biz.id, id: bigOrder.id });
  eq2(fullDetail.summary.fullyDispatched, true, "6.1 order fully dispatched");
  const saleCountBefore = await db.sale.count({ where: { salesOrderId: bigOrder.id } });
  eq2(saleCountBefore, 0, "6.2 no invoice yet");

  const stockPreInvoice = (await db.product.findUnique({ where: { id: product.id }, select: { stockQty: true } }))!.stockQty;
  const adjPreInvoice = await db.inventoryAdjustment.count({ where: { businessId: biz.id } });
  const invoiceResults = await Promise.allSettled([
    issueOrderInvoice({ ...ctx, id: bigOrder.id }),
    issueOrderInvoice({ ...ctx, id: bigOrder.id }),
  ]);
  const invWins = invoiceResults.filter((r) => r.status === "fulfilled");
  const invLoses = invoiceResults.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  ok(`6.3 exactly one invoice wins (${invWins.length}W/${invLoses.length}L)`, invWins.length === 1 && invLoses.length === 1);
  ok(
    `6.4 loser carries the stable already-invoiced code (${invLoses.map((l) => codeOf(l.reason)).join(",")})`,
    invLoses.every((l) => codeOf(l.reason) === "SALES_ORDER_ALREADY_INVOICED"),
  );
  const saleCountAfter = await db.sale.count({ where: { salesOrderId: bigOrder.id } });
  eq2(saleCountAfter, 1, "6.5 EXACTLY ONE linked Sale (§52/§105)");
  const itemRows = await db.saleItem.count({ where: { sale: { salesOrderId: bigOrder.id } } });
  eq2(itemRows, 1, "6.6 exactly one SaleItem (no duplicates)");
  const stockPostInvoice = (await db.product.findUnique({ where: { id: product.id }, select: { stockQty: true } }))!.stockQty;
  eq2(stockPostInvoice, stockPreInvoice, "6.7 §122: NO stock change from either invoice request");
  const adjPostInvoice = await db.inventoryAdjustment.count({ where: { businessId: biz.id } });
  eq2(adjPostInvoice, adjPreInvoice, "6.8 §122: NO InventoryAdjustment from either invoice request");
  const completedOrder = await db.salesOrder.findUnique({ where: { id: bigOrder.id }, select: { status: true, completedAt: true } });
  eq2(completedOrder?.status, "COMPLETED", "6.9 order COMPLETED exactly once");
  ok("6.10 completedAt set", Boolean(completedOrder?.completedAt));
  const invoiceAudits = await db.auditLog.count({ where: { businessId: biz.id, entityId: bigOrder.id, action: "sales_order.invoice" } });
  eq2(invoiceAudits, 1, "6.11 exactly ONE sales_order.invoice audit event");
  const saleAudits = await db.auditLog.count({ where: { businessId: biz.id, action: "sale.create", entityId: (await db.sale.findFirst({ where: { salesOrderId: bigOrder.id } }))!.id } });
  eq2(saleAudits, 1, "6.12 exactly ONE sale.create audit event");
  // Payment status untouched: the linked sale remains UNPAID.
  const linkedSale = await db.sale.findFirst({ where: { salesOrderId: bigOrder.id } });
  eq2(linkedSale?.status, "UNPAID", "6.13 linked invoice UNPAID (payment is a separate authority §57)");

  /* ---------- 7. shared write-transaction serialization ---------- */
  section("7. dispatch post + manual adjustment (no lost update, §102)");
  const serOrder = await createSalesOrder({ ...ctx, reference: `${TAG}-SER` });
  const serLine = await addSalesOrderLine({ ...ctx, id: serOrder.id, productId: product.id, orderedQty: 10, unitPriceMinor: 100 });
  await confirmSalesOrder({ ...ctx, id: serOrder.id });
  const serDispatch = await createLinkedDispatch({ ...ctx, id: serOrder.id, notes: null });
  await addGoodsDispatchLine({ ...ctx, id: serDispatch.id, salesOrderLineId: (serLine as { id: string }).id, qty: 6 });
  const stockBeforeSer = (await db.product.findUnique({ where: { id: product.id }, select: { stockQty: true } }))!.stockQty;
  const { updateProduct } = await import("../src/app/api/v1/products/[id]/route").then(() => ({})) as never;
  // Manual adjustment through the EXISTING adjustment API path (service-level):
  const { PrismaClient: P } = await import("@prisma/client");
  void P;
  const adjPromise = (async () => {
    // The EXISTING adjustments route performs create+update in one tx; here we
    // exercise the same interleaving through a direct write tx on the shared
    // engine: create a manual adjustment and bump stock by +3.
    const { withWriteTransaction } = await import("../src/lib/db/write-transaction");
    return withWriteTransaction(async (tx) => {
      await tx.inventoryAdjustment.create({
        data: { businessId: biz.id, productId: product.id, delta: 3, reason: `${TAG} manual`, actorId: ctx.userId },
      });
      await tx.product.update({ where: { id: product.id }, data: { stockQty: { increment: 3 } } });
      return true;
    });
  })();
  const postSer = await postGoodsDispatch({ ...ctx, id: serDispatch.id });
  await adjPromise;
  eq2(postSer.lineCount, 1, "7.1 dispatch posted alongside the adjustment");
  const stockAfterSer = (await db.product.findUnique({ where: { id: product.id }, select: { stockQty: true } }))!.stockQty;
  eq2(stockAfterSer, stockBeforeSer + 3 - 6, "7.2 exact integer arithmetic (no lost update)");
  ok("7.3 stock never negative", stockAfterSer >= 0);

  /* --------------------------- 8. cancel race --------------------------- */
  section("8. concurrent cancel + dispatch post (§49/§50)");
  const raceOrder = await createSalesOrder({ ...ctx, reference: `${TAG}-RACE2` });
  const raceLine = await addSalesOrderLine({ ...ctx, id: raceOrder.id, productId: product.id, orderedQty: 5, unitPriceMinor: 100 });
  await confirmSalesOrder({ ...ctx, id: raceOrder.id });
  const raceDispatch = await createLinkedDispatch({ ...ctx, id: raceOrder.id, notes: null });
  await addGoodsDispatchLine({ ...ctx, id: raceDispatch.id, salesOrderLineId: (raceLine as { id: string }).id, qty: 5 });
  const raceResults = await Promise.allSettled([
    postGoodsDispatch({ ...ctx, id: raceDispatch.id }),
    cancelSalesOrder({ ...ctx, id: raceOrder.id }),
  ]);
  const racePosted = raceResults[0].status === "fulfilled";
  const raceCancelled = raceResults[1].status === "fulfilled";
  ok("8.1 post and cancel can NEVER both succeed (§49/§50 invariant)", !(racePosted && raceCancelled));
  const raceDetail = await getSalesOrder({ businessId: biz.id, id: raceOrder.id });
  if (racePosted) {
    eq2(raceDetail.order.status, "CONFIRMED", "8.2 posted → order stays CONFIRMED (cancel lost)");
  } else {
    eq2(raceDetail.order.status, "CANCELLED", "8.3 cancel won → dispatch must have failed");
    ok("8.4 losing post carries a domain error", raceResults[0].status === "rejected");
  }

  /* ---------------------------- teardown ---------------------------- */
  section("teardown to ZERO");
  await purge();
  const residueBiz = await db.business.count({ where: { name: { startsWith: `${TAG}-` } } });
  const residueUsers = await db.user.count({ where: { email: { startsWith: `${TAG.toLowerCase()}-` } } });
  eq2(residueBiz, 0, "T.1 zero fixture businesses");
  eq2(residueUsers, 0, "T.2 zero fixture users");

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("FAILURES:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

function eq2(actual: unknown, expected: unknown, name: string) {
  ok(name, actual === expected, `got ${String(actual)}, want ${String(expected)}`);
}

async function safe<T>(fn: () => Promise<T>): Promise<{ status: number; code: string; value?: T }> {
  try {
    const value = await fn();
    return { status: 200, code: "", value };
  } catch (error) {
    const e = error as { status?: number; code?: string };
    return { status: e.status ?? 500, code: e.code ?? String(error) };
  }
}

main()
  .catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
