/**
 * Prompt 47 browser-QA fixture — deterministic sales-quotation dataset for
 * MANUAL agent-browser QA. `--teardown` removes everything (crashed-run
 * safe: teardown sweeps any stale P47Q-BROWSE residue).
 *
 * Run:  node scripts/prompt47-sales-quotations-browser-fixture.mjs            → create + print ids
 *       node scripts/prompt47-sales-quotations-browser-fixture.mjs --teardown → remove everything
 *
 * Dataset: 1 owner + business (Asia/Tehran, USD), 2 customers, 4 products
 * with stock, plus one quotation per lifecycle state so the whole UI matrix
 * is visible:
 *  - DRAFT (2 lines, editable);
 *  - SENT (valid until +30d — accept/reject/cancel/expire actions live);
 *  - ACCEPTED (the "Convert to Sales Order" action state);
 *  - REJECTED (terminal);
 *  - EXPIRED (created SENT with a past validUntilDate, then the explicit
 *    audited expire transition);
 *  - CANCELLED (terminal);
 *  - CONVERTED with its linked CONFIRMED sales order (deep-link card state).
 * Conversion must NOT move stock or create invoices/payments — the fixture
 * leaves the ledger untouched so manual QA can also verify that.
 */
const BASE = "http://localhost:3000";
const PASS = "testpass123";
const TAG = "P47Q-BROWSE";
const STAMP_FILE = "var/p47qa-browser-stamp.txt";
const fs = await import("node:fs");

// Asia/Tehran business-local calendar day (the app's own date law).
function tehranToday() {
  return new Date(Date.now() + 3.5 * 3600 * 1000).toISOString().slice(0, 10);
}
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
const EMAIL = S ? `p47q-owner-${S}@p47q.test` : "";

function makeClient() {
  const jar = new Map();
  const xff = `10.47.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
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
    // Quotations first — SalesOrder.sourceQuotationId is SetNull on delete.
    await prisma.salesQuotationLine.deleteMany({ where: { salesQuotation: { businessId: b.id } } });
    await prisma.salesQuotation.deleteMany({ where: { businessId: b.id } });
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
  const users = await prisma.user.findMany({ where: { email: { contains: "p47q-owner-" } }, select: { id: true } });
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
      name: "P47Q Browser Owner",
      passwordHash: bcrypt.hashSync(PASS, 4),
      locale: "en",
    },
  });
  const biz = await prisma.business.create({
    data: {
      name: `${TAG} Biz`,
      slug: `p47q-browse-${S}`,
      ownerId: user.id,
      currencyCode: "USD",
      currencySymbol: "$",
      decimalPrecision: 2,
      timezone: "Asia/Tehran",
      members: { create: { userId: user.id, role: "OWNER" } },
    },
  });
  const customer = await prisma.customer.create({
    data: { businessId: biz.id, name: "Aria Trading Co." },
  });
  const customer2 = await prisma.customer.create({
    data: { businessId: biz.id, name: "Parse Electrical Supply" },
  });
  const mk = (name, sku, price, stock) =>
    prisma.product.create({ data: { businessId: biz.id, name, sku, unit: "piece", salePriceMinor: price, stockQty: stock } });
  const pLamp = await mk("LED Panel Light 40W", "P47-SK-L1", 850000, 120);
  const pWire = await mk("Copper Wire 2.5mm", "P47-SK-W2", 320000, 400);
  const pSwitch = await mk("Smart Switch S2", "P47-SK-S3", 1250000, 75);
  const pSocket = await mk("Wall Socket Pro", "P47-SK-K4", 480000, 210);
  const STOCK_BEFORE = { pLamp: pLamp.stockQty, pWire: pWire.stockQty, pSwitch: pSwitch.stockQty, pSocket: pSocket.stockQty };

  const f = makeClient();
  const csrf = (await f("/api/auth/csrf")).body.csrfToken;
  await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken: csrf, email: EMAIL, password: PASS, redirect: "false", json: "true" }).toString(),
  });
  const B = { "x-business-id": biz.id };

  async function makeQuotation({ reference, customerId, validUntil, lines, discountMinor = 0, customerNotes, internalNotes, quotedOn }) {
    // NOTE: an empty quotation cannot carry a discount (INVALID_DISCOUNT) —
    // the discount is PATCHed onto the header AFTER the lines exist.
    const r = await f("/api/v1/sales-quotations", {
      method: "POST",
      headers: B,
      body: JSON.stringify({
        customerId,
        reference,
        quotationDate: quotedOn || tehranToday(),
        validUntilDate: validUntil,
        customerNotes,
        internalNotes,
      }),
    });
    if (r.status !== 201) throw new Error(`quotation ${reference}: ${r.status} ${JSON.stringify(r.body)}`);
    const id = r.body.data.id;
    for (const l of lines) {
      const lr = await f(`/api/v1/sales-quotations/${id}/lines`, {
        method: "POST",
        headers: B,
        body: JSON.stringify({ productId: l.productId, qty: l.qty, ...(l.unitPriceMinor ? { unitPriceMinor: l.unitPriceMinor } : {}) }),
      });
      if (lr.status !== 201) throw new Error(`line for ${reference}: ${lr.status} ${JSON.stringify(lr.body)}`);
    }
    if (discountMinor > 0) {
      const pr = await f(`/api/v1/sales-quotations/${id}`, {
        method: "PATCH",
        headers: B,
        body: JSON.stringify({ discountMinor }),
      });
      if (pr.status !== 200) throw new Error(`discount for ${reference}: ${pr.status} ${JSON.stringify(pr.body)}`);
    }
    return id;
  }
  async function act(id, action) {
    const r = await f(`/api/v1/sales-quotations/${id}/${action}`, { method: "POST", headers: B });
    if (r.status !== 200) throw new Error(`${action} ${id}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.data;
  }

  // 1. DRAFT (editable) — 2 lines
  const draft = await makeQuotation({
    reference: "QT-QA47DRAFT",
    customerId: customer.id,
    validUntil: tehranDayOffset(14),
    lines: [{ productId: pLamp.id, qty: 10 }, { productId: pWire.id, qty: 25 }],
    customerNotes: "Site lighting package for the new wing.",
    internalNotes: "Follow up after the site visit next week.",
  });

  // 2. SENT (live offer)
  const sent = await makeQuotation({
    reference: "QT-QA47SENT",
    customerId: customer2.id,
    validUntil: tehranDayOffset(30),
    lines: [{ productId: pSwitch.id, qty: 8 }],
  });
  await act(sent, "mark-sent");

  // 3. ACCEPTED (ready to convert)
  const accepted = await makeQuotation({
    reference: "QT-QA47ACCEPT",
    customerId: customer.id,
    validUntil: tehranDayOffset(20),
    lines: [{ productId: pSocket.id, qty: 40 }],
    discountMinor: 400000,
  });
  await act(accepted, "mark-sent");
  await act(accepted, "accept");

  // 4. REJECTED (terminal)
  const rejected = await makeQuotation({
    reference: "QT-QA47REJECT",
    customerId: customer2.id,
    validUntil: tehranDayOffset(15),
    lines: [{ productId: pWire.id, qty: 60 }],
  });
  await act(rejected, "mark-sent");
  await act(rejected, "reject");

  // 5. EXPIRED (historical backfill: quotationDate -40d, validUntil -10d —
  // both past, ordering legal; SENT is not validity-gated, then the explicit
  // audited expire transition persists the terminal EXPIRED state)
  const expired = await makeQuotation({
    reference: "QT-QA47EXPIRE",
    customerId: customer.id,
    quotedOn: tehranDayOffset(-40),
    validUntil: tehranDayOffset(-10),
    lines: [{ productId: pLamp.id, qty: 6 }],
  });
  await act(expired, "mark-sent");
  await act(expired, "expire");

  // 6. CANCELLED (terminal)
  const cancelled = await makeQuotation({
    reference: "QT-QA47CANCEL",
    customerId: customer2.id,
    validUntil: tehranDayOffset(21),
    lines: [{ productId: pSocket.id, qty: 5 }],
  });
  await act(cancelled, "cancel");

  // 7. CONVERTED — accept then convert exactly once → CONFIRMED order
  const accepted2 = await makeQuotation({
    reference: "QT-QA47CONVRT",
    customerId: customer.id,
    validUntil: tehranDayOffset(25),
    lines: [{ productId: pSwitch.id, qty: 12 }, { productId: pWire.id, qty: 30 }],
    internalNotes: "Repeat customer — priority scheduling.",
  });
  await act(accepted2, "mark-sent");
  await act(accepted2, "accept");
  const conv = await act(accepted2, "convert");
  // convert response: { quotationId, quotationReference, salesOrder: { id, reference, status, confirmedAt } }

  // Conversion MUST NOT have touched stock — assert the byte-law here so the
  // manual QA session starts from a provably clean ledger.
  const after = {};
  for (const [k, id] of Object.entries({ pLamp: pLamp.id, pWire: pWire.id, pSwitch: pSwitch.id, pSocket: pSocket.id })) {
    after[k] = (await prisma.product.findUnique({ where: { id }, select: { stockQty: true } })).stockQty;
  }
  for (const k of Object.keys(STOCK_BEFORE)) {
    if (after[k] !== STOCK_BEFORE[k]) throw new Error(`STOCK LAW VIOLATED for ${k}: ${STOCK_BEFORE[k]} → ${after[k]}`);
  }

  const out = {
    email: EMAIL,
    password: PASS,
    businessId: biz.id,
    customers: { aria: customer.id, parse: customer2.id },
    products: { lamp: pLamp.id, wire: pWire.id, switch: pSwitch.id, socket: pSocket.id },
    quotations: {
      draft, sent, accepted, rejected, expired, cancelled,
      converted: accepted2,
    },
    convertedOrder: conv?.salesOrder?.id ?? null,
    convertedOrderReference: conv?.salesOrder?.reference ?? null,
    convertedOrderStatus: conv?.salesOrder?.status ?? null,
  };
  fs.writeFileSync("var/p47qa-browser-fixture.json", JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
