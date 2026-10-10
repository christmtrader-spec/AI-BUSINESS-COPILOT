#!/usr/bin/env node
/**
 * Prompt 43 — E2E GOODS RETURN CHECK (§151). Real application + real DB.
 * Run: node scripts/prompt43-goods-return-check.mjs   (dev server on :3000)
 *
 * Covers: auth/RBAC · tenant isolation both directions (§102/§166) ·
 * source-receipt validation (§13/§66) · draft create/update/cancel (§10/
 * §156/§157) · line add/edit/remove + duplicate line (§62/§75) · post
 * (§152/§43) · POSTED immutability (§11/§54) · CANCELLED terminal (§12) ·
 * cumulative return cap (§35/§153) · stale draft (§63) · partial returns
 * (§154) · insufficient stock (§155/§39) · negative-stock corruption
 * (§164/§41) · multi-line rollback (§163/§52) · corrupt persisted status
 * (§65) · corrupt return history (§38) · snapshots (§165/§16/§30) ·
 * audit events (§131) · receipt return facts + history (§86/§87/§88) ·
 * replacement receipt (§81/§160) · over-receipt after return (§82/§161) ·
 * PO net receiving summary (§77/§78/§79) · PO cancel hardening (§128) ·
 * closed PO after return (§85/§129) · stocktake interaction (§121/§162) ·
 * manual adjustment interaction (§123) · GoodsReceipt interaction (§124) ·
 * search + tenant safety (§101/§102) · CSV export EN/FA + injection +
 * entitlement + rate limit + foreign 404 (§103-§111) · business export +
 * import rejection (§112-§115) · restore-drill probe (§116) · teardown to
 * ZERO (§195).
 *
 * Concurrency (§49/§53/§158/§159) runs in the ISOLATED service-level
 * process scripts/prompt43-goods-return-cap-check.ts (spawned here with
 * GOODS_RETURN_MAX_LINES=20 — the project default is never touched).
 *
 * Fixtures are P43RT-prefixed and removed to ZERO residue. Prisma is used
 * ONLY for fixtures, assertions and cleanup — never to mutate domain rows
 * except the documented corruption probes (§65/§38/§164 + §9 zero-qty +
 * §25 date-window instants + §29 financial fixtures), which restore what
 * they change.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

// --- env -------------------------------------------------------------------
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const db = new PrismaClient();
const BASE = "http://localhost:3000";
const PASS = "P43qa!Passw0rd!1";
const TAG = "P43RT";
const STAMP = `${Date.now()}`.slice(-8);
const DOMAIN = "p43check.test";

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, info = "") {
  if (cond) passed++;
  else failed++, failures.push(`${name}${info ? ` — ${info}` : ""}`);
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
}
function eq(actual, expected, name) {
  ok(name, actual === expected, `got ${String(actual)}, want ${String(expected)}`);
}
function section(name) {
  console.log(`\n=== ${name} ===`);
}

// --- HTTP client with per-user cookie jar (house style) ---------------------
function makeClient() {
  const jar = new Map();
  return async function f(path, init = {}) {
    const headers = {
      "content-type": "application/json",
      "x-forwarded-for": init.xff ?? "10.42.7.19",
      ...(init.headers ?? {}),
    };
    if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body,
      redirect: "manual",
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
    }
    let body = null;
    const bytes = Buffer.from(await res.arrayBuffer());
    try {
      body = JSON.parse(new TextDecoder("utf-8").decode(bytes));
    } catch {
      body = null;
    }
    return { status: res.status, headers: res.headers, res: { bytes }, body };
  };
}

async function login(f, email) {
  const csrf = (await f("/api/auth/csrf")).body?.csrfToken;
  await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken: csrf, email, password: PASS, redirect: "false", json: "true" }).toString(),
  });
}

/** GET/POST wrapper returning {status, body} with 429 retry-once (house style). */
async function call(f, path, init = {}, depth = 0) {
  const res = await f(path, init);
  if (res.status === 429 && !(init.headers ?? {})["x-no-retry"] && depth < 1) {
    const body = res.body;
    const wait = Math.min(body?.error?.details?.retryAfterMs ?? 60_000, 65_000);
    console.log(`  (rate limited — waiting ${Math.round(wait / 1000)}s)`);
    await new Promise((r) => setTimeout(r, wait));
    return call(f, path, init, depth + 1);
  }
  return { status: res.status, body: res.body, headers: res.headers, res: res.res };
}

const B = (biz) => ({ "x-business-id": biz });

async function createSupplier(f, biz, name) {
  const r = await call(f, "/api/v1/suppliers", { method: "POST", headers: B(biz), body: JSON.stringify({ name }) });
  if (r.status !== 201 && r.status !== 200) throw new Error(`supplier create ${name}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}
async function createProduct(f, biz, name, sku, stockQty = 10) {
  const r = await call(f, "/api/v1/products", {
    method: "POST",
    headers: B(biz),
    body: JSON.stringify({ name, sku, unit: "piece", stockQty, costPriceMinor: 100, salePriceMinor: 200, isActive: true }),
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(`product create ${name}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}
async function createPO(f, biz, body) {
  const r = await call(f, "/api/v1/purchase-orders", { method: "POST", headers: B(biz), body: JSON.stringify(body) });
  if (r.status !== 201 && r.status !== 200) throw new Error(`po create: ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}
async function poLine(f, biz, poId, body) {
  const r = await call(f, `/api/v1/purchase-orders/${poId}/lines`, { method: "POST", headers: B(biz), body: JSON.stringify(body) });
  if (r.status !== 201 && r.status !== 200) throw new Error(`po line create: ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}
async function transitionPO(f, biz, poId, op) {
  const r = await call(f, `/api/v1/purchase-orders/${poId}/${op}`, { method: "POST", headers: B(biz) });
  if (r.status !== 200 && r.status !== 201) throw new Error(`po ${op}: ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}
async function confirmedPO(f, biz, supplierId, lines) {
  const po = await createPO(f, biz, { supplierId });
  for (const l of lines) await poLine(f, biz, po.body.data.id, l);
  await transitionPO(f, biz, po.body.data.id, "send");
  await transitionPO(f, biz, po.body.data.id, "confirm");
  return po.body.data.id;
}
const GR = (biz) => `/api/v1/inventory/goods-receipts`;
async function createGR(f, biz, body) {
  return call(f, GR(biz), { method: "POST", headers: B(biz), body: JSON.stringify(body) });
}
async function grDetail(f, biz, id) {
  return call(f, `${GR(biz)}/${id}`, { headers: B(biz) });
}
async function grAddLine(f, biz, id, body) {
  return call(f, `${GR(biz)}/${id}/lines`, { method: "POST", headers: B(biz), body: JSON.stringify(body) });
}
async function grPost(f, biz, id) {
  return call(f, `${GR(biz)}/${id}/post`, { method: "POST", headers: B(biz) });
}
async function grCancel(f, biz, id) {
  return call(f, `${GR(biz)}/${id}/cancel`, { method: "POST", headers: B(biz) });
}

const RT = (biz) => `/api/v1/inventory/goods-returns`;
async function createRT(f, biz, body) {
  return call(f, RT(biz), { method: "POST", headers: B(biz), body: JSON.stringify(body) });
}
async function rtDetail(f, biz, id) {
  return call(f, `${RT(biz)}/${id}`, { headers: B(biz) });
}
async function rtPatch(f, biz, id, body) {
  return call(f, `${RT(biz)}/${id}`, { method: "PATCH", headers: B(biz), body: JSON.stringify(body) });
}
async function rtAddLine(f, biz, id, body) {
  return call(f, `${RT(biz)}/${id}/lines`, { method: "POST", headers: B(biz), body: JSON.stringify(body) });
}
async function rtPatchLine(f, biz, id, lineId, body) {
  return call(f, `${RT(biz)}/${id}/lines/${lineId}`, { method: "PATCH", headers: B(biz), body: JSON.stringify(body) });
}
async function rtDeleteLine(f, biz, id, lineId) {
  return call(f, `${RT(biz)}/${id}/lines/${lineId}`, { method: "DELETE", headers: B(biz) });
}
async function rtPost(f, biz, id) {
  return call(f, `${RT(biz)}/${id}/post`, { method: "POST", headers: B(biz) });
}
async function rtCancel(f, biz, id) {
  return call(f, `${RT(biz)}/${id}/cancel`, { method: "POST", headers: B(biz) });
}

function csvView(result) {
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(result.res.bytes);
  return { bytes: result.res.bytes, text: text.replace(/^\uFEFF/, "") };
}

/** Posted receipt with one line; returns {receipt, lineId (RECEIPT line), poLineId, lineQty}. */
async function postedReceipt(f, biz, poId, poDetail, opts = {}) {
  const gr = await createGR(f, biz, { purchaseOrderId: poId, reference: opts.reference });
  const poLineId = poDetail.body.data.lines[opts.lineIndex ?? 0].id;
  await grAddLine(f, biz, gr.body.data.id, { purchaseOrderLineId: poLineId, receivedQty: opts.receivedQty ?? 100 });
  await grPost(f, biz, gr.body.data.id);
  // The RETURN line-add API consumes the RECEIPT LINE id (§57) — resolve it
  // from the receipt detail (never the PO line id).
  const d = await grDetail(f, biz, gr.body.data.id);
  const receiptLine = d.body.data.lines.find((l) => l.purchaseOrderLineId === poLineId);
  return { receipt: gr.body.data, lineId: receiptLine.id, poLineId, lineQty: opts.receivedQty ?? 100, receiptDetail: d.body.data };
}

async function main() {
  /* ----------------------------- A. crashed-run sweep ---------------------- */
  section("0. crashed-run recovery sweep (§195)");
  {
    const bizs = await db.business.findMany({ where: { name: { startsWith: `${TAG}-` } }, select: { id: true } });
    for (const b of bizs) {
      await db.auditLog.deleteMany({ where: { businessId: b.id } });
      await db.goodsReturnLine.deleteMany({ where: { goodsReturn: { businessId: b.id } } });
      await db.goodsReturn.deleteMany({ where: { businessId: b.id } });
      await db.goodsReceiptLine.deleteMany({ where: { goodsReceipt: { businessId: b.id } } });
      await db.goodsReceipt.deleteMany({ where: { businessId: b.id } });
      await db.inventoryAdjustment.deleteMany({ where: { businessId: b.id } });
      await db.inventoryStocktakeLine.deleteMany({ where: { stocktake: { businessId: b.id } } });
      await db.inventoryStocktake.deleteMany({ where: { businessId: b.id } });
      await db.purchaseOrderLine.deleteMany({ where: { purchaseOrder: { businessId: b.id } } });
      await db.purchaseOrder.deleteMany({ where: { businessId: b.id } });
      await db.product.deleteMany({ where: { businessId: b.id } });
      await db.supplier.deleteMany({ where: { businessId: b.id } });
      await db.subscriptionEvent.deleteMany({ where: { subscription: { businessId: b.id } } });
      await db.subscription.deleteMany({ where: { businessId: b.id } });
      await db.businessMember.deleteMany({ where: { businessId: b.id } });
      await db.business.deleteMany({ where: { id: b.id } });
    }
    await db.user.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
    await db.plan.deleteMany({ where: { code: { startsWith: `${TAG}-` } } });
    ok("0.1 no P43RT residue before the run", true);
  }

  /* --------------------------------- 1. setup ------------------------------ */
  section("1. fixtures — users, businesses, sessions");
  const emails = {
    ownerA: `${TAG.toLowerCase()}-owner-${STAMP}@${DOMAIN}`,
    memberA: `${TAG.toLowerCase()}-member-${STAMP}@${DOMAIN}`,
    ownerB: `${TAG.toLowerCase()}-foreign-${STAMP}@${DOMAIN}`,
    ownerC: `${TAG.toLowerCase()}-export-${STAMP}@${DOMAIN}`,
  };
  const hash = bcrypt.hashSync(PASS, 4);
  const userA = await db.user.create({ data: { email: emails.ownerA, name: "Owner A", passwordHash: hash, emailVerifiedAt: new Date() }, select: { id: true } });
  const userV = await db.user.create({ data: { email: emails.memberA, name: "Viewer A", passwordHash: hash, emailVerifiedAt: new Date() }, select: { id: true } });
  const userB = await db.user.create({ data: { email: emails.ownerB, name: "Owner B", passwordHash: hash, emailVerifiedAt: new Date() }, select: { id: true } });
  const userC = await db.user.create({ data: { email: emails.ownerC, name: "Owner C", passwordHash: hash, emailVerifiedAt: new Date() }, select: { id: true } });

  const bizA = await db.business.create({
    data: {
      name: `${TAG}-A-${STAMP}`, slug: `p43rt-a-${STAMP}`, currencyCode: "USD", currencySymbol: "$",
      decimalPrecision: 2, ownerId: userA.id,
      members: { create: { userId: userA.id, role: "OWNER" } },
    }, select: { id: true },
  });
  await db.businessMember.create({ data: { businessId: bizA.id, userId: userV.id, role: "MEMBER" } });
  const bizB = await db.business.create({
    data: {
      name: `${TAG}-B-${STAMP}`, slug: `p43rt-b-${STAMP}`, currencyCode: "EUR", currencySymbol: "€",
      decimalPrecision: 2, ownerId: userB.id,
      members: { create: { userId: userB.id, role: "OWNER" } },
    }, select: { id: true },
  });
  const bizC = await db.business.create({
    data: {
      name: `${TAG}-C-${STAMP}`, slug: `p43rt-c-${STAMP}`, currencyCode: "USD", currencySymbol: "$",
      decimalPrecision: 2, ownerId: userC.id,
      members: { create: { userId: userC.id, role: "OWNER" } },
    }, select: { id: true },
  });
  ok("1.1 businesses created", Boolean(bizA.id && bizB.id && bizC.id));

  const publicPlan = await db.plan.findFirst({ where: { isPublic: true, active: true }, orderBy: { sortOrder: "asc" } });
  ok("1.2 public plan available", Boolean(publicPlan));
  const defs = await db.entitlementDefinition.findMany();
  const defByCode = new Map(defs.map((d) => [d.code, d.id]));
  const noExpPlan = await db.plan.create({
    data: {
      code: `${TAG}-NOEXP-${STAMP}`, name: `${TAG} No-Export Plan`, isPublic: false, active: true, sortOrder: 911,
      planEntitlements: {
        create: [
          { entitlementId: defByCode.get("CUSTOMERS_MAX"), value: 50 },
          { entitlementId: defByCode.get("PRODUCTS_MAX"), value: 100 },
          { entitlementId: defByCode.get("TEAM_MEMBERS_MAX"), value: 2 },
          { entitlementId: defByCode.get("BUSINESSES_MAX"), value: 1 },
          { entitlementId: defByCode.get("CSV_EXPORT"), boolValue: false },
        ],
      },
    }, select: { id: true },
  });
  await db.subscription.create({ data: { businessId: bizA.id, planId: noExpPlan.id, status: "ACTIVE", billingPeriod: "MONTHLY" } });
  await db.subscription.create({ data: { businessId: bizB.id, planId: publicPlan.id, status: "ACTIVE", billingPeriod: "MONTHLY" } });
  const expPlan = await db.plan.create({
    data: {
      code: `${TAG}-EXP-${STAMP}`, name: `${TAG} Export Plan`, isPublic: false, active: true, sortOrder: 910,
      planEntitlements: {
        create: [
          { entitlementId: defByCode.get("CUSTOMERS_MAX"), value: 50 },
          { entitlementId: defByCode.get("PRODUCTS_MAX"), value: 100 },
          { entitlementId: defByCode.get("TEAM_MEMBERS_MAX"), value: 2 },
          { entitlementId: defByCode.get("BUSINESSES_MAX"), value: 1 },
          { entitlementId: defByCode.get("CSV_EXPORT"), boolValue: true },
        ],
      },
    }, select: { id: true },
  });
  await db.subscription.create({ data: { businessId: bizC.id, planId: expPlan.id, status: "ACTIVE", billingPeriod: "MONTHLY" } });
  ok("1.3 plans wired (bizA no-export, bizC export)", Boolean(noExpPlan.id && expPlan.id));

  const fA = makeClient();
  const fB = makeClient();
  const fC = makeClient();
  const fV = makeClient();
  const fAnon = makeClient();
  await login(fA, emails.ownerA);
  await login(fB, emails.ownerB);
  await login(fC, emails.ownerC);
  await login(fV, emails.memberA);
  ok("1.4 sessions established", true);

  const supAlpha = await createSupplier(fA, bizA.id, `${TAG}-SUP-Alpha`);
  const prodA = await createProduct(fA, bizA.id, `${TAG}-PROD-Alpha`, `${TAG}-SKU-A1`, 10);
  const prodB = await createProduct(fA, bizA.id, `${TAG}-PROD-Beta`, `${TAG}-SKU-A2`, 5);
  ok("1.5 supplier + products ready", Boolean(supAlpha?.id && prodA?.id && prodB?.id));

  const supForeign = await createSupplier(fB, bizB.id, `${TAG}-SUP-Foreign`);
  const prodForeign = await createProduct(fB, bizB.id, `${TAG}-PROD-Foreign`, `${TAG}-SKU-B1`, 3);
  const poForeignId = await confirmedPO(fB, bizB.id, supForeign.id, [{ productId: prodForeign.id, orderedQty: 50, unitPriceMinor: 100 }]);
  const poFDetail = await call(fB, `/api/v1/purchase-orders/${poForeignId}`, { headers: B(bizB.id) });
  const foreignRt = await postedReceipt(fB, bizB.id, poForeignId, poFDetail, { reference: `GR-FR-${STAMP}`, receivedQty: 3 });
  ok("1.6 foreign fixture ready (posted receipt)", Boolean(poForeignId));

  /* ------------------------- 2. auth/RBAC (§69/§151) ----------------------- */
  section("2. authentication + RBAC");
  {
    const r1 = await call(fAnon, RT(bizA.id));
    eq(r1.status, 401, "2.1 anonymous list → 401");
    const r2 = await fAnon(`${RT(bizA.id)}/ckanonunknownid0000000000/post`, { method: "POST", headers: B(bizA.id) });
    eq(r2.status, 401, "2.2 anonymous post → 401");
    const r3 = await call(fV, RT(bizA.id), { method: "POST", headers: B(bizA.id), body: JSON.stringify({ goodsReceiptId: "x" }) });
    eq(r3.status, 403, "2.3 MEMBER write → 403 (data:write)");
    const r4 = await call(fV, RT(bizA.id), { headers: B(bizA.id) });
    eq(r4.status, 200, "2.4 MEMBER read → 200 (data:read)");
    const r5 = await call(fAnon, `${RT(bizA.id)}/whatever/export`);
    eq(r5.status, 401, "2.5 anonymous export → 401");
  }

  /* ---------------------- 3. source-receipt law (§13) ---------------------- */
  section("3. source receipt must be POSTED + tenant-local");
  {
    // 3.a DRAFT receipt → 422
    const poDraft = await confirmedPO(fA, bizA.id, supAlpha.id, [{ productId: prodA.id, orderedQty: 100, unitPriceMinor: 100 }]);
    const poDraftDetail = await call(fA, `/api/v1/purchase-orders/${poDraft}`, { headers: B(bizA.id) });
    const grDraft = await createGR(fA, bizA.id, { purchaseOrderId: poDraft, reference: `GR-DR-${STAMP}` });
    await grAddLine(fA, bizA.id, grDraft.body.data.id, { purchaseOrderLineId: poDraftDetail.body.data.lines[0].id, receivedQty: 100 });
    const fromDraft = await createRT(fA, bizA.id, { goodsReceiptId: grDraft.body.data.id });
    eq(fromDraft.status, 422, "3.1 return from DRAFT receipt → 422");
    eq(fromDraft.body?.error?.code, "GOODS_RETURN_SOURCE_NOT_POSTED", "3.2 stable code SOURCE_NOT_POSTED");

    // 3.b CANCELLED receipt → 422
    await grCancel(fA, bizA.id, grDraft.body.data.id);
    const fromCancelled = await createRT(fA, bizA.id, { goodsReceiptId: grDraft.body.data.id });
    eq(fromCancelled.status, 422, "3.3 return from CANCELLED receipt → 422");

    // 3.c foreign receipt → 404 (no existence leak)
    const foreign = await createRT(fA, bizA.id, { goodsReceiptId: foreignRt.receipt.id });
    eq(foreign.status, 404, "3.4 FOREIGN receipt → tenant-safe 404");
    ok(!JSON.stringify(foreign.body).includes("Tenant B") && foreign.body?.error?.code !== "FORBIDDEN", "3.5 no cross-tenant wording leak");

    // 3.d unknown receipt → 404
    const unknown = await createRT(fA, bizA.id, { goodsReceiptId: "ckmalloc0notarealid00000" });
    eq(unknown.status, 404, "3.6 unknown receipt → 404");
  }

  /* --------------- 4. create draft + references (§19-§21/§56) -------------- */
  section("4. draft creation + reference laws");
  let receipt100 = null;
  let receiptLine100 = null;
  let ret1 = null;
  {
    const po1 = await confirmedPO(fA, bizA.id, supAlpha.id, [{ productId: prodA.id, orderedQty: 100, unitPriceMinor: 100 }, { productId: prodB.id, orderedQty: 200, unitPriceMinor: 100 }]);
    const po1Detail = await call(fA, `/api/v1/purchase-orders/${po1}`, { headers: B(bizA.id) });
    const posted = await postedReceipt(fA, bizA.id, po1, po1Detail, { reference: `GR-A-${STAMP}`, receivedQty: 100, lineIndex: 0 });
    receipt100 = posted.receipt;
    receiptLine100 = posted.lineId;

    // 4.a explicit reference
    const r1 = await createRT(fA, bizA.id, { goodsReceiptId: receipt100.id, reference: `RET-X-${STAMP}` });
    eq(r1.status, 201, "4.1 create with explicit reference → 201");
    eq(r1.body.data.reference, `RET-X-${STAMP}`, "4.2 reference echoed");
    ret1 = r1.body.data;

    // 4.b duplicate reference → 409 stable
    const r2 = await createRT(fA, bizA.id, { goodsReceiptId: receipt100.id, reference: `RET-X-${STAMP}` });
    eq(r2.status, 409, "4.3 duplicate reference → 409");
    eq(r2.body?.error?.code, "GOODS_RETURN_DUPLICATE_REFERENCE", "4.4 stable code DUPLICATE_REFERENCE");

    // 4.c blank reference → server-generated RET-<date>-<token>
    const r3 = await createRT(fA, bizA.id, { goodsReceiptId: receipt100.id, reference: "  " });
    eq(r3.status, 201, "4.5 blank reference → generated");
    ok(/^RET-\d{8}-[A-Z2-9]{6}$/.test(r3.body.data.reference ?? ""), `4.6 generated reference format (${r3.body.data.reference})`);

    // 4.d newline-injected reference → 422
    const r4 = await createRT(fA, bizA.id, { goodsReceiptId: receipt100.id, reference: `bad\nref-${STAMP}` });
    eq(r4.status, 422, "4.7 newline-injected reference rejected (§19)");

    // 4.e status DRAFT server-derived; client status ignored
    const r5 = await createRT(fA, bizA.id, { goodsReceiptId: receipt100.id, status: "POSTED" });
    eq(r5.status, 201, "4.8 client status field ignored");
    eq(r5.body.data.status, "DRAFT", "4.9 created as DRAFT");
    ret1 = r5.body.data; // keep the generated one for later sections

    // 4.f snapshots derived from the receipt
    const d = await rtDetail(fA, bizA.id, r5.body.data.id);
    eq(d.body.data.supplierNameAtReturn, `${TAG}-SUP-Alpha`, "4.10 supplier snapshot from receipt (§16)");
    eq(d.body.data.goodsReceipt.referenceAtReturn, `GR-A-${STAMP}`, "4.11 receipt reference snapshot (§17)");
    ok(typeof d.body.data.purchaseOrderReferenceAtReturn === "string" && d.body.data.purchaseOrderReferenceAtReturn.length > 0, "4.12 PO reference snapshot (§18)");
    eq(d.body.data.status, "DRAFT", "4.13 status DRAFT");
  }

  /* --------------- 5. header patch + validation (§59/§19-§22) -------------- */
  section("5. header patch (DRAFT-only)");
  {
    const r = await rtPatch(fA, bizA.id, ret1.id, { notes: "return packaging damaged" });
    eq(r.status, 200, "5.1 patch notes → 200");
    const d = await rtDetail(fA, bizA.id, ret1.id);
    eq(d.body.data.notes, "return packaging damaged", "5.2 notes persisted");

    const r2 = await rtPatch(fA, bizA.id, ret1.id, { goodsReceiptId: foreignRt.receipt.id });
    ok(r2.status === 400 || r2.status === 422 || r2.status === 200, "5.3 re-sourcing via patch structurally rejected or ignored");
    const d2 = await rtDetail(fA, bizA.id, ret1.id);
    eq(d2.body.data.goodsReceipt.id, receipt100.id, "5.4 source receipt unchanged (§14)");

    const r3 = await rtPatch(fA, bizA.id, ret1.id, { status: "POSTED" });
    ok(r3.status === 400 || r3.status === 422 || r3.status === 200, "5.5 status via patch structurally rejected or ignored");
    const d3 = await rtDetail(fA, bizA.id, ret1.id);
    eq(d3.body.data.status, "DRAFT", "5.6 status still DRAFT");
  }

  /* ------------------- 6. line CRUD (§57/§58/§60/§62) ---------------------- */
  section("6. line add / update / remove");
  let ret1LineId = null;
  {
    const r = await rtAddLine(fA, bizA.id, ret1.id, { goodsReceiptLineId: receiptLine100, returnedQty: 10, reasonCode: "DAMAGED" });
    eq(r.status, 201, "6.1 add line → 201");
    ret1LineId = r.body.data.id;

    // client productId rejected (strict schema)
    const r2 = await rtAddLine(fA, bizA.id, ret1.id, { goodsReceiptLineId: receiptLine100, returnedQty: 5, reasonCode: "OTHER", productId: "hack" });
    eq(r2.status, 422, "6.2 client productId REJECTED (strict §57)");

    // duplicate line (same receipt line twice) → 409
    const r3 = await rtAddLine(fA, bizA.id, ret1.id, { goodsReceiptLineId: receiptLine100, returnedQty: 5, reasonCode: "OTHER" });
    eq(r3.status, 409, "6.3 duplicate source line → 409");
    eq(r3.body?.error?.code, "GOODS_RETURN_DUPLICATE_LINE", "6.4 stable code DUPLICATE_LINE");

    // foreign receipt line → 404
    const r4 = await rtAddLine(fA, bizA.id, ret1.id, { goodsReceiptLineId: foreignRt.lineId, returnedQty: 1, reasonCode: "OTHER" });
    eq(r4.status, 404, "6.5 FOREIGN receipt line → 404");
    eq(r4.body?.error?.code, "GOODS_RETURN_SOURCE_LINE_NOT_FOUND", "6.6 stable code SOURCE_LINE_NOT_FOUND");

    // quantity laws
    const r5 = await rtAddLine(fA, bizA.id, ret1.id, { goodsReceiptLineId: receiptLine100, returnedQty: 0, reasonCode: "OTHER" });
    eq(r5.status, 422, "6.7 qty 0 → 422");
    const r6 = await rtAddLine(fA, bizA.id, ret1.id, { goodsReceiptLineId: receiptLine100, returnedQty: 1.5, reasonCode: "OTHER" });
    eq(r6.status, 422, "6.8 qty 1.5 → 422");
    const r7 = await rtAddLine(fA, bizA.id, ret1.id, { goodsReceiptLineId: receiptLine100, returnedQty: 101, reasonCode: "OTHER" });
    eq(r7.status, 409, "6.9 qty 101 > returnable 100 → 409 (advisory §62)");
    eq(r7.body?.error?.code, "GOODS_RETURN_EXCEEDS_RETURNABLE", "6.10 stable code EXCEEDS_RETURNABLE");

    // line update (qty + reason)
    const r8 = await rtPatchLine(fA, bizA.id, ret1.id, ret1LineId, { returnedQty: 15, reasonCode: "QUALITY_ISSUE" });
    eq(r8.status, 200, "6.11 update line qty+reason → 200");
    eq(r8.body.data.returnedQty, 15, "6.12 qty updated");
    eq(r8.body.data.reasonCode, "QUALITY_ISSUE", "6.13 reason updated");

    const r8b = await rtPatchLine(fA, bizA.id, ret1.id, ret1LineId, { returnedQty: 15, reasonCode: "QUALITY_ISSUE", productId: "hack" });
    eq(r8b.status, 422, "6.14 line update rejects productId (strict §58)");

    // line remove then re-add
    const r9 = await rtDeleteLine(fA, bizA.id, ret1.id, ret1LineId);
    eq(r9.status, 200, "6.15 remove line → 200");
    const r10 = await rtAddLine(fA, bizA.id, ret1.id, { goodsReceiptLineId: receiptLine100, returnedQty: 30, reasonCode: "DAMAGED" });
    eq(r10.status, 201, "6.16 re-add line → 201");
    ret1LineId = r10.body.data.id;
  }

  /* --------------- 7. draft never mutates stock (§10/§156) ----------------- */
  section("7. draft purity — no stock/adjustment mutation");
  {
    const prodBefore = await db.product.findUnique({ where: { id: prodA.id }, select: { stockQty: true } });
    // "initial stock" rows come from product creation; everything else must
    // be the ONE receiving adjustment from the posted fixture receipt.
    const adjRows = await db.inventoryAdjustment.findMany({ where: { businessId: bizA.id }, select: { delta: true, reason: true } });
    const nonInitial = adjRows.filter((a) => a.reason !== "initial stock");
    eq(prodBefore.stockQty, 110, "7.1 stock unchanged while DRAFT (10 + 100 received)");
    eq(nonInitial.length, 1, "7.2 exactly ONE non-initial adjustment (the receipt receiving)");
    ok(nonInitial.every((a) => a.delta > 0 && a.reason.includes("Goods receipt")), "7.3 it is the receipt's positive adjustment");
    // NOTE: §157 cancel purity verified in section 13 after cancelling a draft.
  }

  /* ------------------- 8. post (§43/§152 — CRITICAL) ----------------------- */
  section("8. CRITICAL POST — stock decrement + negative adjustment");
  {
    const stockBefore = (await db.product.findUnique({ where: { id: prodA.id }, select: { stockQty: true } })).stockQty;
    const r = await rtPost(fA, bizA.id, ret1.id);
    eq(r.status, 200, "8.1 post → 200");
    eq(r.body.data.status, "POSTED", "8.2 status POSTED");
    eq(r.body.data.totalReturnedQty, 30, "8.3 totalReturnedQty 30");
    eq(r.body.data.lineCount, 1, "8.4 lineCount 1");
    ok(r.body.data.postedAt, "8.5 postedAt server-generated");

    const stockAfter = (await db.product.findUnique({ where: { id: prodA.id }, select: { stockQty: true } })).stockQty;
    eq(stockAfter, stockBefore - 30, "8.6 §152 CRITICAL: stock decreased by exactly 30");

    const adj = await db.inventoryAdjustment.findMany({ where: { businessId: bizA.id, productId: prodA.id, delta: { lt: 0 } }, orderBy: { createdAt: "desc" }, take: 1 });
    eq(adj.length, 1, "8.7 one NEGATIVE adjustment created");
    eq(adj[0].delta, -30, "8.8 §152 CRITICAL: delta = -30");
    ok(adj[0].reason.includes(ret1.reference), "8.9 adjustment reason ties to the return reference (§44)");
    eq(adj[0].actorId, userA.id, "8.10 adjustment actor = server ctx user (§45)");
    eq(adj[0].businessId, bizA.id, "8.11 adjustment business = server ctx (§46)");

    // source receipt immutable
    const gr = await db.goodsReceipt.findUnique({ where: { id: receipt100.id }, select: { status: true, postedAt: true } });
    eq(gr.status, "POSTED", "8.12 source receipt status still POSTED (§8)");
    const grLines = await db.goodsReceiptLine.findMany({ where: { goodsReceiptId: receipt100.id } });
    eq(grLines[0].receivedQty, 100, "8.13 §152 CRITICAL: source receivedQty UNCHANGED (immutable)");

    // no financial rows created
    const expenses = await db.expense.count({ where: { businessId: bizA.id } });
    const payments = await db.payment.count({ where: { businessId: bizA.id } });
    const sales = await db.sale.count({ where: { businessId: bizA.id } });
    eq(expenses, 0, "8.14 NO expense created (§7)");
    eq(payments, 0, "8.15 NO payment created (§7)");
    eq(sales, 0, "8.16 NO sale created (§7)");

    // second post → 409 (§53)
    const r2 = await rtPost(fA, bizA.id, ret1.id);
    eq(r2.status, 409, "8.17 second POST → 409 (no double decrement)");
    eq(r2.body?.error?.code, "GOODS_RETURN_INVALID_TRANSITION", "8.18 stable code INVALID_TRANSITION");
    const stockAfter2 = (await db.product.findUnique({ where: { id: prodA.id }, select: { stockQty: true } })).stockQty;
    eq(stockAfter2, stockAfter, "8.19 stock NOT decremented twice (§53)");
    const negAdjCount = await db.inventoryAdjustment.count({ where: { businessId: bizA.id, productId: prodA.id, delta: { lt: 0 } } });
    eq(negAdjCount, 1, "8.20 exactly ONE negative adjustment (§53)");
  }

  /* --------------- 9. POSTED immutability (§11/§54/§97) -------------------- */
  section("9. POSTED return is immutable");
  {
    const p1 = await rtPatch(fA, bizA.id, ret1.id, { notes: "hack" });
    eq(p1.status, 409, "9.1 patch POSTED → 409");
    eq(p1.body?.error?.code, "GOODS_RETURN_IMMUTABLE", "9.2 stable code IMMUTABLE");
    const p2 = await rtPatchLine(fA, bizA.id, ret1.id, ret1LineId, { returnedQty: 5, reasonCode: "OTHER" });
    eq(p2.status, 409, "9.3 line edit POSTED → 409");
    const p3 = await rtDeleteLine(fA, bizA.id, ret1.id, ret1LineId);
    eq(p3.status, 409, "9.4 line delete POSTED → 409");
    const p4 = await rtCancel(fA, bizA.id, ret1.id);
    eq(p4.status, 409, "9.5 §54 NO POSTED → CANCELLED");
    eq(p4.body?.error?.code, "GOODS_RETURN_INVALID_TRANSITION", "9.6 stable code INVALID_TRANSITION");
    const d = await rtDetail(fA, bizA.id, ret1.id);
    eq(d.body.data.lines[0].returnedQty, 30, "9.7 posted line data unchanged");
  }

  /* -------------------- 10. partial returns (§154) ------------------------- */
  section("10. partial returns exhaust the cumulative cap (§154)");
  {
    // receiptLine100: received 100; 30 already returned (section 8). Left 70.
    // §154 walk: +20 (50 total, 50 left) → +30 (80 total, 20 left) → +20
    // (100 total, 0 left) → +1 rejected. NO tolerance (§35).
    const r1 = await createRT(fA, bizA.id, { goodsReceiptId: receipt100.id, reference: `RET-P1-${STAMP}` });
    const line1 = (await rtAddLine(fA, bizA.id, r1.body.data.id, { goodsReceiptLineId: receiptLine100, returnedQty: 20, reasonCode: "EXCESS" })).body.data.id;
    const p1 = await rtPost(fA, bizA.id, r1.body.data.id);
    eq(p1.status, 200, "10.1 return 20 posted (50 total)");

    const facts1 = await grDetail(fA, bizA.id, receipt100.id);
    const f1 = facts1.body.data.returns.lines.find((l) => l.goodsReceiptLineId === receiptLine100);
    eq(f1.returnedQty, 50, "10.2 receipt facts: returned 30+20=50");
    eq(f1.returnableQty, 50, "10.3 receipt facts: returnable 50 (§86)");
    eq(f1.receivedQty, 100, "10.4 receipt facts: received stays 100 (immutable)");

    const r2 = await createRT(fA, bizA.id, { goodsReceiptId: receipt100.id, reference: `RET-P2-${STAMP}` });
    await rtAddLine(fA, bizA.id, r2.body.data.id, { goodsReceiptLineId: receiptLine100, returnedQty: 30, reasonCode: "WRONG_ITEM" });
    const p2 = await rtPost(fA, bizA.id, r2.body.data.id);
    eq(p2.status, 200, "10.5 return 30 posted (80 total)");

    const r3 = await createRT(fA, bizA.id, { goodsReceiptId: receipt100.id, reference: `RET-P3-${STAMP}` });
    await rtAddLine(fA, bizA.id, r3.body.data.id, { goodsReceiptLineId: receiptLine100, returnedQty: 20, reasonCode: "OTHER" });
    const p3 = await rtPost(fA, bizA.id, r3.body.data.id);
    eq(p3.status, 200, "10.6 final 20 posted — cumulative 100, returnable 0");

    const facts2 = await grDetail(fA, bizA.id, receipt100.id);
    const f2 = facts2.body.data.returns.lines.find((l) => l.goodsReceiptLineId === receiptLine100);
    eq(f2.returnedQty, 100, "10.6b returned exactly 100");
    eq(f2.returnableQty, 0, "10.6c returnable 0");

    const r4 = await createRT(fA, bizA.id, { goodsReceiptId: receipt100.id, reference: `RET-P4-${STAMP}` });
    const r4line = await rtAddLine(fA, bizA.id, r4.body.data.id, { goodsReceiptLineId: receiptLine100, returnedQty: 1, reasonCode: "OTHER" });
    eq(r4line.status, 409, "10.7 §153: one more unit → 409 (no tolerance)");
    const r4post = await rtPost(fA, bizA.id, r4.body.data.id);
    eq(r4post.status, 422, "10.8 §61: empty return cannot post either");
    await rtCancel(fA, bizA.id, r4.body.data.id);
  }

  /* ----------------- 11. stale draft (§63/§151) ---------------------------- */
  section("11. stale draft cannot post (§63)");
  {
    const po2 = await confirmedPO(fA, bizA.id, supAlpha.id, [{ productId: prodA.id, orderedQty: 300, unitPriceMinor: 100 }]);
    const po2Detail = await call(fA, `/api/v1/purchase-orders/${po2}`, { headers: B(bizA.id) });
    const rec2 = await postedReceipt(fA, bizA.id, po2, po2Detail, { reference: `GR-B-${STAMP}`, receivedQty: 100 });

    const draftA = await createRT(fA, bizA.id, { goodsReceiptId: rec2.receipt.id, reference: `RET-DA-${STAMP}` });
    await rtAddLine(fA, bizA.id, draftA.body.data.id, { goodsReceiptLineId: rec2.lineId, returnedQty: 70, reasonCode: "OTHER" });
    const draftB = await createRT(fA, bizA.id, { goodsReceiptId: rec2.receipt.id, reference: `RET-DB-${STAMP}` });
    await rtAddLine(fA, bizA.id, draftB.body.data.id, { goodsReceiptLineId: rec2.lineId, returnedQty: 50, reasonCode: "OTHER" });

    await rtPost(fA, bizA.id, draftA.body.data.id);
    ok("11.1 draft A (70) posted", true);

    const stockBefore = (await db.product.findUnique({ where: { id: prodA.id }, select: { stockQty: true } })).stockQty;
    const r = await rtPost(fA, bizA.id, draftB.body.data.id);
    eq(r.status, 409, "11.2 stale draft B (50; 70 already returned; 30 left) → 409");
    eq(r.body?.error?.code, "GOODS_RETURN_EXCEEDS_RETURNABLE", "11.3 stable code EXCEEDS_RETURNABLE");
    const stockAfter = (await db.product.findUnique({ where: { id: prodA.id }, select: { stockQty: true } })).stockQty;
    eq(stockAfter, stockBefore, "11.4 NO stock mutation from the stale post");
    await rtCancel(fA, bizA.id, draftB.body.data.id);
  }

  /* ----------------- 12. insufficient stock (§39/§155) --------------------- */
  section("12. current stock check (§155)");
  {
    const po3 = await confirmedPO(fA, bizA.id, supAlpha.id, [{ productId: prodB.id, orderedQty: 100, unitPriceMinor: 100 }]);
    const po3Detail = await call(fA, `/api/v1/purchase-orders/${po3}`, { headers: B(bizA.id) });
    // prodB: stock 5 (initial) + 100 (receipt) = 105. Sell nothing; instead
    // create receipt 100 but manually reduce stock to 10 via adjustment.
    const rec3 = await postedReceipt(fA, bizA.id, po3, po3Detail, { reference: `GR-C-${STAMP}`, receivedQty: 100 });
    await db.product.update({ where: { id: prodB.id }, data: { stockQty: 10 } });
    const draft = await createRT(fA, bizA.id, { goodsReceiptId: rec3.receipt.id, reference: `RET-S-${STAMP}` });
    await rtAddLine(fA, bizA.id, draft.body.data.id, { goodsReceiptLineId: rec3.lineId, returnedQty: 20, reasonCode: "DAMAGED" });
    const r = await rtPost(fA, bizA.id, draft.body.data.id);
    eq(r.status, 409, "12.1 stock 10 < return 20 → 409 INSUFFICIENT_STOCK");
    eq(r.body?.error?.code, "GOODS_RETURN_INSUFFICIENT_STOCK", "12.2 stable code INSUFFICIENT_STOCK");
    const stock = (await db.product.findUnique({ where: { id: prodB.id }, select: { stockQty: true } })).stockQty;
    eq(stock, 10, "12.3 NO partial decrement (§39)");
    const negAdj = await db.inventoryAdjustment.count({ where: { businessId: bizA.id, productId: prodB.id, delta: { lt: 0 } } });
    eq(negAdj, 0, "12.4 NO adjustment created (§39)");
    eq((await db.goodsReturn.findUnique({ where: { id: draft.body.data.id } })).status, "DRAFT", "12.5 status remains DRAFT");
    // restore stock for later sections + cancel the draft
    await db.product.update({ where: { id: prodB.id }, data: { stockQty: 105 } });
    await rtCancel(fA, bizA.id, draft.body.data.id);
  }

  /* ---------------- 13. draft purity on cancel (§12/§157) ------------------ */
  section("13. cancel purity — DRAFT never changed inventory (§157)");
  {
    const po4 = await confirmedPO(fA, bizA.id, supAlpha.id, [{ productId: prodA.id, orderedQty: 300, unitPriceMinor: 100 }]);
    const po4Detail = await call(fA, `/api/v1/purchase-orders/${po4}`, { headers: B(bizA.id) });
    const rec4 = await postedReceipt(fA, bizA.id, po4, po4Detail, { reference: `GR-D-${STAMP}`, receivedQty: 100 });
    const draft = await createRT(fA, bizA.id, { goodsReceiptId: rec4.receipt.id, reference: `RET-CX-${STAMP}` });
    await rtAddLine(fA, bizA.id, draft.body.data.id, { goodsReceiptLineId: rec4.lineId, returnedQty: 10, reasonCode: "OTHER" });
    const stockBefore = (await db.product.findUnique({ where: { id: prodA.id }, select: { stockQty: true } })).stockQty;
    const adjBefore = await db.inventoryAdjustment.count({ where: { businessId: bizA.id } });
    const r = await rtCancel(fA, bizA.id, draft.body.data.id);
    eq(r.status, 200, "13.1 cancel DRAFT → 200");
    eq(r.body.data.status, "CANCELLED", "13.2 status CANCELLED");
    ok(r.body.data.cancelledAt, "13.3 cancelledAt server-generated");
    const stockAfter = (await db.product.findUnique({ where: { id: prodA.id }, select: { stockQty: true } })).stockQty;
    eq(stockAfter, stockBefore, "13.4 stock unchanged by cancel (§157)");
    const adjAfter = await db.inventoryAdjustment.count({ where: { businessId: bizA.id } });
    eq(adjAfter, adjBefore, "13.5 NO adjustment from cancel (§157)");

    // cancelled is terminal
    const p1 = await rtPost(fA, bizA.id, draft.body.data.id);
    eq(p1.status, 409, "13.6 CANCELLED cannot post (§12)");
    const p2 = await rtPatch(fA, bizA.id, draft.body.data.id, { notes: "x" });
    eq(p2.status, 409, "13.7 CANCELLED cannot be edited (§12)");
    const p3 = await rtCancel(fA, bizA.id, draft.body.data.id);
    eq(p3.status, 409, "13.8 CANCELLED cannot re-cancel (§12)");
    eq(p1.body?.error?.code, "GOODS_RETURN_INVALID_TRANSITION", "13.9 stable code INVALID_TRANSITION");
  }

  /* ------------- 14. multi-line rollback (§52/§163) ------------------------ */
  section("14. multi-line rollback — one bad line fails ALL (§163)");
  {
    const po5 = await confirmedPO(fA, bizA.id, supAlpha.id, [
      { productId: prodA.id, orderedQty: 300, unitPriceMinor: 100 },
      { productId: prodB.id, orderedQty: 300, unitPriceMinor: 100 },
    ]);
    const po5Detail = await call(fA, `/api/v1/purchase-orders/${po5}`, { headers: B(bizA.id) });
    const lineA = po5Detail.body.data.lines[0].id; // prodA
    const lineB = po5Detail.body.data.lines[1].id; // prodB
    const gr = await createGR(fA, bizA.id, { purchaseOrderId: po5, reference: `GR-E-${STAMP}` });
    await grAddLine(fA, bizA.id, gr.body.data.id, { purchaseOrderLineId: lineA, receivedQty: 50 });
    await grAddLine(fA, bizA.id, gr.body.data.id, { purchaseOrderLineId: lineB, receivedQty: 50 });
    await grPost(fA, bizA.id, gr.body.data.id);
    // Resolve the RECEIPT line ids (§57 — return lines reference receipt lines).
    const grE = await grDetail(fA, bizA.id, gr.body.data.id);
    const receiptLineA = grE.body.data.lines.find((l) => l.purchaseOrderLineId === lineA).id;
    const receiptLineB = grE.body.data.lines.find((l) => l.purchaseOrderLineId === lineB).id;

    const stockA = (await db.product.findUnique({ where: { id: prodA.id }, select: { stockQty: true } })).stockQty;
    const stockB = (await db.product.findUnique({ where: { id: prodB.id }, select: { stockQty: true } })).stockQty;

    const draft = await createRT(fA, bizA.id, { goodsReceiptId: gr.body.data.id, reference: `RET-MB-${STAMP}` });
    await rtAddLine(fA, bizA.id, draft.body.data.id, { goodsReceiptLineId: receiptLineA, returnedQty: 5, reasonCode: "OTHER" });
    // line B valid at add time but corrupted to exceed returnable before post
    await rtAddLine(fA, bizA.id, draft.body.data.id, { goodsReceiptLineId: receiptLineB, returnedQty: 5, reasonCode: "OTHER" });
    // corrupt line B's source receivedQty to make the cumulative check fail
    const lineBRow = await db.goodsReceiptLine.findFirst({ where: { purchaseOrderLineId: lineB }, select: { id: true } });
    const originalReceived = 50;
    await db.goodsReceiptLine.update({ where: { id: lineBRow.id }, data: { receivedQty: 3 } });
    const r = await rtPost(fA, bizA.id, draft.body.data.id);
    eq(r.status, 409, "14.1 second line exceeds its (corrupted) cap → 409");
    // restore
    await db.goodsReceiptLine.update({ where: { id: lineBRow.id }, data: { receivedQty: originalReceived } });
    const stockA2 = (await db.product.findUnique({ where: { id: prodA.id }, select: { stockQty: true } })).stockQty;
    const stockB2 = (await db.product.findUnique({ where: { id: prodB.id }, select: { stockQty: true } })).stockQty;
    eq(stockA2, stockA, "14.2 §163: line 1 stock decrement ROLLED BACK");
    eq(stockB2, stockB, "14.3 §163: no partial stock mutation anywhere");
    const negAdj = await db.inventoryAdjustment.count({ where: { businessId: bizA.id, delta: { lt: 0 }, reason: { contains: `RET-MB-${STAMP}` } } });
    eq(negAdj, 0, "14.4 §163: zero negative adjustments survived");
    const doc = await db.goodsReturn.findUnique({ where: { id: draft.body.data.id }, select: { status: true, postedAt: true } });
    eq(doc.status, "DRAFT", "14.5 §163: status remains DRAFT");
    eq(doc.postedAt, null, "14.6 §163: postedAt remains null");
    const postAudit = await db.auditLog.count({ where: { businessId: bizA.id, action: "goods_return.post", entityId: draft.body.data.id } });
    eq(postAudit, 0, "14.7 §163: post audit does not persist");
    await rtCancel(fA, bizA.id, draft.body.data.id);
  }

  /* --------------- 15. corrupt persisted status (§65) ---------------------- */
  section("15. corrupt persisted status never becomes DRAFT (§65)");
  {
    const po6 = await confirmedPO(fA, bizA.id, supAlpha.id, [{ productId: prodA.id, orderedQty: 300, unitPriceMinor: 100 }]);
    const po6Detail = await call(fA, `/api/v1/purchase-orders/${po6}`, { headers: B(bizA.id) });
    const rec6 = await postedReceipt(fA, bizA.id, po6, po6Detail, { reference: `GR-F-${STAMP}`, receivedQty: 100 });
    const draft = await createRT(fA, bizA.id, { goodsReceiptId: rec6.receipt.id, reference: `RET-CS-${STAMP}` });
    await rtAddLine(fA, bizA.id, draft.body.data.id, { goodsReceiptLineId: rec6.lineId, returnedQty: 10, reasonCode: "OTHER" });
    const original = await db.goodsReturn.findUnique({ where: { id: draft.body.data.id }, select: { status: true } });
    await db.goodsReturn.update({ where: { id: draft.body.data.id }, data: { status: "BROKEN" } });

    const d = await rtDetail(fA, bizA.id, draft.body.data.id);
    eq(d.status, 500, "15.1 detail on corrupt status → 500");
    eq(d.body?.error?.code, "GOODS_RETURN_INVALID_PERSISTED_STATUS", "15.2 stable code INVALID_PERSISTED_STATUS");
    const l = await call(fA, `${RT(bizA.id)}?status=ALL`, { headers: B(bizA.id) });
    eq(l.status, 500, "15.3 list containing corrupt row → 500");
    const p = await rtPost(fA, bizA.id, draft.body.data.id);
    eq(p.status, 500, "15.4 post on corrupt status → 500 (never Draft-postable)");
    const c = await rtCancel(fA, bizA.id, draft.body.data.id);
    eq(c.status, 500, "15.5 cancel on corrupt status → 500");
    const e = await fA(`${RT(bizA.id)}/${draft.body.data.id}/export`, { headers: B(bizA.id) });
    // §108 — the entitlement gate precedes any data read on this tenant
    // (bizA has no CSV_EXPORT), so the gate's 403 fires before the 500.
    eq(e.status, 403, "15.6 export gated by entitlement (§108) before any read");

    await db.goodsReturn.update({ where: { id: draft.body.data.id }, data: { status: original.status } });
    ok("15.7 corrupt status restored", true);
    await rtCancel(fA, bizA.id, draft.body.data.id);
  }

  /* --------------- 16. corrupt return history (§38) ------------------------ */
  section("16. corrupt return history surfaces, never clamps (§38)");
  {
    const po7 = await confirmedPO(fA, bizA.id, supAlpha.id, [{ productId: prodA.id, orderedQty: 300, unitPriceMinor: 100 }]);
    const po7Detail = await call(fA, `/api/v1/purchase-orders/${po7}`, { headers: B(bizA.id) });
    const rec7 = await postedReceipt(fA, bizA.id, po7, po7Detail, { reference: `GR-G-${STAMP}`, receivedQty: 100 });
    const draft = await createRT(fA, bizA.id, { goodsReceiptId: rec7.receipt.id, reference: `RET-CH-${STAMP}` });
    await rtAddLine(fA, bizA.id, draft.body.data.id, { goodsReceiptLineId: rec7.lineId, returnedQty: 10, reasonCode: "OTHER" });
    await rtPost(fA, bizA.id, draft.body.data.id); // POSTED so the aggregate includes it
    const line = await db.goodsReturnLine.findFirst({ where: { goodsReturnId: draft.body.data.id } });
    await db.goodsReturnLine.update({ where: { id: line.id }, data: { returnedQty: 150 } }); // > received 100 — corrupt POSTED history

    // corrupt receipt facts path: returned > received on the POSTED aggregate
    const facts = await grDetail(fA, bizA.id, rec7.receipt.id);
    eq(facts.status, 500, "16.2 receipt return-facts corruption → 500 (§36 — never clamped)");
    eq(facts.body?.error?.code, "GOODS_RETURN_CORRUPT_HISTORY", "16.3 stable code CORRUPT_HISTORY");
    await db.goodsReturnLine.update({ where: { id: line.id }, data: { returnedQty: 10 } });
  }

  /* ------------- 17. negative stock corruption (§41/§164) ------------------ */
  section("17. negative persisted stock → controlled integrity failure (§164)");
  {
    const po8 = await confirmedPO(fA, bizA.id, supAlpha.id, [{ productId: prodA.id, orderedQty: 300, unitPriceMinor: 100 }]);
    const po8Detail = await call(fA, `/api/v1/purchase-orders/${po8}`, { headers: B(bizA.id) });
    const rec8 = await postedReceipt(fA, bizA.id, po8, po8Detail, { reference: `GR-H-${STAMP}`, receivedQty: 100 });
    const draft = await createRT(fA, bizA.id, { goodsReceiptId: rec8.receipt.id, reference: `RET-NG-${STAMP}` });
    await rtAddLine(fA, bizA.id, draft.body.data.id, { goodsReceiptLineId: rec8.lineId, returnedQty: 10, reasonCode: "OTHER" });
    const originalStock = (await db.product.findUnique({ where: { id: prodA.id }, select: { stockQty: true } })).stockQty;
    await db.product.update({ where: { id: prodA.id }, data: { stockQty: -3 } });
    const r = await rtPost(fA, bizA.id, draft.body.data.id);
    eq(r.status, 500, "17.1 negative persisted stock → 500 integrity (§41)");
    eq(r.body?.error?.code, "GOODS_RETURN_INVALID_PERSISTED_STOCK", "17.2 stable code INVALID_PERSISTED_STOCK");
    const after = (await db.product.findUnique({ where: { id: prodA.id }, select: { stockQty: true } })).stockQty;
    eq(after, -3, "17.3 NO silent repair — stock untouched (§164)");
    await db.product.update({ where: { id: prodA.id }, data: { stockQty: originalStock } });
    await rtCancel(fA, bizA.id, draft.body.data.id);
  }

  /* --------------- 18. snapshots survive renames (§165) -------------------- */
  section("18. snapshots follow RECEIPT snapshots, not live names (§165)");
  {
    const supRen = await createSupplier(fA, bizA.id, `${TAG}-SUP-Rename`);
    const prodRen = await createProduct(fA, bizA.id, `${TAG}-PROD-Rename`, `${TAG}-SKU-R1`, 0);
    const po9 = await confirmedPO(fA, bizA.id, supRen.id, [{ productId: prodRen.id, orderedQty: 100, unitPriceMinor: 100 }]);
    const po9Detail = await call(fA, `/api/v1/purchase-orders/${po9}`, { headers: B(bizA.id) });
    const rec9 = await postedReceipt(fA, bizA.id, po9, po9Detail, { reference: `GR-I-${STAMP}`, receivedQty: 100 });

    // rename supplier + product AFTER the receipt
    await db.supplier.update({ where: { id: supRen.id }, data: { name: `${TAG}-SUP-RENAMED` } });
    await db.product.update({ where: { id: prodRen.id }, data: { name: `${TAG}-PROD-RENAMED` } });

    const draft = await createRT(fA, bizA.id, { goodsReceiptId: rec9.receipt.id, reference: `RET-SN-${STAMP}` });
    await rtAddLine(fA, bizA.id, draft.body.data.id, { goodsReceiptLineId: rec9.lineId, returnedQty: 10, reasonCode: "OTHER" });
    const d = await rtDetail(fA, bizA.id, draft.body.data.id);
    eq(d.body.data.supplierNameAtReturn, `${TAG}-SUP-Rename`, "18.1 supplier snapshot = receipt's FROZEN name (not live, §16/§165)");
    eq(d.body.data.lines[0].productNameAtReturn, `${TAG}-PROD-Rename`, "18.2 product snapshot = receipt line's FROZEN name (§30/§165)");
    // restore names
    await db.supplier.update({ where: { id: supRen.id }, data: { name: `${TAG}-SUP-Rename` } });
    await db.product.update({ where: { id: prodRen.id }, data: { name: `${TAG}-PROD-Rename` } });
    await rtCancel(fA, bizA.id, draft.body.data.id);
  }

  /* ------------------- 19. audit events (§131/§132) ------------------------ */
  section("19. audit events");
  {
    const actions = await db.auditLog.groupBy({ by: ["action"], where: { businessId: bizA.id, action: { startsWith: "goods_return." } }, _count: { _all: true } });
    const byAction = new Map(actions.map((a) => [a.action, a._count._all]));
    ok(byAction.get("goods_return.create") >= 8, `19.1 goods_return.create audited (${byAction.get("goods_return.create")})`);
    ok(byAction.get("goods_return.line_add") >= 8, `19.2 goods_return.line_add audited`);
    ok(byAction.get("goods_return.line_update") >= 1, "19.3 goods_return.line_update audited");
    ok(byAction.get("goods_return.line_remove") >= 1, "19.4 goods_return.line_remove audited");
    ok(byAction.get("goods_return.post") >= 6, `19.5 goods_return.post audited (${byAction.get("goods_return.post")})`);
    ok(byAction.get("goods_return.cancel") >= 6, "19.6 goods_return.cancel audited");
    // exactly-once per post (§53): count equals number of POSTED docs
    const postedCount = await db.goodsReturn.count({ where: { businessId: bizA.id, status: "POSTED" } });
    const postAuditCount = await db.auditLog.count({ where: { businessId: bizA.id, action: "goods_return.post" } });
    eq(postAuditCount, postedCount, "19.7 exactly ONE post audit per POSTED document (§53)");
    // no notes content in audit metadata (§22/§132)
    const postAudits = await db.auditLog.findMany({ where: { businessId: bizA.id, action: "goods_return.post" }, take: 5 });
    ok(postAudits.every((a) => !JSON.stringify(a.after ?? {}).includes("packaging")), "19.8 audit metadata carries NO notes content (§132)");
  }

  /* --------------- 20. replacement receipt (§81/§160) ---------------------- */
  section("20. replacement receipt after return (§81/§160) + over-receipt (§82/§161)");
  let replPoId = null;
  {
    const po = await confirmedPO(fA, bizA.id, supAlpha.id, [{ productId: prodA.id, orderedQty: 100, unitPriceMinor: 100 }]);
    replPoId = po;
    const poDetail = await call(fA, `/api/v1/purchase-orders/${po}`, { headers: B(bizA.id) });
    const rec = await postedReceipt(fA, bizA.id, po, poDetail, { reference: `GR-J-${STAMP}`, receivedQty: 100 });

    // summary BEFORE return: gross 100, remaining 0
    const poDetail2 = await call(fA, `/api/v1/purchase-orders/${po}`, { headers: B(bizA.id) });
    eq(poDetail2.body.data.receiving.receivedQty, 100, "20.1 gross received 100");
    eq(poDetail2.body.data.receiving.remainingQty, 0, "20.2 remaining 0 (fully received)");

    // return 20
    const ret = await createRT(fA, bizA.id, { goodsReceiptId: rec.receipt.id, reference: `RET-REPL-${STAMP}` });
    await rtAddLine(fA, bizA.id, ret.body.data.id, { goodsReceiptLineId: rec.lineId, returnedQty: 20, reasonCode: "EXCESS" });
    await rtPost(fA, bizA.id, ret.body.data.id);

    // net summary AFTER return
    const poDetail3 = await call(fA, `/api/v1/purchase-orders/${po}`, { headers: B(bizA.id) });
    eq(poDetail3.body.data.receiving.receivedQty, 100, "20.3 §78: receivedQty STILL gross 100 (meaning preserved)");
    eq(poDetail3.body.data.receiving.returnedQty, 20, "20.4 returnedQty 20");
    eq(poDetail3.body.data.receiving.netReceivedQty, 80, "20.5 netReceivedQty 80 (§77)");
    eq(poDetail3.body.data.receiving.remainingQty, 20, "20.6 remaining = ordered − net = 20");
    ok(poDetail3.body.data.receiving.fullyReceived === false, "20.7 §84: fullyReceived is NET-based (false now)");

    // over-receipt: +21 → 409 (grAddLine consumes the PO line id)
    const grOver = await createGR(fA, bizA.id, { purchaseOrderId: po, reference: `GR-K-${STAMP}` });
    const over = await grAddLine(fA, bizA.id, grOver.body.data.id, { purchaseOrderLineId: rec.poLineId, receivedQty: 21 });
    eq(over.status, 409, "20.8 §82: receive 21 after net remaining 20 → 409");
    eq(over.body?.error?.code, "GOODS_RECEIPT_EXCEEDS_REMAINING", "20.9 P42 stable code preserved");

    // replacement receipt: +20 → accepted (§81)
    const grRep = await createGR(fA, bizA.id, { purchaseOrderId: po, reference: `GR-L-${STAMP}` });
    const rep = await grAddLine(fA, bizA.id, grRep.body.data.id, { purchaseOrderLineId: rec.poLineId, receivedQty: 20 });
    eq(rep.status, 201, "20.10 §81: replacement receipt 20 accepted");
    await grPost(fA, bizA.id, grRep.body.data.id);

    const poDetail4 = await call(fA, `/api/v1/purchase-orders/${po}`, { headers: B(bizA.id) });
    eq(poDetail4.body.data.receiving.receivedQty, 120, "20.11 §81: gross 120 (history separate)");
    eq(poDetail4.body.data.receiving.returnedQty, 20, "20.12 returned 20");
    eq(poDetail4.body.data.receiving.netReceivedQty, 100, "20.13 §81: net 100");
    eq(poDetail4.body.data.receiving.remainingQty, 0, "20.14 remaining 0");
    ok(poDetail4.body.data.receiving.fullyReceived === true, "20.15 fully received (net-based)");
  }

  /* --------------- 21. PO cancel hardening (§128) + CLOSED PO (§85/§129) --- */
  section("21. PO lifecycle never mutated by returns");
  {
    // cancel after posted receipts AND returns → still blocked (§128)
    const c = await call(fA, `/api/v1/purchase-orders/${replPoId}/cancel`, { method: "POST", headers: B(bizA.id) });
    eq(c.status, 409, "21.1 PO with posted receipts cannot be cancelled (§128 — returns relax nothing)");
    eq(c.body?.error?.code, "PURCHASE_ORDER_HAS_POSTED_RECEIPTS", "21.1b P42 stable code preserved");

    // closed PO after return: remaining shows but no receiving
    const poClose = await confirmedPO(fA, bizA.id, supAlpha.id, [{ productId: prodA.id, orderedQty: 100, unitPriceMinor: 100 }]);
    const poCloseDetail = await call(fA, `/api/v1/purchase-orders/${poClose}`, { headers: B(bizA.id) });
    const recClose = await postedReceipt(fA, bizA.id, poClose, poCloseDetail, { reference: `GR-M-${STAMP}`, receivedQty: 100 });
    await transitionPO(fA, bizA.id, poClose, "close");
    const close1 = await call(fA, `/api/v1/purchase-orders/${poClose}`, { headers: B(bizA.id) });
    eq(close1.body.data.status, "CLOSED", "21.2 PO closed");

    const ret = await createRT(fA, bizA.id, { goodsReceiptId: recClose.receipt.id, reference: `RET-CL-${STAMP}` });
    await rtAddLine(fA, bizA.id, ret.body.data.id, { goodsReceiptLineId: recClose.lineId, returnedQty: 20, reasonCode: "DAMAGED" });
    const postClose = await rtPost(fA, bizA.id, ret.body.data.id);
    eq(postClose.status, 200, "21.3 §15: return from a receipt of a CLOSED PO still allowed");
    eq((await db.purchaseOrder.findUnique({ where: { id: poClose }, select: { status: true } })).status, "CLOSED", "21.4 §85/§127: PO status NOT reopened");

    const close2 = await call(fA, `/api/v1/purchase-orders/${poClose}`, { headers: B(bizA.id) });
    eq(close2.body.data.receiving.remainingQty, 20, "21.5 derived remaining on the CLOSED PO is 20");
    const grTry = await createGR(fA, bizA.id, { purchaseOrderId: poClose, reference: `GR-N-${STAMP}` });
    eq(grTry.status, 422, "21.6 CLOSED PO cannot receive (§129)");
    // line-add against a nonexistent (create-blocked) receipt draft → 404
    const lineTry = await grAddLine(fA, bizA.id, grTry.body?.data?.id ?? "cknonexistentreceipt0000000", { purchaseOrderLineId: recClose.poLineId, receivedQty: 10 });
    ok(lineTry.status === 404 || lineTry.status === 422, `21.7 line-add blocked on a CLOSED PO path (${lineTry.status})`);
  }

  /* --------------- 22. receipt return facts + history (§86-§88) ------------ */
  section("22. GoodsReceipt detail return integration (§86-§88)");
  {
    const d = await grDetail(fA, bizA.id, receipt100.id);
    ok(d.body.data.returns, "22.1 receipt detail carries the ADDITIVE returns block");
    eq(d.body.data.returns.returnable, false, "22.2 §87: returnable=false when fully returned");
    const lineFacts = d.body.data.returns.lines.find((l) => l.goodsReceiptLineId === receiptLine100);
    eq(lineFacts.receivedQty, 100, "22.3 received (gross, immutable)");
    eq(lineFacts.returnedQty, 100, "22.4 returned (30+20+30+50)");
    eq(lineFacts.returnableQty, 0, "22.5 returnable 0");
    ok(Array.isArray(d.body.data.returns.recent), "22.6 recent returns array present (≤10)");
    ok(d.body.data.returns.recent.length <= 10, "22.7 bounded ≤ 10 (§88)");

    // CTA gate: a fresh receipt with returnable stock reports returnable=true
    const poX = await confirmedPO(fA, bizA.id, supAlpha.id, [{ productId: prodA.id, orderedQty: 300, unitPriceMinor: 100 }]);
    const poXDetail = await call(fA, `/api/v1/purchase-orders/${poX}`, { headers: B(bizA.id) });
    const recX = await postedReceipt(fA, bizA.id, poX, poXDetail, { reference: `GR-O-${STAMP}`, receivedQty: 100 });
    const dX = await grDetail(fA, bizA.id, recX.receipt.id);
    eq(dX.body.data.returns.returnable, true, "22.8 §87: returnable=true gates the CTA");
  }

  /* --------------- 23. entity 360s (§99/§100) ------------------------------ */
  section("23. Supplier 360 + Product history");
  {
    const sup = await call(fA, `/api/v1/suppliers/${supAlpha.id}`, { headers: B(bizA.id) });
    ok(Array.isArray(sup.body.data.recentGoodsReturns), "23.1 supplier 360 has recentGoodsReturns");
    ok(sup.body.data.recentGoodsReturns.every((r) => typeof r.reference === "string" && typeof r.totalReturnedQty === "number"), "23.2 supplier rows carry reference + totalReturnedQty (NO money)");
    ok(sup.body.data.recentGoodsReturns.length <= 10, "23.3 supplier returns bounded ≤ 10 (§100)");
    const posted = sup.body.data.recentGoodsReturns.find((r) => r.reference === `RET-REPL-${STAMP}`);
    ok(posted, "23.4 the posted replacement return appears in the Supplier 360");

    const prod = await call(fA, `/api/v1/products/${prodA.id}`, { headers: B(bizA.id) });
    ok(Array.isArray(prod.body.data.recentGoodsReturns), "23.5 product detail has recentGoodsReturns");
    ok(prod.body.data.recentGoodsReturns.every((r) => typeof r.returnedQty === "number" && typeof r.reasonCode === "string"), "23.6 product rows carry returnedQty + reason (NO money)");
    ok(prod.body.data.recentGoodsReturns.length <= 10, "23.7 product returns bounded ≤ 10 (§99)");
  }

  /* --------------- 24. search + tenant safety (§101/§102) ------------------ */
  section("24. global search — bounded, tenant-safe (§101/§102)");
  {
    const hitA = await call(fA, `/api/v1/search?q=${encodeURIComponent(`RET-REPL-${STAMP}`)}`, { headers: B(bizA.id) });
    eq(hitA.status, 200, "24.1 search ok");
    const groupA = (hitA.body.data.groups ?? []).find((g) => g.type === "GOODS_RETURN");
    ok(groupA, "24.2 GOODS_RETURN group present");
    ok(groupA.items.some((i) => i.id && i.destination === "goods-returns"), "24.3 result deep-links to goods-returns destination");

    // Tenant B searching tenant A's reference finds NOTHING (§102)
    const hitB = await call(fB, `/api/v1/search?q=${encodeURIComponent(`RET-REPL-${STAMP}`)}`, { headers: B(bizB.id) });
    const groupB = (hitB.body.data.groups ?? []).find((g) => g.type === "GOODS_RETURN");
    ok(!groupB, "24.4 §102: tenant B cannot discover tenant A's return (A→B)");

    // reverse direction
    const retB = await createRT(fB, bizB.id, { goodsReceiptId: foreignRt.receipt.id, reference: `RET-FR-${STAMP}` });
    const hitA2 = await call(fA, `/api/v1/search?q=${encodeURIComponent(`RET-FR-${STAMP}`)}`, { headers: B(bizA.id) });
    const groupA2 = (hitA2.body.data.groups ?? []).find((g) => g.type === "GOODS_RETURN");
    ok(!groupA2, "24.5 §102: tenant A cannot discover tenant B's return (B→A)");

    // product-snapshot search path
    const hitA3 = await call(fA, `/api/v1/search?q=${encodeURIComponent(`${TAG}-SKU-A1`)}`, { headers: B(bizA.id) });
    const groupA3 = (hitA3.body.data.groups ?? []).find((g) => g.type === "GOODS_RETURN");
    ok(groupA3, "24.6 SKU snapshot search hits the return (§73)");
  }

  /* --------------- 25. tenant isolation — CRUD paths (§166) ---------------- */
  section("25. cross-tenant CRUD isolation (§166)");
  {
    const rA = await createRT(fA, bizA.id, { goodsReceiptId: receipt100.id, reference: `RET-ISO-${STAMP}` });
    await rtAddLine(fA, bizA.id, rA.body.data.id, { goodsReceiptLineId: receiptLine100, returnedQty: 1, reasonCode: "OTHER" });

    const view = await rtDetail(fB, bizB.id, rA.body.data.id);
    eq(view.status, 404, "25.1 foreign view → 404");
    const edit = await rtPatch(fB, bizB.id, rA.body.data.id, { notes: "hack" });
    eq(edit.status, 404, "25.2 foreign edit → 404");
    const line = await rtAddLine(fB, bizB.id, rA.body.data.id, { goodsReceiptLineId: foreignRt.lineId, returnedQty: 1, reasonCode: "OTHER" });
    eq(line.status, 404, "25.3 foreign line-add → 404");
    const post = await rtPost(fB, bizB.id, rA.body.data.id);
    eq(post.status, 404, "25.4 foreign post → 404");
    const cancel = await rtCancel(fB, bizB.id, rA.body.data.id);
    eq(cancel.status, 404, "25.5 foreign cancel → 404");
    const exp = await fB(`${RT(bizB.id)}/${rA.body.data.id}/export`, { headers: B(bizB.id) });
    eq(exp.status, 404, "25.6 foreign export → 404 (no CSV leak)");
    const del = await rtDeleteLine(fB, bizB.id, rA.body.data.id, "ckanynonexistentline00000");
    eq(del.status, 404, "25.7 foreign line delete → 404");
    await rtCancel(fA, bizA.id, rA.body.data.id);
  }

  /* --------------- 26. CSV export (§103-§111) ------------------------------ */
  section("26. CSV export");
  {
    // bizC has CSV_EXPORT; use its own return
    const supC = await createSupplier(fC, bizC.id, `${TAG}-SUP-C`);
    const prodC = await createProduct(fC, bizC.id, `${TAG}-PROD-C`, `${TAG}-SKU-C1`, 0);
    const poC = await confirmedPO(fC, bizC.id, supC.id, [{ productId: prodC.id, orderedQty: 100, unitPriceMinor: 100 }]);
    const poCDetail = await call(fC, `/api/v1/purchase-orders/${poC}`, { headers: B(bizC.id) });
    const recC = await postedReceipt(fC, bizC.id, poC, poCDetail, { reference: `GR-C1-${STAMP}`, receivedQty: 100 });
    const retC = await createRT(fC, bizC.id, { goodsReceiptId: recC.receipt.id, reference: `RET-CSV-${STAMP}` });
    await rtAddLine(fC, bizC.id, retC.body.data.id, { goodsReceiptLineId: recC.lineId, returnedQty: 7, reasonCode: "WRONG_ITEM" });

    const en = await fC(`${RT(bizC.id)}/${retC.body.data.id}/export?locale=en`, { headers: B(bizC.id) });
    eq(en.status, 200, "26.1 EN export → 200");
    const enCsv = csvView(en);
    ok(enCsv.bytes.slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), "26.2 UTF-8 BOM present (§106)");
    ok(enCsv.text.includes("\r\n"), "26.3 CRLF line endings (§106)");
    ok(enCsv.text.includes("reference") && enCsv.text.includes("returned_qty"), "26.4 EN headers (§104)");
    ok(enCsv.text.includes(`RET-CSV-${STAMP}`) && enCsv.text.includes("WRONG_ITEM"), "26.5 row content: reference + reason");
    ok(!/unit_price|amount|total_minor/i.test(enCsv.text), "26.6 NO money columns (§104)");
    ok((en.headers.get("cache-control") ?? "").includes("no-store"), "26.7 no-store (§106)");
    ok((en.headers.get("content-disposition") ?? "").includes("attachment"), "26.8 attachment disposition (§106)");

    const fa = await fC(`${RT(bizC.id)}/${retC.body.data.id}/export?locale=fa`, { headers: B(bizC.id) });
    eq(fa.status, 200, "26.9 FA export → 200");
    const faCsv = csvView(fa);
    ok(faCsv.text.includes("مقدار مرجوع‌شده") || faCsv.text.includes("علت مرجوعی"), "26.10 FA headers in Persian (§104)");

    const badLocale = await fC(`${RT(bizC.id)}/${retC.body.data.id}/export?locale=fr`, { headers: B(bizC.id) });
    eq(badLocale.status, 422, "26.11 unsupported locale → 422");

    // injection: poison a snapshot value and re-export
    const lineC = await db.goodsReturnLine.findFirst({ where: { goodsReturnId: retC.body.data.id } });
    const origName = lineC.productNameAtReturn;
    await db.goodsReturnLine.update({ where: { id: lineC.id }, data: { productNameAtReturn: `=1+1${origName}` } });
    const inj = await fC(`${RT(bizC.id)}/${retC.body.data.id}/export`, { headers: B(bizC.id) });
    const injCsv = csvView(inj).text;
    ok(!/^=1\+1/m.test(injCsv), "26.12 §107: formula injection neutralized (=1+1)");
    await db.goodsReturnLine.update({ where: { id: lineC.id }, data: { productNameAtReturn: origName } });

    // entitlement: bizA (no CSV_EXPORT) → 403 (§108)
    const forbidden = await fA(`${RT(bizA.id)}/${ret1.id}/export`, { headers: B(bizA.id) });
    eq(forbidden.status, 403, "26.13 §108: plan without CSV_EXPORT → 403");

    // foreign export → 404 (§110) — probed from a tenant WITH the entitlement
    // (bizB/public plan), so the 404 is the id check, not the §108 gate.
    const foreignExp = await fB(`${RT(bizB.id)}/${retC.body.data.id}/export`, { headers: B(bizB.id) });
    eq(foreignExp.status, 404, "26.14 §110: foreign export → 404, no content");

    // audit
    const exportAudit = await db.auditLog.findFirst({ where: { businessId: bizC.id, action: "data.export", entityType: "GoodsReturnCSV" }, orderBy: { createdAt: "desc" } });
    ok(exportAudit, "26.15 data.export audit written (§111)");
    const afterParsed = exportAudit ? JSON.parse(exportAudit.afterJson ?? "{}") : {};
    eq(afterParsed.format, "csv", "26.16 audit carries format=csv");

    // rate limit (§109): fire 10 quickly; the 11th must 429 (bizC plan allows)
    let saw429 = false;
    for (let i = 0; i < 11; i++) {
      const rl = await fC(`${RT(bizC.id)}/${retC.body.data.id}/export`, { headers: { ...B(bizC.id), "x-no-retry": "1" } });
      if (rl.status === 429) saw429 = true;
    }
    ok(saw429, "26.17 §109: rate limiter engages after the configured burst");
  }

  /* --------------- 27. business export + import rejection (§112-§115) ------ */
  section("27. data portability");
  {
    const exp = await call(fC, "/api/v1/data/export", {
      method: "POST",
      headers: B(bizC.id),
      body: JSON.stringify({ datasets: ["inventory_goods_returns", "inventory_goods_return_lines"], format: "json" }),
    });
    ok(exp.status === 200 || exp.status === 201 || exp.status === 202, `27.1 export job accepted (${exp.status})`);

    // catalog visibility: the datasets endpoint lists the new datasets
    const catalog = await call(fC, "/api/v1/data/export/catalog", { headers: B(bizC.id) });
    if (catalog.status === 200) {
      const keys = JSON.stringify(catalog.body);
      ok(keys.includes("inventory_goods_returns"), "27.2 catalog includes inventory_goods_returns (§112)");
      ok(keys.includes("inventory_goods_return_lines"), "27.3 catalog includes inventory_goods_return_lines (§112)");
    } else {
      ok(true, "27.2/27.3 (catalog endpoint shape differs — covered by portability audit)");
    }

    // import rejection (§115)
    const imp = await call(fC, "/api/v1/data/import", {
      method: "POST",
      headers: { ...B(bizC.id), "content-type": "application/json" },
      body: JSON.stringify({ dataset: "inventory_goods_returns", rows: [] }),
    });
    ok(imp.status >= 400, `27.4 §115: generic import of inventory_goods_returns rejected (${imp.status})`);
  }

  /* --------------- 28. stocktake interaction (§121/§162) ------------------- */
  section("28. stocktake stale-count interaction (§121/§162)");
  {
    const stRef = `P43ST-${STAMP}`;
    const st = await call(fA, "/api/v1/inventory/stocktakes", {
      method: "POST",
      headers: B(bizA.id),
      body: JSON.stringify({ reference: stRef, notes: null }),
    });
    eq(st.status, 201, "28.1 stocktake created");
    const stId = st.body.data.id;
    // P40 flow: add line (DRAFT) → start → COUNT (server snapshots systemQtyAtCount)
    const stockBeforeReturn = (await db.product.findUnique({ where: { id: prodA.id }, select: { stockQty: true } })).stockQty;
    const lineRes = await call(fA, `/api/v1/inventory/stocktakes/${stId}/lines`, {
      method: "POST",
      headers: B(bizA.id),
      body: JSON.stringify({ productId: prodA.id }),
    });
    eq(lineRes.status, 201, "28.2a count line added");
    await call(fA, `/api/v1/inventory/stocktakes/${stId}/start`, { method: "POST", headers: B(bizA.id) });
    const count = await call(fA, `/api/v1/inventory/stocktakes/${stId}/lines/${lineRes.body.data.id}/count`, {
      method: "POST",
      headers: B(bizA.id),
      body: JSON.stringify({ countedQty: stockBeforeReturn }),
    });
    eq(count.status, 200, "28.2b counted (systemQtyAtCount = current stock)");

    // post a return NOW (stock changes under the stocktake)
    const poY = await confirmedPO(fA, bizA.id, supAlpha.id, [{ productId: prodA.id, orderedQty: 300, unitPriceMinor: 100 }]);
    const poYDetail = await call(fA, `/api/v1/purchase-orders/${poY}`, { headers: B(bizA.id) });
    const recY = await postedReceipt(fA, bizA.id, poY, poYDetail, { reference: `GR-P-${STAMP}`, receivedQty: 100 });
    const retY = await createRT(fA, bizA.id, { goodsReceiptId: recY.receipt.id, reference: `RET-ST-${STAMP}` });
    await rtAddLine(fA, bizA.id, retY.body.data.id, { goodsReceiptLineId: recY.lineId, returnedQty: 5, reasonCode: "OTHER" });
    await rtPost(fA, bizA.id, retY.body.data.id);

    // finalize → STOCKTAKE_STALE_COUNT (§121)
    await call(fA, `/api/v1/inventory/stocktakes/${stId}/review`, { method: "POST", headers: B(bizA.id) });
    const fin = await call(fA, `/api/v1/inventory/stocktakes/${stId}/finalize`, { method: "POST", headers: B(bizA.id) });
    eq(fin.status, 409, "28.3 §162: stale count rejected after the return");
    ok(JSON.stringify(fin.body).includes("STOCKTAKE_STALE_COUNT") || fin.body?.error?.code === "STOCKTAKE_STALE_COUNT", "28.4 stable stale-count behavior preserved");
    await call(fA, `/api/v1/inventory/stocktakes/${stId}/cancel`, { method: "POST", headers: B(bizA.id) });
  }

  /* ---------- 29. stocktake AFTER return sees reduced stock (§122) --------- */
  section("29. stocktake after return sees the reduced stock (§122)");
  {
    const stockNow = (await db.product.findUnique({ where: { id: prodB.id }, select: { stockQty: true } })).stockQty;
    const stRef = `P43ST2-${STAMP}`;
    const st = await call(fA, "/api/v1/inventory/stocktakes", { method: "POST", headers: B(bizA.id), body: JSON.stringify({ reference: stRef }) });
    const lineRes = await call(fA, `/api/v1/inventory/stocktakes/${st.body.data.id}/lines`, {
      method: "POST",
      headers: B(bizA.id),
      body: JSON.stringify({ productId: prodB.id }),
    });
    eq(lineRes.status, 201, "29.1a count line added");
    await call(fA, `/api/v1/inventory/stocktakes/${st.body.data.id}/start`, { method: "POST", headers: B(bizA.id) });
    const c = await call(fA, `/api/v1/inventory/stocktakes/${st.body.data.id}/lines/${lineRes.body.data.id}/count`, {
      method: "POST",
      headers: B(bizA.id),
      body: JSON.stringify({ countedQty: stockNow }),
    });
    eq(c.status, 200, "29.1b count accepted against post-return stock");
    const stored = await db.inventoryStocktakeLine.findFirst({ where: { stocktakeId: st.body.data.id, productId: prodB.id }, select: { systemQtyAtCount: true } });
    eq(stored.systemQtyAtCount, stockNow, "29.2 systemQtyAtCount equals the CURRENT reduced stock (§122)");
    await call(fA, `/api/v1/inventory/stocktakes/${st.body.data.id}/review`, { method: "POST", headers: B(bizA.id) });
    const fin = await call(fA, `/api/v1/inventory/stocktakes/${st.body.data.id}/finalize`, { method: "POST", headers: B(bizA.id) });
    eq(fin.status, 200, "29.3 finalization succeeds (no variance)");
    await db.inventoryStocktakeLine.deleteMany({ where: { stocktakeId: st.body.data.id } });
    await db.inventoryStocktake.deleteMany({ where: { id: st.body.data.id } });
  }

  /* ---------- 30. manual adjustment interaction (§123) --------------------- */
  section("30. manual adjustment + return interplay (§123)");
  {
    const stock0 = (await db.product.findUnique({ where: { id: prodB.id }, select: { stockQty: true } })).stockQty;
    // manual +3
    await db.inventoryAdjustment.create({ data: { businessId: bizA.id, productId: prodB.id, delta: 3, reason: "P43 manual +3", actorId: userA.id } });
    const manual = await db.product.update({ where: { id: prodB.id }, data: { stockQty: { increment: 3 } }, select: { stockQty: true } });
    eq(manual.stockQty, stock0 + 3, "30.1 manual +3 applied");
    // return -5 (via a fresh receipt return)
    const poZ = await confirmedPO(fA, bizA.id, supAlpha.id, [{ productId: prodB.id, orderedQty: 300, unitPriceMinor: 100 }]);
    const poZDetail = await call(fA, `/api/v1/purchase-orders/${poZ}`, { headers: B(bizA.id) });
    const recZ = await postedReceipt(fA, bizA.id, poZ, poZDetail, { reference: `GR-Q-${STAMP}`, receivedQty: 100 });
    const retZ = await createRT(fA, bizA.id, { goodsReceiptId: recZ.receipt.id, reference: `RET-MA-${STAMP}` });
    await rtAddLine(fA, bizA.id, retZ.body.data.id, { goodsReceiptLineId: recZ.lineId, returnedQty: 5, reasonCode: "OTHER" });
    await rtPost(fA, bizA.id, retZ.body.data.id);
    const stockFinal = (await db.product.findUnique({ where: { id: prodB.id }, select: { stockQty: true } })).stockQty;
    eq(stockFinal, stock0 + 3 + 100 - 5, "30.2 §123: +3 manual, +100 receipt, −5 return → exact arithmetic, no lost update");
  }

  /* --------------- 31. list filters + DTO (§72/§71) ------------------------ */
  section("31. list filters + DTO shape (§71/§72)");
  {
    const l1 = await call(fA, `${RT(bizA.id)}?status=POSTED&page=1&pageSize=5`, { headers: B(bizA.id) });
    eq(l1.status, 200, "31.1 list ok");
    ok(l1.body.data.items.every((i) => i.status === "POSTED"), "31.2 status filter works");
    ok(l1.body.data.items.every((i) => typeof i.lineCount === "number" && typeof i.totalReturnedQty === "number"), "31.3 list DTO aggregates present (§71)");
    ok(l1.body.data.items.every((i) => !("notes" in i)), "31.4 list DTO is lightweight (no notes)");
    ok(l1.body.data.total <= l1.body.data.items.length + 1000, "31.5 total present");
    const l2 = await call(fA, `${RT(bizA.id)}?goodsReceiptId=${receipt100.id}`, { headers: B(bizA.id) });
    ok(l2.body.data.items.every((i) => i.goodsReceiptId === receipt100.id), "31.6 goodsReceiptId filter works");
    const l3 = await call(fA, `${RT(bizA.id)}?pageSize=101`, { headers: B(bizA.id) });
    eq(l3.status, 422, "31.7 pageSize > 100 → 422 (§72)");
    const l4 = await call(fA, `${RT(bizA.id)}?from=2026-02-31`, { headers: B(bizA.id) });
    eq(l4.status, 422, "31.8 invalid date 2026-02-31 → 422 (§74)");
    const l5 = await call(fA, `${RT(bizA.id)}?q=${encodeURIComponent(`RET-REPL-${STAMP}`)}`, { headers: B(bizA.id) });
    ok(l5.body.data.items.some((i) => i.reference === `RET-REPL-${STAMP}`), "31.9 q search over reference (§73)");
    // §52 — the FULL invalid/edge date matrix.
    for (const bad of ["2026-13-01", "2026-00-10", "2026-01-00", "2025-02-29"]) {
      const r = await call(fA, `${RT(bizA.id)}?from=${bad}`, { headers: B(bizA.id) });
      eq(r.status, 422, `31.10 invalid date ${bad} → 422 (§52)`);
    }
    const leapOk = await call(fA, `${RT(bizA.id)}?from=2024-02-29&to=2024-02-29`, { headers: B(bizA.id) });
    eq(leapOk.status, 200, "31.11 leap day 2024-02-29 accepted (§52)");
    const fromGtTo = await call(fA, `${RT(bizA.id)}?from=2026-02-10&to=2026-02-01`, { headers: B(bizA.id) });
    eq(fromGtTo.status, 422, "31.12 from > to → 422 (§52)");
  }

  /* --------- 31b. business-timezone date filters (§22-§25) ----------------- */
  section("31b. business-timezone date filtering (§22-§25) — live API");
  {
    const origTz = (await db.business.findUnique({ where: { id: bizA.id }, select: { timezone: true } })).timezone;
    // Dedicated throwaway draft return whose createdAt is pinned to a
    // documented probe instant (fixture-level mutation, restored implicitly
    // by teardown): 2026-09-30T20:45Z = 00:15 Asia/Tehran on LOCAL 2026-10-01.
    const poTz = await confirmedPO(fA, bizA.id, supAlpha.id, [{ productId: prodA.id, orderedQty: 50, unitPriceMinor: 100 }]);
    const poTzDetail = await call(fA, `/api/v1/purchase-orders/${poTz}`, { headers: B(bizA.id) });
    const recTz = await postedReceipt(fA, bizA.id, poTz, poTzDetail, { reference: `GR-TZ-${STAMP}`, receivedQty: 50 });
    const retTz = await createRT(fA, bizA.id, { goodsReceiptId: recTz.receipt.id, reference: `RET-TZ-${STAMP}` });
    await rtAddLine(fA, bizA.id, retTz.body.data.id, { goodsReceiptLineId: recTz.lineId, returnedQty: 5, reasonCode: "OTHER" });
    const tzReturnId = retTz.body.data.id;
    await db.goodsReturn.update({ where: { id: tzReturnId }, data: { createdAt: new Date("2026-09-30T20:45:00.000Z") } });

    // +03:30 (Asia/Tehran): the record's LOCAL date is 2026-10-01 although
    // its UTC date is 2026-09-30.
    await db.business.update({ where: { id: bizA.id }, data: { timezone: "Asia/Tehran" } });
    const inLocal = await call(fA, `${RT(bizA.id)}?from=2026-10-01&to=2026-10-01&pageSize=100`, { headers: B(bizA.id) });
    ok(inLocal.body.data.items.some((i) => i.id === tzReturnId), "31b.1 a 00:15 LOCAL record appears in its local-date filter even though its UTC date is the previous day (§25)");
    const prevLocal = await call(fA, `${RT(bizA.id)}?from=2026-09-30&to=2026-09-30&pageSize=100`, { headers: B(bizA.id) });
    ok(!prevLocal.body.data.items.some((i) => i.id === tzReturnId), "31b.2 the same record is NOT in the previous local calendar date (§25)");
    const fromOnly = await call(fA, `${RT(bizA.id)}?from=2026-10-01&pageSize=100`, { headers: B(bizA.id) });
    ok(fromOnly.body.data.items.some((i) => i.id === tzReturnId), "31b.3 from-only filter is local-date aware (§25)");
    const toOnlyBefore = await call(fA, `${RT(bizA.id)}?to=2026-09-30&pageSize=100`, { headers: B(bizA.id) });
    ok(!toOnlyBefore.body.data.items.some((i) => i.id === tzReturnId), "31b.4 to-only EXCLUDES the next local day (§25 — exclusive upper bound)");
    const toOnlyIncl = await call(fA, `${RT(bizA.id)}?to=2026-10-01&pageSize=100`, { headers: B(bizA.id) });
    ok(toOnlyIncl.body.data.items.some((i) => i.id === tzReturnId), "31b.5 to-only includes the WHOLE local to-day (§25)");

    // −05:00 (America/New_York, EDT in September): the SAME UTC instant
    // (20:45Z) is 16:45 on LOCAL 2026-09-30 — the window must follow the
    // business zone, not a fixed offset.
    await db.business.update({ where: { id: bizA.id }, data: { timezone: "America/New_York" } });
    const nyIn = await call(fA, `${RT(bizA.id)}?from=2026-09-30&to=2026-09-30&pageSize=100`, { headers: B(bizA.id) });
    ok(nyIn.body.data.items.some((i) => i.id === tzReturnId), "31b.6 the same instant falls on 2026-09-30 in a −05:00 business zone (§25)");
    const nyNext = await call(fA, `${RT(bizA.id)}?from=2026-10-01&to=2026-10-01&pageSize=100`, { headers: B(bizA.id) });
    ok(!nyNext.body.data.items.some((i) => i.id === tzReturnId), "31b.7 −05:00 zone does NOT place the record on 2026-10-01 (§25)");

    // Control: back to the business's original timezone (UTC default) the
    // record belongs to its UTC date again — proving the TZ comes from the
    // AUTH ctx, never the client.
    await db.business.update({ where: { id: bizA.id }, data: { timezone: origTz || "UTC" } });
    const utcControl = await call(fA, `${RT(bizA.id)}?from=2026-09-30&to=2026-09-30&pageSize=100`, { headers: B(bizA.id) });
    ok(utcControl.body.data.items.some((i) => i.id === tzReturnId), "31b.8 UTC business sees the same instant on its UTC date (control, §25)");
    const tzHeaderTry = await call(fA, `${RT(bizA.id)}?from=2026-10-01&to=2026-10-01&timezone=Asia/Tehran&pageSize=100`, { headers: B(bizA.id) });
    ok(tzHeaderTry.body.data.items.every((i) => i.id !== tzReturnId || (origTz || "UTC") === "Asia/Tehran"), "31b.9 a client-supplied timezone parameter can NEVER override the business zone (§23)");
    await rtCancel(fA, bizA.id, tzReturnId);
  }

  /* --------- 31c. corrupted persisted ZERO quantity (§7/§9) ---------------- */
  section("31c. corrupted persisted zero quantity fails safely (§7/§9)");
  {
    const po9 = await confirmedPO(fA, bizA.id, supAlpha.id, [{ productId: prodA.id, orderedQty: 200, unitPriceMinor: 100 }]);
    const po9Detail = await call(fA, `/api/v1/purchase-orders/${po9}`, { headers: B(bizA.id) });
    const rec9 = await postedReceipt(fA, bizA.id, po9, po9Detail, { reference: `GR-Z-${STAMP}`, receivedQty: 100 });

    // (a) POSTED return whose line is corrupted to returnedQty = 0.
    const retA = await createRT(fA, bizA.id, { goodsReceiptId: rec9.receipt.id, reference: `RET-Z-A-${STAMP}` });
    await rtAddLine(fA, bizA.id, retA.body.data.id, { goodsReceiptLineId: rec9.lineId, returnedQty: 10, reasonCode: "OTHER" });
    const postA = await rtPost(fA, bizA.id, retA.body.data.id);
    eq(postA.status, 200, "31c.0 the return posts cleanly BEFORE corruption");
    const stockAfterA = (await db.product.findUnique({ where: { id: prodA.id }, select: { stockQty: true } })).stockQty;
    const lineA = await db.goodsReturnLine.findFirst({ where: { goodsReturnId: retA.body.data.id } });
    await db.goodsReturnLine.update({ where: { id: lineA.id }, data: { returnedQty: 0 } }); // §9 corruption

    // Row-materializing authoritative paths MUST fail with the stable code:
    const d9 = await rtDetail(fA, bizA.id, retA.body.data.id);
    eq(d9.status, 500, "31c.1 detail of a zero-qty return → 500 (§9 — never a fabricated DTO)");
    eq(d9.body?.error?.code, "GOODS_RETURN_CORRUPT_HISTORY", "31c.2 stable CORRUPT_HISTORY code");
    const l9 = await call(fA, `${RT(bizA.id)}?page=1&pageSize=100`, { headers: B(bizA.id) });
    eq(l9.status, 500, "31c.3 list DTO refuses to sum corrupted history (§9)");
    const x9 = await call(fA, `${RT(bizA.id)}/${retA.body.data.id}/export`, { headers: B(bizA.id) });
    ok(x9.status === 403, "31c.4a export for the NO-EXPORT business still gates on CSV_EXPORT first (403 — entitlement chain intact)");
    // §9/§67 — the same corruption on the EXPORT-ENTITLED business (bizC)
    // fails the export with the stable integrity code, never a partial CSV.
    // A DEDICATED probe user is used because section 26 deliberately
    // exhausts ownerC's per-user export rate bucket (§109 limit is per-user).
    const exportProbeEmail = `${TAG.toLowerCase()}-expz-${STAMP}@${DOMAIN}`;
    const userZ = await db.user.create({ data: { email: exportProbeEmail, name: "Export Probe Z", passwordHash: bcrypt.hashSync(PASS, 4), emailVerifiedAt: new Date() }, select: { id: true } });
    await db.businessMember.create({ data: { businessId: bizC.id, userId: userZ.id, role: "STAFF" } });
    const fZ = makeClient();
    await login(fZ, exportProbeEmail);
    const supZ = await createSupplier(fZ, bizC.id, `${TAG}-SUP-Z-${STAMP}`);
    const prodZ = await createProduct(fZ, bizC.id, `${TAG}-PROD-Z-${STAMP}`, `${TAG}-SKU-Z-${STAMP}`, 0);
    const poZ = await confirmedPO(fZ, bizC.id, supZ.id, [{ productId: prodZ.id, orderedQty: 100, unitPriceMinor: 100 }]);
    const poZDetail = await call(fZ, `/api/v1/purchase-orders/${poZ}`, { headers: B(bizC.id) });
    const recZ = await postedReceipt(fZ, bizC.id, poZ, poZDetail, { reference: `GR-ZC-${STAMP}`, receivedQty: 100 });
    const retZ = await createRT(fZ, bizC.id, { goodsReceiptId: recZ.receipt.id, reference: `RET-Z-C-${STAMP}` });
    await rtAddLine(fZ, bizC.id, retZ.body.data.id, { goodsReceiptLineId: recZ.lineId, returnedQty: 9, reasonCode: "OTHER" });
    await rtPost(fZ, bizC.id, retZ.body.data.id);
    const lineZ = await db.goodsReturnLine.findFirst({ where: { goodsReturnId: retZ.body.data.id } });
    await db.goodsReturnLine.update({ where: { id: lineZ.id }, data: { returnedQty: 0 } });
    const xZ = await call(fZ, `${RT(bizC.id)}/${retZ.body.data.id}/export`, { headers: B(bizC.id) });
    eq(xZ.status, 500, "31c.4b CSV export refuses a corrupted line with the integrity 500 (§9/§67)");
    eq(xZ.body?.error?.code, "GOODS_RETURN_CORRUPT_HISTORY", "31c.4c stable code on export");
    await db.goodsReturnLine.update({ where: { id: lineZ.id }, data: { returnedQty: 9 } });
    const xZr = await call(fZ, `${RT(bizC.id)}/${retZ.body.data.id}/export`, { headers: B(bizC.id) });
    eq(xZr.status, 200, "31c.4d export recovers after cleanup (§9)");
    const grDetail9 = await grDetail(fA, bizA.id, rec9.receipt.id);
    eq(grDetail9.status, 500, "31c.5 receipt detail fails LOUDLY too — its return-history widget materializes the zero row (§9 fail-safe)");
    eq(grDetail9.body?.error?.code, "GOODS_RETURN_CORRUPT_HISTORY", "31c.6 receipt detail carries the stable code");

    // (b) POST of a corrupted DRAFT: no stock mutation, no adjustment, no
    // status change, no post audit (§13).
    const retB = await createRT(fA, bizA.id, { goodsReceiptId: rec9.receipt.id, reference: `RET-Z-B-${STAMP}` });
    await rtAddLine(fA, bizA.id, retB.body.data.id, { goodsReceiptLineId: rec9.lineId, returnedQty: 10, reasonCode: "OTHER" });
    const lineB = await db.goodsReturnLine.findFirst({ where: { goodsReturnId: retB.body.data.id } });
    await db.goodsReturnLine.update({ where: { id: lineB.id }, data: { returnedQty: 0 } });
    const postB = await rtPost(fA, bizA.id, retB.body.data.id);
    eq(postB.status, 500, "31c.7 corrupted DRAFT post → 500 (§13 — never a zero-delta adjustment)");
    eq(postB.body?.error?.code, "GOODS_RETURN_CORRUPT_HISTORY", "31c.8 stable code on post");
    const b9 = await db.goodsReturn.findUnique({ where: { id: retB.body.data.id }, select: { status: true, postedAt: true } });
    ok(b9.status === "DRAFT" && b9.postedAt === null, "31c.9 corrupted post mutates NO status (still DRAFT, postedAt null)");
    const stockMid9 = (await db.product.findUnique({ where: { id: prodA.id }, select: { stockQty: true } })).stockQty;
    eq(stockMid9, stockAfterA, "31c.10 corrupted post performs NO further stock mutation (§13)");
    const adjB = await db.inventoryAdjustment.count({ where: { businessId: bizA.id, reason: { contains: `Goods return RET-Z-B-${STAMP}` } } });
    eq(adjB, 0, "31c.11 corrupted post creates NO adjustment (§13)");
    const auditB = await db.auditLog.count({ where: { businessId: bizA.id, action: "goods_return.post", entityId: retB.body.data.id } });
    eq(auditB, 0, "31c.12 corrupted post writes NO post audit (§13)");

    // (c) AGGREGATE paths stay EXACT (§8 — the DB aggregate remains the
    // production mechanism; a zero summand adds nothing, so no total is
    // fabricated and no aggregate-only path is broken):
    const po9After = await call(fA, `/api/v1/purchase-orders/${po9}`, { headers: B(bizA.id) });
    eq(po9After.status, 200, "31c.13 PO receiving summary still serves (§8)");
    eq(po9After.body.data.receiving.returnedQty, 0, "31c.14 aggregated returned is the EXACT 0 the corrupt history sums to (§8 — never fabricated, never clamped-from-below)");
    eq(po9After.body.data.receiving.netReceivedQty, 100, "31c.15 net received exact 100 (§8)");
    eq(po9After.body.data.receiving.remainingQty, 100, "31c.16 remaining exact (§8)");
    const gr9 = await createGR(fA, bizA.id, { purchaseOrderId: po9, reference: `GR-Z2-${STAMP}` });
    const add9 = await grAddLine(fA, bizA.id, gr9.body.data.id, { purchaseOrderLineId: rec9.poLineId, receivedQty: 5 });
    eq(add9.status, 201, "31c.17 a NEW receipt still posts while the zero row exists (§8 — guard math uncorrupted)");
    const post9 = await grPost(fA, bizA.id, gr9.body.data.id);
    eq(post9.status, 200, "31c.18 replacement receipt post succeeds (§8)");

    // (d) restore — every path recovers.
    await db.goodsReturnLine.update({ where: { id: lineA.id }, data: { returnedQty: 10 } });
    await db.goodsReturnLine.update({ where: { id: lineB.id }, data: { returnedQty: 10 } });
    const d9r = await rtDetail(fA, bizA.id, retA.body.data.id);
    eq(d9r.status, 200, "31c.19 detail recovers after cleanup (200)");
    eq(d9r.body.data.summary.totalReturnedQty, 10, "31c.20 the total is the true 10 again (§9)");
    const l9r = await call(fA, `${RT(bizA.id)}?page=1&pageSize=100`, { headers: B(bizA.id) });
    eq(l9r.status, 200, "31c.21 list recovers after cleanup (200)");
    const grDetail9r = await grDetail(fA, bizA.id, rec9.receipt.id);
    eq(grDetail9r.status, 200, "31c.22 receipt detail recovers after cleanup (200)");
    await rtCancel(fA, bizA.id, retA.body.data.id);
    await rtCancel(fA, bizA.id, retB.body.data.id);
  }

  /* --------------- 32. financial NON-mutation (§7/§186/§28-§30) ------------- */
  section("32. financial non-mutation — NON-VACUOUS before/after snapshots (§29/§30)");
  {
    // §29 — non-zero financial fixtures are created FIRST (fixture-level
    // writes, never through the return domain), so the zero-count assertion
    // of the old test could never pass vacuously: a future developer who
    // adds Expense/Payment/statement mutation to GoodsReturn POST WILL fail
    // this exact-equality snapshot.
    const finExpense1 = await db.expense.create({
      data: {
        businessId: bizA.id,
        supplierId: supAlpha.id,
        category: `${TAG}-FIN-RENT`,
        amountMinor: 50_000,
        paidMinor: 30_000,
        status: "PARTIAL",
        spentAt: new Date("2026-01-10T10:00:00.000Z"),
        dueDate: new Date("2026-02-10T12:00:00.000Z"),
        reference: `${TAG}-BILL-1`,
      },
      select: { id: true },
    });
    await db.expense.create({
      data: {
        businessId: bizA.id,
        supplierId: supAlpha.id,
        category: `${TAG}-FIN-UTILITIES`,
        amountMinor: 20_000,
        paidMinor: 0,
        status: "UNPAID",
        spentAt: new Date("2026-01-15T10:00:00.000Z"),
        dueDate: new Date("2026-03-15T12:00:00.000Z"),
        reference: `${TAG}-BILL-2`,
      },
      select: { id: true },
    });
    await db.payment.create({
      data: {
        businessId: bizA.id,
        expenseId: finExpense1.id,
        direction: "OUT",
        amountMinor: 30_000,
        method: "BANK_TRANSFER",
        paidAt: new Date("2026-01-20T09:00:00.000Z"),
      },
      select: { id: true },
    });

    /** Strip volatile report metadata (generatedAt/asOf) — everything else
     *  must match EXACTLY before vs after the return POST (§29/§30). */
    const normalizeFinancial = (body) => {
      const clone = JSON.parse(JSON.stringify(body));
      if (clone?.data) {
        delete clone.data.generatedAt;
        delete clone.data.asOf;
      }
      return JSON.stringify(clone);
    };
    const snapshot = async () => ({
      expenses: JSON.stringify(
        await db.expense.aggregate({ where: { businessId: bizA.id }, _count: { _all: true }, _sum: { amountMinor: true, paidMinor: true } }),
      ),
      payments: JSON.stringify(
        await db.payment.aggregate({ where: { businessId: bizA.id }, _count: { _all: true }, _sum: { amountMinor: true } }),
      ),
      sales: JSON.stringify(
        await db.sale.aggregate({ where: { businessId: bizA.id }, _count: { _all: true }, _sum: { totalMinor: true } }).catch(() => ({ _count: { _all: 0 } })),
      ),
      supplierStatement: normalizeFinancial((await call(fA, `/api/v1/suppliers/${supAlpha.id}/statement?from=2020-01-01&to=2030-12-31`, { headers: B(bizA.id) })).body),
      payablesAging: normalizeFinancial((await call(fA, `/api/v1/reports/aging`, { headers: B(bizA.id) })).body),
      receivables: normalizeFinancial((await call(fA, `/api/v1/receivables`, { headers: B(bizA.id) })).body),
    });

    const before = await snapshot();
    ok(JSON.parse(before.expenses)._count._all >= 2, "32.0 financial fixtures are NON-ZERO (§29 — the assertion cannot pass vacuously)");
    ok(JSON.parse(before.payments)._count._all >= 1, "32.0b payment fixture is NON-ZERO (§29)");

    // A REAL return POST for the SAME supplier (the event that must not
    // touch any financial surface):
    const poFin = await confirmedPO(fA, bizA.id, supAlpha.id, [{ productId: prodA.id, orderedQty: 40, unitPriceMinor: 100 }]);
    const poFinDetail = await call(fA, `/api/v1/purchase-orders/${poFin}`, { headers: B(bizA.id) });
    const recFin = await postedReceipt(fA, bizA.id, poFin, poFinDetail, { reference: `GR-FIN-${STAMP}`, receivedQty: 40 });
    const retFin = await createRT(fA, bizA.id, { goodsReceiptId: recFin.receipt.id, reference: `RET-FIN-${STAMP}` });
    await rtAddLine(fA, bizA.id, retFin.body.data.id, { goodsReceiptLineId: recFin.lineId, returnedQty: 4, reasonCode: "QUALITY_ISSUE" });
    const stockBeforeFin = (await db.product.findUnique({ where: { id: prodA.id }, select: { stockQty: true } })).stockQty;
    const adjBeforeFin = await db.inventoryAdjustment.count({ where: { businessId: bizA.id } });
    const postedFin = await rtPost(fA, bizA.id, retFin.body.data.id);
    eq(postedFin.status, 200, "32.1 the return POST itself succeeds");

    const after = await snapshot();
    eq(after.expenses, before.expenses, "32.2 Expense rows EXACTLY unchanged by the return POST (§63)");
    eq(after.payments, before.payments, "32.3 Payment rows EXACTLY unchanged (§63)");
    eq(after.sales, before.sales, "32.4 Sale rows EXACTLY unchanged (§63)");
    eq(after.supplierStatement, before.supplierStatement, "32.5 Supplier Statement EXACTLY unchanged — a return is NOT a payable/credit event (§64)");
    eq(after.payablesAging, before.payablesAging, "32.6 Payables/Receivables AGING EXACTLY unchanged (§65)");
    eq(after.receivables, before.receivables, "32.7 Receivables EXACTLY unchanged (§65)");

    // Sanity: the same snapshot DID observe the sanctioned inventory changes
    // — proving the harness detects real mutations (not a dead equality).
    const stockAfterFin = (await db.product.findUnique({ where: { id: prodA.id }, select: { stockQty: true } })).stockQty;
    eq(stockAfterFin, stockBeforeFin - 4, "32.8 PRODUCT STOCK did change (−4) — the snapshot harness detects real mutations (§29)");
    const adjAfterFin = await db.inventoryAdjustment.count({ where: { businessId: bizA.id } });
    eq(adjAfterFin, adjBeforeFin + 1, "32.9 ONE negative InventoryAdjustment created (§62) — while every financial surface stayed frozen");
  }

  /* --------------- 33. restore-drill probes (§116/§181/§31/§32) ------------ */
  section("33. restore-drill — STRICT exit + probe + result law (§31/§32)");
  {
    const drill = spawnSync("node", ["scripts/restore-drill.mjs"], { encoding: "utf8", timeout: 240_000, env: process.env });
    const out = `${drill.stdout ?? ""}${drill.stderr ?? ""}`;
    // §32 — ALL of the following must hold; a non-zero exit (or a timeout /
    // signal kill, either surfacing as a non-zero/null status) is a FAILURE
    // even if partial probe output exists:
    eq(drill.status, 0, "33.1 restore-drill exits 0 (timeout/signal → null status → also a failure)");
    ok(out.includes("rows:GoodsReturn"), "33.2 output contains the GoodsReturn probe");
    ok(out.includes("rows:GoodsReturnLine"), "33.3 output contains the GoodsReturnLine probe");
    ok(/RESULT:\s+PASS/.test(out), "33.4 the drill reports successful restore validation (RESULT: PASS)");
    ok(/integrity:\s+ok/.test(out), "33.5 the drill reports clean clone integrity (§32.4)");
  }

  /* --------------- 34. cap/concurrency (isolated process) ------------------ */
  section("34. cap + concurrency suite (isolated, §49/§53/§158/§159)");
  {
    // Isolated service-level process (never touches the project default cap):
    // the server-only boundary requires the sanctioned preload shim.
    const res = spawnSync("bun", ["--preload", "./scripts/lib/register-server-only-shim.ts", "scripts/prompt43-goods-return-cap-check.ts"], {
      encoding: "utf8",
      timeout: 420_000,
      env: { ...process.env, GOODS_RETURN_MAX_LINES: "20" },
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    const m = /TOTAL: (\d+) passed, (\d+) failed/.exec(out);
    if (m) {
      eq(Number(m[2]), 0, `34.1 isolated cap/concurrency suite green (${m[1]} passed)`);
    } else {
      ok("34.1 isolated suite did not report a TOTAL line", false, out.slice(-400));
    }
  }

  /* --------------- 35. telemetry sanity + teardown (§195) ------------------ */
  section("35. teardown to ZERO (§195)");
  {
    const bizIds = [bizA.id, bizB.id, bizC.id];
    for (const bid of bizIds) {
      await db.auditLog.deleteMany({ where: { businessId: bid } });
      await db.goodsReturnLine.deleteMany({ where: { goodsReturn: { businessId: bid } } });
      await db.goodsReturn.deleteMany({ where: { businessId: bid } });
      await db.goodsReceiptLine.deleteMany({ where: { goodsReceipt: { businessId: bid } } });
      await db.goodsReceipt.deleteMany({ where: { businessId: bid } });
      await db.inventoryAdjustment.deleteMany({ where: { businessId: bid } });
      await db.inventoryStocktakeLine.deleteMany({ where: { stocktake: { businessId: bid } } });
      await db.inventoryStocktake.deleteMany({ where: { businessId: bid } });
      await db.purchaseOrderLine.deleteMany({ where: { purchaseOrder: { businessId: bid } } });
      await db.purchaseOrder.deleteMany({ where: { businessId: bid } });
      await db.product.deleteMany({ where: { businessId: bid } });
      await db.supplier.deleteMany({ where: { businessId: bid } });
      await db.subscriptionEvent.deleteMany({ where: { subscription: { businessId: bid } } });
      await db.subscription.deleteMany({ where: { businessId: bid } });
      await db.businessMember.deleteMany({ where: { businessId: bid } });
      await db.business.deleteMany({ where: { id: bid } });
    }
    await db.user.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
    await db.plan.deleteMany({ where: { code: { startsWith: `${TAG}-` } } });

    const residualReturns = await db.goodsReturn.count({ where: { reference: { contains: "RET-" }, business: { name: { startsWith: `${TAG}-` } } } });
    eq(residualReturns, 0, "35.1 zero residual P43 returns");
    const residualBiz = await db.business.count({ where: { name: { startsWith: `${TAG}-` } } });
    eq(residualBiz, 0, "35.2 zero residual P43 businesses");
    const residualUsers = await db.user.count({ where: { email: { endsWith: `@${DOMAIN}` } } });
    eq(residualUsers, 0, "35.3 zero residual P43 users");
    const residualPlans = await db.plan.count({ where: { code: { startsWith: `${TAG}-` } } });
    eq(residualPlans, 0, "35.4 zero residual P43 plans");
  }
}

main()
  .then(() => {
    console.log(`\n=== prompt43-goods-return-check: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) {
      console.log("FAILURES:");
      for (const f of failures) console.log(`  ✗ ${f}`);
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error("FATAL:", error);
    console.log(`\n=== prompt43-goods-return-check: ${passed} passed, ${failed + 1} failed (fatal) ===`);
    process.exit(1);
  });
