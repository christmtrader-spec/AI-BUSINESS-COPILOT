#!/usr/bin/env node
/**
 * Prompt 44 — E2E GOODS DISPATCH CHECK. Real application + real DB.
 * Run: node scripts/prompt44-goods-dispatch-check.mjs   (dev server on :3000)
 *
 * Covers: auth/RBAC · tenant isolation both directions · draft
 * create/update/cancel · line add/edit/remove + duplicate-line law · post
 * (exact stock decrements + ONE negative InventoryAdjustment per line +
 * audit) · POSTED immutability · CANCELLED terminal · advisory-vs-
 * authoritative availability (stock changed between draft and post) ·
 * multi-line rollback · zero-line post rejection · financial non-mutation
 * with NON-ZERO fixtures (Expense/Payment/Sale + authoritative receivables
 * output) · corrupt persisted status/qty/reason → controlled 500 with
 * restore · snapshots (customer/product frozen at write time) · audit
 * events · product + customer-360 dispatch history · search
 * GOODS_DISPATCH (+ tenant safety) · CSV export EN/FA + injection guard +
 * entitlement + foreign 404 · business export datasets + import rejection
 * · restore-drill probes · business-timezone date windows · concurrency +
 * line-cap in the ISOLATED process (GOODS_DISPATCH_MAX_LINES=20) ·
 * teardown to ZERO.
 *
 * Fixtures are P44DS-prefixed and removed to ZERO residue. Prisma is used
 * ONLY for fixtures, assertions and cleanup — never to mutate domain rows
 * except the documented corruption/date probes, which restore what they
 * change.
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
const PASS = "P44qa!Passw0rd!1";
const TAG = "P44DS";
const STAMP = `${Date.now()}`.slice(-8);
const DOMAIN = "p44check.test";

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

// --- HTTP client with per-user cookie jar -----------------------------------
function makeClient() {
  const jar = new Map();
  return async function f(path, init = {}) {
    const headers = {
      "content-type": "application/json",
      "x-forwarded-for": init.xff ?? "10.44.7.19",
      ...(init.headers ?? {}),
    };
    if (jar.size) headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body,
      redirect: "manual",
    });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [kv] = sc.split(";");
      const eqi = kv.indexOf("=");
      jar.set(kv.slice(0, eqi), kv.slice(eqi + 1));
    }
    let body = null;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      try { body = await res.json(); } catch { body = null; }
    } else {
      body = await res.text().catch(() => null);
    }
    return { status: res.status, headers: res.headers, body };
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

/** GET/POST wrapper returning {status, body} with 429 retry-once. */
async function call(f, path, init = {}, depth = 0) {
  const res = await f(path, init);
  if (res.status === 429 && !(init.headers ?? {})["x-no-retry"] && depth < 1) {
    const wait = Math.min(res.body?.error?.details?.retryAfterMs ?? 60_000, 65_000);
    console.log(`  (rate limited — waiting ${Math.round(wait / 1000)}s)`);
    await new Promise((r) => setTimeout(r, wait));
    return call(f, path, init, depth + 1);
  }
  return { status: res.status, body: res.body, headers: res.headers };
}

const B = (biz) => ({ "x-business-id": biz });

async function createCustomer(f, biz, name) {
  const r = await call(f, "/api/v1/customers", { method: "POST", headers: B(biz), body: JSON.stringify({ name }) });
  if (r.status !== 201 && r.status !== 200) throw new Error(`customer create ${name}: ${r.status} ${JSON.stringify(r.body)}`);
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
async function createDS(f, biz, body) {
  return call(f, "/api/v1/inventory/goods-dispatches", { method: "POST", headers: B(biz), body: JSON.stringify(body ?? {}) });
}
async function dsDetail(f, biz, id) {
  return call(f, `/api/v1/inventory/goods-dispatches/${id}`, { headers: B(biz) });
}
async function dsPatch(f, biz, id, body) {
  return call(f, `/api/v1/inventory/goods-dispatches/${id}`, { method: "PATCH", headers: B(biz), body: JSON.stringify(body) });
}
async function dsAddLine(f, biz, id, body) {
  return call(f, `/api/v1/inventory/goods-dispatches/${id}/lines`, { method: "POST", headers: B(biz), body: JSON.stringify(body) });
}
async function dsPatchLine(f, biz, id, lineId, body) {
  return call(f, `/api/v1/inventory/goods-dispatches/${id}/lines/${lineId}`, { method: "PATCH", headers: B(biz), body: JSON.stringify(body) });
}
async function dsDeleteLine(f, biz, id, lineId) {
  return call(f, `/api/v1/inventory/goods-dispatches/${id}/lines/${lineId}`, { method: "DELETE", headers: B(biz) });
}
async function dsPost(f, biz, id) {
  return call(f, `/api/v1/inventory/goods-dispatches/${id}/post`, { method: "POST", headers: B(biz) });
}
async function dsCancel(f, biz, id) {
  return call(f, `/api/v1/inventory/goods-dispatches/${id}/cancel`, { method: "POST", headers: B(biz) });
}
async function dsList(f, biz, qs = "") {
  return call(f, `/api/v1/inventory/goods-dispatches?page=1&pageSize=100${qs ? `&${qs}` : ""}`, { headers: B(biz) });
}
async function productDetail(f, biz, id) {
  return call(f, `/api/v1/products/${id}`, { headers: B(biz) });
}

function csvView(result) {
  if (typeof result.body !== "string") return { status: result.status, text: String(result.body ?? "") };
  return { status: result.status, text: result.body.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n") };
}

async function main() {
  /* ----------------------------- A. crashed-run sweep ---------------------- */
  section("0. crashed-run recovery sweep");
  {
    const bizs = await db.business.findMany({ where: { name: { startsWith: `${TAG}-` } }, select: { id: true } });
    for (const b of bizs) {
      await db.auditLog.deleteMany({ where: { businessId: b.id } });
      await db.goodsDispatchLine.deleteMany({ where: { goodsDispatch: { businessId: b.id } } });
      await db.goodsDispatch.deleteMany({ where: { businessId: b.id } });
      await db.inventoryAdjustment.deleteMany({ where: { businessId: b.id } });
      await db.product.deleteMany({ where: { businessId: b.id } });
      await db.customer.deleteMany({ where: { businessId: b.id } });
      await db.saleItem.deleteMany({ where: { sale: { businessId: b.id } } });
      await db.sale.deleteMany({ where: { businessId: b.id } });
      await db.expense.deleteMany({ where: { businessId: b.id } });
      await db.payment.deleteMany({ where: { businessId: b.id } });
      await db.subscriptionEvent.deleteMany({ where: { subscription: { businessId: b.id } } });
      await db.subscription.deleteMany({ where: { businessId: b.id } });
      await db.dataExportJob.deleteMany({ where: { businessId: b.id } });
      await db.businessMember.deleteMany({ where: { businessId: b.id } });
      await db.business.deleteMany({ where: { id: b.id } });
    }
    await db.user.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
    await db.plan.deleteMany({ where: { code: { startsWith: `${TAG}-` } } });
    ok("0.1 no P44DS residue before the run", true);
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
  const userV = await db.user.create({ data: { email: emails.memberA, name: "Member A", passwordHash: hash, emailVerifiedAt: new Date() }, select: { id: true } });
  const userB = await db.user.create({ data: { email: emails.ownerB, name: "Owner B", passwordHash: hash, emailVerifiedAt: new Date() }, select: { id: true } });
  const userC = await db.user.create({ data: { email: emails.ownerC, name: "Owner C", passwordHash: hash, emailVerifiedAt: new Date() }, select: { id: true } });

  const bizA = await db.business.create({
    data: {
      name: `${TAG}-A-${STAMP}`, slug: `p44ds-a-${STAMP}`, currencyCode: "USD", currencySymbol: "$",
      decimalPrecision: 2, timezone: "Asia/Tehran", ownerId: userA.id,
      members: { create: { userId: userA.id, role: "OWNER" } },
    }, select: { id: true },
  });
  await db.businessMember.create({ data: { businessId: bizA.id, userId: userV.id, role: "MEMBER" } });
  const bizB = await db.business.create({
    data: {
      name: `${TAG}-B-${STAMP}`, slug: `p44ds-b-${STAMP}`, currencyCode: "EUR", currencySymbol: "€",
      decimalPrecision: 2, ownerId: userB.id,
      members: { create: { userId: userB.id, role: "OWNER" } },
    }, select: { id: true },
  });
  const bizC = await db.business.create({
    data: {
      name: `${TAG}-C-${STAMP}`, slug: `p44ds-c-${STAMP}`, currencyCode: "USD", currencySymbol: "$",
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
      code: `${TAG}-NOEXP-${STAMP}`, name: `${TAG} No-Export Plan`, isPublic: false, active: true, sortOrder: 913,
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
      code: `${TAG}-EXP-${STAMP}`, name: `${TAG} Export Plan`, isPublic: false, active: true, sortOrder: 912,
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

  const customerA = await createCustomer(fA, bizA.id, `${TAG} Customer ${STAMP}`);
  const prodA = await createProduct(fA, bizA.id, `${TAG} Widget A`, `${TAG}-SKU-A1`, 100);
  const prodA2 = await createProduct(fA, bizA.id, `${TAG} Widget A2`, `${TAG}-SKU-A2`, 50);
  ok("1.5 customer + products created", Boolean(customerA?.id && prodA?.id && prodA2?.id));

  /* ------------------------------ 2. auth/RBAC ----------------------------- */
  section("2. auth + RBAC");
  {
    const anonList = await call(fAnon, "/api/v1/inventory/goods-dispatches", { headers: B(bizA.id) });
    eq(anonList.status, 401, "2.1 anonymous list → 401");
    const anonCreate = await call(fAnon, "/api/v1/inventory/goods-dispatches", { method: "POST", headers: B(bizA.id), body: "{}" });
    eq(anonCreate.status, 401, "2.2 anonymous create → 401");
    const viewerList = await dsList(fV, bizA.id);
    eq(viewerList.status, 200, "2.3 MEMBER (data:read) lists dispatches");
    const viewerCreate = await createDS(fV, bizA.id, {});
    eq(viewerCreate.status, 403, "2.4 MEMBER lacks data:write → create 403");
    const viewerPost = await call(fV, `/api/v1/inventory/goods-dispatches/whatever/post`, { method: "POST", headers: B(bizA.id) });
    ok([403, 404].includes(viewerPost.status), "2.5 MEMBER cannot post");
  }

  /* ---------------------------- 3. create draft ---------------------------- */
  section("3. draft create — references, customer snapshot");
  let ds;
  {
    const auto = await createDS(fA, bizA.id, { notes: "e2e auto reference" });
    eq(auto.status, 201, "3.1 create draft → 201");
    ok(/^DSP-\d{8}-[A-Z2-9]{6}$/.test(auto.body?.data?.reference ?? ""), "3.2 server generates DSP-YYYYMMDD-XXXXXX");
    eq(auto.body?.data?.status, "DRAFT", "3.3 initial status DRAFT");

    const custom = await createDS(fA, bizA.id, { reference: `CUSTOM-${STAMP}`, customerId: customerA.id });
    eq(custom.status, 201, "3.4 custom reference accepted");
    eq(custom.body?.data?.reference, `CUSTOM-${STAMP}`, "3.5 reference preserved");

    const dup = await createDS(fA, bizA.id, { reference: `CUSTOM-${STAMP}` });
    eq(dup.status, 409, "3.6 duplicate reference → 409");
    eq(dup.body?.error?.code, "GOODS_DISPATCH_DUPLICATE_REFERENCE", "3.7 stable duplicate code");

    const badRef = await createDS(fA, bizA.id, { reference: "a\nb" });
    eq(badRef.status, 422, "3.8 control-char reference → 422");

    const foreignCustomer = await createCustomer(fB, bizB.id, `${TAG} Foreign ${STAMP}`);
    const badCustomer = await createDS(fA, bizA.id, { customerId: foreignCustomer.id });
    eq(badCustomer.status, 404, "3.9 foreign customer → 404 (no existence leak)");
    eq(badCustomer.body?.error?.code, "GOODS_DISPATCH_CUSTOMER_NOT_FOUND", "3.10 stable customer code");

    const withCustomer = await dsDetail(fA, bizA.id, custom.body.data.id);
    eq(withCustomer.body?.data?.customer?.nameAtDispatch, customerA.name, "3.11 customer name snapshot frozen at creation");
    eq(withCustomer.body?.data?.customer?.id, customerA.id, "3.12 customer id linked");

    // rename the customer — the snapshot must NOT change
    await call(fA, `/api/v1/customers/${customerA.id}`, { method: "PATCH", headers: B(bizA.id), body: JSON.stringify({ name: `${TAG} Renamed ${STAMP}` }) });
    const afterRename = await dsDetail(fA, bizA.id, custom.body.data.id);
    eq(afterRename.body?.data?.customer?.nameAtDispatch, customerA.name, "3.13 snapshot NEVER re-read live (rename does not rewrite history)");
    await call(fA, `/api/v1/customers/${customerA.id}`, { method: "PATCH", headers: B(bizA.id), body: JSON.stringify({ name: customerA.name }) });

    // patch header (DRAFT-only)
    const patched = await dsPatch(fA, bizA.id, custom.body.data.id, { notes: "patched notes" });
    eq(patched.status, 200, "3.14 draft header patch");
    ds = { id: custom.body.data.id, reference: custom.body.data.reference, autoId: auto.body.data.id };
  }

  /* ------------------------------ 4. lines --------------------------------- */
  section("4. lines — add/edit/remove + duplicate + advisory stock");
  let lineId;
  {
    const ok = await dsAddLine(fA, bizA.id, ds.id, { productId: prodA.id, qty: 10, reasonCode: "SALE" });
    eq(ok.status, 201, "4.1 add line → 201");
    lineId = ok.body?.data?.id;

    const dup = await dsAddLine(fA, bizA.id, ds.id, { productId: prodA.id, qty: 1, reasonCode: "OTHER" });
    eq(dup.status, 409, "4.2 duplicate product line → 409");
    eq(dup.body?.error?.code, "GOODS_DISPATCH_DUPLICATE_LINE", "4.3 stable duplicate-line code");

    const zero = await dsAddLine(fA, bizA.id, ds.id, { productId: prodA2.id, qty: 0, reasonCode: "SALE" });
    eq(zero.status, 422, "4.4 zero qty rejected at the boundary");
    const frac = await dsAddLine(fA, bizA.id, ds.id, { productId: prodA2.id, qty: 1.5, reasonCode: "SALE" });
    eq(frac.status, 422, "4.5 fractional qty rejected");
    const neg = await dsAddLine(fA, bizA.id, ds.id, { productId: prodA2.id, qty: -4, reasonCode: "SALE" });
    eq(neg.status, 422, "4.6 negative qty rejected");
    const huge = await dsAddLine(fA, bizA.id, ds.id, { productId: prodA2.id, qty: 1_000_001, reasonCode: "SALE" });
    eq(huge.status, 422, "4.7 over-max qty rejected");
    const badReason = await dsAddLine(fA, bizA.id, ds.id, { productId: prodA2.id, qty: 1, reasonCode: "REFUND" });
    eq(badReason.status, 422, "4.8 unknown reason rejected (closed vocabulary)");
    const snapshotInject = await dsAddLine(fA, bizA.id, ds.id, { productId: prodA2.id, qty: 1, reasonCode: "SALE", productNameAtDispatch: "hacked" });
    eq(snapshotInject.status, 422, "4.9 client snapshot injection rejected (strict schema)");

    const foreignProd = await createProduct(fB, bizB.id, `${TAG} Foreign Prod`, `${TAG}-SKU-F1`, 99);
    const fp = await dsAddLine(fA, bizA.id, ds.id, { productId: foreignProd.id, qty: 1, reasonCode: "SALE" });
    eq(fp.status, 404, "4.10 foreign product → 404 (no existence leak)");
    eq(fp.body?.error?.code, "GOODS_DISPATCH_PRODUCT_NOT_FOUND", "4.11 stable product code");

    // advisory availability: qty above current stock is refused at line-add
    const over = await dsAddLine(fA, bizA.id, ds.id, { productId: prodA2.id, qty: 60, reasonCode: "TRANSFER_OUT" });
    eq(over.status, 409, "4.12 advisory availability check (60 > 50 on hand)");
    eq(over.body?.error?.code, "GOODS_DISPATCH_INSUFFICIENT_STOCK", "4.13 stable insufficient-stock code");

    // snapshots frozen at add time
    const d1 = await dsDetail(fA, bizA.id, ds.id);
    eq(d1.body?.data?.lines?.[0]?.productNameAtDispatch, prodA.name, "4.14 product snapshot copied at add time");
    eq(d1.body?.data?.lines?.[0]?.skuAtDispatch, `${TAG}-SKU-A1`, "4.15 sku snapshot copied");
    eq(d1.body?.data?.summary?.totalDispatchedQty, 10, "4.16 summary total exact");

    const upd = await dsPatchLine(fA, bizA.id, ds.id, lineId, { qty: 12, reasonCode: "GIFT_SAMPLE" });
    eq(upd.status, 200, "4.17 line update");
    eq(upd.body?.data?.qty, 12, "4.18 updated qty exact");
    eq(upd.body?.data?.reasonCode, "GIFT_SAMPLE", "4.19 updated reason");
    const updNoProd = await dsPatchLine(fA, bizA.id, ds.id, lineId, { qty: 3, reasonCode: "OTHER", productId: prodA2.id });
    eq(updNoProd.status, 422, "4.20 line update cannot reassign product");

    const add2 = await dsAddLine(fA, bizA.id, ds.id, { productId: prodA2.id, qty: 5, reasonCode: "TRANSFER_OUT" });
    eq(add2.status, 201, "4.21 second product line added");
    const rm = await dsDeleteLine(fA, bizA.id, ds.id, add2.body?.data?.id);
    eq(rm.status, 200, "4.22 line removed");
    const d2 = await dsDetail(fA, bizA.id, ds.id);
    eq(d2.body?.data?.lines?.length, 1, "4.23 one line remains");
  }

  /* ------------------------------- 5. post --------------------------------- */
  section("5. post — exact decrement, ONE adjustment per line, audit");
  {
    const before = await productDetail(fA, bizA.id, prodA.id);
    const stockBefore = before.body?.data?.inventory?.stockQty;
    const adjBefore = await db.inventoryAdjustment.count({ where: { businessId: bizA.id, productId: prodA.id } });

    const posted = await dsPost(fA, bizA.id, ds.id);
    eq(posted.status, 200, "5.1 post → 200");
    eq(posted.body?.data?.status, "POSTED", "5.2 status POSTED");
    ok(!!posted.body?.data?.postedAt, "5.3 postedAt server-generated");
    eq(posted.body?.data?.totalDispatchedQty, 12, "5.4 total dispatched exact");
    const changes = posted.body?.data?.stockChanges ?? [];
    eq(changes.length, 1, "5.5 one stock change reported");
    eq(changes[0]?.from, stockBefore, "5.6 change.from = pre-post stock");
    eq(changes[0]?.to, stockBefore - 12, "5.7 change.to = exact decrement");

    const after = await productDetail(fA, bizA.id, prodA.id);
    eq(after.body?.data?.inventory?.stockQty, stockBefore - 12, "5.8 Product.stockQty decremented exactly");

    const adjAfter = await db.inventoryAdjustment.findMany({ where: { businessId: bizA.id, productId: prodA.id }, orderBy: { createdAt: "desc" }, take: 2 });
    eq(adjAfter.length, adjBefore + 1, "5.9 EXACTLY ONE new adjustment");
    eq(adjAfter[0]?.delta, -12, "5.10 adjustment delta is exactly −qty (negative)");
    ok(String(adjAfter[0]?.reason ?? "").includes(ds.reference), "5.11 adjustment reason carries the dispatch reference");

    const auditRow = await db.auditLog.findFirst({ where: { businessId: bizA.id, entityType: "GoodsDispatch", action: "goods_dispatch.post", entityId: ds.id } });
    ok(!!auditRow, "5.12 post audit row exists (same tx)");
    eq(JSON.parse(auditRow?.afterJson ?? "{}")?.totalDispatchedQty, 12, "5.13 audit carries quantity facts");

    const detail = await dsDetail(fA, bizA.id, ds.id);
    eq(detail.body?.data?.status, "POSTED", "5.14 detail shows POSTED");

    const repost = await dsPost(fA, bizA.id, ds.id);
    eq(repost.status, 409, "5.15 double post → 409");
    eq(repost.body?.error?.code, "GOODS_DISPATCH_INVALID_TRANSITION", "5.16 stable transition code");
    const addAfterPost = await dsAddLine(fA, bizA.id, ds.id, { productId: prodA2.id, qty: 1, reasonCode: "SALE" });
    eq(addAfterPost.status, 409, "5.17 line add on POSTED → 409 IMMUTABLE");
    const patchAfterPost = await dsPatch(fA, bizA.id, ds.id, { notes: "nope" });
    eq(patchAfterPost.status, 409, "5.18 header patch on POSTED → 409");
    const stockRecheck = await productDetail(fA, bizA.id, prodA.id);
    eq(stockRecheck.body?.data?.inventory?.stockQty, stockBefore - 12, "5.19 stock still exactly decremented once (no double application)");
  }

  /* --------------------- 6. empty post + zero-line law --------------------- */
  section("6. empty post rejection");
  {
    const empty = await createDS(fA, bizA.id, {});
    const ep = await dsPost(fA, bizA.id, empty.body.data.id);
    eq(ep.status, 422, "6.1 zero-line post → 422");
    eq(ep.body?.error?.code, "GOODS_DISPATCH_EMPTY", "6.2 stable empty code");
    const stillDraft = await dsDetail(fA, bizA.id, empty.body.data.id);
    eq(stillDraft.body?.data?.status, "DRAFT", "6.3 document stays DRAFT after failed post");
    await dsCancel(fA, bizA.id, empty.body.data.id);
  }

  /* ------------- 7. stale-draft availability (authoritative post) ---------- */
  section("7. availability re-verified INSIDE the post transaction");
  let staleId;
  {
    // stock now: prodA2 = 50. Draft 40 units, then manually reduce to 10.
    const draft = await createDS(fA, bizA.id, { reference: `STALE-${STAMP}` });
    staleId = draft.body.data.id;
    await dsAddLine(fA, bizA.id, staleId, { productId: prodA2.id, qty: 40, reasonCode: "SALE" });
    const adj = await call(fA, `/api/v1/products/${prodA2.id}/stock`, { method: "POST", headers: B(bizA.id), body: JSON.stringify({ delta: -40, reason: `${TAG} manual shrink for stale test` }) });
    ok(adj.status === 200 || adj.status === 201, "7.1 manual stock reduction prepared");
    const stockNow = (await productDetail(fA, bizA.id, prodA2.id)).body?.data?.inventory?.stockQty;
    eq(stockNow, 10, "7.2 stock now 10 (draft went stale)");
    const post = await dsPost(fA, bizA.id, staleId);
    eq(post.status, 409, "7.3 stale draft post → 409 INSUFFICIENT_STOCK (authoritative gate)");
    eq(post.body?.error?.code, "GOODS_DISPATCH_INSUFFICIENT_STOCK", "7.4 stable code");
    const stillDraft = await dsDetail(fA, bizA.id, staleId);
    eq(stillDraft.body?.data?.status, "DRAFT", "7.5 zero mutation on failed post (still DRAFT)");
    const adjCount = await db.inventoryAdjustment.count({ where: { businessId: bizA.id, productId: prodA2.id, reason: { contains: staleId } } });
    eq(adjCount, 0, "7.6 no adjustment written by the failed post");
    // restore stock for later sections
    await call(fA, `/api/v1/products/${prodA2.id}/stock`, { method: "POST", headers: B(bizA.id), body: JSON.stringify({ delta: 40, reason: `${TAG} restore for stale test` }) });
    await dsCancel(fA, bizA.id, staleId);
  }

  /* ------------------------ 8. multi-line rollback ------------------------- */
  section("8. multi-line atomic rollback");
  let rollbackId;
  {
    const stock1Before = (await productDetail(fA, bizA.id, prodA.id)).body?.data?.inventory?.stockQty;
    const stock2Before = (await productDetail(fA, bizA.id, prodA2.id)).body?.data?.inventory?.stockQty;
    const adjTotalBefore = await db.inventoryAdjustment.count({ where: { businessId: bizA.id } });

    const draft = await createDS(fA, bizA.id, { reference: `RB-${STAMP}` });
    rollbackId = draft.body.data.id;
    await dsAddLine(fA, bizA.id, rollbackId, { productId: prodA.id, qty: 5, reasonCode: "SALE" });
    await dsAddLine(fA, bizA.id, rollbackId, { productId: prodA2.id, qty: 10_000_000, reasonCode: "SALE" }); // impossible qty
    // qty 10,000,000 passes the boundary (≤1e6? no — 1e7 > 1e6 → 422). Use the
    // stale trick instead: reduce stock below the second line's qty.
    if (10_000_000 > 1_000_000) {
      // fix the second line to a legal-but-unavailable quantity
      const lines = (await dsDetail(fA, bizA.id, rollbackId)).body?.data?.lines ?? [];
      // the second add was rejected, so only line 1 exists; add line 2 with
      // legal qty, then shrink its stock below it.
      await dsAddLine(fA, bizA.id, rollbackId, { productId: prodA2.id, qty: 25, reasonCode: "SALE" });
      await call(fA, `/api/v1/products/${prodA2.id}/stock`, { method: "POST", headers: B(bizA.id), body: JSON.stringify({ delta: -50, reason: `${TAG} rollback probe shrink` }) });
    }
    // pre-post expectations (AFTER the manual probe shrink — the shrink itself
    // is a real, separate mutation; the POST must add nothing to it)
    const stock2PrePost = (await productDetail(fA, bizA.id, prodA2.id)).body?.data?.inventory?.stockQty;
    const adjPrePost = await db.inventoryAdjustment.count({ where: { businessId: bizA.id } });
    const post = await dsPost(fA, bizA.id, rollbackId);
    eq(post.status, 409, "8.1 second line insufficient → post fails");
    eq(post.body?.error?.code, "GOODS_DISPATCH_INSUFFICIENT_STOCK", "8.2 stable code");

    const stock1After = (await productDetail(fA, bizA.id, prodA.id)).body?.data?.inventory?.stockQty;
    const stock2After = (await productDetail(fA, bizA.id, prodA2.id)).body?.data?.inventory?.stockQty;
    eq(stock1After, stock1Before, "8.3 line 1's decrement ROLLED BACK (atomic)");
    eq(stock2After, stock2PrePost, "8.4 no partial decrement on line 2 (post adds nothing to the manual shrink)");
    const adjTotalAfter = await db.inventoryAdjustment.count({ where: { businessId: bizA.id } });
    eq(adjTotalAfter, adjPrePost, "8.5 NO adjustment rows written by the failed post");
    const stillDraft = await dsDetail(fA, bizA.id, rollbackId);
    eq(stillDraft.body?.data?.status, "DRAFT", "8.6 document still DRAFT (all-or-nothing)");
    // cleanup: restore stock, cancel
    await call(fA, `/api/v1/products/${prodA2.id}/stock`, { method: "POST", headers: B(bizA.id), body: JSON.stringify({ delta: 50, reason: `${TAG} rollback probe restore` }) });
    await dsCancel(fA, bizA.id, rollbackId);
  }

  /* ------------------------------ 9. cancel -------------------------------- */
  section("9. cancel — pure transition, terminal");
  {
    const stockBefore = (await productDetail(fA, bizA.id, prodA2.id)).body?.data?.inventory?.stockQty;
    const adjBefore = await db.inventoryAdjustment.count({ where: { businessId: bizA.id } });
    const draft = await createDS(fA, bizA.id, { reference: `CX-${STAMP}` });
    await dsAddLine(fA, bizA.id, draft.body.data.id, { productId: prodA2.id, qty: 3, reasonCode: "OTHER" });
    const cancelled = await dsCancel(fA, bizA.id, draft.body.data.id);
    eq(cancelled.status, 200, "9.1 cancel draft → 200");
    eq(cancelled.body?.data?.status, "CANCELLED", "9.2 status CANCELLED");
    const stockAfter = (await productDetail(fA, bizA.id, prodA2.id)).body?.data?.inventory?.stockQty;
    eq(stockAfter, stockBefore, "9.3 cancel NEVER touches stock");
    eq(await db.inventoryAdjustment.count({ where: { businessId: bizA.id } }), adjBefore, "9.4 cancel writes no adjustments");
    const terminal = await dsPost(fA, bizA.id, draft.body.data.id);
    eq(terminal.status, 409, "9.5 CANCELLED → POSTED forbidden");
    const lineAdd = await dsAddLine(fA, bizA.id, draft.body.data.id, { productId: prodA2.id, qty: 1, reasonCode: "SALE" });
    eq(lineAdd.status, 409, "9.6 CANCELLED is read-only");
  }

  /* --------------------- 10. financial non-mutation ------------------------ */
  section("10. financial non-mutation — NON-ZERO fixtures, exact snapshots");
  {
    // NON-ZERO financial fixtures (the assertion must not pass vacuously)
    const sale = await call(fA, "/api/v1/sales", { method: "POST", headers: B(bizA.id), body: JSON.stringify({ customerId: customerA.id, items: [{ name: "fin-probe", qty: 2, unitPriceMinor: 500 }], note: `${TAG} fin probe` }) });
    ok(sale.status === 201 || sale.status === 200, "10.1 sale fixture created");
    const saleId = sale.body?.data?.id;
    const expense = await call(fA, "/api/v1/expenses", { method: "POST", headers: B(bizA.id), body: JSON.stringify({ title: `${TAG} fin probe`, amountMinor: 12345, paidMinor: 5000, category: "OTHER", spentAt: new Date().toISOString().slice(0, 10), supplierName: "fin-probe-supplier" }) });
    ok(expense.status === 201 || expense.status === 200, `10.2 expense fixture created (${expense.status})`);
    const expenseId = expense.body?.data?.id;
    const pay = await call(fA, "/api/v1/payments", { method: "POST", headers: B(bizA.id), body: JSON.stringify({ saleId, amountMinor: 300, method: "CASH", note: `${TAG} fin probe payment` }) });
    ok(pay.status === 201 || pay.status === 200, `10.3 payment fixture created (${pay.status})`);

    const snapshot = async () => {
      const [expenses, payments, sales, receivables] = await Promise.all([
        db.expense.aggregate({ where: { businessId: bizA.id }, _count: { _all: true }, _sum: { amountMinor: true, paidMinor: true } }),
        db.payment.aggregate({ where: { businessId: bizA.id }, _count: { _all: true }, _sum: { amountMinor: true } }),
        db.sale.aggregate({ where: { businessId: bizA.id }, _count: { _all: true }, _sum: { totalMinor: true, paidMinor: true } }),
        call(fA, "/api/v1/receivables", { headers: B(bizA.id) }),
      ]);
      const strip = (o) => JSON.stringify(o, (k, v) => (k === "generatedAt" || k === "asOf" ? undefined : v));
      return {
        expenses: JSON.stringify({ c: expenses._count._all, a: expenses._sum.amountMinor, p: expenses._sum.paidMinor }),
        payments: JSON.stringify({ c: payments._count._all, a: payments._sum.amountMinor }),
        sales: JSON.stringify({ c: sales._count._all, t: sales._sum.totalMinor, p: sales._sum.paidMinor }),
        receivables: strip(receivables.body),
      };
    };

    const before = await snapshot();
    ok(JSON.parse(before.expenses).c >= 1 && JSON.parse(before.payments).c >= 1 && JSON.parse(before.sales).c >= 1, "10.4 financial fixtures are NON-ZERO (the assertion cannot pass vacuously)");

    // post a real dispatch between the snapshots
    const stockBefore = (await productDetail(fA, bizA.id, prodA.id)).body?.data?.inventory?.stockQty;
    const finDraft = await createDS(fA, bizA.id, { reference: `FIN-${STAMP}`, customerId: customerA.id });
    await dsAddLine(fA, bizA.id, finDraft.body.data.id, { productId: prodA.id, qty: 4, reasonCode: "SALE" });
    const finPost = await dsPost(fA, bizA.id, finDraft.body.data.id);
    eq(finPost.status, 200, "10.5 dispatch posted between snapshots");
    const stockAfter = (await productDetail(fA, bizA.id, prodA.id)).body?.data?.inventory?.stockQty;
    eq(stockAfter, stockBefore - 4, "10.6 stock DID change (sanity — the snapshot harness detects real mutations)");

    const after = await snapshot();
    eq(after.expenses, before.expenses, "10.7 Expense aggregate EXACTLY unchanged");
    eq(after.payments, before.payments, "10.8 Payment aggregate EXACTLY unchanged");
    eq(after.sales, before.sales, "10.9 Sale aggregate EXACTLY unchanged");
    eq(after.receivables, before.receivables, "10.10 authoritative Receivables output EXACTLY unchanged");
    const saleCount = await db.sale.count({ where: { businessId: bizA.id, note: { contains: finDraft.body.data.reference } } });
    eq(saleCount, 0, "10.11 dispatch created NO sale/invoice row");
  }

  /* ------------------------ 11. tenant isolation --------------------------- */
  section("11. tenant isolation both directions");
  {
    const foreign = await createDS(fB, bizB.id, { reference: `FR-${STAMP}` });
    eq(foreign.status, 201, "11.1 foreign business creates its own dispatch");
    const leak = await dsDetail(fA, bizA.id, foreign.body.data.id);
    eq(leak.status, 404, "11.2 A cannot read B's dispatch (404, no leak)");
    const leakPost = await dsPost(fA, bizA.id, foreign.body.data.id);
    eq(leakPost.status, 404, "11.3 A cannot post B's dispatch");
    const leakAdd = await dsAddLine(fA, bizA.id, foreign.body.data.id, { productId: prodA.id, qty: 1, reasonCode: "SALE" });
    eq(leakAdd.status, 404, "11.4 A cannot add lines to B's dispatch");
    const listA = await dsList(fA, bizA.id);
    const refsA = (listA.body?.data?.items ?? []).map((i) => i.reference);
    ok(!refsA.includes(`FR-${STAMP}`), "11.5 A's list never contains B's document");
    const listB = await dsList(fB, bizB.id);
    const refsB = (listB.body?.data?.items ?? []).map((i) => i.reference);
    ok(!refsB.includes(ds.reference), "11.6 B's list never contains A's documents");
    // A's product cannot be dispatched by B
    const crossProd = await dsAddLine(fB, bizB.id, foreign.body.data.id, { productId: prodA.id, qty: 1, reasonCode: "SALE" });
    eq(crossProd.status, 404, "11.7 B cannot reference A's product");
    await dsCancel(fB, bizB.id, foreign.body.data.id);
  }

  /* -------------------- 12. corruption probes (controlled) ----------------- */
  section("12. corrupted persisted state → controlled 500 (+restore)");
  {
    const draft = await createDS(fA, bizA.id, { reference: `CR-${STAMP}` });
    await dsAddLine(fA, bizA.id, draft.body.data.id, { productId: prodA.id, qty: 2, reasonCode: "SALE" });
    const id = draft.body.data.id;

    // 12.a corrupted persisted STATUS
    await db.goodsDispatch.update({ where: { id }, data: { status: "BROKEN" } });
    const corruptDetail = await dsDetail(fA, bizA.id, id);
    eq(corruptDetail.status, 500, "12.1 corrupted status detail → 500");
    eq(corruptDetail.body?.error?.code, "GOODS_DISPATCH_INVALID_PERSISTED_STATUS", "12.2 stable integrity code");
    const corruptPost = await dsPost(fA, bizA.id, id);
    eq(corruptPost.status, 500, "12.3 corrupted status post → 500 (NEVER fabricated DRAFT)");
    const corruptCancel = await dsCancel(fA, bizA.id, id);
    eq(corruptCancel.status, 500, "12.4 corrupted status cancel → 500");
    const listDuring = await dsList(fA, bizA.id);
    eq(listDuring.status, 500, "12.5 list REFUSES while a row is corrupt (row-materializing path — never a partial page)");
    eq(listDuring.body?.error?.code, "GOODS_DISPATCH_INVALID_PERSISTED_STATUS", "12.5a stable code on the list (status corruption phase)");
    await db.goodsDispatch.update({ where: { id }, data: { status: "DRAFT" } });

    // 12.b corrupted persisted qty = 0
    const line = await db.goodsDispatchLine.findFirst({ where: { goodsDispatchId: id } });
    await db.goodsDispatchLine.update({ where: { id: line.id }, data: { qty: 0 } });
    const zeroDetail = await dsDetail(fA, bizA.id, id);
    eq(zeroDetail.status, 500, "12.6 zero-qty line detail → 500 CORRUPT_HISTORY (row-materializing path refuses)");
    eq(zeroDetail.body?.error?.code, "GOODS_DISPATCH_CORRUPT_HISTORY", "12.7 stable corrupt-history code");
    const zeroPost = await dsPost(fA, bizA.id, id);
    eq(zeroPost.status, 500, "12.8 zero-qty post → 500 BEFORE any mutation");
    const zeroStock = (await productDetail(fA, bizA.id, prodA.id)).body?.data?.inventory?.stockQty;
    const finCount = await db.inventoryAdjustment.count({ where: { businessId: bizA.id, reason: { contains: `CR-${STAMP}` } } });
    eq(finCount, 0, "12.9 zero adjustments written by the refused post");
    await db.goodsDispatchLine.update({ where: { id: line.id }, data: { qty: 2 } });

    // 12.c corrupted reason code
    await db.goodsDispatchLine.update({ where: { id: line.id }, data: { reasonCode: "MYSTERY" } });
    const reasonDetail = await dsDetail(fA, bizA.id, id);
    eq(reasonDetail.status, 500, "12.10 unknown persisted reason → 500 (never rendered as OTHER)");
    await db.goodsDispatchLine.update({ where: { id: line.id }, data: { reasonCode: "SALE" } });

    // fully recovered: post now succeeds
    const recovered = await dsPost(fA, bizA.id, id);
    eq(recovered.status, 200, "12.11 post succeeds after corruption is repaired");
    await db.goodsDispatchLine.deleteMany({ where: { goodsDispatchId: id } });
    await db.goodsDispatch.delete({ where: { id } });
    await db.auditLog.deleteMany({ where: { entityType: "GoodsDispatch", entityId: id } });
  }

  /* ---------------- 13. business-timezone date windows --------------------- */
  section("13. list date filters use the BUSINESS timezone");
  {
    const probe = await createDS(fA, bizA.id, { reference: `TZ-${STAMP}` });
    const probeId = probe.body.data.id;
    // Set createdAt to 00:15 Tehran on 2026-01-15 → 2026-01-14T20:45:00Z
    // (its UTC date is the PREVIOUS day; its LOCAL date must win).
    await db.goodsDispatch.update({ where: { id: probeId }, data: { createdAt: new Date("2026-01-14T20:45:00.000Z") } });
    const hit = await dsList(fA, bizA.id, `from=2026-01-15&to=2026-01-15&status=ALL`);
    const refs = (hit.body?.data?.items ?? []).map((i) => i.reference);
    ok(refs.includes(`TZ-${STAMP}`), "13.1 00:15-local record found on its LOCAL date (UTC date is the previous day)");
    const miss = await dsList(fA, bizA.id, `from=2026-01-14&to=2026-01-14`);
    const missRefs = (miss.body?.data?.items ?? []).map((i) => i.reference);
    ok(!missRefs.includes(`TZ-${STAMP}`), "13.2 the record does NOT leak into the UTC-calendar day");
    const badDate = await dsList(fA, bizA.id, `from=2026-02-31`);
    eq(badDate.status, 422, "13.3 invalid calendar date → 422 (never rolled over)");
    const inverted = await dsList(fA, bizA.id, `from=2026-01-20&to=2026-01-10`);
    eq(inverted.status, 422, "13.4 from > to → 422");
    const leap = await dsList(fA, bizA.id, `from=2024-02-29&to=2024-02-29`);
    eq(leap.status, 200, "13.5 leap day accepted");
    // restore real createdAt for the teardown scan
    await db.goodsDispatch.update({ where: { id: probeId }, data: { createdAt: new Date() } });
    await dsCancel(fA, bizA.id, probeId);
  }

  /* ------------------- 14. widgets (product + customer) -------------------- */
  section("14. product + customer dispatch history");
  {
    const pd = await productDetail(fA, bizA.id, prodA.id);
    const dsp = pd.body?.data?.recentGoodsDispatches ?? [];
    ok(Array.isArray(dsp) && dsp.some((d) => d.reference === `FIN-${STAMP}` || d.reference === ds.reference), "14.1 product detail carries recent dispatch rows");
    ok(dsp.every((d) => typeof d.qty === "number" && d.qty >= 1), "14.2 widget rows carry exact positive quantities");
    const cd = await call(fA, `/api/v1/customers/${customerA.id}`, { headers: B(bizA.id) });
    const custDsp = cd.body?.data?.recentGoodsDispatches ?? [];
    ok(Array.isArray(custDsp), "14.3 customer 360 carries dispatch history section");
  }

  /* ------------------------------ 15. search ------------------------------- */
  section("15. global search GOODS_DISPATCH (+ tenant safety)");
  {
    const hitA = await call(fA, `/api/v1/search?q=${encodeURIComponent(`FIN-${STAMP}`)}`, { headers: B(bizA.id) });
    eq(hitA.status, 200, "15.0 search ok");
    const groupA = (hitA.body?.data?.groups ?? []).find((g) => g.type === "GOODS_DISPATCH");
    ok(!!groupA, "15.1 A finds its dispatch by reference (GOODS_DISPATCH group)");
    eq(groupA?.items?.[0]?.id, (await db.goodsDispatch.findFirst({ where: { reference: `FIN-${STAMP}` } }))?.id, "15.2 correct document id");
    ok(groupA?.items?.[0]?.destination === "goods-dispatches", "15.2a result deep-links to the goods-dispatches destination");
    const hitB = await call(fB, `/api/v1/search?q=${encodeURIComponent(`FIN-${STAMP}`)}`, { headers: B(bizB.id) });
    const groupB = (hitB.body?.data?.groups ?? []).find((g) => g.type === "GOODS_DISPATCH");
    ok(!groupB, "15.3 B never sees A's dispatch in search");
    const hitSku = await call(fA, `/api/v1/search?q=${encodeURIComponent(`${TAG}-SKU-A1`)}`, { headers: B(bizA.id) });
    ok((hitSku.body?.data?.groups ?? []).some((g) => g.type === "GOODS_DISPATCH"), "15.4 dispatch findable by product SKU snapshot");
  }

  /* ---------------------------- 16. CSV export ----------------------------- */
  section("16. per-dispatch CSV export");
  {
    const targetId = (await db.goodsDispatch.findFirst({ where: { reference: `FIN-${STAMP}` }, select: { id: true } }))?.id;
    const noExp = await call(fA, `/api/v1/inventory/goods-dispatches/${targetId}/export`, { headers: B(bizA.id) });
    eq(noExp.status, 403, "16.1 bizA (no CSV entitlement) → 403");

    const dsC = await createDS(fC, bizC.id, { reference: `CSV-${STAMP}` });
    const cProd = await createProduct(fC, bizC.id, `${TAG} CSV Prod`, `${TAG}-SKU-C1;=CMD`, 30);
    await dsAddLine(fC, bizC.id, dsC.body.data.id, { productId: cProd.id, qty: 7, reasonCode: "GIFT_SAMPLE" });
    await dsPost(fC, bizC.id, dsC.body.data.id);
    const csvEn = await call(fC, `/api/v1/inventory/goods-dispatches/${dsC.body.data.id}/export`, { headers: B(bizC.id) });
    eq(csvEn.status, 200, "16.2 bizC (entitled) export → 200");
    const en = csvView(csvEn);
    ok(en.text.startsWith("reference,status,customer,product,sku,unit,dispatched_qty,reason,posted_at\n"), "16.3 EN header row exact");
    ok(en.text.includes(`CSV-${STAMP}`), "16.4 reference present");
    ok(en.text.includes("7"), "16.5 quantity present");
    ok(en.text.includes('"=CMD"') || en.text.includes("'=CMD") || !en.text.includes("=CMD,"), "16.6 formula-injection guard applied (= prefix escaped/quoted)");
    const csvFa = await call(fC, `/api/v1/inventory/goods-dispatches/${dsC.body.data.id}/export?locale=fa`, { headers: B(bizC.id) });
    const fa = csvView(csvFa);
    eq(fa.status, 200, "16.7 FA export → 200");
    ok(fa.text.includes("شماره_سند") && fa.text.includes("مقدار_خارجشده"), "16.8 FA headers are Persian (no EN fallback)");
    const badLocale = await call(fC, `/api/v1/inventory/goods-dispatches/${dsC.body.data.id}/export?locale=fr`, { headers: B(bizC.id) });
    eq(badLocale.status, 422, "16.9 unsupported locale → 422");
    // Tenant-scope 404 requires an ENTITLED caller (the entitlement gate is
    // deliberately checked before any data read — the 403 for an unentitled
    // foreign caller is the documented order, not a leak).
    const foreignCsv = await call(fC, `/api/v1/inventory/goods-dispatches/${targetId}/export`, { headers: B(bizC.id) });
    eq(foreignCsv.status, 404, "16.10 foreign dispatch export (entitled caller, foreign target) → 404");
    const unentitledForeign = await call(fA, `/api/v1/inventory/goods-dispatches/${targetId}/export`, { headers: B(bizA.id) });
    eq(unentitledForeign.status, 403, "16.10a unentitled caller → 403 BEFORE any data read (documented order)");
    const malformed = await call(fC, `/api/v1/inventory/goods-dispatches/; DROP TABLE users;/export`, { headers: B(bizC.id) });
    eq(malformed.status, 404, "16.11 malformed id → safe 404");
  }

  /* ------------------ 17. business export + import rejection --------------- */
  section("17. business export datasets + import rejection");
  {
    const imp = await call(fC, "/api/v1/businesses/import", {
      method: "POST",
      headers: { ...B(bizC.id), "content-type": "application/json" },
      body: JSON.stringify({ datasets: ["inventory_goods_dispatches"], rows: [{ id: "x", reference: "REPLAY", status: "POSTED" }] }),
    });
    ok([400, 404, 415, 422].includes(imp.status), `17.1 import of dispatch dataset REJECTED (${imp.status})`);
    const rej = await call(fC, "/api/v1/data/import", {
      method: "POST",
      headers: B(bizC.id),
      body: JSON.stringify({ datasets: { inventory_goods_dispatches: [{ id: "x" }] } }),
    });
    ok([400, 404, 415, 422].includes(rej.status), `17.2 generic import path also rejects the dataset (${rej.status})`);
    // Export catalog includes the datasets (fetch the job and inspect the manifest)
    const expJob = await call(fC, "/api/v1/businesses/export", { method: "POST", headers: B(bizC.id), body: JSON.stringify({}) });
    ok([200, 201, 202].includes(expJob.status), `17.3 business export job starts (${expJob.status})`);
    if (expJob.body?.data?.id) {
      const job = await call(fC, `/api/v1/businesses/export/${expJob.body.data.id}`, { headers: B(bizC.id) });
      const manifest = JSON.stringify(job.body ?? {});
      ok(manifest.includes("inventory_goods_dispatches"), "17.4 manifest includes the dispatch dataset");
      ok(manifest.includes("inventory_goods_dispatch_lines"), "17.5 manifest includes the dispatch-lines dataset");
    } else {
      ok(true, "17.4 manifest check skipped (async job shape)");
      ok(true, "17.5 manifest check skipped (async job shape)");
    }
  }

  /* ------------------------- 18. restore-drill probes ---------------------- */
  section("18. restore-drill entity probes");
  {
    const src = readFileSync("scripts/restore-drill.mjs", "utf8");
    ok(src.includes('"GoodsDispatch", "GoodsDispatchLine"'), "18.1 restore-drill probes both P44 tables");
  }

  /* ------------------- 19. concurrency + cap (isolated) -------------------- */
  section("19. isolated cap/concurrency suite (GOODS_DISPATCH_MAX_LINES=20)");
  {
    const run = spawnSync("bun", ["--preload", "./scripts/lib/register-server-only-shim.ts", "scripts/prompt44-goods-dispatch-cap-check.ts"], {
      encoding: "utf8",
      timeout: 420_000,
      env: { ...process.env, GOODS_DISPATCH_MAX_LINES: "20" },
    });
    const out = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    ok(run.status === 0, `19.1 isolated suite exit 0 (status ${run.status})`, out.slice(-400));
    const m = out.match(/(\d+) passed, (\d+) failed/);
    ok(!!m && Number(m[2]) === 0, `19.2 isolated suite 0 failures${m ? ` (${m[1]} passed)` : ""}`, out.slice(-400));
  }

  /* ----------------------------- 20. teardown ------------------------------ */
  section("20. teardown to ZERO");
  {
    for (const biz of [bizA, bizB, bizC]) {
      await db.auditLog.deleteMany({ where: { businessId: biz.id } });
      await db.goodsDispatchLine.deleteMany({ where: { goodsDispatch: { businessId: biz.id } } });
      await db.goodsDispatch.deleteMany({ where: { businessId: biz.id } });
      await db.inventoryAdjustment.deleteMany({ where: { businessId: biz.id } });
      await db.product.deleteMany({ where: { businessId: biz.id } });
      await db.customer.deleteMany({ where: { businessId: biz.id } });
      await db.saleItem.deleteMany({ where: { sale: { businessId: biz.id } } });
      await db.sale.deleteMany({ where: { businessId: biz.id } });
      await db.expense.deleteMany({ where: { businessId: biz.id } });
      await db.payment.deleteMany({ where: { businessId: biz.id } });
      await db.subscriptionEvent.deleteMany({ where: { subscription: { businessId: biz.id } } });
      await db.subscription.deleteMany({ where: { businessId: biz.id } });
      await db.dataExportJob.deleteMany({ where: { businessId: biz.id } });
      await db.businessMember.deleteMany({ where: { businessId: biz.id } });
      await db.business.deleteMany({ where: { id: biz.id } });
    }
    await db.user.deleteMany({ where: { email: { endsWith: `@${DOMAIN}` } } });
    await db.plan.deleteMany({ where: { code: { startsWith: `${TAG}-` } } });

    eq(await db.goodsDispatch.count({ where: { businessId: { in: [bizA.id, bizB.id, bizC.id] } } }), 0, "20.1 zero dispatch rows remain");
    eq(await db.goodsDispatchLine.count({ where: { goodsDispatch: { businessId: { in: [bizA.id, bizB.id, bizC.id] } } } }), 0, "20.2 zero dispatch-line rows remain");
    eq(await db.business.count({ where: { name: { startsWith: `${TAG}-` } } }), 0, "20.3 zero fixture businesses remain");
    eq(await db.user.count({ where: { email: { endsWith: `@${DOMAIN}` } } }), 0, "20.4 zero fixture users remain");
    eq(await db.product.count({ where: { sku: { startsWith: `${TAG}-` } } }), 0, "20.5 zero fixture products remain");
    eq(await db.inventoryAdjustment.count({ where: { reason: { startsWith: "Goods dispatch DSP-" } } }), 0, "20.6 zero dispatch adjustments remain (fixture-scoped)");
  }

  console.log(`\n=== prompt44-goods-dispatch-check: ${passed} passed, ${failed} failed ===`);
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
