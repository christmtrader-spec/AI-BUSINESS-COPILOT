/**
 * Prompt 45 browser-QA fixture — deterministic sales-order dataset for
 * MANUAL agent-browser QA. `--teardown` removes everything (crashed-run
 * safe: teardown sweeps any stale P45SO-BROWSE residue).
 *
 * Run:  node scripts/prompt45-sales-orders-browser-fixture.mjs            → create + print ids
 *       node scripts/prompt45-sales-orders-browser-fixture.mjs --teardown → remove everything
 *
 * Dataset: 1 owner + business (Asia/Tehran, USD), 1 customer, 4 products
 * with stock, plus:
 *  - one DRAFT order (P45SO-BROWSE-DRAFT) with 2 lines;
 *  - one CONFIRMED order (P45SO-BROWSE-CONFIRMED, ordered 10) with one
 *    PARTIAL posted dispatch (4 units) so dispatched=4/remaining=6 shows;
 *  - one fully-dispatched CONFIRMED order (P45SO-BROWSE-READY, ordered 6)
 *    with no invoice — the "Issue Invoice" action state;
 *  - one COMPLETED order (P45SO-BROWSE-DONE) with linked invoice UNPAID;
 *  - one CANCELLED order (P45SO-BROWSE-CANCELLED);
 * so every status/action state exists for the UI matrix.
 */
const BASE = "http://localhost:3000";
const PASS = "testpass123";
const TAG = "P45SO-BROWSE";
const STAMP_FILE = "var/p45so-browser-stamp.txt";
const fs = await import("node:fs");

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
const EMAIL = S ? `p45so-owner-${S}@p45so.test` : "";

function makeClient() {
  const jar = new Map();
  const xff = `10.45.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
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
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  };
}

async function teardown() {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  const bizs = await prisma.business.findMany({ where: { name: { contains: TAG } }, select: { id: true } });
  for (const b of bizs) {
    await prisma.auditLog.deleteMany({ where: { businessId: b.id } });
    await prisma.goodsDispatchLine.deleteMany({ where: { goodsDispatch: { businessId: b.id } } });
    await prisma.goodsDispatch.deleteMany({ where: { businessId: b.id } });
    await prisma.salesOrderLine.deleteMany({ where: { salesOrder: { businessId: b.id } } });
    await prisma.salesOrder.deleteMany({ where: { businessId: b.id } });
    await prisma.payment.deleteMany({ where: { businessId: b.id } });
    await prisma.saleItem.deleteMany({ where: { sale: { businessId: b.id } } });
    await prisma.sale.deleteMany({ where: { businessId: b.id } });
    await prisma.inventoryAdjustment.deleteMany({ where: { businessId: b.id } });
    await prisma.customer.deleteMany({ where: { businessId: b.id } });
    await prisma.product.deleteMany({ where: { businessId: b.id } });
    await prisma.business.deleteMany({ where: { id: b.id } });
  }
  const users = await prisma.user.findMany({ where: { email: { contains: "p45so-owner-" } }, select: { id: true } });
  for (const u of users) {
    await prisma.userSession.deleteMany({ where: { userId: u.id } });
    await prisma.user.deleteMany({ where: { id: u.id } });
  }
  await prisma.$disconnect();
  console.log("teardown complete");
  if (!process.argv.includes("--create-after")) process.exit(0);
}

const bcrypt = await import("bcryptjs");

async function main() {
  if (process.argv.includes("--teardown")) await teardown();

  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();

  const user = await prisma.user.create({
    data: {
      email: EMAIL,
      name: "P45SO Browser Owner",
      passwordHash: bcrypt.hashSync(PASS, 4),
      locale: "en",
    },
  });
  const biz = await prisma.business.create({
    data: {
      name: `${TAG} Biz`,
      slug: `p45so-browse-${S}`,
      ownerId: user.id,
      currencyCode: "USD",
      currencySymbol: "$",
      decimalPrecision: 2,
      timezone: "Asia/Tehran",
      members: { create: { userId: user.id, role: "OWNER" } },
    },
  });
  const customer = await prisma.customer.create({
    data: { businessId: biz.id, name: "P45SO Browser Customer" },
  });
  const mk = (name, sku, price, stock) =>
    prisma.product.create({ data: { businessId: biz.id, name, sku, unit: "piece", salePriceMinor: price, stockQty: stock } });
  const pWidget = await mk("Widget Pro", "P45-SK-W1", 500, 200);
  const pGadget = await mk("Gadget Mini", "P45-SK-G2", 1200, 80);
  const pCable = await mk("Cable X", "P45-SK-C3", 250, 500);
  const pCase = await mk("Case Slim", "P45-SK-K4", 900, 60);

  const f = makeClient();
  const csrf = (await f("/api/auth/csrf")).body.csrfToken;
  await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken: csrf, email: EMAIL, password: PASS, redirect: "false", json: "true" }).toString(),
  });
  const B = { "x-business-id": biz.id };

  async function makeOrder(reference, lines) {
    const r = await f("/api/v1/sales-orders", { method: "POST", headers: B, body: JSON.stringify({ customerId: customer.id, reference, orderDate: "2026-10-11" }) });
    if (r.status !== 201) throw new Error(`order ${reference}: ${r.status} ${JSON.stringify(r.body)}`);
    const id = r.body.data.id;
    const lineIds = [];
    for (const l of lines) {
      const lr = await f(`/api/v1/sales-orders/${id}/lines`, { method: "POST", headers: B, body: JSON.stringify({ productId: l.productId, orderedQty: l.qty }) });
      lineIds.push({ id: lr.body.data.id, productId: l.productId, qty: l.qty });
    }
    return { id, lineIds };
  }
  async function dispatchAndPost(order, lineId, qty) {
    const d = await f(`/api/v1/sales-orders/${order.id}/dispatches`, { method: "POST", headers: B, body: "{}" });
    await f(`/api/v1/inventory/goods-dispatches/${d.body.data.id}/lines`, { method: "POST", headers: B, body: JSON.stringify({ salesOrderLineId: lineId, qty }) });
    await f(`/api/v1/inventory/goods-dispatches/${d.body.data.id}/post`, { method: "POST", headers: B });
  }

  // 1. DRAFT order (editable)
  const draft = await makeOrder("P45SO-BROWSE-DRAFT", [
    { productId: pWidget.id, qty: 5 },
    { productId: pCable.id, qty: 12 },
  ]);

  // 2. CONFIRMED + partial dispatch (4/10)
  const partial = await makeOrder("P45SO-BROWSE-PARTIAL", [{ productId: pGadget.id, qty: 10 }]);
  await f(`/api/v1/sales-orders/${partial.id}/confirm`, { method: "POST", headers: B });
  await dispatchAndPost(partial, partial.lineIds[0].id, 4);

  // 3. CONFIRMED fully dispatched, NOT invoiced (Issue Invoice state)
  const ready = await makeOrder("P45SO-BROWSE-READY", [{ productId: pCase.id, qty: 6 }]);
  await f(`/api/v1/sales-orders/${ready.id}/confirm`, { method: "POST", headers: B });
  await dispatchAndPost(ready, ready.lineIds[0].id, 6);

  // 4. COMPLETED with linked UNPAID invoice
  const done = await makeOrder("P45SO-BROWSE-DONE", [{ productId: pWidget.id, qty: 8 }]);
  await f(`/api/v1/sales-orders/${done.id}/confirm`, { method: "POST", headers: B });
  await dispatchAndPost(done, done.lineIds[0].id, 8);
  const inv = await f(`/api/v1/sales-orders/${done.id}/invoice`, { method: "POST", headers: B });

  // 5. CANCELLED
  const cancelled = await makeOrder("P45SO-BROWSE-CANCELLED", [{ productId: pCable.id, qty: 3 }]);
  await f(`/api/v1/sales-orders/${cancelled.id}/cancel`, { method: "POST", headers: B });

  const out = {
    email: EMAIL,
    password: PASS,
    businessId: biz.id,
    customerId: customer.id,
    products: { widget: pWidget.id, gadget: pGadget.id, cable: pCable.id, case: pCase.id },
    orders: { draft: draft.id, partial: partial.id, ready: ready.id, done: done.id, cancelled: cancelled.id },
    invoiceNumber: inv.body?.data?.invoiceNumber ?? null,
  };
  fs.writeFileSync("var/p45so-browser-fixture.json", JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
