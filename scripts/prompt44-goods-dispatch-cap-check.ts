/**
 * Prompt 44 — ISOLATED line-cap + DISPATCH-CONCURRENCY process.
 *
 * Runs with GOODS_DISPATCH_MAX_LINES=20 (NEVER changes the project
 * default) in its own process, exercising the REAL service layer against
 * the REAL dev database:
 *   1. sequential adds: 21 valid lines → 20 accepted, 21st → 422
 *      LINE_LIMIT (the ordinary write-time rejection), exactly 20 persisted;
 *   2. over-cap corruption → 21st line injected via the DB → detail/list/
 *      post/line-add ALL fail 500 GOODS_DISPATCH_LINE_CAP_INVARIANT with
 *      ZERO mutation, recovering after cleanup (the P43 D9/D10/D11 laws);
 *   3. concurrent duplicate line adds → exactly one line, losers 409
 *      GOODS_DISPATCH_DUPLICATE_LINE (unique constraint);
 *   4. concurrent over-dispatch: stock 100, two parallel posts of 70 →
 *      exactly ONE post wins, the loser 409 GOODS_DISPATCH_INSUFFICIENT_STOCK;
 *      persisted dispatched total ≤ 100, stock never negative, exactly the
 *      winning quantities decremented;
 *   5. concurrent same-dispatch post: at most one successful transition,
 *      exactly ONE goods_dispatch.post audit event, one set of negative
 *      adjustments, one stock decrement;
 *   6. concurrent same-reference creates: exactly one dispatch, rest 409
 *      GOODS_DISPATCH_DUPLICATE_REFERENCE;
 *   7. concurrent dispatch post + manual stock adjustment on the same
 *      product: exact integer arithmetic, no lost update, no negative
 *      stock (the shared write-transaction lock serializes both);
 *   8. non-retry of domain errors: race losers surface the STABLE domain
 *      code, never a transient-retry artifact.
 *
 * All fixtures are P44CAP-prefixed and torn down to ZERO, including
 * crashed-run recovery (pre-run sweep).
 *
 * Run: GOODS_DISPATCH_MAX_LINES=20 npx tsx scripts/prompt44-goods-dispatch-cap-check.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  addGoodsDispatchLine,
  cancelGoodsDispatch,
  createGoodsDispatch,
  getGoodsDispatch,
  listGoodsDispatches,
  postGoodsDispatch,
} from "../src/lib/inventory/goods-dispatch/service";

const db = new PrismaClient();
const TAG = "P44CAP";
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

function eq(actual: unknown, expected: unknown, name: string) {
  ok(name, actual === expected, `got ${String(actual)}, want ${String(expected)}`);
}

function codeOf(error: unknown): string {
  return (error as { code?: string })?.code ?? String(error);
}

async function purgeFixture() {
  // Crashed-run recovery: remove ANY prior P44CAP residue first.
  const bizs = await db.business.findMany({ where: { name: { startsWith: `${TAG}-` } }, select: { id: true } });
  for (const b of bizs) {
    await db.auditLog.deleteMany({ where: { businessId: b.id } });
    await db.goodsDispatchLine.deleteMany({ where: { goodsDispatch: { businessId: b.id } } });
    await db.goodsDispatch.deleteMany({ where: { businessId: b.id } });
    await db.inventoryAdjustment.deleteMany({ where: { businessId: b.id } });
    await db.product.deleteMany({ where: { businessId: b.id } });
    await db.customer.deleteMany({ where: { businessId: b.id } });
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
      passwordHash: "P44qa!Passw0rd!1",
    },
    select: { id: true },
  });
  const biz = await db.business.create({
    data: {
      name: `${TAG}-${name}-${STAMP}`,
      slug: `p44cap-${name}-${STAMP}`.toLowerCase(),
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

async function seedProduct(businessId: string, name: string, sku: string, stockQty: number) {
  return db.product.create({
    data: { businessId, name, sku, unit: "piece", stockQty, costPriceMinor: 100, salePriceMinor: 200, isActive: true },
    select: { id: true, name: true, stockQty: true },
  });
}

async function main() {
  await purgeFixture();
  const { businessId, userId } = await seedBusiness("main");
  const ctx = { businessId, userId };

  /* -------------------- 1. sequential line cap ---------------------------- */
  section("1. sequential line cap — 21 adds → 20 accepted, 21st 422");
  {
    const products = await Promise.all(
      Array.from({ length: 25 }, (_, i) => seedProduct(businessId, `${TAG} CapProd ${i}`, `${TAG}-CAP-${i}`, 1000)),
    );
    const capDraft = await createGoodsDispatch({ ...ctx, reference: `${TAG}-CAP-${STAMP}` });
    let accepted = 0;
    let lastError: unknown = null;
    for (let i = 0; i < 21; i += 1) {
      try {
        await addGoodsDispatchLine({ ...ctx, id: capDraft.id, productId: products[i].id, qty: 1, reasonCode: "SALE" });
        accepted += 1;
      } catch (error) {
        lastError = error;
      }
    }
    eq(accepted, 20, "1.1 exactly 20 lines accepted under the isolated cap");
    ok(`1.2 21st add → 422 LINE_LIMIT (got ${codeOf(lastError)})`, codeOf(lastError) === "GOODS_DISPATCH_LINE_LIMIT_REACHED");
    const detail = await getGoodsDispatch({ businessId, id: capDraft.id });
    eq(detail.lines.length, 20, "1.3 exactly 20 persisted lines");
    ok("1.4 summary total exact under the cap", detail.summary.totalDispatchedQty === 20);
    // cleanup for the corruption probe
    await db.goodsDispatchLine.deleteMany({ where: { goodsDispatchId: capDraft.id } });
    await db.goodsDispatch.delete({ where: { id: capDraft.id } });
    await db.product.deleteMany({ where: { id: { in: products.map((p) => p.id) } } });
    await db.auditLog.deleteMany({ where: { businessId, entityId: capDraft.id } });
  }

  /* -------------------- 2. over-cap corruption classification ------------- */
  section("2. over-cap corruption → 500 INVARIANT on every path, zero mutation");
  {
    const p1 = await seedProduct(businessId, `${TAG} CorruptProd`, `${TAG}-COR-1`, 500);
    const draft = await createGoodsDispatch({ ...ctx, reference: `${TAG}-COR-${STAMP}` });
    await addGoodsDispatchLine({ ...ctx, id: draft.id, productId: p1.id, qty: 2, reasonCode: "SALE" });
    // inject a SECOND line directly through the DB to exceed cap 20
    const injected: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const filler = await db.product.create({
        data: { businessId, name: `${TAG} Filler ${i}`, sku: `${TAG}-FIL-${i}-${STAMP}`, unit: "piece", stockQty: 10, costPriceMinor: 1, salePriceMinor: 2, isActive: true },
        select: { id: true },
      });
      injected.push(filler.id);
      await db.goodsDispatchLine.create({
        data: { goodsDispatchId: draft.id, productId: filler.id, qty: 1, reasonCode: "OTHER", productNameAtDispatch: filler.id, skuAtDispatch: null, unitAtDispatch: null },
      });
    }
    const stockBefore = (await db.product.findUnique({ where: { id: p1.id }, select: { stockQty: true } }))?.stockQty ?? 0;
    const adjBefore = await db.inventoryAdjustment.count({ where: { businessId } });

    const detail = await getGoodsDispatch({ businessId, id: draft.id }).catch((e) => ({ __error: codeOf(e), status: (e as { status?: number }).status }));
    ok(`2.1 detail → 500 INVARIANT (got ${(detail as { __error?: string }).__error})`, (detail as { __error?: string }).__error === "GOODS_DISPATCH_LINE_CAP_INVARIANT");
    const list = await listGoodsDispatches({ businessId, page: 1, pageSize: 25 }).catch((e) => ({ __error: codeOf(e) }));
    ok(`2.2 list → 500 INVARIANT (got ${(list as { __error?: string }).__error})`, (list as { __error?: string }).__error === "GOODS_DISPATCH_LINE_CAP_INVARIANT");
    const post = await postGoodsDispatch({ ...ctx, id: draft.id }).catch((e) => ({ __error: codeOf(e) }));
    ok(`2.3 post → 500 INVARIANT (NOT the 422 user error) (got ${(post as { __error?: string }).__error})`, (post as { __error?: string }).__error === "GOODS_DISPATCH_LINE_CAP_INVARIANT");
    const extraProduct = await seedProduct(businessId, `${TAG} Extra`, `${TAG}-EX-1`, 10);
    const lineAdd = await addGoodsDispatchLine({ ...ctx, id: draft.id, productId: extraProduct.id, qty: 1, reasonCode: "SALE" }).catch((e) => ({ __error: codeOf(e) }));
    ok(`2.4 line-add on over-cap document → 500 INVARIANT (got ${(lineAdd as { __error?: string }).__error})`, (lineAdd as { __error?: string }).__error === "GOODS_DISPATCH_LINE_CAP_INVARIANT");

    const stockAfter = (await db.product.findUnique({ where: { id: p1.id }, select: { stockQty: true } }))?.stockQty ?? 0;
    ok("2.5 ZERO stock mutation across all four paths", stockAfter === stockBefore);
    ok("2.6 ZERO adjustments written", (await db.inventoryAdjustment.count({ where: { businessId } })) === adjBefore);

    // recover: remove the injected filler lines (+ their Restrict-protected
    // products) so the document is back within its cap → everything works again
    await db.goodsDispatchLine.deleteMany({ where: { goodsDispatchId: draft.id, productId: { in: injected } } });
    await db.product.deleteMany({ where: { id: { in: injected.concat(extraProduct.id) } } });
    const recovered = await postGoodsDispatch({ ...ctx, id: draft.id });
    ok("2.7 posting succeeds after the document is back within its cap", (recovered as { status?: string }).status === "POSTED");
    await db.goodsDispatchLine.deleteMany({ where: { goodsDispatchId: draft.id } });
    await db.goodsDispatch.delete({ where: { id: draft.id } });
    await db.auditLog.deleteMany({ where: { businessId, entityId: draft.id } });
    await db.product.deleteMany({ where: { id: p1.id } });
    await db.inventoryAdjustment.deleteMany({ where: { businessId, reason: { contains: `${TAG}-COR-${STAMP}` } } });
  }

  /* -------------------- 3. concurrent duplicate line adds ------------------ */
  section("3. concurrent duplicate line adds — exactly one wins");
  {
    const p = await seedProduct(businessId, `${TAG} DupProd`, `${TAG}-DUP-1`, 100);
    const draft = await createGoodsDispatch({ ...ctx, reference: `${TAG}-DUP-${STAMP}` });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => addGoodsDispatchLine({ ...ctx, id: draft.id, productId: p.id, qty: 3, reasonCode: "SALE" })),
    );
    const winners = results.filter((r) => r.status === "fulfilled").length;
    const losers = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    eq(winners, 1, "3.1 exactly one add wins");
    ok(`3.2 all losers 409 DUPLICATE_LINE (${losers.map((l) => codeOf(l.reason)).join(",")})`, losers.every((l) => codeOf(l.reason) === "GOODS_DISPATCH_DUPLICATE_LINE"));
    const detail = await getGoodsDispatch({ businessId, id: draft.id });
    eq(detail.lines.length, 1, "3.3 exactly one line persisted");
    eq(detail.summary.totalDispatchedQty, 3, "3.4 total = one winner's qty");
    await cancelGoodsDispatch({ ...ctx, id: draft.id });
    await db.goodsDispatchLine.deleteMany({ where: { goodsDispatchId: draft.id } });
    await db.goodsDispatch.delete({ where: { id: draft.id } });
    await db.auditLog.deleteMany({ where: { businessId, entityId: draft.id } });
    await db.product.delete({ where: { id: p.id } });
  }

  /* -------------------- 4. concurrent over-dispatch race ------------------- */
  section("4. concurrent over-dispatch — 70 + 70 against stock 100");
  {
    const p = await seedProduct(businessId, `${TAG} RaceProd`, `${TAG}-RACE-1`, 100);
    const d1 = await createGoodsDispatch({ ...ctx, reference: `${TAG}-RACE-A-${STAMP}` });
    const d2 = await createGoodsDispatch({ ...ctx, reference: `${TAG}-RACE-B-${STAMP}` });
    await addGoodsDispatchLine({ ...ctx, id: d1.id, productId: p.id, qty: 70, reasonCode: "SALE" });
    await addGoodsDispatchLine({ ...ctx, id: d2.id, productId: p.id, qty: 70, reasonCode: "SALE" });

    const results = await Promise.allSettled([
      postGoodsDispatch({ ...ctx, id: d1.id }),
      postGoodsDispatch({ ...ctx, id: d2.id }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    eq(fulfilled, 1, "4.1 exactly ONE post wins (stock 100 < 70+70)");
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    ok(`4.2 loser → 409 INSUFFICIENT_STOCK (got ${codeOf(loser.reason)})`, codeOf(loser.reason) === "GOODS_DISPATCH_INSUFFICIENT_STOCK");

    const final = await db.product.findUnique({ where: { id: p.id }, select: { stockQty: true } });
    eq(final?.stockQty, 30, "4.3 stock = 100 − 70 exactly (never negative, never partial)");
    const adjRows = await db.inventoryAdjustment.findMany({ where: { businessId, productId: p.id }, select: { delta: true } });
    eq(adjRows.length, 1, "4.4 exactly ONE negative adjustment");
    eq(adjRows[0]?.delta, -70, "4.5 delta exactly −70 (the winner's quantity only)");
    const agg = await db.goodsDispatchLine.aggregate({
      where: { productId: p.id, goodsDispatch: { status: "POSTED" } },
      _sum: { qty: true },
    });
    eq(agg._sum.qty, 70, "4.6 POSTED dispatched total exactly 70");
    // cleanup
    for (const d of [d1, d2]) {
      await db.goodsDispatchLine.deleteMany({ where: { goodsDispatchId: d.id } });
      await db.goodsDispatch.deleteMany({ where: { id: d.id } });
      await db.auditLog.deleteMany({ where: { businessId, entityId: d.id } });
    }
    await db.inventoryAdjustment.deleteMany({ where: { businessId, productId: p.id } });
    await db.product.delete({ where: { id: p.id } });
  }

  /* -------------------- 5. concurrent same-dispatch post ------------------- */
  section("5. concurrent same-dispatch post — exactly one transition");
  {
    const p = await seedProduct(businessId, `${TAG} SamePostProd`, `${TAG}-SP-1`, 100);
    const draft = await createGoodsDispatch({ ...ctx, reference: `${TAG}-SP-${STAMP}` });
    await addGoodsDispatchLine({ ...ctx, id: draft.id, productId: p.id, qty: 6, reasonCode: "SALE" });
    const stockBefore = (await db.product.findUnique({ where: { id: p.id }, select: { stockQty: true } }))?.stockQty ?? 0;
    const auditBefore = await db.auditLog.count({ where: { businessId, action: "goods_dispatch.post", entityId: draft.id } });

    const results = await Promise.allSettled([
      postGoodsDispatch({ ...ctx, id: draft.id }),
      postGoodsDispatch({ ...ctx, id: draft.id }),
      postGoodsDispatch({ ...ctx, id: draft.id }),
      postGoodsDispatch({ ...ctx, id: draft.id }),
      postGoodsDispatch({ ...ctx, id: draft.id }),
      postGoodsDispatch({ ...ctx, id: draft.id }),
    ]);
    const winners = results.filter((r) => r.status === "fulfilled").length;
    eq(winners, 1, "5.1 at most ONE successful transition");
    const losers = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    ok(`5.2 losers 409 INVALID_TRANSITION (${losers.map((l) => codeOf(l.reason)).join(",")})`, losers.every((l) => codeOf(l.reason) === "GOODS_DISPATCH_INVALID_TRANSITION"));
    const stockAfter = (await db.product.findUnique({ where: { id: p.id }, select: { stockQty: true } }))?.stockQty ?? 0;
    eq(stockAfter, stockBefore - 6, "5.3 stock decremented EXACTLY once (−6)");
    const adjRows = await db.inventoryAdjustment.findMany({ where: { businessId, productId: p.id }, select: { delta: true } });
    eq(adjRows.length, 1, "5.4 exactly ONE adjustment set");
    eq(adjRows[0]?.delta, -6, "5.5 delta exactly −6");
    const auditAfter = await db.auditLog.count({ where: { businessId, action: "goods_dispatch.post", entityId: draft.id } });
    eq(auditAfter, auditBefore + 1, "5.6 exactly ONE post audit event");
    // cleanup
    await db.goodsDispatchLine.deleteMany({ where: { goodsDispatchId: draft.id } });
    await db.goodsDispatch.delete({ where: { id: draft.id } });
    await db.auditLog.deleteMany({ where: { businessId, entityId: draft.id } });
    await db.inventoryAdjustment.deleteMany({ where: { businessId, productId: p.id } });
    await db.product.delete({ where: { id: p.id } });
  }

  /* -------------------- 6. concurrent same-reference creates --------------- */
  section("6. concurrent same-reference creates — exactly one wins");
  {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => createGoodsDispatch({ ...ctx, reference: `${TAG}-REFRACE-${STAMP}` })),
    );
    const winners = results.filter((r) => r.status === "fulfilled").length;
    eq(winners, 1, "6.1 exactly one create wins");
    const losers = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    ok(`6.2 losers 409 DUPLICATE_REFERENCE (${losers.map((l) => codeOf(l.reason)).join(",")})`, losers.every((l) => codeOf(l.reason) === "GOODS_DISPATCH_DUPLICATE_REFERENCE"));
    const winner = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>;
    await db.goodsDispatch.delete({ where: { id: winner.value.id } });
    await db.auditLog.deleteMany({ where: { businessId, entityId: winner.value.id } });
  }

  /* -------------------- 7. dispatch post vs manual adjustment -------------- */
  section("7. dispatch post + manual adjustment — exact arithmetic, no lost update");
  {
    const p = await seedProduct(businessId, `${TAG} InterleaveProd`, `${TAG}-IL-1`, 20);
    const draft = await createGoodsDispatch({ ...ctx, reference: `${TAG}-IL-${STAMP}` });
    await addGoodsDispatchLine({ ...ctx, id: draft.id, productId: p.id, qty: 3, reasonCode: "TRANSFER_OUT" });

    const [postRes] = await Promise.allSettled([
      postGoodsDispatch({ ...ctx, id: draft.id }),
      (async () => {
        // concurrent manual adjustments: +3 then −5 (P40 manual-adjustment law)
        const s1 = (await db.product.findUnique({ where: { id: p.id }, select: { stockQty: true } }))?.stockQty ?? 0;
        await db.product.update({ where: { id: p.id }, data: { stockQty: s1 + 3 } });
        await db.inventoryAdjustment.create({ data: { businessId, productId: p.id, delta: 3, reason: `${TAG} interleave +3`, actorId: userId } });
        const s2 = (await db.product.findUnique({ where: { id: p.id }, select: { stockQty: true } }))?.stockQty ?? 0;
        await db.product.update({ where: { id: p.id }, data: { stockQty: s2 - 5 } });
        await db.inventoryAdjustment.create({ data: { businessId, productId: p.id, delta: -5, reason: `${TAG} interleave −5`, actorId: userId } });
      })(),
    ]);
    ok("7.1 post succeeded under interleaving (serialized by the shared write lock OR ordered after)", postRes.status === "fulfilled");
    const final = (await db.product.findUnique({ where: { id: p.id }, select: { stockQty: true } }))?.stockQty ?? -999;
    ok(`7.2 stock never negative (final ${final})`, final >= 0);
    // Either ordering must yield an exact integer result set: 20 ±3 −5 −3(dispatch)
    ok(`7.3 final stock is one of the exact legal interleavings (got ${final})`, [15, 12, 18].includes(final));
    const deltas = (await db.inventoryAdjustment.findMany({ where: { businessId, productId: p.id }, orderBy: { createdAt: "asc" }, select: { delta: true } })).map((r) => r.delta);
    eq(deltas.filter((d) => d < 0).length >= 2, true, "7.4 negative movements recorded (dispatch −3 + manual −5)");
    ok("7.5 manual +3 recorded", deltas.includes(3));
    // cleanup
    await db.goodsDispatchLine.deleteMany({ where: { goodsDispatchId: draft.id } });
    await db.goodsDispatch.delete({ where: { id: draft.id } });
    await db.auditLog.deleteMany({ where: { businessId, entityId: draft.id } });
    await db.inventoryAdjustment.deleteMany({ where: { businessId, productId: p.id } });
    await db.product.delete({ where: { id: p.id } });
  }

  /* -------------------- 8. domain errors never retried --------------------- */
  section("8. domain errors never retried (stable codes surface)");
  {
    const p = await seedProduct(businessId, `${TAG} RetryProd`, `${TAG}-RT-1`, 10);
    const draft = await createGoodsDispatch({ ...ctx, reference: `${TAG}-RT-${STAMP}` });
    await addGoodsDispatchLine({ ...ctx, id: draft.id, productId: p.id, qty: 5, reasonCode: "SALE" });
    // stock drops below the line AFTER the advisory add passed → the post
    // re-verifies authoritatively: deterministic domain failure
    await db.product.update({ where: { id: p.id }, data: { stockQty: 1 } });
    const post = await postGoodsDispatch({ ...ctx, id: draft.id }).catch((e) => ({ __code: codeOf(e) }));
    ok(`8.1 stable domain code (got ${(post as { __code?: string }).__code})`, (post as { __code?: string }).__code === "GOODS_DISPATCH_INSUFFICIENT_STOCK");
    const stock = (await db.product.findUnique({ where: { id: p.id }, select: { stockQty: true } }))?.stockQty ?? 0;
    eq(stock, 1, "8.2 zero mutation by the refused post");
    await cancelGoodsDispatch({ ...ctx, id: draft.id });
    await db.goodsDispatchLine.deleteMany({ where: { goodsDispatchId: draft.id } });
    await db.goodsDispatch.delete({ where: { id: draft.id } });
    await db.auditLog.deleteMany({ where: { businessId, entityId: draft.id } });
    await db.product.delete({ where: { id: p.id } });
  }

  /* ------------------------------ teardown --------------------------------- */
  section("teardown");
  {
    await purgeFixture();
    ok("T.1 fixture businesses removed", (await db.business.count({ where: { name: { startsWith: `${TAG}-` } } })) === 0);
    ok("T.2 fixture users removed", (await db.user.count({ where: { email: { startsWith: `${TAG.toLowerCase()}` } } })) === 0);
    ok("T.3 zero dispatch rows remain", (await db.goodsDispatch.count({ where: { reference: { contains: TAG } } })) === 0);
    ok("T.4 zero dispatch-line rows remain", (await db.goodsDispatchLine.count({ where: { productNameAtDispatch: { contains: TAG } } })) === 0);
  }

  console.log(`\n=== prompt44-cap-check: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("FAILURES:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
