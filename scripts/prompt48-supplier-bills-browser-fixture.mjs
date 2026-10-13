/**
 * Prompt 48 browser-QA fixture — deterministic supplier-bill dataset for
 * MANUAL agent-browser QA. `--teardown` removes everything (crashed-run
 * safe: teardown sweeps any stale P48Q-BROWSE residue).
 *
 * Run:  node scripts/prompt48-supplier-bills-browser-fixture.mjs            → create + print ids
 *       node scripts/prompt48-supplier-bills-browser-fixture.mjs --teardown → remove everything
 *
 * Dataset: 1 owner + business (Asia/Tehran, USD), 1 supplier, 3 products
 * with stock, plus supplier bills covering the whole UI matrix:
 *  - DRAFT with 2 lines (editable: header edit, line add/edit/remove, post);
 *  - POSTED with its linked Expense payable UNPAID (payable card state);
 *  - POSTED with a linked Expense PARTIAL (payment display after partial
 *    payment via the EXISTING Payment workflow);
 *  - CANCELLED (terminal, export-only);
 *  - a second CONFIRMED PO with received stock for in-QA bill creation.
 * The fixture leaves stock untouched by billing (posting is a no-stock law)
 * so manual QA can verify the invariant live.
 */
const BASE = "http://localhost:3000";
const PASS = "testpass123";
const TAG = "P48Q-BROWSE";
const STAMP_FILE = "var/p48qa-browser-stamp.txt";
const fs = await import("node:fs");

function tehranDayOffset(days) {
  return new Date(Date.now() + 3.5 * 3600 * 1000 + days * 86400 * 1000).toISOString().slice(0, 10);
}

function stamp() {
  if (process.argv.includes("--teardown")) {
    try { return fs.readFileSync(STAMP_FILE, "utf8").trim(); } catch { return ""; }
  }
  const s = `${Date.now().toString(36)}`;
  fs.mkdirSync("var", { recursive: true });
  fs.writeFileSync(STAMP_FILE, s);
  return s;
}
const S = stamp();
const EMAIL = S ? `p48q-owner-${S}@p48q.test` : "";

function makeClient() {
  const jar = new Map();
  const xff = `10.48.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
  return async (path, init = {}) => {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const headers = { "x-forwarded-for": xff, ...(init.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    let body = null;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) { try { body = await res.json(); } catch { body = null; } }
    else body = await res.text().catch(() => null);
    return { status: res.status, body };
  };
}

async function main() {
  const { PrismaClient } = await import("@prisma/client");
  const bcrypt = (await import("bcryptjs")).default;
  const db = new PrismaClient();

  try {
    // ---- sweep stale residue (create AND teardown) ----
    const staleBizs = await db.business.findMany({ where: { name: { startsWith: `${TAG}-` } }, select: { id: true } });
    for (const b of staleBizs) {
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
    const staleUsers = await db.user.findMany({ where: { email: { endsWith: "@p48q.test" } }, select: { id: true } });
    for (const u of staleUsers) {
      await db.userSession.deleteMany({ where: { userId: u.id } });
      await db.auditLog.deleteMany({ where: { actorId: u.id } });
      await db.user.deleteMany({ where: { id: u.id } });
    }

    if (process.argv.includes("--teardown")) {
      console.log("P48Q browser fixture torn down to zero.");
      return;
    }
    if (!S || !EMAIL) throw new Error("missing stamp");

    const user = await db.user.create({
      data: { email: EMAIL, name: "P48Q Browser Owner", passwordHash: bcrypt.hashSync(PASS, 4), locale: "en" },
    });
    const biz = await db.business.create({
      data: {
        name: `${TAG}-${S}`, slug: `p48q-browse-${S}`, ownerId: user.id,
        currencyCode: "USD", currencySymbol: "$", decimalPrecision: 2, timezone: "Asia/Tehran",
        members: { create: { userId: user.id, role: "OWNER" } },
      },
    });
    // Attach an ACTIVE plan subscription so the global "subs >= businesses"
    // billing invariant (P23 §23.7) holds while the fixture lives.
    const somePlan = await db.plan.findFirst({ where: { active: true }, orderBy: { sortOrder: "asc" } });
    if (somePlan) {
      const sub = await db.subscription.create({
        data: { businessId: biz.id, planId: somePlan.id, status: "ACTIVE", billingPeriod: "MONTHLY" },
      });
      // Billing auditability law (P20 B3): every subscription carries a
      // CREATED event — raw fixture creation must stay auditable too.
      await db.subscriptionEvent.create({
        data: { businessId: biz.id, subscriptionId: sub.id, type: "CREATED", toStatus: "ACTIVE", dataJson: '{"source":"p48q-browser-fixture-bootstrap"}' },
      }).catch(() => {});
    }
    const supplier = await db.supplier.create({ data: { businessId: biz.id, name: "P48Q Global Parts" } });
    const products = [];
    for (const [name, sku, price, stock] of [
      ["P48Q Hydraulic Pump", "P48Q-HP-1", 45000, 120],
      ["P48Q Steel Bearing", "P48Q-SB-2", 8500, 640],
      ["P48Q Rubber Seal", "P48Q-RS-3", 1200, 900],
    ]) {
      products.push(await db.product.create({
        data: { businessId: biz.id, name, sku, unit: "piece", salePriceMinor: price, stockQty: stock },
      }));
    }

    const f = makeClient();
    const csrf = (await f("/api/auth/csrf")).body?.csrfToken;
    await f("/api/auth/callback/credentials", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken: csrf, email: EMAIL, password: PASS, redirect: "false", json: "true" }).toString(),
    });
    const B = { "x-business-id": biz.id, "content-type": "application/json" };
    const post = async (path, body) => {
      const r = await f(path, { method: "POST", headers: B, body: JSON.stringify(body) });
      if (r.status >= 300) throw new Error(`${path} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      return r.body?.data;
    };

    const makePoWithReceipt = async (ref, lineDefs) => {
      const po = await post("/api/v1/purchase-orders", { supplierId: supplier.id, reference: ref });
      const poLines = [];
      for (const [pi, qty, price] of lineDefs) {
        poLines.push(await post(`/api/v1/purchase-orders/${po.id}/lines`, { productId: products[pi].id, orderedQty: qty, unitPriceMinor: price }));
      }
      await post(`/api/v1/purchase-orders/${po.id}/send`, {});
      await post(`/api/v1/purchase-orders/${po.id}/confirm`, {});
      const gr = await post("/api/v1/inventory/goods-receipts", { purchaseOrderId: po.id });
      for (const [i, pl] of poLines.entries()) {
        await post(`/api/v1/inventory/goods-receipts/${gr.id}/lines`, { purchaseOrderLineId: pl.id, receivedQty: lineDefs[i][1] });
      }
      await post(`/api/v1/inventory/goods-receipts/${gr.id}/post`, {});
      return { po, poLines };
    };

    // PO1: 40 pumps @ 45000 + 100 bearings @ 8500 (fully billed, variance on bearings).
    const { po: po1, poLines: po1Lines } = await makePoWithReceipt("PO-P48Q-1", [[0, 40, 45000], [1, 100, 8500]]);
    // PO2: 60 seals @ 1200 — left with received stock for in-QA bill creation.
    const { po: po2, poLines: po2Lines } = await makePoWithReceipt("PO-P48Q-2", [[2, 60, 1200]]);

    // Bill A — POSTED, UNPAID payable (fully billed PO1 line1).
    const billA = await post("/api/v1/supplier-bills", {
      purchaseOrderId: po1.id, supplierInvoiceReference: "GINV-2026-001",
      billDate: tehranDayOffset(-1), dueDate: tehranDayOffset(29),
    });
    await post(`/api/v1/supplier-bills/${billA.id}/lines`, { purchaseOrderLineId: po1Lines[0].id, billedQty: 40, unitPriceMinor: 45000 });
    await post(`/api/v1/supplier-bills/${billA.id}/post`, {});

    // Bill B — POSTED with price variance + PARTIAL payment (PO1 line2).
    const billB = await post("/api/v1/supplier-bills", {
      purchaseOrderId: po1.id, supplierInvoiceReference: "GINV-2026-002",
      billDate: tehranDayOffset(-1), dueDate: tehranDayOffset(14),
    });
    await post(`/api/v1/supplier-bills/${billB.id}/lines`, { purchaseOrderLineId: po1Lines[1].id, billedQty: 100, unitPriceMinor: 9200 });
    const postedB = await post(`/api/v1/supplier-bills/${billB.id}/post`, {});
    await post("/api/v1/payments", { expenseId: postedB.expenseId, direction: "OUT", amountMinor: 300000, method: "BANK_TRANSFER", note: "P48Q partial" });

    // Bill C — DRAFT with 2 lines (editable in QA).
    const billC = await post("/api/v1/supplier-bills", {
      purchaseOrderId: po2.id, billDate: tehranDayOffset(0), internalNotes: "P48Q draft — editable",
    });
    await post(`/api/v1/supplier-bills/${billC.id}/lines`, { purchaseOrderLineId: po2Lines[0].id, billedQty: 25, unitPriceMinor: 1200 });

    // Bill D — CANCELLED (terminal, export-only).
    const billD = await post("/api/v1/supplier-bills", { purchaseOrderId: po2.id, billDate: tehranDayOffset(0) });
    await post(`/api/v1/supplier-bills/${billD.id}/cancel`, {});

    const out = {
      tag: TAG,
      email: EMAIL,
      password: PASS,
      businessId: biz.id,
      supplierId: supplier.id,
      purchaseOrderIds: [po1.id, po2.id],
      bills: { postedUnpaid: billA.id, postedPartial: billB.id, draft: billC.id, cancelled: billD.id },
      references: { A: billA.reference, B: billB.reference, C: billC.reference, D: billD.reference },
      invoiceRefs: { A: "GINV-2026-001", B: "GINV-2026-002" },
      products: products.map((p) => p.id),
      stockBaseline: "unchanged by billing (posting is a no-stock law)",
    };
    fs.mkdirSync("var", { recursive: true });
    fs.writeFileSync("var/p48qa-browser-fixture.json", JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error("FATAL:", err?.message ?? err);
  process.exit(1);
});
