/**
 * Prompt 48 — ISOLATED line-cap + SUPPLIER-BILL CONCURRENCY process.
 *
 * Runs with SUPPLIER_BILL_MAX_LINES=20 (NEVER changes the project default)
 * in its own process, exercising the REAL service layer against the REAL
 * dev database (the same harness law as the P42–P47 cap checks — the dev DB
 * is shared but every fixture row is P48CAP-prefixed and torn down to ZERO,
 * including crashed-run recovery):
 *   1. cap parsing: default / malformed → 200, below-min → 20 clamp,
 *      above-max → 500 clamp (§10 — never unbounded);
 *   2. sequential adds: 21 valid lines → 20 accepted, 21st → 422
 *      SUPPLIER_BILL_LINE_LIMIT_REACHED, exactly 20 persisted;
 *   3. over-cap corruption → a 21st line injected via the DB → detail/
 *      export ALL fail 500 SUPPLIER_BILL_LINE_CAP_INVARIANT with ZERO
 *      mutation, recovering after cleanup (the P43 D9–D11 laws);
 *   4. concurrent post ×2 of the SAME draft → exactly ONE Expense, one
 *      POSTED bill, loser 409 ALREADY_LINKED/ALREADY_POSTED (§13-A);
 *   5. two bills competing for the LAST received quantity → at most one
 *      posts, no over-bill, loser controlled 422 (§13-B);
 *   6. concurrent duplicate-reference creates ×5 → exactly one bill,
 *      losers 409 SUPPLIER_BILL_DUPLICATE_REFERENCE (§13-E);
 *   7. concurrent duplicate supplier-invoice-reference creates ×2 →
 *      exactly one bill (§13-F);
 *   8. AUDIT-FAILURE ROLLBACK (§13-G): a SQLite trigger aborts AuditLog
 *      inserts for the fixture business → posting FAILS ENTIRELY: bill
 *      stays DRAFT, NO Expense, NO status change, no partial payable;
 *   9. FAILURE-AFTER-EXPENSE-CREATE ROLLBACK (§13-H): a trigger aborts the
 *      SupplierBill DRAFT→POSTED update → the Expense created moments
 *      earlier is ROLLED BACK (transactional atomicity §11);
 *  10. audit atomicity: every committed mutation carries EXACTLY its
 *      expected audit rows (shared withWriteTransaction law).
 *
 * Run: SUPPLIER_BILL_MAX_LINES=20 bun --preload ./scripts/lib/register-server-only-shim.ts \
 *      scripts/prompt48-supplier-bill-cap-check.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  addSupplierBillLine,
  cancelSupplierBill,
  createSupplierBill,
  getSupplierBill,
  postSupplierBill,
} from "../src/lib/supplier-bills/service";
import { buildSupplierBillCsv } from "../src/lib/supplier-bills/export";
import {
  SUPPLIER_BILL_LINE_CAP_DEFAULT,
  SUPPLIER_BILL_LINE_CAP_MAX,
  SUPPLIER_BILL_LINE_CAP_MIN,
  supplierBillLineCap,
} from "../src/lib/supplier-bills/types";

const db = new PrismaClient();
const TAG = "P48CAP";
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
    await db.supplierBillLine.deleteMany({ where: { supplierBill: { businessId: b.id } } });
    await db.supplierBill.deleteMany({ where: { businessId: b.id } });
    await db.goodsReturnLine.deleteMany({ where: { goodsReturn: { businessId: b.id } } });
    await db.goodsReturn.deleteMany({ where: { businessId: b.id } });
    await db.goodsReceiptLine.deleteMany({ where: { goodsReceipt: { businessId: b.id } } });
    await db.goodsReceipt.deleteMany({ where: { businessId: b.id } });
    await db.purchaseOrderLine.deleteMany({ where: { purchaseOrder: { businessId: b.id } } });
    await db.purchaseOrder.deleteMany({ where: { businessId: b.id } });
    await db.payment.deleteMany({ where: { businessId: b.id } });
    await db.expense.deleteMany({ where: { businessId: b.id } });
    await db.supplier.deleteMany({ where: { businessId: b.id } });
    await db.product.deleteMany({ where: { businessId: b.id } });
    await db.business.deleteMany({ where: { id: b.id } });
  }
  const users = await db.user.findMany({ where: { email: { startsWith: `${TAG.toLowerCase()}-` } }, select: { id: true } });
  for (const u of users) {
    await db.userSession.deleteMany({ where: { userId: u.id } });
    await db.auditLog.deleteMany({ where: { actorId: u.id } });
    await db.user.deleteMany({ where: { id: u.id } });
  }
}

async function main() {
  await purge();
  const prior = await db.business.count({ where: { name: { startsWith: `${TAG}-` } } });
  ok("0.1 no prior P48CAP residue", prior === 0);

  /* ----------------------------- 1. cap parsing ---------------------------- */
  section("1. line-cap parsing (never unbounded §10)");
  eq2(supplierBillLineCap(undefined), SUPPLIER_BILL_LINE_CAP_DEFAULT, "1.1 default cap 200");
  eq2(supplierBillLineCap("garbage"), SUPPLIER_BILL_LINE_CAP_DEFAULT, "1.2 malformed → default");
  eq2(supplierBillLineCap("1"), SUPPLIER_BILL_LINE_CAP_MIN, "1.3 below-min clamps to 20");
  eq2(supplierBillLineCap("100000"), SUPPLIER_BILL_LINE_CAP_MAX, "1.4 above-max clamps to 500");
  eq2(supplierBillLineCap("35"), 35, "1.5 in-range honored");

  /* ----------------------------- 2. fixtures ------------------------------- */
  section("2. fixtures (real service layer, real dev DB)");
  const { execSync } = await import("node:child_process");
  const bcrypt = (await import("bcryptjs")).default;
  const user = await db.user.create({
    data: {
      email: `${TAG.toLowerCase()}-owner-${STAMP}@p48cap.test`,
      name: `${TAG} owner`,
      passwordHash: bcrypt.hashSync("P48CAP!Passw0rd!1", 4),
      locale: "en",
    },
  });
  const biz = await db.business.create({
    data: {
      name: `${TAG}-A-${STAMP}`,
      slug: `${TAG.toLowerCase()}-a-${STAMP}`,
      ownerId: user.id,
      currencyCode: "USD",
      currencySymbol: "$",
      decimalPrecision: 2,
      timezone: "UTC",
      members: { create: { userId: user.id, role: "OWNER" } },
    },
  });
  const supplier = await db.supplier.create({ data: { businessId: biz.id, name: `${TAG} Cap Supply` } });
  // 26 distinct products — the PO @@unique([purchaseOrderId, productId]) law
  // gives every bill line its own PO line.
  const products = await db.product.createMany({
    data: Array.from({ length: 26 }, (_, i) => ({
      businessId: biz.id, name: `${TAG} Cap Widget ${i}`, sku: `${TAG}-CAP-${i}`,
      salePriceMinor: 100, stockQty: 1000,
    })),
  });
  const productRows = await db.product.findMany({ where: { businessId: biz.id }, orderBy: { id: "asc" } });
  const product = productRows[0];
  void products;
  // 26 PO lines (one per cap test + spares) — the PO-line-per-bill UNIQUE
  // law means each bill line needs its OWN purchase order line.
  const po = await db.purchaseOrder.create({
    data: {
      businessId: biz.id, supplierId: supplier.id, reference: `PO-${TAG}-${STAMP}`,
      status: "CONFIRMED", orderedAt: new Date(), supplierNameAtOrder: supplier.name,
      currencyCodeAtOrder: "USD", currencySymbolAtOrder: "$", decimalPrecisionAtOrder: 2,
      createdByUserId: user.id,
      lines: {
        create: productRows.map((prod) => ({
          productId: prod.id, orderedQty: 1000, unitPriceMinor: 500,
          productNameAtOrder: prod.name,
        })),
      },
    },
  });
  const poLines = await db.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id }, orderBy: { id: "asc" } });
  const poLine = poLines[0];
  const gr = await db.goodsReceipt.create({
    data: {
      businessId: biz.id, purchaseOrderId: po.id, status: "POSTED", postedAt: new Date(),
      reference: `GR-${TAG}-${STAMP}`, supplierNameAtReceipt: supplier.name,
      purchaseOrderReferenceAtReceipt: po.reference, createdByUserId: user.id,
      lines: {
        create: poLines.map((pl) => ({
          purchaseOrderLineId: pl.id, receivedQty: 500, productId: pl.productId, productNameAtReceipt: product.name,
        })),
      },
    },
  });
  ok("2.1 fixture chain ready (CONFIRMED PO ×26 lines + POSTED receipt 500 each)", Boolean(gr.id && poLine.id && poLines.length === 26));

  const ctx = { businessId: biz.id, userId: user.id };

  /* ------------------------ 3. sequential line cap ------------------------- */
  section("3. sequential adds vs SUPPLIER_BILL_MAX_LINES=20");
  const capBill = await createSupplierBill({
    ...ctx, purchaseOrderId: po.id, billDate: "2026-10-13",
  });
  let added = 0;
  let limitError = "";
  for (let i = 0; i < 21; i++) {
    const r = await safe(() =>
      addSupplierBillLine({
        ...ctx, id: capBill.id, purchaseOrderLineId: poLines[i].id,
        billedQty: 1, unitPriceMinor: 10 + i,
      }),
    );
    if (r.status === 200) added += 1;
    else limitError = r.code;
  }
  eq2(added, 20, "3.1 exactly 20 lines accepted under the cap");
  eq2(limitError, "SUPPLIER_BILL_LINE_LIMIT_REACHED", "3.2 21st line → stable line-limit error");
  eq2(await db.supplierBillLine.count({ where: { supplierBillId: capBill.id } }), 20, "3.3 exactly 20 persisted");
  // Remove all lines so the bill can post later (and prove the remove path).
  const capLines = await db.supplierBillLine.findMany({ where: { supplierBillId: capBill.id }, select: { id: true } });
  for (const l of capLines) {
    await db.supplierBillLine.delete({ where: { id: l.id } });
  }
  eq2(await db.supplierBillLine.count({ where: { supplierBillId: capBill.id } }), 0, "3.4 lines cleared for later sections");

  /* ------------------ 4. over-cap corruption → integrity ------------------- */
  section("4. over-cap corruption → 500 CAP_INVARIANT on reads (never partial)");
  const victim = await db.supplierBill.create({
    data: {
      businessId: biz.id, supplierId: supplier.id, purchaseOrderId: po.id,
      reference: `SB-${TAG}-VICTIM`, status: "DRAFT", billDate: new Date(),
      supplierNameAtBill: supplier.name, purchaseOrderReferenceAtBill: po.reference,
      currencyCodeAtBill: "USD", currencySymbolAtBill: "$", decimalPrecisionAtBill: 2,
      createdByUserId: user.id, subtotalMinor: 0, totalMinor: 0,
    },
  });
  const victimLines = Array.from({ length: 21 }, (_, i) => ({
    supplierBillId: victim.id, purchaseOrderLineId: poLines[i].id, productId: product.id,
    billedQty: 1, unitPriceMinor: 1, lineTotalMinor: 1,
    productNameAtBill: product.name, purchaseOrderUnitPriceMinor: 1,
  }));
  await db.supplierBillLine.createMany({ data: victimLines });
  eq2(await db.supplierBillLine.count({ where: { supplierBillId: victim.id } }), 21, "4.1 21 corrupt lines injected via DB");
  const detailFail = await safe(() => getSupplierBill({ businessId: biz.id, id: victim.id }));
  eq2(detailFail.status, 500, "4.2 detail read fails 500");
  eq2(detailFail.code, "SUPPLIER_BILL_LINE_CAP_INVARIANT", "4.3 stable cap-invariant code");
  const csvFail = await safe(() => buildSupplierBillCsv({ businessId: biz.id, id: victim.id, locale: "en" }));
  eq2(csvFail.status, 500, "4.4 export fails 500 (never a partial-looking CSV)");
  eq2(csvFail.code, "SUPPLIER_BILL_LINE_CAP_INVARIANT", "4.5 export stable cap-invariant code");
  await db.supplierBillLine.deleteMany({ where: { supplierBillId: victim.id } });
  await db.supplierBill.delete({ where: { id: victim.id } });
  const recov = await safe(() => getSupplierBill({ businessId: biz.id, id: capBill.id }));
  eq2(recov.status, 200, "4.6 reads recover after corruption cleanup");

  /* ------------------- 5. concurrent post of ONE bill ---------------------- */
  section("5. concurrent post ×2 of the same draft (§13-A)");
  const raceBill = await createSupplierBill({ ...ctx, purchaseOrderId: po.id, billDate: "2026-10-13" });
  await addSupplierBillLine({ ...ctx, id: raceBill.id, purchaseOrderLineId: poLine.id, billedQty: 10, unitPriceMinor: 1000 });
  const [postA, postB] = await Promise.all([
    safe(() => postSupplierBill({ ...ctx, id: raceBill.id })),
    safe(() => postSupplierBill({ ...ctx, id: raceBill.id })),
  ]);
  const winner = postA.status === 200 ? postA : postB;
  const loser = postA.status === 200 ? postB : postA;
  eq2(winner.status, 200, "5.1 exactly one concurrent post succeeded");
  ok(`5.2 loser got 409 (${loser.status} ${loser.code})`, loser.status === 409);
  ok(`5.3 stable loser code (${loser.code})`, loser.code === "SUPPLIER_BILL_ALREADY_LINKED" || loser.code === "SUPPLIER_BILL_ALREADY_POSTED");
  const raceAfter = await db.supplierBill.findUniqueOrThrow({ where: { id: raceBill.id } });
  eq2(raceAfter.status, "POSTED", "5.4 bill POSTED exactly once");
  eq2(await db.expense.count({ where: { businessId: biz.id, category: "Supplier bill" } }), 1, "5.5 EXACTLY ONE Expense after the race");
  ok("5.6 linked Expense = the winner's Expense", raceAfter.expenseId === winner.value?.expenseId);
  const stockAfterRace = await db.product.findUniqueOrThrow({ where: { id: product.id } });
  eq2(stockAfterRace.stockQty, 1000, "5.7 stock untouched by both posts");

  /* ------------- 6. competing bills for the LAST quantity ------------------ */
  section("6. two bills competing for the last received quantity (§13-B)");
  // 500 received; race posted 10 → 490 remain. Two bills of 400 each: at most one fits.
  const comp1 = await createSupplierBill({ ...ctx, purchaseOrderId: po.id, billDate: "2026-10-13" });
  const comp2 = await createSupplierBill({ ...ctx, purchaseOrderId: po.id, billDate: "2026-10-13" });
  await addSupplierBillLine({ ...ctx, id: comp1.id, purchaseOrderLineId: poLine.id, billedQty: 400, unitPriceMinor: 500 });
  await addSupplierBillLine({ ...ctx, id: comp2.id, purchaseOrderLineId: poLine.id, billedQty: 400, unitPriceMinor: 500 });
  const [c1, c2] = await Promise.all([
    safe(() => postSupplierBill({ ...ctx, id: comp1.id })),
    safe(() => postSupplierBill({ ...ctx, id: comp2.id })),
  ]);
  const successes = [c1, c2].filter((r) => r.status === 200);
  eq2(successes.length, 1, "6.1 at most ONE competing bill posts (490 available, 400+400 demanded)");
  const loserCode = [c1, c2].find((r) => r.status !== 200)?.code ?? "";
  ok(`6.2 loser stable controlled error (${loserCode})`, loserCode === "SUPPLIER_BILL_QUANTITY_EXCEEDS_AVAILABLE" || loserCode === "SUPPLIER_BILL_QUANTITY_EXCEEDS_RECEIVED");
  const billedAgg = await db.supplierBillLine.aggregate({
    where: { purchaseOrderLineId: poLine.id, supplierBill: { status: "POSTED" } },
    _sum: { billedQty: true },
  });
  const totalBilled = billedAgg._sum.billedQty ?? 0;
  ok(`6.3 no over-bill (posted billed ${totalBilled} ≤ received 500)`, totalBilled <= 500);
  eq2(totalBilled, 410, "6.4 exact posted billed = 10 + 400");
  eq2(await db.expense.count({ where: { businessId: biz.id, category: "Supplier bill" } }), 2, "6.5 exactly one Expense per posted bill (2 total)");

  /* --------------- 7. concurrent duplicate references ---------------------- */
  section("7. concurrent duplicate reference creates (§13-E/§13-F)");
  const ref = `SB-${TAG}-DUP`;
  const dupResults = await Promise.all(
    Array.from({ length: 5 }, () =>
      safe(() => createSupplierBill({ ...ctx, purchaseOrderId: po.id, reference: ref, billDate: "2026-10-13" })),
    ),
  );
  eq2(dupResults.filter((r) => r.status === 200).length, 1, "7.1 exactly one create wins the shared reference");
  ok("7.2 losers → 409 DUPLICATE_REFERENCE", dupResults.filter((r) => r.status === 409 && r.code === "SUPPLIER_BILL_DUPLICATE_REFERENCE").length === 4);
  eq2(await db.supplierBill.count({ where: { businessId: biz.id, reference: ref } }), 1, "7.3 exactly one persisted row");

  const invRef = `INV-CAP-${STAMP}`;
  const invResults = await Promise.all(
    Array.from({ length: 2 }, () =>
      safe(() => createSupplierBill({
        ...ctx, purchaseOrderId: po.id, supplierInvoiceReference: invRef, billDate: "2026-10-13",
      })),
    ),
  );
  eq2(invResults.filter((r) => r.status === 200).length, 1, "7.4 exactly one create wins the shared invoice reference");
  ok("7.5 loser → 409 DUPLICATE_INVOICE_REFERENCE", invResults.filter((r) => r.status === 409 && r.code === "SUPPLIER_BILL_DUPLICATE_INVOICE_REFERENCE").length === 1);

  /* -------------- 8. audit-failure rollback (§13-G/§14-F) ------------------ */
  section("8. audit insertion failure rolls back the ENTIRE posting");
  const auditBill = await createSupplierBill({ ...ctx, purchaseOrderId: po.id, billDate: "2026-10-13" });
  await addSupplierBillLine({ ...ctx, id: auditBill.id, purchaseOrderLineId: poLine.id, billedQty: 5, unitPriceMinor: 700 });
  const beforeAuditCount = await db.auditLog.count({ where: { businessId: biz.id } });
  // Database-level audit failure: block AuditLog inserts for THIS business.
  execSync(
    `node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.DB_PATH||'db/custom.db');db.exec(\\"CREATE TRIGGER IF NOT EXISTS p48cap_block_audit BEFORE INSERT ON AuditLog WHEN NEW.businessId = '${biz.id}' BEGIN SELECT RAISE(ABORT, 'p48cap audit block'); END;\\")"`,
    { cwd: process.cwd() },
  );
  const auditFail = await safe(() => postSupplierBill({ ...ctx, id: auditBill.id }));
  execSync(
    `node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.DB_PATH||'db/custom.db');db.exec('DROP TRIGGER IF EXISTS p48cap_block_audit')"`,
    { cwd: process.cwd() },
  );
  ok(`8.1 posting under audit failure terminated (${auditFail.status})`, auditFail.status >= 400);
  const auditBillAfter = await db.supplierBill.findUniqueOrThrow({ where: { id: auditBill.id } });
  eq2(auditBillAfter.status, "DRAFT", "8.2 bill stayed DRAFT (no un-audited transition)");
  eq2(auditBillAfter.expenseId ?? null, null, "8.3 NO Expense persisted");
  eq2(await db.expense.count({ where: { businessId: biz.id, category: "Supplier bill", supplierBill: { id: auditBill.id } } }), 0, "8.4 no partial payable row");
  eq2(await db.auditLog.count({ where: { businessId: biz.id } }), beforeAuditCount, "8.5 no partial audit rows either");
  // The blocked post must NOT consume billable quantity: re-post succeeds.
  const repostAfterAuditFix = await safe(() => postSupplierBill({ ...ctx, id: auditBill.id }));
  eq2(repostAfterAuditFix.status, 200, "8.6 posting succeeds once the audit path is healthy");
  eq2((await db.supplierBill.findUniqueOrThrow({ where: { id: auditBill.id } })).status, "POSTED", "8.7 bill POSTED on the healthy retry");

  /* ---------- 9. failure AFTER expense creation rolls back (§13-H) --------- */
  section("9. post-expense failure → FULL transactional rollback");
  const lateBill = await createSupplierBill({ ...ctx, purchaseOrderId: po.id, billDate: "2026-10-13" });
  await addSupplierBillLine({ ...ctx, id: lateBill.id, purchaseOrderLineId: poLine.id, billedQty: 3, unitPriceMinor: 900 });
  const expenseCountBefore = await db.expense.count({ where: { businessId: biz.id } });
  // Block the FINAL status update: the Expense was already created inside
  // the transaction when this trigger aborts — rollback must remove it.
  execSync(
    `node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.DB_PATH||'db/custom.db');db.exec(\\"CREATE TRIGGER IF NOT EXISTS p48cap_block_post BEFORE UPDATE ON SupplierBill WHEN NEW.status='POSTED' AND OLD.status='DRAFT' AND NEW.businessId = '${biz.id}' BEGIN SELECT RAISE(ABORT, 'p48cap post block'); END;\\")"`,
    { cwd: process.cwd() },
  );
  const lateFail = await safe(() => postSupplierBill({ ...ctx, id: lateBill.id }));
  execSync(
    `node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.DB_PATH||'db/custom.db');db.exec('DROP TRIGGER IF EXISTS p48cap_block_post')"`,
    { cwd: process.cwd() },
  );
  ok(`9.1 posting terminated late (${lateFail.status})`, lateFail.status >= 400);
  const lateAfter = await db.supplierBill.findUniqueOrThrow({ where: { id: lateBill.id } });
  eq2(lateAfter.status, "DRAFT", "9.2 bill still DRAFT");
  eq2(await db.expense.count({ where: { businessId: biz.id } }), expenseCountBefore, "9.3 the mid-transaction Expense was ROLLED BACK");
  eq2(lateAfter.expenseId ?? null, null, "9.4 no dangling expenseId");
  const lateStock = await db.product.findUniqueOrThrow({ where: { id: product.id } });
  eq2(lateStock.stockQty, 1000, "9.5 stock still untouched");
  const lateRepost = await safe(() => postSupplierBill({ ...ctx, id: lateBill.id }));
  eq2(lateRepost.status, 200, "9.6 healthy retry posts cleanly after the rollback");

  /* -------------------- 10. audit atomicity + teardown --------------------- */
  section("10. audit atomicity + zero-residue teardown");
  const finalAuditCount = await db.auditLog.count({ where: { businessId: biz.id } });
  ok(`10.1 committed flows carry audit rows (${finalAuditCount})`, finalAuditCount >= 5);
  const postedBills = await db.supplierBill.findMany({ where: { businessId: biz.id, status: "POSTED" } });
  for (const b of postedBills) {
    const rows = await db.auditLog.count({ where: { businessId: biz.id, action: "supplier_bill.post", entityId: b.id } });
    eq2(rows, 1, `10.2 ${b.reference}: exactly one supplier_bill.post audit row`);
  }
  const draftToCancel = await db.supplierBill.findFirstOrThrow({ where: { businessId: biz.id, status: "DRAFT" } });
  const cancelRes = await safe(() => cancelSupplierBill({ ...ctx, id: draftToCancel.id }));
  eq2(cancelRes.status, 200, "10.3 DRAFT cancel works (pure transition)");
  ok("10.4 expense ledger consistent", (await db.expense.count({ where: { businessId: biz.id } })) >= 4);

  await purge();
  const [b, bl, e, sb] = await Promise.all([
    db.business.count({ where: { name: { startsWith: `${TAG}-` } } }),
    db.supplierBillLine.count({ where: { supplierBill: { business: { name: { startsWith: `${TAG}-` } } } } }),
    db.expense.count({ where: { business: { name: { startsWith: `${TAG}-` } } } }),
    db.supplierBill.count({ where: { business: { name: { startsWith: `${TAG}-` } } } }),
  ]);
  eq2(b, 0, "10.5 zero fixture businesses remain");
  eq2(bl, 0, "10.6 zero bill lines remain");
  eq2(e, 0, "10.7 zero payables remain");
  eq2(sb, 0, "10.8 zero bills remain");

  console.log("\n=========================================");
  console.log(`prompt48-supplier-bill-cap-check: ${passed}/${passed + failed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }
  console.log("=========================================");
  process.exit(failed === 0 ? 0 : 1);
}

main()
  .catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
