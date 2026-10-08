/**
 * Prompt 42 — ISOLATED line-cap + RECEIVING-CONCURRENCY process (§50/§51/§71/§210/§211).
 *
 * Runs with GOODS_RECEIPT_MAX_LINES=20 (NEVER changes the project default)
 * in its own bun process, exercising the REAL service layer against the REAL
 * dev database:
 *   1. sequential adds: 21 valid lines → 20 accepted, 21st → 422 LINE_LIMIT,
 *      exactly 20 persisted;
 *   2. concurrent duplicate line adds → exactly one line, loser 409
 *      GOODS_RECEIPT_IMMUTABLE (unique constraint §27/§209);
 *   3. CONCURRENT OVER-RECEIPT (§50/§210): ordered=100, two parallel posts
 *      of 60 → persisted received total ≤ 100, never 120; one post wins,
 *      the other 409 GOODS_RECEIPT_EXCEEDS_REMAINING;
 *   4. 20 concurrent receipt-post requests on ONE PO line ordered=100
 *      (§51): persisted total ≤ 100; no stock mutation beyond persisted
 *      receipt lines (adjustment deltas sum == persisted received sum);
 *   5. concurrent same-receipt post (§211): at most one successful
 *      transition, exactly ONE goods_receipt.post audit event, exactly one
 *      set of adjustments;
 *   6. concurrent same-reference creates (§208): exactly one receipt, rest
 *      409 GOODS_RECEIPT_DUPLICATE_REFERENCE.
 *
 * All fixtures are P42CAP-prefixed and torn down to ZERO (§231), including
 * crashed-run recovery (pre-run sweep).
 *
 * Run: GOODS_RECEIPT_MAX_LINES=20 bun --preload ./scripts/lib/register-server-only-shim.ts \
 *        scripts/prompt42-cap-check.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  addGoodsReceiptLine,
  cancelGoodsReceipt,
  createGoodsReceipt,
  postGoodsReceipt,
} from "../src/lib/inventory/goods-receipt/service";

const db = new PrismaClient();
const TAG = "P42CAP";
const STAMP = `${Date.now()}`;
const PASS = "P42qa!Passw0rd!1";

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

function codeOf(error: unknown): string {
  return (error as { code?: string })?.code ?? String(error);
}

async function purgeFixture() {
  // Crashed-run recovery (§231): remove ANY prior P42CAP residue first.
  const bizs = await db.business.findMany({ where: { name: { startsWith: `${TAG}-` } }, select: { id: true } });
  for (const b of bizs) {
    await db.auditLog.deleteMany({ where: { businessId: b.id } });
    await db.goodsReceiptLine.deleteMany({ where: { goodsReceipt: { businessId: b.id } } });
    await db.goodsReceipt.deleteMany({ where: { businessId: b.id } });
    await db.inventoryAdjustment.deleteMany({ where: { businessId: b.id } });
    await db.purchaseOrderLine.deleteMany({ where: { purchaseOrder: { businessId: b.id } } });
    await db.purchaseOrder.deleteMany({ where: { businessId: b.id } });
    await db.product.deleteMany({ where: { businessId: b.id } });
    await db.supplier.deleteMany({ where: { businessId: b.id } });
    await db.subscriptionEvent.deleteMany({ where: { subscription: { businessId: b.id } } });
    await db.subscription.deleteMany({ where: { businessId: b.id } });
    await db.businessMember.deleteMany({ where: { businessId: b.id } });
    await db.business.deleteMany({ where: { id: b.id } });
  }
  await db.user.deleteMany({ where: { email: { startsWith: `${TAG.toLowerCase()}` } } });
}

async function seedBusiness(name: string): Promise<{ businessId: string; userId: string }> {
  const user = await db.user.create({
    data: {
      email: `${TAG.toLowerCase()}-${name}-${STAMP}@test.local`,
      name: `${TAG} ${name}`,
      passwordHash: PASS,
    },
    select: { id: true },
  });
  const biz = await db.business.create({
    data: {
      name: `${TAG}-${name}-${STAMP}`,
      slug: `${TAG}-${name}-${STAMP}`.toLowerCase().replace(/_/g, "-"),
      currencyCode: "USD",
      currencySymbol: "$",
      decimalPrecision: 2,
      ownerId: user.id,
      members: { create: { userId: user.id, role: "OWNER" } },
    },
    select: { id: true },
  });
  return { businessId: biz.id, userId: user.id };
}

let seedSeq = 0;
async function seedConfirmedPo(
  businessId: string,
  userId: string,
  orderedQty: number,
  lineCount = 1,
): Promise<{ poId: string; poLineIds: string[]; productId: string; supplierId: string }> {
  seedSeq += 1;
  const suffix = `${STAMP}-${seedSeq}`;
  const supplier = await db.supplier.create({
    data: { businessId, name: `${TAG} SUP ${suffix}` },
    select: { id: true },
  });
  const products = await Promise.all(
    Array.from({ length: lineCount }, (_, i) =>
      db.product.create({
        data: {
          businessId,
          name: `${TAG} PROD ${suffix}-${i}`,
          sku: `${TAG}-SKU-${suffix}-${i}`,
          unit: "pcs",
          stockQty: 10,
        },
        select: { id: true },
      }),
    ),
  );
  const po = await db.purchaseOrder.create({
    data: {
      businessId,
      supplierId: supplier.id,
      reference: `${TAG}-PO-${suffix}`,
      status: "CONFIRMED",
      currencyCodeAtOrder: "USD",
      currencySymbolAtOrder: "$",
      decimalPrecisionAtOrder: 2,
      orderedAt: new Date(),
      supplierNameAtOrder: `${TAG} SUP ${suffix}`,
      createdByUserId: userId,
      confirmedAt: new Date(),
      lines: {
        create: products.map((p, i) => ({
          productId: p.id,
          orderedQty,
          unitPriceMinor: 100,
          productNameAtOrder: `${TAG} PROD ${suffix}-${i}`,
          skuAtOrder: `${TAG}-SKU-${suffix}-${i}`,
          unitAtOrder: "pcs",
        })),
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  });
  return { poId: po.id, poLineIds: po.lines.map((l) => l.id), productId: products[0]!.id, supplierId: supplier.id };
}

async function main() {
  await purgeFixture();

  const ctx = await seedBusiness("main");
  const actor = { businessId: ctx.businessId, userId: ctx.userId };

  /* ---------------- 1. sequential line cap (§71, isolated cap=20) ---------- */
  section("1. sequential line cap — 21 adds → 20 accepted, 21st 422");
  // A receipt may contain each PO line AT MOST ONCE (§27), so the cap test
  // needs 21 DIFFERENT PO lines on one confirmed order.
  const cap = await seedConfirmedPo(ctx.businessId, ctx.userId, 1_000_000, 21);
  const capReceipt = await createGoodsReceipt({ ...actor, purchaseOrderId: cap.poId });
  let accepted = 0;
  let limitHit = 0;
  for (let i = 0; i < 21; i += 1) {
    try {
      await addGoodsReceiptLine({ ...actor, id: capReceipt.id, purchaseOrderLineId: cap.poLineIds[i]!, receivedQty: 1 });
      accepted += 1;
    } catch (error) {
      limitHit += 1;
      ok(`1.${i + 1} 21st add rejected with LINE_LIMIT`, codeOf(error) === "GOODS_RECEIPT_LINE_LIMIT_REACHED", codeOf(error));
      break;
    }
  }
  ok("1.22 exactly 20 lines accepted before the limit", accepted === 20, String(accepted));
  ok("1.23 limit rejection observed exactly once", limitHit === 1, String(limitHit));
  const capCount = await db.goodsReceiptLine.count({ where: { goodsReceiptId: capReceipt.id } });
  ok("1.24 exactly 20 lines persisted", capCount === 20, String(capCount));
  // post still works with the full 20 lines? qty 1 each → 20 units, ordered 1M — fine.
  const capPosted = await postGoodsReceipt({ ...actor, id: capReceipt.id });
  ok("1.25 capped receipt posts cleanly", capPosted.status === "POSTED");
  const capLines = await db.goodsReceiptLine.findMany({
    where: { goodsReceiptId: capReceipt.id },
    select: { productId: true, receivedQty: true },
  });
  const capStocks = await db.product.findMany({
    where: { id: { in: capLines.map((l) => l.productId) } },
    select: { id: true, stockQty: true },
  });
  const stockByProduct = new Map(capStocks.map((p) => [p.id, p.stockQty]));
  ok(
    "1.26 stock moved +1 on exactly the 20 received products",
    capLines.every((l) => stockByProduct.get(l.productId) === 10 + l.receivedQty),
  );

  /* -------------- 2. concurrent duplicate line add (§27/§209) -------------- */
  section("2. concurrent duplicate line add — exactly one line, loser 409");
  const dup = await seedConfirmedPo(ctx.businessId, ctx.userId, 100);
  const dupReceipt = await createGoodsReceipt({ ...actor, purchaseOrderId: dup.poId });
  const dupResults = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      addGoodsReceiptLine({ ...actor, id: dupReceipt.id, purchaseOrderLineId: dup.poLineIds[0]!, receivedQty: 10 }),
    ),
  );
  const dupWon = dupResults.filter((r) => r.status === "fulfilled").length;
  const dupLostCodes = dupResults
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => codeOf(r.reason));
  ok("2.1 exactly one duplicate-add winner", dupWon === 1, String(dupWon));
  ok("2.2 losers all 409 GOODS_RECEIPT_IMMUTABLE (unique constraint)", dupLostCodes.every((c) => c === "GOODS_RECEIPT_IMMUTABLE"), dupLostCodes.join(","));
  ok("2.3 loser count = 7", dupLostCodes.length === 7, String(dupLostCodes.length));
  const dupLines = await db.goodsReceiptLine.count({ where: { goodsReceiptId: dupReceipt.id } });
  ok("2.4 exactly one line persisted (§209)", dupLines === 1, String(dupLines));

  /* -------------- 3. CONCURRENT OVER-RECEIPT (§50/§210) -------------------- */
  section("3. two parallel posts of 60 vs ordered 100 → never 120");
  const over = await seedConfirmedPo(ctx.businessId, ctx.userId, 100);
  const overA = await createGoodsReceipt({ ...actor, purchaseOrderId: over.poId });
  const overB = await createGoodsReceipt({ ...actor, purchaseOrderId: over.poId });
  await addGoodsReceiptLine({ ...actor, id: overA.id, purchaseOrderLineId: over.poLineIds[0]!, receivedQty: 60 });
  await addGoodsReceiptLine({ ...actor, id: overB.id, purchaseOrderLineId: over.poLineIds[0]!, receivedQty: 60 });
  const overResults = await Promise.allSettled([
    postGoodsReceipt({ ...actor, id: overA.id }),
    postGoodsReceipt({ ...actor, id: overB.id }),
  ]);
  const overWins = overResults.filter((r) => r.status === "fulfilled").length;
  const overLoses = overResults
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => codeOf(r.reason));
  ok("3.1 exactly one post wins", overWins === 1, String(overWins));
  ok("3.2 loser 409 GOODS_RECEIPT_EXCEEDS_REMAINING", overLoses.every((c) => c === "GOODS_RECEIPT_EXCEEDS_REMAINING"), overLoses.join(","));
  const postedSum = await db.goodsReceiptLine.groupBy({
    by: ["purchaseOrderLineId"],
    where: { purchaseOrderLineId: over.poLineIds[0]!, goodsReceipt: { status: "POSTED" } },
    _sum: { receivedQty: true },
  });
  const overReceived = postedSum[0]?._sum.receivedQty ?? 0;
  ok("3.3 persisted received ≤ 100 (NEVER 120, §50)", overReceived <= 100, String(overReceived));
  const overAdjustments = await db.inventoryAdjustment.findMany({
    where: { businessId: ctx.businessId, productId: over.productId },
    select: { delta: true },
  });
  const overDeltaSum = overAdjustments.reduce((a, r) => a + r.delta, 0);
  ok("3.4 stock mutations match persisted receipts exactly (§50)", overDeltaSum === overReceived, `${overDeltaSum} vs ${overReceived}`);
  const overStock = await db.product.findUnique({ where: { id: over.productId }, select: { stockQty: true } });
  ok("3.5 stock = initial 10 + persisted received", overStock?.stockQty === 10 + overReceived, String(overStock?.stockQty));

  /* ------- 4. 20 concurrent posts on one PO line ordered=100 (§51) --------- */
  section("4. 20 concurrent receipt posts vs ordered 100 → total ≤ 100");
  const many = await seedConfirmedPo(ctx.businessId, ctx.userId, 100);
  const manyReceiptIds: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    const r = await createGoodsReceipt({ ...actor, purchaseOrderId: many.poId });
    await addGoodsReceiptLine({ ...actor, id: r.id, purchaseOrderLineId: many.poLineIds[0]!, receivedQty: 10 });
    manyReceiptIds.push(r.id);
  }
  const manyResults = await Promise.allSettled(
    manyReceiptIds.map((id) => postGoodsReceipt({ ...actor, id })),
  );
  const manyWins = manyResults.filter((r) => r.status === "fulfilled").length;
  const manyLoses = manyResults
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => codeOf(r.reason));
  const manyPosted = await db.goodsReceiptLine.groupBy({
    by: ["purchaseOrderLineId"],
    where: { purchaseOrderLineId: many.poLineIds[0]!, goodsReceipt: { status: "POSTED" } },
    _sum: { receivedQty: true },
  });
  const manyReceived = manyPosted[0]?._sum.receivedQty ?? 0;
  ok("4.1 persisted received ≤ 100 (§51)", manyReceived <= 100, String(manyReceived));
  ok("4.2 winners == persistedReceived / 10", manyWins === manyReceived / 10, `${manyWins} vs ${manyReceived}`);
  ok("4.3 every loser is the stable 409 (never a generic 500)", manyLoses.every((c) => c === "GOODS_RECEIPT_EXCEEDS_REMAINING"), [...new Set(manyLoses)].join(","));
  const manyAdjustments = await db.inventoryAdjustment.findMany({
    where: { businessId: ctx.businessId, productId: many.productId },
    select: { delta: true },
  });
  const manyDeltaSum = manyAdjustments.reduce((a, r) => a + r.delta, 0);
  ok("4.4 adjustment deltas sum == persisted received (no lost update §51)", manyDeltaSum === manyReceived, `${manyDeltaSum} vs ${manyReceived}`);
  const manyStock = await db.product.findUnique({ where: { id: many.productId }, select: { stockQty: true } });
  ok("4.5 stock = initial + persisted received exactly", manyStock?.stockQty === 10 + manyReceived, String(manyStock?.stockQty));

  /* -------- 5. concurrent same-receipt post (§211) — one transition -------- */
  section("5. same receipt posted concurrently — one transition, one audit");
  const once = await seedConfirmedPo(ctx.businessId, ctx.userId, 100);
  const onceReceipt = await createGoodsReceipt({ ...actor, purchaseOrderId: once.poId });
  await addGoodsReceiptLine({ ...actor, id: onceReceipt.id, purchaseOrderLineId: once.poLineIds[0]!, receivedQty: 25 });
  const onceResults = await Promise.allSettled([
    postGoodsReceipt({ ...actor, id: onceReceipt.id }),
    postGoodsReceipt({ ...actor, id: onceReceipt.id }),
    postGoodsReceipt({ ...actor, id: onceReceipt.id }),
    postGoodsReceipt({ ...actor, id: onceReceipt.id }),
  ]);
  const onceWins = onceResults.filter((r) => r.status === "fulfilled").length;
  const onceLoses = onceResults
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => codeOf(r.reason));
  ok("5.1 at most one successful transition (§211)", onceWins === 1, String(onceWins));
  ok("5.2 replays are 409 immutable/invalid-transition", onceLoses.every((c) => c === "GOODS_RECEIPT_INVALID_TRANSITION" || c === "GOODS_RECEIPT_IMMUTABLE"), [...new Set(onceLoses)].join(","));
  const onceAdjustments = await db.inventoryAdjustment.count({
    where: { businessId: ctx.businessId, productId: once.productId },
  });
  ok("5.3 exactly ONE adjustment set (one row, §211)", onceAdjustments === 1, String(onceAdjustments));
  const onceAudits = await db.auditLog.count({
    where: { businessId: ctx.businessId, action: "goods_receipt.post", entityId: onceReceipt.id },
  });
  ok("5.4 exactly ONE goods_receipt.post audit (§211/§215)", onceAudits === 1, String(onceAudits));
  const onceStock = await db.product.findUnique({ where: { id: once.productId }, select: { stockQty: true } });
  ok("5.5 exactly one stock mutation (+25)", onceStock?.stockQty === 35, String(onceStock?.stockQty));

  /* --------- 6. concurrent same-reference creates (§208) ------------------- */
  section("6. concurrent creates with the same reference → one wins");
  const ref = await seedConfirmedPo(ctx.businessId, ctx.userId, 100);
  const refResults = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      createGoodsReceipt({ ...actor, purchaseOrderId: ref.poId, reference: `${TAG}-DUPREF-${STAMP}` }),
    ),
  );
  const refWins = refResults.filter((r) => r.status === "fulfilled").length;
  const refLoses = refResults
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => codeOf(r.reason));
  ok("6.1 exactly one create wins (§208)", refWins === 1, String(refWins));
  ok("6.2 losers 409 GOODS_RECEIPT_DUPLICATE_REFERENCE", refLoses.every((c) => c === "GOODS_RECEIPT_DUPLICATE_REFERENCE"), refLoses.join(","));
  const refCount = await db.goodsReceipt.count({ where: { businessId: ctx.businessId, reference: `${TAG}-DUPREF-${STAMP}` } });
  ok("6.3 exactly one receipt persisted with the reference", refCount === 1, String(refCount));

  /* --------------- 7. cancel is draft-only + no stock (§10/§75) ------------ */
  section("7. cancel draft — no stock mutation; cancel replay 409");
  const cancel = await seedConfirmedPo(ctx.businessId, ctx.userId, 100);
  const cancelReceipt = await createGoodsReceipt({ ...actor, purchaseOrderId: cancel.poId });
  await addGoodsReceiptLine({ ...actor, id: cancelReceipt.id, purchaseOrderLineId: cancel.poLineIds[0]!, receivedQty: 10 });
  const cancelled = await cancelGoodsReceipt({ ...actor, id: cancelReceipt.id });
  ok("7.1 draft cancel → CANCELLED", cancelled.status === "CANCELLED");
  const cancelStock = await db.product.findUnique({ where: { id: cancel.productId }, select: { stockQty: true } });
  ok("7.2 no stock mutation from cancel (§10)", cancelStock?.stockQty === 10, String(cancelStock?.stockQty));
  const cancelAdjust = await db.inventoryAdjustment.count({ where: { businessId: ctx.businessId, productId: cancel.productId } });
  ok("7.3 no adjustment from cancel", cancelAdjust === 0, String(cancelAdjust));
  try {
    await cancelGoodsReceipt({ ...actor, id: cancelReceipt.id });
    ok("7.4 cancel replay rejected", false, "no throw");
  } catch (error) {
    ok("7.4 cancel replay rejected 409", codeOf(error) === "GOODS_RECEIPT_INVALID_TRANSITION", codeOf(error));
  }
  const cancelAudits = await db.auditLog.count({
    where: { businessId: ctx.businessId, action: "goods_receipt.cancel", entityId: cancelReceipt.id },
  });
  ok("7.5 exactly ONE cancel audit (§279)", cancelAudits === 1, String(cancelAudits));

  /* ------------------------------ teardown ---------------------------------- */
  section("teardown (§231)");
  await purgeFixture();
  const residueBiz = await db.business.count({ where: { name: { startsWith: `${TAG}-` } } });
  const residueUser = await db.user.count({ where: { email: { startsWith: `${TAG.toLowerCase()}` } } });
  ok("T.1 zero business residue", residueBiz === 0, String(residueBiz));
  ok("T.2 zero user residue", residueUser === 0, String(residueUser));

  console.log(`\nprompt42-cap-check: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.error(`  FAIL: ${f}`);
    process.exitCode = 1;
  } else {
    console.log("prompt42-cap-check: ALL PASS ✓");
  }
}

main()
  .catch((error) => {
    console.error("fatal:", error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
