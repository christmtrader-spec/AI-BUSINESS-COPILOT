/**
 * Prompt 47 — ISOLATED line-cap + SALES-QUOTATION CONCURRENCY process.
 *
 * Runs with SALES_QUOTATION_MAX_LINES=20 (NEVER changes the project default)
 * in its own process, exercising the REAL service layer against the REAL
 * dev database (the same harness law as the P42–P45 cap checks — the dev DB
 * is shared but every fixture row is P47CAP-prefixed and torn down to ZERO,
 * including crashed-run recovery):
 *   1. cap parsing: default / malformed → 200, below-min → 20 clamp,
 *      above-max → 500 clamp (§11 — never unbounded);
 *   2. sequential adds: 21 valid lines → 20 accepted, 21st → 422
 *      SALES_QUOTATION_LINE_LIMIT_REACHED (ordinary write-time rejection),
 *      exactly 20 persisted;
 *   3. over-cap corruption → a 21st line injected via the DB → detail/
 *      list/export ALL fail 500 SALES_QUOTATION_LINE_CAP_INVARIANT with
 *      ZERO mutation, recovering after cleanup (the P43 D9–D11 laws);
 *   4. exact-integer overflow: ONE max-magnitude line (1_000_000 ×
 *      9_000_000_000 = 9×10^15) is exactly safe and accepted; a SECOND
 *      max-magnitude line overflows the ACCUMULATED subtotal → 422
 *      SALES_QUOTATION_TOTAL_OVERFLOW (input-time law §11; the rejected
 *      line does NOT persist); the persisted-corruption path (a second max
 *      line injected via the DB) fails reads with the integrity 500;
 *   5. concurrent duplicate product lines → exactly one line, losers 409
 *      SALES_QUOTATION_DUPLICATE_PRODUCT (unique constraint);
 *   6. concurrent mark-sent vs line-add → no edit sneaks into SENT (the
 *      final line set is consistent with the add result);
 *   7. concurrent accept vs expire on a valid offer → the validity law
 *      holds (exactly one wins; ACCEPTED and EXPIRED never both);
 *   8. concurrent duplicate-reference creates → exactly one quotation,
 *      losers 409 SALES_QUOTATION_DUPLICATE_REFERENCE;
 *   9. conversion failure ROLLBACK: the cheapest SAFE simulation — the
 *      quotation's discountMinor is corrupted DIRECTLY in the DB (above
 *      the subtotal) AFTER acceptance, so the in-transaction conversion
 *      guard fails. Asserted: NO SalesOrder, quotation stays ACCEPTED (no
 *      CONVERTED/convertedAt), zero sales_order.create /
 *      sales_quotation.convert audit rows, zero stock/finance mutation;
 *  10. audit atomicity: every mutation produced EXACTLY its expected audit
 *      rows (the shared withWriteTransaction law — audit failure rolls back
 *      the mutation, so a committed mutation must always have its rows).
 *
 * Run: SALES_QUOTATION_MAX_LINES=20 bun --preload ./scripts/lib/register-server-only-shim.ts \
 *      scripts/prompt47-sales-quotation-cap-check.ts
 * (the shim neutralizes the `server-only` guard for out-of-process runs —
 * plain tsx/node CANNOT import the server service modules).
 */
import { PrismaClient } from "@prisma/client";
import {
  acceptSalesQuotation,
  addSalesQuotationLine,
  cancelSalesQuotation,
  convertSalesQuotationToOrder,
  createSalesQuotation,
  expireSalesQuotation,
  getSalesQuotation,
  listSalesQuotations,
  markSalesQuotationSent,
  updateSalesQuotationLine,
} from "../src/lib/sales-quotations/service";
import { buildSalesQuotationCsv } from "../src/lib/sales-quotations/export";
import {
  SALES_QUOTATION_LINE_CAP_DEFAULT,
  SALES_QUOTATION_LINE_CAP_MAX,
  SALES_QUOTATION_LINE_CAP_MIN,
  salesQuotationLineCap,
} from "../src/lib/sales-quotations/types";

const db = new PrismaClient();
const TAG = "P47CAP";
const STAMP = `${Date.now()}`.slice(-8);

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
function eq2(actual: unknown, expected: unknown, name: string) {
  ok(name, actual === expected, `got ${String(actual)}, want ${String(expected)}`);
}
function codeOf(error: unknown): string {
  return (error as { code?: string })?.code ?? String(error);
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

async function purge() {
  const bizs = await db.business.findMany({ where: { name: { startsWith: `${TAG}-` } }, select: { id: true } });
  for (const b of bizs) {
    await db.auditLog.deleteMany({ where: { businessId: b.id } });
    await db.salesOrderLine.deleteMany({ where: { salesOrder: { businessId: b.id } } });
    await db.salesOrder.deleteMany({ where: { businessId: b.id } });
    await db.salesQuotationLine.deleteMany({ where: { salesQuotation: { businessId: b.id } } });
    await db.salesQuotation.deleteMany({ where: { businessId: b.id } });
    await db.payment.deleteMany({ where: { businessId: b.id } });
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

const CTX = () => ({ businessId: "", userId: "", timezone: "Asia/Tehran" }); // matches the fixture business timezone
const calDate = (d: Date) => d.toISOString().slice(0, 10);
const futureDate = (n: number) => calDate(new Date(Date.now() + n * 86_400_000));

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
      timezone: "Asia/Tehran",
    },
  });
  const ctx = CTX();
  ctx.businessId = biz.id;
  ctx.userId = owner.id;

  const product = await db.product.create({
    data: { businessId: biz.id, name: `${TAG} Stocked`, sku: `${TAG}-SKU`, salePriceMinor: 100, stockQty: 500 },
  });

  /* ---------------- 1. cap parsing (§11) ---------------- */
  section("1. cap parsing (SALES_QUOTATION_MAX_LINES env law)");
  eq2(SALES_QUOTATION_LINE_CAP_DEFAULT, 200, "1.1 default cap 200");
  eq2(SALES_QUOTATION_LINE_CAP_MIN, 20, "1.2 min cap 20");
  eq2(SALES_QUOTATION_LINE_CAP_MAX, 500, "1.3 max cap 500");
  eq2(salesQuotationLineCap(process.env.SALES_QUOTATION_MAX_LINES), 20, "1.4 the suite's env (20) is honored");
  eq2(salesQuotationLineCap(undefined), 200, "1.5 undefined env → default 200");
  eq2(salesQuotationLineCap("garbage"), 200, "1.6 malformed env → default 200");
  eq2(salesQuotationLineCap("10"), 20, "1.7 below min → clamped UP to 20");
  eq2(salesQuotationLineCap("1000"), 500, "1.8 above max → clamped DOWN to 500");
  eq2(salesQuotationLineCap("500"), 500, "1.9 max boundary accepted");
  eq2(salesQuotationLineCap("20"), 20, "1.10 min boundary accepted");

  /* ---------------- 2. sequential line cap ---------------- */
  section("2. sequential line cap (SALES_QUOTATION_MAX_LINES=20)");
  const capped = await createSalesQuotation({ ...ctx, validUntilDate: futureDate(30), reference: `${TAG}-CAP` });
  let accepted = 0;
  let limitError = "";
  for (let i = 0; i < 21; i += 1) {
    const p = await db.product.create({
      data: { businessId: biz.id, name: `${TAG} P${i}`, sku: `${TAG}-P${i}`, salePriceMinor: 10, stockQty: 5 },
    });
    try {
      await addSalesQuotationLine({ ...ctx, id: capped.id, productId: p.id, qty: 1 });
      accepted += 1;
    } catch (error) {
      limitError = codeOf(error);
    }
  }
  eq2(accepted, 20, "2.1 exactly 20 lines accepted");
  ok(`2.2 21st line → 422 LINE_LIMIT (${limitError})`, limitError === "SALES_QUOTATION_LINE_LIMIT_REACHED");
  const cappedCount = await db.salesQuotationLine.count({ where: { salesQuotationId: capped.id } });
  eq2(cappedCount, 20, "2.3 exactly 20 lines persisted");

  /* ---------------- 3. over-cap corruption (§11) ---------------- */
  section("3. over-cap corruption → controlled 500, zero mutation");
  const extra = await db.product.create({
    data: { businessId: biz.id, name: `${TAG} Extra`, sku: `${TAG}-X`, salePriceMinor: 10 },
  });
  await db.salesQuotationLine.create({
    data: {
      salesQuotationId: capped.id,
      productId: extra.id,
      qty: 1,
      unitPriceMinor: 10,
      productNameAtQuotation: extra.name,
    },
  }); // direct DB injection → 21 lines (corruption)
  const capDetail = await safe(() => getSalesQuotation({ businessId: biz.id, id: capped.id, timezone: "Asia/Tehran" }));
  eq2(capDetail.status, 500, "3.1 detail fails 500");
  eq2(capDetail.code, "SALES_QUOTATION_LINE_CAP_INVARIANT", "3.2 stable invariant code");
  const capList = await safe(() => listSalesQuotations({ businessId: biz.id, page: 1, pageSize: 25, timezone: "Asia/Tehran" }));
  eq2(capList.status, 500, "3.3 list fails 500 on the corrupted row");
  eq2(capList.code, "SALES_QUOTATION_LINE_CAP_INVARIANT", "3.4 stable invariant code (list)");
  const capExport = await safe(() => buildSalesQuotationCsv({ businessId: biz.id, id: capped.id, locale: "en" }));
  eq2(capExport.status, 500, "3.5 export fails 500 (never a truncated CSV)");
  eq2(capExport.code, "SALES_QUOTATION_LINE_CAP_INVARIANT", "3.6 stable invariant code (export)");
  const capAdd = await safe(() => addSalesQuotationLine({ ...ctx, id: capped.id, productId: product.id, qty: 1 }));
  eq2(capAdd.status, 500, "3.7 line-add on corrupted quotation fails 500 (not the 422 user path)");
  eq2(capAdd.code, "SALES_QUOTATION_LINE_CAP_INVARIANT", "3.8 stable invariant code (line-add)");
  const capSend = await safe(() => markSalesQuotationSent({ ...ctx, id: capped.id }));
  eq2(capSend.status, 500, "3.9 mark-sent on corrupted quotation fails 500");
  eq2(capSend.code, "SALES_QUOTATION_LINE_CAP_INVARIANT", "3.10 stable invariant code (mark-sent)");
  await db.salesQuotationLine.delete({
    where: { id: (await db.salesQuotationLine.findFirst({ where: { salesQuotationId: capped.id, productId: extra.id } }))!.id },
  });
  const recovered = await getSalesQuotation({ businessId: biz.id, id: capped.id, timezone: "Asia/Tehran" });
  eq2(recovered.quotation.id, capped.id, "3.11 reads recover after cleanup");

  /* ------------- 4. exact-integer overflow (§11) ------------- */
  section("4. exact-integer overflow (accumulation crosses MAX_SAFE_INTEGER → 422/500)");
  // NOTE (discovered by this suite, reported to the orchestrator): the
  // documented price ceiling 9_000_000_000 cannot be PERSISTED — the
  // minor-unit money columns are Prisma `Int` (32-bit signed on read);
  // a stored value above 2_147_483_647 fails every later read with a
  // Prisma P2023 "Inconsistent column data" corruption error. This is a
  // PRE-EXISTING cross-module issue (Sale/SaleItem/PurchaseOrder/SalesOrder
  // share the same Int columns and the same 9e9 law). No migration may be
  // authored by the test task, so the overflow laws are exercised with
  // STORABLE magnitudes: line total 1_000_000 × 2_000_000_000 = 2×10^15
  // (safe per line); FIVE such lines accumulate past Number.MAX_SAFE_INTEGER.
  const BIG_PRICE = 2_000_000_000; // storable (< 2^31−1); line total 2×10^15
  const overQ = await createSalesQuotation({ ...ctx, validUntilDate: futureDate(30), reference: `${TAG}-OVER` });
  const maxLine1 = await addSalesQuotationLine({
    ...ctx,
    id: overQ.id,
    productId: product.id,
    qty: 1_000_000,
    unitPriceMinor: BIG_PRICE,
  });
  ok(`4.1 one max-magnitude line is exactly safe and accepted (id ${maxLine1.id})`, Boolean(maxLine1.id));
  const overQDetail1 = await getSalesQuotation({ businessId: biz.id, id: overQ.id, timezone: "Asia/Tehran" });
  eq2(overQDetail1.summary.subtotalMinor, 2_000_000_000_000_000, "4.2 subtotal = 2×10^15 (exactly inside the safe range)");
  // Each additional max line needs a DIFFERENT product (duplicate-product law).
  for (let i = 2; i <= 5; i += 1) {
    const pN = await db.product.create({
      data: { businessId: biz.id, name: `${TAG} Big ${i}`, sku: `${TAG}-BIG${i}`, salePriceMinor: BIG_PRICE, stockQty: 5 },
    });
    const res = await safe(() =>
      addSalesQuotationLine({ ...ctx, id: overQ.id, productId: pN.id, qty: 1_000_000, unitPriceMinor: BIG_PRICE }),
    );
    if (i < 5) {
      eq2(res.status, 200, `4.${i}.a line ${i} accumulates to ${i * 2}×10^15 — still safe, accepted`);
    } else {
      eq2(res.status, 422, "4.3 fifth max line overflows the ACCUMULATED subtotal → 422 (input-time TOTAL_OVERFLOW, tx rolled back)");
      eq2(res.code, "SALES_QUOTATION_TOTAL_OVERFLOW", "4.4 stable overflow code");
    }
  }
  eq2(await db.salesQuotationLine.count({ where: { salesQuotationId: overQ.id } }), 4, "4.5 exactly the four lawful lines persisted (the overflowing 5th rolled back)");
  // Persisted-corruption path: inject a fifth max line DIRECTLY in the DB
  // (storable values, overflowing SUM) — reads fail with the integrity 500,
  // never a fabricated total. BIG5 is the product whose overflow add was
  // rejected above, so it has NO line yet (the (quotation, product) unique
  // constraint admits the corruption probe exactly once).
  const product5 = await db.product.findFirst({ where: { businessId: biz.id, sku: `${TAG}-BIG5` } });
  await db.salesQuotationLine.create({
    data: {
      salesQuotationId: overQ.id,
      productId: product5!.id,
      qty: 1_000_000,
      unitPriceMinor: BIG_PRICE,
      productNameAtQuotation: product5!.name,
    },
  });
  const overRead = await safe(() => getSalesQuotation({ businessId: biz.id, id: overQ.id, timezone: "Asia/Tehran" }));
  eq2(overRead.status, 500, "4.6 corrupted-persisted overflow → read fails 500");
  eq2(overRead.code, "SALES_QUOTATION_TOTAL_OVERFLOW", "4.7 stable integrity overflow code (not a subtotal lie)");
  await db.salesQuotationLine.delete({
    where: { id: (await db.salesQuotationLine.findFirst({ where: { salesQuotationId: overQ.id, productId: product5!.id, qty: 1_000_000 } }))!.id },
  });
  const overRecovered = await getSalesQuotation({ businessId: biz.id, id: overQ.id, timezone: "Asia/Tehran" });
  eq2(overRecovered.summary.subtotalMinor, 8_000_000_000_000_000, "4.8 reads recover after cleanup (4 × 2×10^15)");
  // Line UPDATE with the same law: a tiny 5th line exists; updating it to
  // the max magnitude would overflow the ACCUMULATED subtotal → 422.
  await addSalesQuotationLine({ ...ctx, id: overQ.id, productId: product5!.id, qty: 1, unitPriceMinor: 1 });
  const overLines = await db.salesQuotationLine.findMany({ where: { salesQuotationId: overQ.id }, orderBy: { createdAt: "asc" } });
  eq2(overLines.length, 5, "4.8b tiny fifth line in place (8×10^15 + 1)");
  const updOverflow = await safe(() =>
    updateSalesQuotationLine({ ...ctx, id: overQ.id, lineId: overLines[4].id, qty: 1_000_000, unitPriceMinor: BIG_PRICE }),
  );
  eq2(updOverflow.status, 422, "4.9 line UPDATE that would overflow the accumulated subtotal → 422");
  eq2(updOverflow.code, "SALES_QUOTATION_TOTAL_OVERFLOW", "4.10 stable overflow code (update path)");
  eq2(
    (await db.salesQuotationLine.findUnique({ where: { id: overLines[4].id }, select: { qty: true } }))!.qty,
    1,
    "4.11 update rolled back (the tiny line keeps its lawful value)",
  );

  /* ------------- 5. concurrent duplicate product lines ------------- */
  section("5. concurrent duplicate product lines (§6)");
  const dupQ = await createSalesQuotation({ ...ctx, validUntilDate: futureDate(30), reference: `${TAG}-DUP` });
  const dupResults = await Promise.allSettled(
    Array.from({ length: 5 }, () => addSalesQuotationLine({ ...ctx, id: dupQ.id, productId: product.id, qty: 5 })),
  );
  const dupWins = dupResults.filter((r) => r.status === "fulfilled");
  const dupLoses = dupResults.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  eq2(dupWins.length, 1, "5.1 exactly ONE line created");
  eq2(dupLoses.length, 4, "5.2 four losers");
  ok("5.3 losers carry the stable duplicate code", dupLoses.every((l) => codeOf(l.reason) === "SALES_QUOTATION_DUPLICATE_PRODUCT"));
  eq2(await db.salesQuotationLine.count({ where: { salesQuotationId: dupQ.id } }), 1, "5.4 exactly one persisted line (DB uniqueness authoritative)");

  /* -------- 6. concurrent mark-sent vs line-add (§8/§10) -------- */
  section("6. concurrent mark-sent vs line-add (no edit sneaks into SENT)");
  const raceQ = await createSalesQuotation({ ...ctx, validUntilDate: futureDate(30), reference: `${TAG}-RACE1` });
  await addSalesQuotationLine({ ...ctx, id: raceQ.id, productId: product.id, qty: 1 });
  const preCount = await db.salesQuotationLine.count({ where: { salesQuotationId: raceQ.id } });
  const raceProduct = await db.product.create({
    data: { businessId: biz.id, name: `${TAG} Racer`, sku: `${TAG}-RACE`, salePriceMinor: 50, stockQty: 10 },
  });
  const [sendRes, addRes] = await Promise.allSettled([
    markSalesQuotationSent({ ...ctx, id: raceQ.id }),
    addSalesQuotationLine({ ...ctx, id: raceQ.id, productId: raceProduct.id, qty: 2 }),
  ]);
  const sendOk = sendRes.status === "fulfilled";
  const addOk = addRes.status === "fulfilled";
  const raceCount = await db.salesQuotationLine.count({ where: { salesQuotationId: raceQ.id } });
  const raceStatus = (await db.salesQuotation.findUnique({ where: { id: raceQ.id }, select: { status: true } }))!.status;
  eq2(raceStatus, "SENT", "6.1 final status SENT (mark-sent always eventually succeeds on a non-empty draft)");
  if (addOk) {
    eq2(raceCount, 2, "6.2 add won the lock FIRST → the line is part of the frozen offer (2 lines)");
    eq2(sendOk, true, "6.3 mark-sent then froze the 2-line offer");
  } else {
    eq2(raceCount, 1, "6.4 send won the lock FIRST → the late add is REJECTED (no post-send edit)");
    ok("6.5 losing add carries the stable immutable code", codeOf((addRes as PromiseRejectedResult).reason) === "SALES_QUOTATION_IMMUTABLE");
  }
  eq2(raceCount, addOk ? preCount + 1 : preCount, "6.6 the final line set is CONSISTENT with the add result (no partial write)");

  /* ------------ 7. concurrent accept vs expire (§9) ------------ */
  section("7. concurrent accept vs expire (validity law holds)");
  const valQ = await createSalesQuotation({ ...ctx, validUntilDate: futureDate(30), reference: `${TAG}-RACE2` });
  await addSalesQuotationLine({ ...ctx, id: valQ.id, productId: product.id, qty: 1 });
  await markSalesQuotationSent({ ...ctx, id: valQ.id });
  const [acceptRes, expireRes] = await Promise.allSettled([
    acceptSalesQuotation({ ...ctx, id: valQ.id }),
    expireSalesQuotation({ ...ctx, id: valQ.id }),
  ]);
  const acceptOk = acceptRes.status === "fulfilled";
  const expireOk = expireRes.status === "fulfilled";
  ok(`7.1 exactly one wins (${acceptOk ? "accept" : "expire"})`, acceptOk !== expireOk);
  const valStatus = (await db.salesQuotation.findUnique({ where: { id: valQ.id }, select: { status: true, acceptedAt: true } }))!;
  ok(
    "7.2 the persisted status is consistent (ACCEPTED or EXPIRED, never both)",
    (valStatus.status === "ACCEPTED" && Boolean(valStatus.acceptedAt)) ||
      (valStatus.status === "EXPIRED" && !valStatus.acceptedAt),
  );
  if (acceptOk) {
    ok(
      "7.3 losing expire carries a transition/validity domain code",
      expireRes.status === "rejected" && ["SALES_QUOTATION_INVALID_TRANSITION", "SALES_QUOTATION_NOT_EXPIRED"].includes(codeOf((expireRes as PromiseRejectedResult).reason)),
    );
  } else {
    ok(
      "7.3 losing accept carries the expired code (validity gate)",
      acceptRes.status === "rejected" && ["SALES_QUOTATION_INVALID_TRANSITION", "SALES_QUOTATION_EXPIRED"].includes(codeOf((acceptRes as PromiseRejectedResult).reason)),
    );
  }

  /* -------- 8. concurrent duplicate references (§10) -------- */
  section("8. concurrent duplicate-reference creates");
  const ref = `${TAG}-RACEREF`;
  const refResults = await Promise.allSettled(
    Array.from({ length: 5 }, () => createSalesQuotation({ ...ctx, validUntilDate: futureDate(30), reference: ref })),
  );
  const refWins = refResults.filter((r) => r.status === "fulfilled");
  const refLoses = refResults.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  eq2(refWins.length, 1, "8.1 exactly ONE quotation created");
  ok("8.2 losers carry the stable duplicate-reference code", refLoses.every((l) => codeOf(l.reason) === "SALES_QUOTATION_DUPLICATE_REFERENCE"));
  eq2(await db.salesQuotation.count({ where: { businessId: biz.id, reference: ref } }), 1, "8.3 exactly one persisted row");

  /* ------- 9. conversion failure rollback (§13/H) ------- */
  section("9. conversion failure rollback (discount corrupted directly in DB)");
  // Simulation (documented): an ACCEPTED quotation whose discountMinor is
  // corrupted DIRECTLY via Prisma to exceed the canonical subtotal. The
  // in-transaction conversion guard then fails AFTER the transaction began
  // — the cheapest SAFE way to exercise the rollback law without forging
  // FKs (Product is Restrict-referenced by quotation lines, so deleting it
  // is impossible; pointing the line at a foreign product keeps the FK
  // valid and does NOT fail the order-line insert).
  const convQ = await createSalesQuotation({ ...ctx, validUntilDate: futureDate(30), reference: `${TAG}-CONV` });
  await addSalesQuotationLine({ ...ctx, id: convQ.id, productId: product.id, qty: 3, unitPriceMinor: 1000 }); // subtotal 3000
  await markSalesQuotationSent({ ...ctx, id: convQ.id });
  await acceptSalesQuotation({ ...ctx, id: convQ.id });
  const stockBefore = (await db.product.findUnique({ where: { id: product.id }, select: { stockQty: true } }))!.stockQty;
  const adjBefore = await db.inventoryAdjustment.count({ where: { businessId: biz.id } });
  await db.salesQuotation.update({ where: { id: convQ.id }, data: { discountMinor: 9999 } }); // > subtotal (corruption)
  const convFail = await safe(() => convertSalesQuotationToOrder({ ...ctx, id: convQ.id }));
  eq2(convFail.status, 500, "9.1 conversion of corrupted-discount quotation fails 500 (integrity, not a user error)");
  eq2(convFail.code, "SALES_QUOTATION_CORRUPT_HISTORY", "9.2 stable corrupt-history code");
  eq2(await db.salesOrder.count({ where: { sourceQuotationId: convQ.id } }), 0, "9.3 NO SalesOrder created");
  const convQRow = await db.salesQuotation.findUnique({ where: { id: convQ.id }, select: { status: true, convertedAt: true } });
  eq2(convQRow?.status, "ACCEPTED", "9.4 quotation UNCHANGED (still ACCEPTED — rollback held)");
  eq2(convQRow?.convertedAt, null, "9.5 no convertedAt (rollback held)");
  eq2(await db.auditLog.count({ where: { businessId: biz.id, action: "sales_order.create" } }), 0, "9.6 zero sales_order.create audit rows");
  eq2(await db.auditLog.count({ where: { businessId: biz.id, action: "sales_quotation.convert" } }), 0, "9.7 zero sales_quotation.convert audit rows");
  const stockAfterFail = (await db.product.findUnique({ where: { id: product.id }, select: { stockQty: true } }))!.stockQty;
  eq2(stockAfterFail, stockBefore, "9.8 zero stock mutation from the failed conversion");
  eq2(await db.inventoryAdjustment.count({ where: { businessId: biz.id } }), adjBefore, "9.9 zero adjustments from the failed conversion");
  // Restore the lawful discount; conversion then succeeds and the audit
  // trail appears EXACTLY once (rollback law → atomicity law).
  await db.salesQuotation.update({ where: { id: convQ.id }, data: { discountMinor: 0 } });
  const convOk = await convertSalesQuotationToOrder({ ...ctx, id: convQ.id });
  ok(`9.10 conversion succeeds after the corruption is repaired (order ${convOk.salesOrder.reference})`, Boolean(convOk.salesOrder.id));
  eq2(await db.salesOrder.count({ where: { sourceQuotationId: convQ.id } }), 1, "9.11 exactly ONE order after the successful conversion");
  eq2((await db.salesQuotation.findUnique({ where: { id: convQ.id }, select: { status: true } }))!.status, "CONVERTED", "9.12 quotation CONVERTED");
  eq2(await db.auditLog.count({ where: { businessId: biz.id, action: "sales_quotation.convert", entityId: convQ.id } }), 1, "9.13 exactly ONE convert audit row");
  eq2(await db.auditLog.count({ where: { businessId: biz.id, action: "sales_order.create" } }), 1, "9.14 exactly ONE order-create audit row");

  /* ---------- 10. audit atomicity (withWriteTransaction law) ---------- */
  section("10. audit-failure atomicity: every committed mutation has EXACTLY its audit rows");
  const audQ = await createSalesQuotation({ ...ctx, validUntilDate: futureDate(30), reference: `${TAG}-AUD` });
  eq2(await db.auditLog.count({ where: { businessId: biz.id, action: "sales_quotation.create", entityId: audQ.id } }), 1, "10.1 create → exactly 1 sales_quotation.create audit");
  const audP1 = await db.product.create({ data: { businessId: biz.id, name: `${TAG} A1`, sku: `${TAG}-A1`, salePriceMinor: 10, stockQty: 5 } });
  const audP2 = await db.product.create({ data: { businessId: biz.id, name: `${TAG} A2`, sku: `${TAG}-A2`, salePriceMinor: 10, stockQty: 5 } });
  await addSalesQuotationLine({ ...ctx, id: audQ.id, productId: audP1.id, qty: 2 });
  await addSalesQuotationLine({ ...ctx, id: audQ.id, productId: audP2.id, qty: 1 });
  eq2(await db.auditLog.count({ where: { businessId: biz.id, action: "sales_quotation.line_add", entityId: audQ.id } }), 2, "10.2 two line-adds → exactly 2 line_add audits");
  await markSalesQuotationSent({ ...ctx, id: audQ.id });
  eq2(await db.auditLog.count({ where: { businessId: biz.id, action: "sales_quotation.mark_sent", entityId: audQ.id } }), 1, "10.3 mark-sent → exactly 1 mark_sent audit");
  await acceptSalesQuotation({ ...ctx, id: audQ.id });
  eq2(await db.auditLog.count({ where: { businessId: biz.id, action: "sales_quotation.accept", entityId: audQ.id } }), 1, "10.4 accept → exactly 1 accept audit");
  await cancelSalesQuotation({ ...ctx, id: dupQ.id }); // DRAFT cancel path
  eq2(await db.auditLog.count({ where: { businessId: biz.id, action: "sales_quotation.cancel", entityId: dupQ.id } }), 1, "10.5 cancel → exactly 1 cancel audit");
  // The stock NEVER moved across the WHOLE suite (quotation purity §1).
  const stockEnd = (await db.product.findUnique({ where: { id: product.id }, select: { stockQty: true } }))!.stockQty;
  eq2(stockEnd, stockBefore, "10.6 Product.stockQty byte-identical across the entire suite (§1 purity)");
  eq2(await db.inventoryAdjustment.count({ where: { businessId: biz.id } }), adjBefore, "10.7 zero InventoryAdjustment rows across the entire suite");
  eq2(await db.sale.count({ where: { businessId: biz.id } }), 0, "10.8 zero Sale rows (conversion creates no invoice §13)");

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

main()
  .catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
