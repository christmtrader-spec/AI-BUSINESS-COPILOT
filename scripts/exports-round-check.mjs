#!/usr/bin/env node
/**
 * exports-round-check.mjs — E2E for the EXPORTS ROUND (stocktake CSV,
 * aging CSV, adjustments feed upgrade) against the RUNNING dev server.
 *
 * Covers:
 *   A. Auth + validation edges (401 without session; 422 family; 404s)
 *   B. Tenant isolation (foreign stocktake → 404, no existence leakage)
 *   C. CSV_EXPORT billing gate LIVE — custom in-DB plan with CSV_EXPORT
 *     =false → 403 ENTITLEMENT_NOT_AVAILABLE (the seeded plans keep CSV
 *      enabled for backwards compatibility §38, so this is the only way to
 *      trigger the real gate path end-to-end)
 *   D. Stocktake CSV — full coverage beyond the 50-line detail page (§184),
 *      snapshot honesty (uncounted lines BLANK), localized headers (EN+FA),
 *      OWASP formula guard, filename law, rate limit 10/5min → 429
 *   E. Aging CSV — buckets/parties/past-due/total rows exactly equal to the
 *      JSON engine (A11), money as exact decimal strings (A08), EN+FA
 *   F. Adjustments feed — DTO envelope + filters (direction/productId/q/
 *      from-to in the business calendar), legacy take alias, CSV export
 *      (EN+FA, injection guard, direction filter)
 *   G. Teardown to ZERO residue (fixture-owned patterns only)
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();
const BASE = process.argv[2] ?? "http://localhost:3000";
const PASS = "testpass123";
const STAMP = `${Date.now()}`;
const TAG6 = STAMP.slice(-6);

let passCount = 0;
let failCount = 0;
const failures = [];

function check(name, cond, info = "") {
  if (cond) {
    passCount++;
    console.log(`  ✓ ${name}${info ? ` — ${info}` : ""}`);
  } else {
    failCount++;
    failures.push(`${name} — ${info}`);
    console.log(`  ✗ ${name} — ${info}`);
  }
}

function makeFetch(xff) {
  const jar = new Map();
  return async function f(path, init = {}) {
    const headers = { ...(init.headers ?? {}) };
    if (init.body && !headers["content-type"]) headers["content-type"] = "application/json";
    if (xff) headers["x-forwarded-for"] = xff;
    const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookieHeader) headers.cookie = cookieHeader;
    const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
    const setCookies = [].concat(res.headers.getSetCookie?.() ?? []);
    for (const raw of setCookies) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    let body = null;
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString("utf8"); // Buffer decoding KEEPS the UTF-8 BOM
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body, headers: res.headers, text, raw: buf };
  };
}

async function login(email) {
  const f = makeFetch(`10.220.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`);
  const csrf = (await f("/api/auth/csrf")).body?.csrfToken;
  const res = await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken: csrf, email, password: PASS, redirect: "false", json: "true" }).toString(),
  });
  if (!(res.status === 200 || res.status === 302)) throw new Error(`login failed for ${email}`);
  return f;
}

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000);
const hoursAgo = (n) => new Date(Date.now() - n * 3_600_000);

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { contains: "@exp-round-" } } });
  for (const u of users) {
    const owned = await prisma.business.findMany({ where: { ownerId: u.id } });
    for (const b of owned) {
      await prisma.inventoryStocktakeLine.deleteMany({ where: { stocktake: { businessId: b.id } } });
      await prisma.inventoryStocktake.deleteMany({ where: { businessId: b.id } });
      await prisma.inventoryAdjustment.deleteMany({ where: { businessId: b.id } });
      await prisma.payment.deleteMany({ where: { businessId: b.id } });
      await prisma.sale.deleteMany({ where: { businessId: b.id } });
      await prisma.expense.deleteMany({ where: { businessId: b.id } });
      await prisma.customer.deleteMany({ where: { businessId: b.id } });
      await prisma.supplier.deleteMany({ where: { businessId: b.id } });
      await prisma.product.deleteMany({ where: { businessId: b.id } });
      await prisma.auditLog.deleteMany({ where: { businessId: b.id } });
      await prisma.subscriptionEvent.deleteMany({ where: { subscription: { businessId: b.id } } });
      await prisma.subscription.deleteMany({ where: { businessId: b.id } });
      await prisma.businessMember.deleteMany({ where: { businessId: b.id } });
      await prisma.business.delete({ where: { id: b.id } });
    }
    await prisma.userSession.deleteMany({ where: { userId: u.id } });
    await prisma.securityEvent.deleteMany({ where: { userId: u.id } });
    await prisma.auditLog.deleteMany({ where: { actorId: u.id } });
    await prisma.user.delete({ where: { id: u.id } }).catch(() => {});
  }
  // Custom no-CSV plans (any stamp — crashed-run recovery)
  const plans = await prisma.plan.findMany({ where: { code: { startsWith: "EXP-NOCSV-" } } });
  for (const p of plans) {
    await prisma.planEntitlement.deleteMany({ where: { planId: p.id } });
    await prisma.plan.delete({ where: { id: p.id } }).catch(() => {});
  }
  return users.length;
}

async function waitServer(ms = 45_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const h = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3_000) });
      if (h.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function main() {
  console.log(`\nEXPORTS ROUND CHECK — target ${BASE}\n`);
  if (!(await waitServer())) {
    console.error("dev server unreachable");
    process.exit(1);
  }

  const ownerEmail = `owner@exp-round-${STAMP}.test`;
  const intruderEmail = `intruder@exp-round-${STAMP}.test`;

  /* ---- fixture ---------------------------------------------------------- */
  const owner = await prisma.user.create({
    data: {
      email: ownerEmail,
      name: "Exports Owner",
      passwordHash: bcrypt.hashSync(PASS, 10),
      emailVerifiedAt: new Date(),
    },
  });
  const intruder = await prisma.user.create({
    data: {
      email: intruderEmail,
      name: "Exports Intruder",
      passwordHash: bcrypt.hashSync(PASS, 10),
      emailVerifiedAt: new Date(),
    },
  });
  const business = await prisma.business.create({
    data: {
      name: `EXP-BIZ ${TAG6}`,
      slug: `exp-biz-${TAG6}`,
      currencyCode: "USD",
      currencySymbol: "$",
      locale: "en",
      timezone: "Asia/Tehran",
      decimalPrecision: 2,
      ownerId: owner.id,
    },
  });
  const foreignBiz = await prisma.business.create({
    data: {
      name: `EXP-BIZ2 ${TAG6}`,
      slug: `exp-biz2-${TAG6}`,
      currencyCode: "USD",
      currencySymbol: "$",
      locale: "en",
      timezone: "Asia/Tehran",
      decimalPrecision: 2,
      ownerId: intruder.id,
    },
  });
  await prisma.businessMember.create({ data: { businessId: business.id, userId: owner.id, role: "OWNER" } });
  await prisma.businessMember.create({ data: { businessId: foreignBiz.id, userId: intruder.id, role: "OWNER" } });

  // Custom plan for the LIVE gate proof. Starts WITH CSV_EXPORT so the
  // isolation probe (C1) reaches the 404; the entitlement is then flipped to
  // false for the gate checks (D) — entitlements are read FRESH from the DB
  // (§111), so the flip takes effect on the next request.
  const defs = await prisma.entitlementDefinition.findMany();
  const defByCode = new Map(defs.map((d) => [d.code, d.id]));
  const noCsvPlan = await prisma.plan.create({
    data: {
      code: `EXP-NOCSV-${TAG6}`,
      name: "Exports fixture no-CSV",
      active: true,
      isPublic: false,
      sortOrder: 999,
      planEntitlements: {
        create: [
          { entitlementId: defByCode.get("CUSTOMERS_MAX"), value: 50 },
          { entitlementId: defByCode.get("PRODUCTS_MAX"), value: 25 },
          { entitlementId: defByCode.get("TEAM_MEMBERS_MAX"), value: 2 },
          { entitlementId: defByCode.get("BUSINESSES_MAX"), value: 1 },
          { entitlementId: defByCode.get("AI_REQUESTS_MAX"), value: 25 },
          { entitlementId: defByCode.get("AI_MESSAGES_MAX"), value: 25 },
          { entitlementId: defByCode.get("AI_COPILOT"), boolValue: true },
          { entitlementId: defByCode.get("ADVANCED_REPORTS"), boolValue: false },
          { entitlementId: defByCode.get("CSV_EXPORT"), boolValue: true },
        ],
      },
    },
  });
  await prisma.subscription.create({
    data: { businessId: foreignBiz.id, planId: noCsvPlan.id, status: "ACTIVE", billingPeriod: "MONTHLY" },
  });

  // 55 products → stocktake with 55 lines (> the 50-line detail page).
  await prisma.product.createMany({
    data: [
      { businessId: business.id, name: "Widget Alpha", sku: "EXP-SKU-A", unit: "piece", stockQty: 10, isActive: true },
      { businessId: business.id, name: "Widget Beta", sku: "EXP-SKU-B", unit: "piece", stockQty: 5, isActive: true },
      { businessId: business.id, name: "=EVIL-INJECTION", sku: "EXP-SKU-C", unit: "piece", stockQty: 7, isActive: true },
      ...Array.from({ length: 52 }, (_, i) => ({
        businessId: business.id,
        name: `Filler ${String(i + 1).padStart(3, "0")}`,
        sku: `EXP-FILLER-${String(i + 1).padStart(3, "0")}`,
        unit: "piece",
        stockQty: 0,
        isActive: true,
      })),
    ],
  });
  const products = await prisma.product.findMany({ where: { businessId: business.id }, orderBy: { sku: "asc" } });
  // Named products resolved by SKU — NEVER by array position (createMany
  // order is not a contract).
  const pA = products.find((p) => p.sku === "EXP-SKU-A");
  const pB = products.find((p) => p.sku === "EXP-SKU-B");
  const pC = products.find((p) => p.sku === "EXP-SKU-C");
  if (!pA || !pB || !pC) throw new Error("fixture products missing");

  const customer = await prisma.customer.create({ data: { businessId: business.id, name: "Acme Receivables" } });
  const supplier = await prisma.supplier.create({ data: { businessId: business.id, name: "Pay Supplier" } });

  await prisma.sale.createMany({
    data: [
      { businessId: business.id, number: 1, customerId: customer.id, subtotalMinor: 100000, totalMinor: 100000, paidMinor: 0, status: "UNPAID", issueDate: daysAgo(20) },
      { businessId: business.id, number: 2, customerId: customer.id, subtotalMinor: 50000, totalMinor: 50000, paidMinor: 10000, status: "UNPAID", issueDate: daysAgo(45) },
      { businessId: business.id, number: 3, customerId: customer.id, subtotalMinor: 20000, totalMinor: 20000, paidMinor: 0, status: "UNPAID", issueDate: daysAgo(100) },
    ],
  });
  await prisma.expense.createMany({
    data: [
      { businessId: business.id, supplierId: supplier.id, category: "services", amountMinor: 30000, paidMinor: 0, status: "UNPAID", spentAt: daysAgo(10), dueDate: null },
      { businessId: business.id, supplierId: supplier.id, category: "services", amountMinor: 25000, paidMinor: 0, status: "UNPAID", spentAt: daysAgo(40), dueDate: daysAgo(5) },
      { businessId: business.id, supplierId: supplier.id, category: "services", amountMinor: 40000, paidMinor: 0, status: "UNPAID", spentAt: daysAgo(95), dueDate: daysAgo(95) },
    ],
  });
  await prisma.inventoryAdjustment.createMany({
    data: [
      { businessId: business.id, productId: pA.id, delta: 5, reason: "initial stock", actorId: owner.id, createdAt: daysAgo(3) },
      { businessId: business.id, productId: pB.id, delta: -3, reason: "damage", actorId: owner.id, createdAt: daysAgo(2) },
      { businessId: business.id, productId: pA.id, delta: 2, reason: "found", actorId: owner.id, createdAt: daysAgo(1) },
      { businessId: business.id, productId: pC.id, delta: -1, reason: "=DANGEROUS", actorId: owner.id, createdAt: hoursAgo(12) },
    ],
  });
  console.log(`fixture: 2 users · 2 businesses · no-CSV plan · ${products.length} products · sales/expenses/adjustments`);

  const biz1 = { "x-business-id": business.id };
  const biz2 = { "x-business-id": foreignBiz.id };

  try {
    /* A. unauthenticated -------------------------------------------------- */
    const anon = makeFetch();
    check("A1. stocktake export w/o session → 401", (await anon(`/api/v1/inventory/stocktakes/cluxxxxxxxxxxxxxxxxxxxxxx/export`)).status === 401);
    check("A2. aging export w/o session → 401", (await anon(`/api/v1/reports/aging/export?side=receivables`)).status === 401);
    check("A3. adjustments w/o session → 401", (await anon(`/api/v1/inventory/adjustments`)).status === 401);

    const ownerF = await login(ownerEmail);
    const intruderF = await login(intruderEmail);

    /* B. validation edges -------------------------------------------------- */
    const badSide1 = await ownerF(`/api/v1/reports/aging/export`, { headers: biz1 });
    const badSide2 = await ownerF(`/api/v1/reports/aging/export?side=bogus`, { headers: biz1 });
    check("B1. aging export side missing → 422", badSide1.status === 422, `status ${badSide1.status}`);
    check("B2. aging export bogus side → 422", badSide2.status === 422, `status ${badSide2.status}`);

    check(
      "B3. stocktake export invalid id → 404",
      (await ownerF(`/api/v1/inventory/stocktakes/not-an-id/export`, { headers: biz1 })).status === 404,
    );

    const dir = (v) => ownerF(`/api/v1/inventory/adjustments?direction=${v}`, { headers: biz1 });
    check("B4. adjustments bogus direction → 422", (await dir("SIDEWAYS")).status === 422);
    check("B5. adjustments pattern-violating productId → 422", (await ownerF(`/api/v1/inventory/adjustments?productId=zz%21`, { headers: biz1 })).status === 422);
    check(
      "B5b. valid-format unknown productId → 200 with total 0",
      (await ownerF(`/api/v1/inventory/adjustments?productId=clxxxxxxxxxxxxxxxxxxxxxxxx`, { headers: biz1 })).body?.data?.total === 0,
    );
    check("B6. adjustments from without to → 422", (await ownerF(`/api/v1/inventory/adjustments?from=2026-01-01`, { headers: biz1 })).status === 422);
    check("B7. adjustments non-calendar date → 422", (await ownerF(`/api/v1/inventory/adjustments?from=2026-02-31&to=2026-03-01`, { headers: biz1 })).status === 422);
    check("B8. adjustments from>to → 422", (await ownerF(`/api/v1/inventory/adjustments?from=2026-03-02&to=2026-03-01`, { headers: biz1 })).status === 422);

    /* C. tenant isolation --------------------------------------------------- */
    // Create a stocktake in business1 first (needed for the isolation probe).
    const createRes = await ownerF(`/api/v1/inventory/stocktakes`, {
      method: "POST",
      headers: biz1,
      body: JSON.stringify({ reference: `EXP-ST-${TAG6}`, notes: "exports round stocktake" }),
    });
    check("C0. stocktake created", createRes.status === 201 || createRes.status === 200, `status ${createRes.status}`);
    const stId = createRes.body?.data?.id;
    check("C0b. stocktake id present", !!stId);

    check(
      "C1. foreign stocktake export → 404 (no leak)",
      (await intruderF(`/api/v1/inventory/stocktakes/${stId}/export`, { headers: biz2 })).status === 404,
    );
    check(
      "C2. foreign adjustments feed is empty for intruder",
      ((await intruderF(`/api/v1/inventory/adjustments`, { headers: biz2 })).body?.data?.total ?? -1) === 0,
    );

    /* D. CSV_EXPORT gate LIVE — flip the plan entitlement; fresh read (§111) */
    await prisma.planEntitlement.update({
      where: {
        planId_entitlementId: { planId: noCsvPlan.id, entitlementId: defByCode.get("CSV_EXPORT") },
      },
      data: { boolValue: false },
    });
    const gated1 = await intruderF(`/api/v1/reports/aging/export?side=receivables`, { headers: biz2 });
    check("D1. aging export gated → 403 ENTITLEMENT_NOT_AVAILABLE", gated1.status === 403 && gated1.body?.error?.code === "ENTITLEMENT_NOT_AVAILABLE", `status ${gated1.status} code ${gated1.body?.error?.code}`);
    const gated2 = await intruderF(`/api/v1/inventory/adjustments?format=csv`, { headers: biz2 });
    check("D2. adjustments CSV gated → 403", gated2.status === 403 && gated2.body?.error?.code === "ENTITLEMENT_NOT_AVAILABLE", `status ${gated2.status}`);

    /* E. stocktake lines + counts ------------------------------------------- */
    const productsAsc = [...products].sort((a, b) => (a.sku < b.sku ? -1 : 1));
    let added = 0;
    for (const p of productsAsc) {
      const r = await ownerF(`/api/v1/inventory/stocktakes/${stId}/lines`, {
        method: "POST",
        headers: biz1,
        body: JSON.stringify({ productId: p.id }),
      });
      if (r.status === 200 || r.status === 201) added++;
    }
    check("E1. 55 lines added", added === 55, `added=${added}`);

    const startRes = await ownerF(`/api/v1/inventory/stocktakes/${stId}/start`, { method: "POST", headers: biz1 });
    check("E2. start counting", startRes.status === 200, `status ${startRes.status}`);

    const detail = await ownerF(`/api/v1/inventory/stocktakes/${stId}?page=1&pageSize=100`, { headers: biz1 });
    const lines = detail.body?.data?.lines ?? [];
    check("E3. detail carries all 55 lines (pageSize 100)", lines.length === 55, `lines=${lines.length}`);
    const lineA = lines.find((l) => l.productId === pA.id);
    const lineB = lines.find((l) => l.productId === pB.id);
    const countA = await ownerF(`/api/v1/inventory/stocktakes/${stId}/lines/${lineA.id}/count`, { method: "POST", headers: biz1, body: JSON.stringify({ countedQty: 12 }) });
    const countB = await ownerF(`/api/v1/inventory/stocktakes/${stId}/lines/${lineB.id}/count`, { method: "POST", headers: biz1, body: JSON.stringify({ countedQty: 5 }) });
    check("E4. counted A=12 (variance +2)", countA.status === 200 && countA.body?.data?.varianceQty === 2, `status ${countA.status}`);
    check("E5. counted B=5 (variance 0)", countB.status === 200 && countB.body?.data?.varianceQty === 0, `status ${countB.status}`);

    /* F. stocktake CSV ------------------------------------------------------ */
    const stCsv = await ownerF(`/api/v1/inventory/stocktakes/${stId}/export`, { headers: biz1 });
    check("F1. stocktake export 200 + text/csv", stCsv.status === 200 && (stCsv.headers.get("content-type") ?? "").includes("text/csv"), `status ${stCsv.status}`);
    const dispo = stCsv.headers.get("content-disposition") ?? "";
    check("F2. filename law stocktake-exp-st-<tag>.csv", dispo.includes(`filename="stocktake-exp-st-${TAG6}`), dispo);
    check("F3. no-store", (stCsv.headers.get("cache-control") ?? "") === "no-store");
    const csvText = typeof stCsv.body === "string" ? stCsv.body : String(stCsv.body);
    check("F4. BOM present (raw bytes EF BB BF)", stCsv.raw[0] === 0xef && stCsv.raw[1] === 0xbb && stCsv.raw[2] === 0xbf);
    const csvLines = csvText.replace(/^\uFEFF/, "").split(/\r\n/).filter((l) => l.length > 0);
    check("F5. header row exact (EN)", csvLines[0] === "reference,status,product,sku,unit,system_qty,counted_qty,variance,counted_at,counted_by", csvLines[0]);
    check("F6. FULL coverage: 1 header + 55 rows (beyond the 50-line page)", csvLines.length === 56, `rows=${csvLines.length - 1}`);
    const rowA = csvLines.find((l) => l.includes("EXP-SKU-A"));
    const rowC = csvLines.find((l) => l.includes("EXP-SKU-C"));
    check("F7. counted row variance +2 & counted 12", !!rowA && rowA.split(",").slice(5, 8).join(",") === "10,12,2", rowA ?? "missing");
    const cFields = rowC ? rowC.split(",") : [];
    check(
      "F8. uncounted row: placeholder system 0 + BLANK counted/variance/at/by",
      cFields.length === 10 && cFields[5] === "0" && cFields[6] === "" && cFields[7] === "" && cFields[8] === "" && cFields[9] === "",
      rowC ?? "missing",
    );
    check("F9. OWASP guard: =-leading product name prefixed with apostrophe", !!rowC && rowC.includes("'=EVIL-INJECTION"), rowC ?? "missing");

    const stCsvFa = await ownerF(`/api/v1/inventory/stocktakes/${stId}/export?locale=fa`, { headers: biz1 });
    const faText = typeof stCsvFa.body === "string" ? stCsvFa.body : String(stCsvFa.body);
    const faHeader = faText.replace(/^\uFEFF/, "").split(/\r\n/)[0];
    check("F10. FA localized header", faHeader === "شناسه,وضعیت,کالا,کد کالا,واحد,موجودی سیستم,موجودی شمارش‌شده,اختلاف,زمان شمارش,شمارش‌کننده", faHeader);

    /* G. rate limit 10 / 5 min --------------------------------------------- */
    let lastStatus = 0;
    for (let i = 0; i < 9; i++) {
      const r = await ownerF(`/api/v1/inventory/stocktakes/${stId}/export`, { headers: biz1 });
      lastStatus = r.status;
      if (r.status === 429) break;
    }
    check("G1. 11th export → 429 RATE_LIMITED", lastStatus === 429, `last ${lastStatus}`);

    /* H. aging CSV ----------------------------------------------------------- */
    const ageEnOwner = await ownerF(`/api/v1/reports/aging/export?side=receivables&locale=en`, { headers: biz1 });
    check("H1. receivables CSV 200", ageEnOwner.status === 200, `status ${ageEnOwner.status}`);
    const ageText = typeof ageEnOwner.body === "string" ? ageEnOwner.body : String(ageEnOwner.body);
    const ageRows = ageText.replace(/^\uFEFF/, "").split(/\r\n/).filter(Boolean);
    check("H2. aging header exact", ageRows[0] === "section,label,items,oldest_days,balance", ageRows[0]);
    const totalRow = ageRows.find((l) => l.startsWith("total,"));
    check("H3. total row 1600.00 across 3 items", !!totalRow && totalRow === "total,Total outstanding,3,,1600.00", totalRow ?? "missing");
    const b0 = ageRows.find((l) => l.startsWith("bucket,0–30 days,"));
    const b60 = ageRows.find((l) => l.startsWith("bucket,31–60 days,"));
    const b90 = ageRows.find((l) => l.startsWith("bucket,90+ days,"));
    check("H4. bucket 0–30 = 1000.00 (1 item)", !!b0 && b0.endsWith(",1,,1000.00"), b0 ?? "missing");
    check("H5. bucket 31–60 = 400.00 (1 item)", !!b60 && b60.endsWith(",1,,400.00"), b60 ?? "missing");
    check("H6. bucket 90+ = 200.00 (1 item)", !!b90 && b90.endsWith(",1,,200.00"), b90 ?? "missing");
    const partyRow = ageRows.find((l) => l.startsWith("party,Acme Receivables,"));
    check("H7. party row aggregated: 3 items, oldest 100, 1600.00", !!partyRow && partyRow === "party,Acme Receivables,3,100,1600.00", partyRow ?? "missing");
    check("H8. receivables has NO past_due row", !ageRows.some((l) => l.startsWith("past_due,")));
    const ageFile = ageEnOwner.headers.get("content-disposition") ?? "";
    check("H9. filename aging-receivables-<asOf>.csv", /filename="aging-receivables-\d{8}\.csv"/.test(ageFile), ageFile);

    const agePay = await ownerF(`/api/v1/reports/aging/export?side=payables`, { headers: biz1 });
    const payText = typeof agePay.body === "string" ? agePay.body : String(agePay.body);
    const payRows = payText.replace(/^\uFEFF/, "").split(/\r\n/).filter(Boolean);
    const payTotal = payRows.find((l) => l.startsWith("total,"));
    const pastDue = payRows.find((l) => l.startsWith("past_due,"));
    const payParty = payRows.find((l) => l.startsWith("party,Pay Supplier,"));
    check("H10. payables total 950.00 across 3 items", !!payTotal && payTotal === "total,Total outstanding,3,,950.00", payTotal ?? "missing");
    // BOTH dated bills are past their due day (−5d and −95d); the undated one is never past due.
    check("H11. past-due row 650.00 (2 bills)", !!pastDue && pastDue === "past_due,Past due,2,,650.00", pastDue ?? "missing");
    check("H11b. payables party row: 3 items, oldest 95, 950.00", !!payParty && payParty === "party,Pay Supplier,3,95,950.00", payParty ?? "missing");

    const ageFa = await ownerF(`/api/v1/reports/aging/export?side=payables&locale=fa`, { headers: biz1 });
    const faAge = typeof ageFa.body === "string" ? ageFa.body : String(ageFa.body);
    check("H12. FA aging header", faAge.replace(/^\uFEFF/, "").split(/\r\n/)[0] === "بخش,عنوان,تعداد اقلام,قدیمی‌ترین (روز),مانده");

    const ageJson = await ownerF(`/api/v1/reports/aging`, { headers: biz1 });
    check("H13. aging JSON route still healthy after refactor", ageJson.status === 200 && !!ageJson.body?.data?.receivables && !!ageJson.body?.data?.payables);

    /* I. adjustments feed + CSV ---------------------------------------------- */
    const feed = await ownerF(`/api/v1/inventory/adjustments?page=1&pageSize=20`, { headers: biz1 });
    check("I1. feed 200 with envelope", feed.status === 200 && feed.body?.data?.total === 4 && Array.isArray(feed.body?.data?.items), `total ${feed.body?.data?.total}`);
    const firstItem = feed.body?.data?.items?.[0];
    check(
      "I2. DTO allowlist (exact keys)",
      !!firstItem &&
        JSON.stringify(Object.keys(firstItem).sort()) === JSON.stringify(["actor", "createdAt", "delta", "id", "product", "productId", "reason"]) &&
        JSON.stringify(Object.keys(firstItem.product).sort()) === JSON.stringify(["name", "sku", "unit"]),
      JSON.stringify(firstItem ? Object.keys(firstItem) : null),
    );
    check("I3. no internal ids leak (businessId/actorId absent)", !!firstItem && !("businessId" in firstItem) && !("actorId" in firstItem));

    const inc = await ownerF(`/api/v1/inventory/adjustments?direction=INCREASE`, { headers: biz1 });
    const dec = await ownerF(`/api/v1/inventory/adjustments?direction=DECREASE`, { headers: biz1 });
    check("I4. INCREASE filter → 2 rows, all positive", inc.body?.data?.total === 2 && inc.body.data.items.every((a) => a.delta > 0), `total ${inc.body?.data?.total}`);
    check("I5. DECREASE filter → 2 rows, all negative", dec.body?.data?.total === 2 && dec.body.data.items.every((a) => a.delta < 0), `total ${dec.body?.data?.total}`);

    const bySku = await ownerF(`/api/v1/inventory/adjustments?q=EXP-SKU-A`, { headers: biz1 });
    check("I6. q by SKU → only product A (2 rows)", bySku.body?.data?.total === 2 && bySku.body.data.items.every((a) => a.product.sku === "EXP-SKU-A"), `total ${bySku.body?.data?.total}`);
    const byProduct = await ownerF(`/api/v1/inventory/adjustments?productId=${pB.id}`, { headers: biz1 });
    check("I7. productId filter → 1 row", byProduct.body?.data?.total === 1, `total ${byProduct.body?.data?.total}`);

    const legacy = await ownerF(`/api/v1/inventory/adjustments?take=2`, { headers: biz1 });
    check("I8. legacy take=2 alias honored", legacy.status === 200 && legacy.body?.data?.pageSize === 2 && legacy.body?.data?.items?.length === 2, `pageSize ${legacy.body?.data?.pageSize}`);

    const window = await ownerF(`/api/v1/inventory/adjustments?from=2020-01-01&to=2030-12-31`, { headers: biz1 });
    check("I9. wide calendar window → all 4", window.body?.data?.total === 4, `total ${window.body?.data?.total}`);

    const adjCsv = await ownerF(`/api/v1/inventory/adjustments?format=csv`, { headers: biz1 });
    check("I10. adjustments CSV 200 + attachment", adjCsv.status === 200 && /filename="inventory-adjustments-\d{8}\.csv"/.test(adjCsv.headers.get("content-disposition") ?? ""));
    const adjText = typeof adjCsv.body === "string" ? adjCsv.body : String(adjCsv.body);
    const adjRows = adjText.replace(/^\uFEFF/, "").split(/\r\n/).filter(Boolean);
    check("I11. adjustments header exact (EN)", adjRows[0] === "created_at,product,sku,unit,direction,quantity,reason,by", adjRows[0]);
    check("I12. all 4 rows exported", adjRows.length === 5, `rows=${adjRows.length - 1}`);
    const evilRow = adjRows.find((l) => l.includes("EXP-SKU-C"));
    check("I13. injection guarded in product AND reason cells", !!evilRow && evilRow.includes("'=EVIL-INJECTION") && evilRow.includes("'=DANGEROUS"), evilRow ?? "missing");
    check("I14. direction labels EN", adjRows.slice(1).every((l) => l.includes(",Increase,") || l.includes(",Decrease,")));

    const adjCsvDec = await ownerF(`/api/v1/inventory/adjustments?format=csv&direction=DECREASE`, { headers: biz1 });
    const decText = typeof adjCsvDec.body === "string" ? adjCsvDec.body : String(adjCsvDec.body);
    const decRows = decText.replace(/^\uFEFF/, "").split(/\r\n/).filter(Boolean).slice(1);
    check("I15. CSV honors direction filter (2 negative rows)", decRows.length === 2 && decRows.every((l) => l.includes(",Decrease,")), `rows=${decRows.length}`);

    const adjCsvFa = await ownerF(`/api/v1/inventory/adjustments?format=csv&locale=fa`, { headers: biz1 });
    const adjFaText = typeof adjCsvFa.body === "string" ? adjCsvFa.body : String(adjCsvFa.body);
    const adjFaHeader = adjFaText.replace(/^\uFEFF/, "").split(/\r\n/)[0];
    check(
      "I16. adjustments FA header + direction",
      adjFaHeader === "زمان,کالا,کد کالا,واحد,جهت,تعداد,دلیل,عامل" &&
        adjFaText.includes(",افزایش موجودی,") &&
        adjFaText.includes(",کاهش موجودی,"),
      adjFaHeader,
    );
  } finally {
    /* G. teardown ------------------------------------------------------------ */
    const removed = await cleanup();
    const [resUsers, resBiz, resProducts, resSt, resAdj, resSales, resPlans] = await Promise.all([
      prisma.user.count({ where: { email: { contains: "@exp-round-" } } }),
      prisma.business.count({ where: { name: { startsWith: "EXP-BIZ" } } }),
      prisma.product.count({ where: { sku: { startsWith: "EXP-" } } }),
      prisma.inventoryStocktake.count({ where: { reference: { startsWith: "EXP-ST-" } } }),
      prisma.inventoryAdjustment.count({ where: { business: { name: { startsWith: "EXP-BIZ" } } } }),
      prisma.sale.count({ where: { business: { name: { startsWith: "EXP-BIZ" } } } }),
      prisma.plan.count({ where: { code: { startsWith: "EXP-NOCSV-" } } }),
    ]);
    console.log(
      `\ncleanup: ${removed} fixture user(s) · residue users=${resUsers} biz=${resBiz} products=${resProducts} stocktakes=${resSt} adjustments=${resAdj} sales=${resSales} plans=${resPlans}`,
    );
    check("G. zero fixture residue", [resUsers, resBiz, resProducts, resSt, resAdj, resSales, resPlans].every((n) => n === 0));
  }

  console.log(`\n== EXPORTS ROUND CHECK: ${passCount} passed, ${failCount} failed ==`);
  if (failCount > 0) {
    failures.forEach((x) => console.log(`  FAILED: ${x}`));
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error("harness crashed:", e);
    cleanup()
      .then(() => console.log("cleanup after crash done"))
      .finally(() => process.exit(1));
  })
  .finally(() => prisma.$disconnect());
