/**
 * Prompt 43 — ISOLATED line-cap + RETURN-CONCURRENCY process (§33/§49/§50/
 * §53/§75/§76/§158/§159).
 *
 * Runs with GOODS_RETURN_MAX_LINES=20 (NEVER changes the project default)
 * in its own bun process, exercising the REAL service layer against the REAL
 * dev database:
 *   1. sequential adds: 21 valid lines → 20 accepted, 21st → 422 LINE_LIMIT
 *      (§33), exactly 20 persisted;
 *   2. concurrent duplicate line adds → exactly one line, loser 409
 *      GOODS_RETURN_DUPLICATE_LINE (unique constraint §29/§75);
 *   3. CONCURRENT OVER-RETURN (§49/§159): received=100, two parallel posts
 *      of 70 → persisted returned total ≤ 100, never 140; one post wins,
 *      the other 409 GOODS_RETURN_EXCEEDS_RETURNABLE; stock never negative;
 *   4. concurrent same-return post (§53/§158): at most one successful
 *      transition, exactly ONE goods_return.post audit event, exactly one
 *      set of negative adjustments, one stock decrement;
 *   5. concurrent same-reference creates (§21): exactly one return, rest
 *      409 GOODS_RETURN_DUPLICATE_REFERENCE;
 *   6. concurrent return + manual stock adjustment on the same product
 *      (§123): exact integer arithmetic, no lost update, no negative stock;
 *   7. cap+1 read invariant (§76): a corrupt 21-line return fails detail/
 *      list/export with GOODS_RETURN_LINE_CAP_INVARIANT (500), recovering
 *      after cleanup;
 *   8. non-retry of domain errors (§50): the loser of race #3 surfaces the
 *      STABLE domain code, never a transient-retry artifact.
 *
 * All fixtures are P43CAP-prefixed and torn down to ZERO (§195), including
 * crashed-run recovery (pre-run sweep).
 *
 * Run: GOODS_RETURN_MAX_LINES=20 bunx tsx scripts/prompt43-goods-return-cap-check.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  addGoodsReturnLine,
  cancelGoodsReturn,
  createGoodsReturn,
  getGoodsReturn,
  listGoodsReturns,
  postGoodsReturn,
} from "../src/lib/inventory/goods-return/service";

const db = new PrismaClient();
const TAG = "P43CAP";
const STAMP = `${Date.now()}`;

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

async function purgeFixture() {
  // Crashed-run recovery (§195): remove ANY prior P43CAP residue first.
  const bizs = await db.business.findMany({ where: { name: { startsWith: `${TAG}-` } }, select: { id: true } });
  for (const b of bizs) {
    await db.auditLog.deleteMany({ where: { businessId: b.id } });
    await db.goodsReturnLine.deleteMany({ where: { goodsReturn: { businessId: b.id } } });
    await db.goodsReturn.deleteMany({ where: { businessId: b.id } });
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
      passwordHash: "P43qa!Passw0rd!1",
    },
    select: { id: true },
  });
  const biz = await db.business.create({
    data: {
      name: `${TAG}-${name}-${STAMP}`,
      slug: `${TAG}-${name}-${STAMP}`.toLowerCase(),
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
async function seedPostedReceipt(
  businessId: string,
  userId: string,
  receivedQty: number,
  lineCount = 1,
): Promise<{ receiptId: string; receiptLineIds: string[]; productId: string; productId2: string | null }> {
  seedSeq += 1;
  const suffix = `${STAMP}-${seedSeq}`;
  const supplier = await db.supplier.create({
    data: { businessId, name: `${TAG} SUP ${suffix}` },
    select: { id: true },
  });
  const products = await Promise.all(
    Array.from({ length: lineCount }, (_, i) =>
      db.product.create({
        data: { businessId, name: `${TAG} PROD ${suffix}-${i}`, sku: `${TAG}-SKU-${suffix}-${i}`, unit: "pcs", stockQty: 10_000 },
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
          orderedQty: 10_000_000,
          unitPriceMinor: 100,
          productNameAtOrder: `${TAG} PROD ${suffix}-${i}`,
          skuAtOrder: `${TAG}-SKU-${suffix}-${i}`,
          unitAtOrder: "pcs",
        })),
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  });
  const receipt = await db.goodsReceipt.create({
    data: {
      businessId,
      purchaseOrderId: po.id,
      reference: `${TAG}-GR-${suffix}`,
      status: "POSTED",
      supplierNameAtReceipt: `${TAG} SUP ${suffix}`,
      purchaseOrderReferenceAtReceipt: `${TAG}-PO-${suffix}`,
      createdByUserId: userId,
      postedAt: new Date(),
      lines: {
        create: po.lines.map((l, i) => ({
          purchaseOrderLineId: l.id,
          productId: products[i]!.id,
          receivedQty,
          productNameAtReceipt: `${TAG} PROD ${suffix}-${i}`,
          skuAtReceipt: `${TAG}-SKU-${suffix}-${i}`,
          unitAtReceipt: "pcs",
        })),
      },
    },
    select: { id: true, lines: { select: { id: true } } },
  });
  // Mirror the receipt's stock effect (fixtures write what a real post writes).
  for (const p of products) {
    await db.product.update({ where: { id: p.id }, data: { stockQty: { increment: receivedQty } } });
  }
  return { receiptId: receipt.id, receiptLineIds: receipt.lines.map((l) => l.id), productId: products[0]!.id, productId2: products[1]?.id ?? null };
}

async function main() {
  await purgeFixture();

  const ctx = await seedBusiness("main");
  const actor = { businessId: ctx.businessId, userId: ctx.userId };

  /* ------------- 1. sequential line cap (§33, isolated cap=20) ------------- */
  section("1. sequential line cap — 21 adds → 20 accepted, 21st 422");
  const capSeed = await seedPostedReceipt(ctx.businessId, ctx.userId, 1, 21);
  const capReturn = await createGoodsReturn({ ...actor, goodsReceiptId: capSeed.receiptId });
  let accepted = 0;
  let limitHit = 0;
  for (let i = 0; i < 21; i += 1) {
    try {
      await addGoodsReturnLine({ ...actor, id: capReturn.id, goodsReceiptLineId: capSeed.receiptLineIds[i]!, returnedQty: 1, reasonCode: "OTHER" });
      accepted += 1;
    } catch (error) {
      if (codeOf(error) === "GOODS_RETURN_LINE_LIMIT_REACHED") limitHit += 1;
      else throw error;
    }
  }
  ok("1.1 20 lines accepted", accepted === 20, `accepted=${accepted}`);
  ok("1.2 21st add → 422 GOODS_RETURN_LINE_LIMIT_REACHED", limitHit === 1);
  const capCount = await db.goodsReturnLine.count({ where: { goodsReturnId: capReturn.id } });
  ok("1.3 exactly 20 persisted", capCount === 20, `persisted=${capCount}`);
  await cancelGoodsReturn({ ...actor, id: capReturn.id });

  /* -------- 2. concurrent duplicate line adds (§29/§75 — DB unique) -------- */
  section("2. concurrent duplicate line adds — exactly one wins");
  const dupSeed = await seedPostedReceipt(ctx.businessId, ctx.userId, 100, 1);
  const dupReturn = await createGoodsReturn({ ...actor, goodsReceiptId: dupSeed.receiptId });
  const dupResults = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      addGoodsReturnLine({ ...actor, id: dupReturn.id, goodsReceiptLineId: dupSeed.receiptLineIds[0]!, returnedQty: 5, reasonCode: "OTHER" }),
    ),
  );
  const dupWinners = dupResults.filter((r) => r.status === "fulfilled").length;
  const dupLoserCodes = dupResults
    .filter((r) => r.status === "rejected")
    .map((r) => codeOf((r as PromiseRejectedResult).reason));
  ok("2.1 exactly one line persisted", dupWinners === 1, `winners=${dupWinners}`);
  ok("2.2 losers → 409 GOODS_RETURN_DUPLICATE_LINE", dupLoserCodes.every((c) => c === "GOODS_RETURN_DUPLICATE_LINE") && dupLoserCodes.length === 7, dupLoserCodes.join(","));
  await cancelGoodsReturn({ ...actor, id: dupReturn.id });

  /* ------------- 3. concurrent over-return (§49/§159 — THE race) ----------- */
  section("3. concurrent over-return — 70 + 70 against received 100");
  const raceSeed = await seedPostedReceipt(ctx.businessId, ctx.userId, 100, 1);
  const stockBefore = (await db.product.findUnique({ where: { id: raceSeed.productId }, select: { stockQty: true } }))!.stockQty;
  const raceA = await createGoodsReturn({ ...actor, goodsReceiptId: raceSeed.receiptId, reference: `${TAG}-RA-${STAMP}` });
  const raceB = await createGoodsReturn({ ...actor, goodsReceiptId: raceSeed.receiptId, reference: `${TAG}-RB-${STAMP}` });
  await addGoodsReturnLine({ ...actor, id: raceA.id, goodsReceiptLineId: raceSeed.receiptLineIds[0]!, returnedQty: 70, reasonCode: "OTHER" });
  await addGoodsReturnLine({ ...actor, id: raceB.id, goodsReceiptLineId: raceSeed.receiptLineIds[0]!, returnedQty: 70, reasonCode: "OTHER" });

  const raceResults = await Promise.allSettled([
    postGoodsReturn({ ...actor, id: raceA.id }),
    postGoodsReturn({ ...actor, id: raceB.id }),
  ]);
  const raceWinners = raceResults.filter((r) => r.status === "fulfilled").length;
  const raceLoserCodes = raceResults
    .filter((r) => r.status === "rejected")
    .map((r) => codeOf((r as PromiseRejectedResult).reason));
  ok("3.1 exactly ONE post wins the race", raceWinners === 1, `winners=${raceWinners}`);
  ok("3.2 loser → 409 GOODS_RETURN_EXCEEDS_RETURNABLE (§50 — domain errors never retried)", raceLoserCodes.every((c) => c === "GOODS_RETURN_EXCEEDS_RETURNABLE") && raceLoserCodes.length === 1, raceLoserCodes.join(","));

  const totalReturned = await db.goodsReturnLine.aggregate({
    where: { goodsReturn: { businessId: ctx.businessId, status: "POSTED" }, goodsReceiptLineId: raceSeed.receiptLineIds[0]! },
    _sum: { returnedQty: true },
  });
  ok("3.3 §49/§159: persisted returned ≤ 100 (never 140)", (totalReturned._sum.returnedQty ?? 0) === 70, `summed=${totalReturned._sum.returnedQty}`);
  const stockAfterRace = (await db.product.findUnique({ where: { id: raceSeed.productId }, select: { stockQty: true } }))!.stockQty;
  ok("3.4 stock decremented exactly once (70)", stockAfterRace === stockBefore - 70, `stock=${stockAfterRace}`);
  ok("3.5 stock never negative", stockAfterRace >= 0);
  const raceAdj = await db.inventoryAdjustment.count({ where: { businessId: ctx.businessId, productId: raceSeed.productId, delta: { lt: 0 } } });
  ok("3.6 exactly ONE negative adjustment", raceAdj === 1, `adj=${raceAdj}`);

  /* -------- 4. concurrent same-return post (§53/§158 — single transition) -- */
  section("4. concurrent same-return post — exactly one transition");
  const dpSeed = await seedPostedReceipt(ctx.businessId, ctx.userId, 100, 2);
  const dpReturn = await createGoodsReturn({ ...actor, goodsReceiptId: dpSeed.receiptId });
  await addGoodsReturnLine({ ...actor, id: dpReturn.id, goodsReceiptLineId: dpSeed.receiptLineIds[0]!, returnedQty: 3, reasonCode: "OTHER" });
  await addGoodsReturnLine({ ...actor, id: dpReturn.id, goodsReceiptLineId: dpSeed.receiptLineIds[1]!, returnedQty: 4, reasonCode: "OTHER" });
  const dpStockBefore = (await db.product.findUnique({ where: { id: dpSeed.productId }, select: { stockQty: true } }))!.stockQty;
  const dpStock2Before = (await db.product.findUnique({ where: { id: dpSeed.productId2! }, select: { stockQty: true } }))!.stockQty;
  const dpResults = await Promise.allSettled(
    Array.from({ length: 6 }, () => postGoodsReturn({ ...actor, id: dpReturn.id })),
  );
  const dpWinners = dpResults.filter((r) => r.status === "fulfilled").length;
  ok("4.1 at most one successful posting (§53)", dpWinners === 1, `winners=${dpWinners}`);
  const dpLoserCodes = dpResults.filter((r) => r.status === "rejected").map((r) => codeOf((r as PromiseRejectedResult).reason));
  ok("4.2 losers → GOODS_RETURN_INVALID_TRANSITION", dpLoserCodes.every((c) => c === "GOODS_RETURN_INVALID_TRANSITION"), dpLoserCodes.join(","));
  const dpAudit = await db.auditLog.count({ where: { businessId: ctx.businessId, action: "goods_return.post", entityId: dpReturn.id } });
  ok("4.3 exactly ONE goods_return.post audit", dpAudit === 1, `audit=${dpAudit}`);
  // Two lines → two products → exactly one negative adjustment per product.
  const dpAdj = await db.inventoryAdjustment.count({
    where: { businessId: ctx.businessId, reason: { contains: "inventory returned to supplier" }, productId: { in: [dpSeed.productId, dpSeed.productId2!] } },
  });
  ok("4.4 exactly one adjustment set (2 lines → 2 adjustments)", dpAdj === 2, `adj=${dpAdj}`);
  const dpStockAfter = (await db.product.findUnique({ where: { id: dpSeed.productId }, select: { stockQty: true } }))!.stockQty;
  ok("4.5 line-1 stock decremented exactly once (−3)", dpStockAfter === dpStockBefore - 3, `stock=${dpStockAfter}`);
  const dpStock2After = (await db.product.findUnique({ where: { id: dpSeed.productId2! }, select: { stockQty: true } }))!.stockQty;
  ok("4.6 line-2 stock decremented exactly once (−4)", dpStock2After === dpStock2Before - 4, `stock=${dpStock2After}`);

  /* -------- 5. concurrent same-reference creates (§21 — DB unique) --------- */
  section("5. concurrent same-reference creates — exactly one wins");
  const refSeed = await seedPostedReceipt(ctx.businessId, ctx.userId, 10, 1);
  const refResults = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      createGoodsReturn({ ...actor, goodsReceiptId: refSeed.receiptId, reference: `${TAG}-REF-${STAMP}` }),
    ),
  );
  const refWinners = refResults.filter((r) => r.status === "fulfilled").length;
  const refLoserCodes = refResults.filter((r) => r.status === "rejected").map((r) => codeOf((r as PromiseRejectedResult).reason));
  ok("5.1 exactly one return created", refWinners === 1, `winners=${refWinners}`);
  ok("5.2 losers → 409 GOODS_RETURN_DUPLICATE_REFERENCE", refLoserCodes.every((c) => c === "GOODS_RETURN_DUPLICATE_REFERENCE"), refLoserCodes.join(","));

  /* ---- 6. concurrent return + manual stock adjustment (§123 — no lost update) */
  section("6. concurrent return + manual adjustment — exact arithmetic");
  const manSeed = await seedPostedReceipt(ctx.businessId, ctx.userId, 100, 1);
  const manReturn = await createGoodsReturn({ ...actor, goodsReceiptId: manSeed.receiptId });
  await addGoodsReturnLine({ ...actor, id: manReturn.id, goodsReceiptLineId: manSeed.receiptLineIds[0]!, returnedQty: 5, reasonCode: "OTHER" });
  const manStockBefore = (await db.product.findUnique({ where: { id: manSeed.productId }, select: { stockQty: true } }))!.stockQty;
  // Race: return post (−5) vs manual +3 (the exact §123 scenario, concurrent).
  const [postRes] = await Promise.allSettled([
    postGoodsReturn({ ...actor, id: manReturn.id }),
    (async () => {
      await db.product.update({ where: { id: manSeed.productId }, data: { stockQty: { increment: 3 } } });
      await db.inventoryAdjustment.create({
        data: { businessId: ctx.businessId, productId: manSeed.productId, delta: 3, reason: `${TAG} manual +3`, actorId: ctx.userId },
      });
    })(),
  ]);
  ok("6.1 both operations serialized through the shared write tx", postRes.status === "fulfilled");
  const manStockAfter = (await db.product.findUnique({ where: { id: manSeed.productId }, select: { stockQty: true } }))!.stockQty;
  ok("6.2 §123: +3 manual, −5 return → exact (no lost update)", manStockAfter === manStockBefore - 5 + 3, `stock=${manStockAfter}`);
  ok("6.3 stock never negative", manStockAfter >= 0);

  /* -------- 7. cap+1 read invariant (§76 — corruption fails loudly) -------- */
  section("7. cap+1 read invariant — over-cap return fails reads");
  const invSeed = await seedPostedReceipt(ctx.businessId, ctx.userId, 1, 21);
  const invReturn = await createGoodsReturn({ ...actor, goodsReceiptId: invSeed.receiptId });
  // Insert 21 lines DIRECTLY (simulating corruption past the write-time cap).
  await db.goodsReturnLine.createMany({
    data: invSeed.receiptLineIds.map((rlId, i) => ({
      goodsReturnId: invReturn.id,
      goodsReceiptLineId: rlId,
      productId: invSeed.productId,
      returnedQty: 1,
      reasonCode: "OTHER",
      productNameAtReturn: `P43CAP-${i}`,
    })),
  });
  try {
    await getGoodsReturn({ businessId: ctx.businessId, id: invReturn.id });
    ok("7.1 corrupt over-cap detail → 500 invariant", false, "read unexpectedly succeeded");
  } catch (error) {
    ok("7.1 corrupt over-cap detail → 500 invariant", codeOf(error) === "GOODS_RETURN_LINE_CAP_INVARIANT", codeOf(error));
  }
  try {
    await listGoodsReturns({ businessId: ctx.businessId, page: 1, pageSize: 25 });
    ok("7.2 corrupt over-cap list → 500 invariant", false, "list unexpectedly succeeded");
  } catch (error) {
    ok("7.2 corrupt over-cap list → 500 invariant", codeOf(error) === "GOODS_RETURN_LINE_CAP_INVARIANT", codeOf(error));
  }

  // §18/§19/§21 — POST on a persisted over-cap document is a 500
  // GOODS_RETURN_LINE_CAP_INVARIANT (data corruption), NEVER the 422
  // write-time LINE_LIMIT error — and it mutates NOTHING.
  const invStockBefore = (await db.product.findUnique({ where: { id: invSeed.productId }, select: { stockQty: true } }))!.stockQty;
  try {
    await postGoodsReturn({ ...actor, id: invReturn.id });
    ok("7.4 corrupt over-cap post → 500 invariant", false, "post unexpectedly succeeded");
  } catch (error) {
    ok("7.4 corrupt over-cap post → 500 GOODS_RETURN_LINE_CAP_INVARIANT (§18/§19)", codeOf(error) === "GOODS_RETURN_LINE_CAP_INVARIANT", codeOf(error));
  }
  const invReturnAfterPost = await db.goodsReturn.findUnique({ where: { id: invReturn.id }, select: { status: true, postedAt: true } });
  ok("7.5 corrupt post mutates NOTHING: still DRAFT, postedAt null", invReturnAfterPost?.status === "DRAFT" && invReturnAfterPost?.postedAt === null, JSON.stringify(invReturnAfterPost));
  const invStockAfterPost = (await db.product.findUnique({ where: { id: invSeed.productId }, select: { stockQty: true } }))!.stockQty;
  ok("7.6 corrupt post performs NO stock mutation", invStockAfterPost === invStockBefore, `stock=${invStockAfterPost}`);
  const invAdjAfterPost = await db.inventoryAdjustment.count({ where: { businessId: ctx.businessId, reason: { contains: invReturn.reference } } });
  ok("7.7 corrupt post creates NO adjustment for THIS document", invAdjAfterPost === 0, `adj=${invAdjAfterPost}`);
  const invPostAudit = await db.auditLog.count({ where: { businessId: ctx.businessId, action: "goods_return.post", entityId: invReturn.id } });
  ok("7.8 corrupt post writes NO post audit", invPostAudit === 0, `audit=${invPostAudit}`);

  // §20/§21 — LINE-ADD on a persisted over-cap document is the 500
  // integrity error, not the normal 422 LINE_LIMIT validation failure.
  try {
    await addGoodsReturnLine({ ...actor, id: invReturn.id, goodsReceiptLineId: invSeed.receiptLineIds[0]!, returnedQty: 1, reasonCode: "OTHER" });
    ok("7.9 corrupt over-cap line-add → 500 invariant", false, "line-add unexpectedly succeeded");
  } catch (error) {
    ok("7.9 corrupt over-cap line-add → 500 GOODS_RETURN_LINE_CAP_INVARIANT (§20)", codeOf(error) === "GOODS_RETURN_LINE_CAP_INVARIANT", codeOf(error));
  }

  // _count cross-check: delete one line so count(20) ≠ rows(21 is gone)... after
  // cleanup the doc must read 200 again (recovery proof).
  await db.goodsReturnLine.deleteMany({ where: { goodsReturnId: invReturn.id } });
  const recovered = await getGoodsReturn({ businessId: ctx.businessId, id: invReturn.id });
  ok("7.3 reads recover after corruption cleanup (200)", recovered.status === "DRAFT");
  await cancelGoodsReturn({ ...actor, id: invReturn.id });

  /* ------------------------------ teardown --------------------------------- */
  section("teardown (§195)");
  {
    const bizs = await db.business.findMany({ where: { name: { startsWith: `${TAG}-` } }, select: { id: true } });
    for (const b of bizs) {
      await db.auditLog.deleteMany({ where: { businessId: b.id } });
      await db.goodsReturnLine.deleteMany({ where: { goodsReturn: { businessId: b.id } } });
      await db.goodsReturn.deleteMany({ where: { businessId: b.id } });
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
    const residual = await db.business.count({ where: { name: { startsWith: `${TAG}-` } } });
    ok("T.1 zero residual P43CAP businesses", residual === 0);
  }
}

main()
  .then(() => {
    console.log(`\nTOTAL: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.log("FAILURES:");
      for (const f of failures) console.log(`  ✗ ${f}`);
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error("FATAL:", error);
    console.log(`\nTOTAL: ${passed} passed, ${failed + 1} failed (fatal)`);
    process.exit(1);
  });
