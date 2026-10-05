#!/usr/bin/env node
/**
 * Prompt 40 — E2E STOCKTAKE CHECK. Real application + real DB.
 * Run: node scripts/prompt40-stocktake-check.mjs   (dev server on :3000)
 *
 * Covers scenarios A..AB against /api/v1/inventory/stocktakes (Prompt 40):
 * auth/RBAC, create validation, lines, lifecycle transitions, server-side
 * counting snapshot, stale-count protection, atomic finalization, terminal
 * immutability, cancel, tenant isolation, list/detail pagination, audit,
 * DTO hygiene, financial non-interference.
 *
 * All fixtures are P40-prefixed (per-run stamp suffix on stocktake
 * references) and removed to ZERO residue (final DB assertions). The
 * dev-baseline fixtures of other prompts are never touched. Reads use a
 * 429-retry-once wrapper (house style, prompt39); Prisma is used ONLY for
 * cleanup + audit/adjustment/stock assertions.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

// --- env -------------------------------------------------------------------
for (const line of readFileSync(".env", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const db = new PrismaClient();
const BASE = "http://localhost:3000";
const PASS = "P40qa!Passw0rd!1";
const TAG = "P40";
const USER_PREFIX = "p40-e2e-";

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, info = "") {
  if (cond) passed++;
  else failed++, failures.push(`${name}${info ? ` — ${info}` : ""}`);
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
}
function section(name) {
  console.log(`\n=== ${name} ===`);
}

// --- HTTP client with per-user cookie jar ----------------------------------
function makeClient() {
  const jar = new Map(); // cookie name → value (merge, never overwrite others)
  return async function f(path, init = {}) {
    const headers = {
      "content-type": "application/json",
      "x-forwarded-for": init.xff ?? "10.40.12.7",
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
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
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

async function register(f, name, email, xff) {
  const reg = await f("/api/v1/auth/register", { method: "POST", xff, body: JSON.stringify({ name, email, password: PASS }) });
  if (reg.status !== 201 && reg.status !== 200) {
    console.log(`  (register ${email}: ${reg.status} ${JSON.stringify(reg.body?.error ?? "")})`);
  }
}

/** GET wrapper with 429 retry-once (house style, prompt39 §201). */
async function retryRead(fn, depth = 0) {
  const r = await fn();
  if (r.status === 429 && depth < 1) {
    const wait = Math.min(r.body?.error?.details?.retryAfterMs ?? 60_000, 65_000);
    console.log(`  (rate limited — waiting ${Math.round(wait / 1000)}s)`);
    await new Promise((res) => setTimeout(res, wait));
    return retryRead(fn, depth + 1);
  }
  return r;
}

// --- API fixture helpers (throw on failure — fixture bugs abort the run) ----
async function createProduct(f, bizId, name, stockQty) {
  const r = await f("/api/v1/products", {
    method: "POST",
    headers: { "x-business-id": bizId },
    body: JSON.stringify({ name, sku: name, salePriceMinor: 1000, costPriceMinor: 500, stockQty }),
  });
  if (r.status !== 201) throw new Error(`product create ${name} ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.data;
}
async function createStocktake(f, bizId, reference, notes) {
  const r = await f("/api/v1/inventory/stocktakes", {
    method: "POST",
    headers: { "x-business-id": bizId },
    body: JSON.stringify({ reference, ...(notes !== undefined ? { notes } : {}) }),
  });
  if (r.status !== 201) throw new Error(`stocktake create ${reference} ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.data;
}
async function addLine(f, bizId, stId, productId) {
  const r = await f(`/api/v1/inventory/stocktakes/${stId}/lines`, {
    method: "POST",
    headers: { "x-business-id": bizId },
    body: JSON.stringify({ productId }),
  });
  if (r.status !== 201) throw new Error(`add line ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.data;
}
async function countLine(f, bizId, stId, lineId, countedQty) {
  const r = await f(`/api/v1/inventory/stocktakes/${stId}/lines/${lineId}/count`, {
    method: "POST",
    headers: { "x-business-id": bizId },
    body: JSON.stringify({ countedQty }),
  });
  if (r.status !== 200) throw new Error(`count ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.data;
}
async function transition(f, bizId, stId, op) {
  const r = await f(`/api/v1/inventory/stocktakes/${stId}/${op}`, {
    method: "POST",
    headers: { "x-business-id": bizId },
  });
  if (r.status !== 200) throw new Error(`${op} ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body.data;
}
async function detail(f, bizId, stId, query = "") {
  return retryRead(() => f(`/api/v1/inventory/stocktakes/${stId}${query}`, { headers: { "x-business-id": bizId } }));
}
const stockOf = async (productId) =>
  (await db.product.findUnique({ where: { id: productId }, select: { stockQty: true, isActive: true, deletedAt: true } })) ?? {};

/**
 * FK-safe purge of fixture-owned rows for the given businesses + users.
 * Order: lines → stocktakes → adjustments → products → audit → notifications
 * → memberships → sessions → businesses → users. Dev-baseline data outside
 * the P40 tag is never touched.
 */
async function purgeBusinesses(bizIds, userIds) {
  const lines = await db.inventoryStocktakeLine.count({ where: { stocktake: { businessId: { in: bizIds } } } });
  await db.inventoryStocktakeLine.deleteMany({ where: { stocktake: { businessId: { in: bizIds } } } });
  await db.inventoryStocktake.deleteMany({ where: { businessId: { in: bizIds } } });
  await db.inventoryAdjustment.deleteMany({ where: { businessId: { in: bizIds } } });
  await db.product.deleteMany({ where: { businessId: { in: bizIds } } });
  await db.auditLog.deleteMany({ where: { businessId: { in: bizIds } } });
  await db.notification.deleteMany({ where: { OR: [{ businessId: { in: bizIds } }, ...(userIds.length ? [{ userId: { in: userIds } }] : [])] } });
  await db.businessMember.deleteMany({ where: { businessId: { in: bizIds } } });
  if (userIds.length) await db.userSession.deleteMany({ where: { userId: { in: userIds } } });
  await db.business.deleteMany({ where: { id: { in: bizIds } } });
  if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } });
  return { lines };
}

async function main() {
  // Pre-cleanup: residue from any previously crashed run (fixture-owned
  // records only; never touches dev-baseline data).
  {
    const oldBiz = await db.business.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    const oldUsers = await db.user.findMany({ where: { email: { startsWith: USER_PREFIX } }, select: { id: true } });
    // users first own the businesses — purge businesses before deleting users
    const purged = await purgeBusinesses(oldBiz.map((b) => b.id), oldUsers.map((u) => u.id));
    if (oldBiz.length || oldUsers.length) {
      console.log(`  (pre-cleaned ${oldBiz.length} leftover P40 business(es), ${oldUsers.length} user(s), ${purged.lines} line(s))`);
    }
  }

  const stamp = Date.now();
  const refOf = (base) => `${base}-${stamp}`;
  const today = () => new Date().toISOString().slice(0, 10);

  const ownerA = makeClient();
  const ownerB = makeClient();
  const viewer = makeClient();
  const anon = makeClient();

  let okCleanup = null; // set once cleanup ran
  try {
    // ===== fixtures =========================================================
    section("FIXTURES (P40-)");
    const emailA = `${USER_PREFIX}owner-${stamp}@p40.test`;
    const emailB = `${USER_PREFIX}ownerb-${stamp}@p40.test`;
    const emailV = `${USER_PREFIX}viewer-${stamp}@p40.test`;
    await register(ownerA, "P40 Owner A", emailA, "10.40.1.1");
    await register(ownerB, "P40 Owner B", emailB, "10.40.1.2");
    await register(viewer, "P40 Viewer", emailV, "10.40.1.3");
    await login(ownerA, emailA);
    await login(ownerB, emailB);
    await login(viewer, emailV);

    const bizA = (await ownerA("/api/v1/businesses", { method: "POST", body: JSON.stringify({ name: `${TAG}-BIZ-A`, currencyCode: "USD", timezone: "Asia/Tehran" }) })).body?.data?.business;
    const bizB = (await ownerB("/api/v1/businesses", { method: "POST", body: JSON.stringify({ name: `${TAG}-BIZ-B`, currencyCode: "EUR", timezone: "Europe/Berlin" }) })).body?.data?.business;
    ok("F1. business A created", Boolean(bizA?.id));
    ok("F2. business B created", Boolean(bizB?.id));
    if (!bizA?.id || !bizB?.id) throw new Error("business fixture failed");

    const memberRes = await ownerA(`/api/v1/businesses/${bizA.id}/members`, { method: "POST", headers: { "x-business-id": bizA.id }, body: JSON.stringify({ email: emailV, role: "VIEWER" }) });
    ok("F3. VIEWER member added to business A", memberRes.status === 201 || memberRes.status === 200, JSON.stringify(memberRes.body?.error ?? ""));
    if (memberRes.status !== 201 && memberRes.status !== 200) throw new Error("VIEWER member setup failed");

    const wb = (f, bizId) => (path, init = {}) => f(path, { ...init, headers: { ...(init.headers ?? {}), "x-business-id": bizId } });
    const A = wb(ownerA, bizA.id);
    const B = wb(ownerB, bizB.id);
    const V = wb(viewer, bizA.id);

    // Products in A: create with initial stock via POST /api/v1/products
    // {stockQty} (field verified in src/app/api/v1/products/route.ts — the
    // create schema accepts stockQty and writes an "initial stock" adjustment).
    const pA = await createProduct(A, bizA.id, "P40-A", 10);
    const pB = await createProduct(A, bizA.id, "P40-B", 20);
    const pC = await createProduct(A, bizA.id, "P40-C", 30);
    const pInact = await createProduct(A, bizA.id, "P40-INACT", 9);
    const pDel = await createProduct(A, bizA.id, "P40-DEL", 6);
    const pStale = await createProduct(A, bizA.id, "P40-STALE", 20);
    const pK1 = await createProduct(A, bizA.id, "P40-K1", 10);
    const pK2 = await createProduct(A, bizA.id, "P40-K2", 20);
    const pK3 = await createProduct(A, bizA.id, "P40-K3", 30);
    const pDeact = await createProduct(A, bizA.id, "P40-DEACT", 7);
    const pBP = await createProduct(B, bizB.id, "P40-BP", 5); // foreign tenant product
    const patchInact = await A(`/api/v1/products/${pInact.id}`, { method: "PATCH", body: JSON.stringify({ isActive: false }) });
    ok("F4. products created with exact initial stock (A=10,B=20,C=30,…)", (await stockOf(pA.id)).stockQty === 10 && (await stockOf(pB.id)).stockQty === 20 && (await stockOf(pC.id)).stockQty === 30 && (await stockOf(pDel.id)).stockQty === 6 && (await stockOf(pStale.id)).stockQty === 20 && (await stockOf(pK1.id)).stockQty === 10 && (await stockOf(pK2.id)).stockQty === 20 && (await stockOf(pK3.id)).stockQty === 30 && (await stockOf(pDeact.id)).stockQty === 7 && (await stockOf(pBP.id)).stockQty === 5);
    ok("F5. P40-INACT deactivated via PATCH isActive:false", patchInact.status === 200 && (await stockOf(pInact.id)).isActive === false);

    // RBAC fixture stocktake (DRAFT, 1 line) — used by scenario A.
    const stRbac = await createStocktake(A, bizA.id, refOf("P40-ST-RBAC"));
    const stRbacLine = await addLine(A, bizA.id, stRbac.id, pA.id);
    ok("F6. RBAC fixture stocktake DRAFT with 1 line", stRbac.id && stRbac.status === "DRAFT" && stRbacLine.id && stRbacLine.productId === pA.id);

    const aSts = [stRbac]; // every stocktake created in business A (for from/to + AA)
    const allSts = [stRbac]; // both businesses (for line cleanup assertions)
    const ownerAId = (await db.user.findUnique({ where: { email: emailA }, select: { id: true } }))?.id;
    const st001Ref = refOf("P40-ST-001");

    // ===== A. auth + RBAC ===================================================
    section("A auth + RBAC");
    ok("A1. unauthenticated GET list → 401", (await anon("/api/v1/inventory/stocktakes")).status === 401);
    const vList = await retryRead(() => V("/api/v1/inventory/stocktakes"));
    ok("A2. VIEWER GET list → 200", vList.status === 200 && Array.isArray(vList.body?.data?.items));
    const vDetail = await detail(V, bizA.id, stRbac.id);
    ok("A3. VIEWER GET detail → 200", vDetail.status === 200 && vDetail.body?.data?.id === stRbac.id);
    const vCreate = await V("/api/v1/inventory/stocktakes", { method: "POST", body: JSON.stringify({ reference: "P40-VIEWER-NOPE" }) });
    ok("A4. VIEWER create → 403", vCreate.status === 403, `got ${vCreate.status}`);
    ok("A5. VIEWER start → 403", (await V(`/api/v1/inventory/stocktakes/${stRbac.id}/start`, { method: "POST" })).status === 403);
    ok("A6. VIEWER count → 403", (await V(`/api/v1/inventory/stocktakes/${stRbac.id}/lines/${stRbacLine.id}/count`, { method: "POST", body: JSON.stringify({ countedQty: 1 }) })).status === 403);
    ok("A7. VIEWER review → 403", (await V(`/api/v1/inventory/stocktakes/${stRbac.id}/review`, { method: "POST" })).status === 403);
    ok("A8. VIEWER finalize → 403", (await V(`/api/v1/inventory/stocktakes/${stRbac.id}/finalize`, { method: "POST" })).status === 403);
    ok("A9. VIEWER cancel → 403", (await V(`/api/v1/inventory/stocktakes/${stRbac.id}/cancel`, { method: "POST" })).status === 403);
    ok("A10. VIEWER add line → 403", (await V(`/api/v1/inventory/stocktakes/${stRbac.id}/lines`, { method: "POST", body: JSON.stringify({ productId: pA.id }) })).status === 403);
    ok("A11. VIEWER remove line → 403", (await V(`/api/v1/inventory/stocktakes/${stRbac.id}/lines/${stRbacLine.id}`, { method: "DELETE" })).status === 403);
    ok("A12. stocktake untouched by viewer attempts (still DRAFT)", (await detail(A, bizA.id, stRbac.id)).body?.data?.status === "DRAFT");

    // ===== B. create ========================================================
    section("B create");
    const st001 = await createStocktake(A, bizA.id, st001Ref, "P40 E2E ST-001 notes");
    aSts.push(st001); allSts.push(st001);
    ok("B1. valid create → 201 {id, reference, status:DRAFT}", st001.id && st001.reference === st001Ref && st001.status === "DRAFT");
    ok("B2. reference 1-char → 422", (await A("/api/v1/inventory/stocktakes", { method: "POST", body: JSON.stringify({ reference: "x" }) })).status === 422);
    ok("B3. reference 81-char → 422", (await A("/api/v1/inventory/stocktakes", { method: "POST", body: JSON.stringify({ reference: "x".repeat(81) }) })).status === 422);
    const dup = await A("/api/v1/inventory/stocktakes", { method: "POST", body: JSON.stringify({ reference: st001Ref }) });
    ok("B4. duplicate reference → 409 DUPLICATE_REFERENCE", dup.status === 409 && dup.body?.error?.code === "DUPLICATE_REFERENCE", JSON.stringify(dup.body?.error ?? ""));
    ok("B5. countType FULL → 422 (SELECTED is the only type)", (await A("/api/v1/inventory/stocktakes", { method: "POST", body: JSON.stringify({ reference: refOf("P40-ST-FULL"), countType: "FULL" }) })).status === 422);

    // ===== C. add lines =====================================================
    section("C add lines");
    const lineA = await addLine(A, bizA.id, st001.id, pA.id);
    const lineB = await addLine(A, bizA.id, st001.id, pB.id);
    const lineC = await addLine(A, bizA.id, st001.id, pC.id);
    const d3 = (await detail(A, bizA.id, st001.id)).body?.data;
    ok("C1. add A/B/C → 3 lines", d3?.linesPage?.total === 3 && d3?.lines?.length === 3 && d3?.summary?.lineCount === 3);
    ok("C2. uncounted lines expose null count fields (epoch-0 sentinel)", d3?.lines?.every((l) => l.countedQty === null && l.varianceQty === null && l.countedAt === null && l.countedBy === null));
    const dupLine = await A(`/api/v1/inventory/stocktakes/${st001.id}/lines`, { method: "POST", body: JSON.stringify({ productId: pA.id }) });
    ok("C3. add A again → 409 DUPLICATE_STOCKTAKE_PRODUCT", dupLine.status === 409 && dupLine.body?.error?.code === "DUPLICATE_STOCKTAKE_PRODUCT", JSON.stringify(dupLine.body?.error ?? ""));
    ok("C4. add business-B product → 404 (no existence leak)", (await A(`/api/v1/inventory/stocktakes/${st001.id}/lines`, { method: "POST", body: JSON.stringify({ productId: pBP.id }) })).status === 404);
    const inactAdd = await A(`/api/v1/inventory/stocktakes/${st001.id}/lines`, { method: "POST", body: JSON.stringify({ productId: pInact.id }) });
    ok("C5. add inactive product → 422 STOCKTAKE_PRODUCT_INACTIVE", inactAdd.status === 422 && inactAdd.body?.error?.code === "STOCKTAKE_PRODUCT_INACTIVE", JSON.stringify(inactAdd.body?.error ?? ""));

    // ===== D. start =========================================================
    section("D start");
    const stEmpty = await createStocktake(A, bizA.id, refOf("P40-ST-EMPTY"));
    aSts.push(stEmpty); allSts.push(stEmpty);
    const emptyStart = await A(`/api/v1/inventory/stocktakes/${stEmpty.id}/start`, { method: "POST" });
    ok("D1. zero-line stocktake start → 422 INVALID_STOCKTAKE_TRANSITION", emptyStart.status === 422 && emptyStart.body?.error?.code === "INVALID_STOCKTAKE_TRANSITION", JSON.stringify(emptyStart.body?.error ?? ""));
    const started = await transition(A, bizA.id, st001.id, "start");
    ok("D2. start with lines → 200 COUNTING", started.status === "COUNTING");
    ok("D3. startedAt set on detail", Boolean((await detail(A, bizA.id, st001.id)).body?.data?.startedAt));

    // ===== E. line add after start ==========================================
    section("E line mutation after start");
    const lateAdd = await A(`/api/v1/inventory/stocktakes/${st001.id}/lines`, { method: "POST", body: JSON.stringify({ productId: pDel.id }) });
    ok("E1. add line after start → 422 INVALID_STOCKTAKE_TRANSITION", lateAdd.status === 422 && lateAdd.body?.error?.code === "INVALID_STOCKTAKE_TRANSITION", JSON.stringify(lateAdd.body?.error ?? ""));
    const lateRemove = await A(`/api/v1/inventory/stocktakes/${st001.id}/lines/${lineC.id}`, { method: "DELETE" });
    ok("E2. remove line after start → 422 INVALID_STOCKTAKE_TRANSITION", lateRemove.status === 422 && lateRemove.body?.error?.code === "INVALID_STOCKTAKE_TRANSITION");

    // ===== F. count =========================================================
    section("F count");
    const cA = await countLine(A, bizA.id, st001.id, lineA.id, 10);
    const cB = await countLine(A, bizA.id, st001.id, lineB.id, 18);
    const cC = await countLine(A, bizA.id, st001.id, lineC.id, 35);
    ok("F1. count A=10 → server snapshot systemQtyAtCount=10, variance 0", cA.systemQtyAtCount === 10 && cA.varianceQty === 0 && cA.countedQty === 10, JSON.stringify(cA));
    ok("F2. count B=18 → snapshot 20, variance -2", cB.systemQtyAtCount === 20 && cB.varianceQty === -2, JSON.stringify(cB));
    ok("F3. count C=35 → snapshot 30, variance +5", cC.systemQtyAtCount === 30 && cC.varianceQty === 5, JSON.stringify(cC));
    ok("F4. countedQty -1 → 422", (await A(`/api/v1/inventory/stocktakes/${st001.id}/lines/${lineA.id}/count`, { method: "POST", body: JSON.stringify({ countedQty: -1 }) })).status === 422);
    ok("F5. countedQty 1.5 → 422 (integer only)", (await A(`/api/v1/inventory/stocktakes/${st001.id}/lines/${lineA.id}/count`, { method: "POST", body: JSON.stringify({ countedQty: 1.5 }) })).status === 422);
    ok("F6. countedQty 1000000001 → 422 (max 1e9)", (await A(`/api/v1/inventory/stocktakes/${st001.id}/lines/${lineA.id}/count`, { method: "POST", body: JSON.stringify({ countedQty: 1000000001 }) })).status === 422);
    ok("F7. countedQty null → 422", (await A(`/api/v1/inventory/stocktakes/${st001.id}/lines/${lineA.id}/count`, { method: "POST", body: JSON.stringify({ countedQty: null }) })).status === 422);
    const dCounted = (await detail(A, bizA.id, st001.id)).body?.data;
    const lA = dCounted?.lines?.find((l) => l.productId === pA.id);
    ok("F8. countedAt/countedBy set in detail (owner A)", Boolean(lA?.countedAt) && lA?.countedBy?.id === ownerAId && lA?.productNameAtCount === "P40-A");

    // ===== G. review gating =================================================
    section("G review gating");
    const stPartial = await createStocktake(A, bizA.id, refOf("P40-ST-PARTIAL"));
    aSts.push(stPartial); allSts.push(stPartial);
    const pLine = await addLine(A, bizA.id, stPartial.id, pA.id);
    await transition(A, bizA.id, stPartial.id, "start");
    const earlyReview = await A(`/api/v1/inventory/stocktakes/${stPartial.id}/review`, { method: "POST" });
    ok("G1. review before all counted → 422 INVALID_STOCKTAKE_TRANSITION", earlyReview.status === 422 && earlyReview.body?.error?.code === "INVALID_STOCKTAKE_TRANSITION", JSON.stringify(earlyReview.body?.error ?? ""));
    await countLine(A, bizA.id, stPartial.id, pLine.id, 10);
    const reviewed = await transition(A, bizA.id, stPartial.id, "review");
    ok("G2. count the line then review → 200 REVIEW", reviewed.status === "REVIEW");
    ok("G3. reviewedAt set", Boolean((await detail(A, bizA.id, stPartial.id)).body?.data?.reviewedAt));

    // ===== H. summary =======================================================
    section("H summary (ST-001 after counts)");
    const s1 = (await detail(A, bizA.id, st001.id)).body?.data?.summary;
    ok("H1. lineCount 3, counted 3, pending 0", s1?.lineCount === 3 && s1?.countedLineCount === 3 && s1?.pendingLineCount === 0, JSON.stringify(s1));
    ok("H2. positive 1, negative 1, zero 1", s1?.positiveVarianceLineCount === 1 && s1?.negativeVarianceLineCount === 1 && s1?.zeroVarianceLineCount === 1);
    ok("H3. increase 5, decrease 2, net 3 (EXACT)", s1?.increaseVarianceUnits === 5 && s1?.decreaseVarianceUnits === 2 && s1?.netVarianceUnits === 3);

    // ===== I. stale count ===================================================
    section("I stale count");
    const stStale = await createStocktake(A, bizA.id, refOf("P40-ST-STALE"));
    aSts.push(stStale); allSts.push(stStale);
    const sLine = await addLine(A, bizA.id, stStale.id, pStale.id);
    await transition(A, bizA.id, stStale.id, "start");
    const staleCount = await countLine(A, bizA.id, stStale.id, sLine.id, 18);
    ok("I1. count 18 → snapshot 20, variance -2", staleCount.systemQtyAtCount === 20 && staleCount.varianceQty === -2, JSON.stringify(staleCount));
    // Task arithmetic note: "adjust the product to 19 ... currentQty=19" from
    // stock 20 requires delta -1 (a +1 would give 21 and break every later
    // 19/-1 assertion). Same reason string as specified.
    await A(`/api/v1/products/${pStale.id}/stock`, { method: "POST", body: JSON.stringify({ delta: -1, reason: "P40 stale setup" }) });
    ok("I2. product adjusted to 19 after counting", (await stockOf(pStale.id)).stockQty === 19);
    await transition(A, bizA.id, stStale.id, "review");
    const staleFin = await A(`/api/v1/inventory/stocktakes/${stStale.id}/finalize`, { method: "POST" });
    ok("I3. finalize → 409 STOCKTAKE_STALE_COUNT", staleFin.status === 409 && staleFin.body?.error?.code === "STOCKTAKE_STALE_COUNT", JSON.stringify(staleFin.body?.error ?? ""));
    const staleP = staleFin.body?.error?.details?.products?.[0];
    ok("I4. details.products[0] exact {lineId, productId, productName, 20 vs 19, STALE}", staleP?.lineId === sLine.id && staleP?.productId === pStale.id && staleP?.productName === "P40-STALE" && staleP?.systemQtyAtCount === 20 && staleP?.currentQty === 19 && staleP?.kind === "STALE", JSON.stringify(staleP));
    ok("I5. product stays 19 (no auto-rebase)", (await stockOf(pStale.id)).stockQty === 19);
    ok("I6. stocktake stays REVIEW", (await detail(A, bizA.id, stStale.id)).body?.data?.status === "REVIEW");

    // ===== J. recount + finalize ============================================
    section("J recount");
    await transition(A, bizA.id, stStale.id, "reopen"); // REVIEW → COUNTING
    const recount = await countLine(A, bizA.id, stStale.id, sLine.id, 18);
    ok("J1. recount snapshots NEW system 19, variance -1 (replaces in place)", recount.systemQtyAtCount === 19 && recount.varianceQty === -1 && recount.countedQty === 18, JSON.stringify(recount));
    await transition(A, bizA.id, stStale.id, "review");
    const staleFin2 = await transition(A, bizA.id, stStale.id, "finalize");
    ok("J2. review + finalize after recount → 200 FINALIZED", staleFin2.status === "FINALIZED");
    ok("J3. product now 18", (await stockOf(pStale.id)).stockQty === 18);
    const stAdjPattern = `Stocktake ${stStale.reference}`;
    const stAdjs = await db.inventoryAdjustment.findMany({ where: { businessId: bizA.id, reason: { startsWith: stAdjPattern } } });
    ok("J4. EXACTLY ONE reconciliation adjustment, delta -1", stAdjs.length === 1 && stAdjs[0].delta === -1 && stAdjs[0].productId === pStale.id, JSON.stringify(stAdjs.map((a) => a.delta)));
    ok("J5. stale attempt wrote NO delta -2 adjustment", stAdjs.every((a) => a.delta !== -2));
    ok("J6. adjustment actorId = owner A, businessId = A", stAdjs[0]?.actorId === ownerAId && stAdjs[0]?.businessId === bizA.id);

    // ===== K. atomic finalization ===========================================
    section("K atomic finalization");
    const stK = await createStocktake(A, bizA.id, refOf("P40-ST-K"));
    aSts.push(stK); allSts.push(stK);
    const kLine1 = await addLine(A, bizA.id, stK.id, pK1.id);
    const kLine2 = await addLine(A, bizA.id, stK.id, pK2.id);
    const kLine3 = await addLine(A, bizA.id, stK.id, pK3.id);
    await transition(A, bizA.id, stK.id, "start");
    await countLine(A, bizA.id, stK.id, kLine1.id, 10);
    await countLine(A, bizA.id, stK.id, kLine2.id, 20);
    await countLine(A, bizA.id, stK.id, kLine3.id, 30);
    await transition(A, bizA.id, stK.id, "review");
    await A(`/api/v1/products/${pK1.id}/stock`, { method: "POST", body: JSON.stringify({ delta: 1, reason: "P40 stale setup" }) });
    const kFin = await A(`/api/v1/inventory/stocktakes/${stK.id}/finalize`, { method: "POST" });
    ok("K1. finalize with 1 stale of 3 lines → 409 STOCKTAKE_STALE_COUNT", kFin.status === 409 && kFin.body?.error?.code === "STOCKTAKE_STALE_COUNT", JSON.stringify(kFin.body?.error ?? ""));
    const kStale = kFin.body?.error?.details?.products ?? [];
    ok("K2. exactly one stale entry (K1, currentQty 11)", kStale.length === 1 && kStale[0].productId === pK1.id && kStale[0].currentQty === 11 && kStale[0].systemQtyAtCount === 10 && kStale[0].kind === "STALE", JSON.stringify(kStale));
    ok("K3. other two products NOT changed (20/20… 20/30 exact)", (await stockOf(pK2.id)).stockQty === 20 && (await stockOf(pK3.id)).stockQty === 30);
    ok("K4. NO InventoryAdjustment rows for the stocktake reason", (await db.inventoryAdjustment.count({ where: { businessId: bizA.id, reason: { startsWith: `Stocktake ${stK.reference}` } } })) === 0);
    ok("K5. stocktake still REVIEW (no partial finalization)", (await detail(A, bizA.id, stK.id)).body?.data?.status === "REVIEW");

    // ===== L. finalize happy path (capture financial counts first) ==========
    section("L finalize ST-001");
    await transition(A, bizA.id, st001.id, "review"); // COUNTING → REVIEW (finalize precondition)
    const finBefore = {
      sales: await db.sale.count(),
      expenses: await db.expense.count(),
      payments: await db.payment.count(),
      customers: await db.customer.count(),
      suppliers: await db.supplier.count(),
    };
    const fin1 = await transition(A, bizA.id, st001.id, "finalize");
    ok("L1. finalize → 200 FINALIZED (+finalizedAt)", fin1.status === "FINALIZED" && Boolean((await detail(A, bizA.id, st001.id)).body?.data?.finalizedAt));
    ok("L2. stock after: A=10, B=18, C=35 EXACT", (await stockOf(pA.id)).stockQty === 10 && (await stockOf(pB.id)).stockQty === 18 && (await stockOf(pC.id)).stockQty === 35);
    const adjs1 = await db.inventoryAdjustment.findMany({ where: { businessId: bizA.id, reason: { startsWith: `Stocktake ${st001Ref}` } } });
    ok("L3. exactly 2 adjustments carry the ST-001 reason", adjs1.length === 2, `got ${adjs1.length}`);
    ok("L4. B delta -2, C delta +5, A none", adjs1.some((a) => a.productId === pB.id && a.delta === -2) && adjs1.some((a) => a.productId === pC.id && a.delta === 5) && !adjs1.some((a) => a.productId === pA.id));
    ok("L5. adjustment actorId = owner A, businessId = A", adjs1.every((a) => a.actorId === ownerAId && a.businessId === bizA.id));

    // ===== M. finalized immutability ========================================
    section("M finalized immutability");
    const mCount = await A(`/api/v1/inventory/stocktakes/${st001.id}/lines/${lineA.id}/count`, { method: "POST", body: JSON.stringify({ countedQty: 10 }) });
    ok("M1. count on FINALIZED → 422 INVALID_STOCKTAKE_TRANSITION", mCount.status === 422 && mCount.body?.error?.code === "INVALID_STOCKTAKE_TRANSITION", JSON.stringify(mCount.body?.error ?? ""));
    ok("M2. add line on FINALIZED → 422", (await A(`/api/v1/inventory/stocktakes/${st001.id}/lines`, { method: "POST", body: JSON.stringify({ productId: pA.id }) })).status === 422);
    ok("M3. remove line on FINALIZED → 422", (await A(`/api/v1/inventory/stocktakes/${st001.id}/lines/${lineA.id}`, { method: "DELETE" })).status === 422);
    ok("M4. cancel FINALIZED → 422", (await A(`/api/v1/inventory/stocktakes/${st001.id}/cancel`, { method: "POST" })).status === 422);
    ok("M5. PATCH edit FINALIZED → 422", (await A(`/api/v1/inventory/stocktakes/${st001.id}`, { method: "PATCH", body: JSON.stringify({ notes: "nope" }) })).status === 422);
    ok("M6. finalize again → 422 (terminal)", (await A(`/api/v1/inventory/stocktakes/${st001.id}/finalize`, { method: "POST" })).status === 422);

    // ===== N. cancel ========================================================
    section("N cancel");
    const stCancel = await createStocktake(A, bizA.id, refOf("P40-ST-CANCEL"));
    aSts.push(stCancel); allSts.push(stCancel);
    const cancelled = await transition(A, bizA.id, stCancel.id, "cancel");
    ok("N1. cancel DRAFT → 200 CANCELLED", cancelled.status === "CANCELLED");
    ok("N2. canceledAt set on detail", Boolean((await detail(A, bizA.id, stCancel.id)).body?.data?.canceledAt));
    ok("N3. stock unchanged by cancel (A=10)", (await stockOf(pA.id)).stockQty === 10);
    ok("N4. finalize CANCELLED → 422", (await A(`/api/v1/inventory/stocktakes/${stCancel.id}/finalize`, { method: "POST" })).status === 422);
    ok("N5. cancel again → 422 (terminal)", (await A(`/api/v1/inventory/stocktakes/${stCancel.id}/cancel`, { method: "POST" })).status === 422);
    ok("N6. count CANCELLED → 422", (await A(`/api/v1/inventory/stocktakes/${stCancel.id}/lines/x/count`, { method: "POST", body: JSON.stringify({ countedQty: 1 }) })).status === 422);

    // ===== O. foreign tenant ================================================
    section("O foreign tenant");
    const stB = await createStocktake(B, bizB.id, refOf("P40-BIZB-ST"));
    allSts.push(stB);
    ok("O1. A requests B's stocktake detail → 404", (await detail(A, bizA.id, stB.id)).status === 404);
    ok("O2. A transitions B's stocktake → 404", (await A(`/api/v1/inventory/stocktakes/${stB.id}/start`, { method: "POST" })).status === 404);

    // ===== P. deleted product after count ===================================
    section("P deleted product after count");
    const stDel = await createStocktake(A, bizA.id, refOf("P40-ST-DEL"));
    aSts.push(stDel); allSts.push(stDel);
    const delLine = await addLine(A, bizA.id, stDel.id, pDel.id);
    await transition(A, bizA.id, stDel.id, "start");
    const delCount = await countLine(A, bizA.id, stDel.id, delLine.id, 6);
    ok("P1. count P40-DEL → snapshot 6, variance 0", delCount.systemQtyAtCount === 6 && delCount.varianceQty === 0);
    ok("P2. soft-delete product via DELETE /api/v1/products/[id] → 200", (await A(`/api/v1/products/${pDel.id}`, { method: "DELETE" })).status === 200);
    await transition(A, bizA.id, stDel.id, "review"); // COUNTING → REVIEW (finalize precondition)
    const delFin = await A(`/api/v1/inventory/stocktakes/${stDel.id}/finalize`, { method: "POST" });
    ok("P3. finalize → 409 (deleted product rejected)", delFin.status === 409 && (delFin.body?.error?.code === "STOCKTAKE_STALE_COUNT" || delFin.body?.error?.code === "STOCKTAKE_PRODUCT_INACTIVE"), JSON.stringify(delFin.body?.error ?? ""));
    ok("P4. deleted product stock unchanged (6)", (await stockOf(pDel.id)).stockQty === 6);

    // ===== Q. inactive product after count ==================================
    section("Q inactive product after count");
    // NOTE: inactive products cannot be COUNTED (422), so the deactivation is
    // applied AFTER counting a dedicated active product (P40-DEACT) — the
    // task's "add P40-DEL to ST-DEL2" is impossible once P has soft-deleted it.
    const stDel2 = await createStocktake(A, bizA.id, refOf("P40-ST-DEL2"));
    aSts.push(stDel2); allSts.push(stDel2);
    const deactLine = await addLine(A, bizA.id, stDel2.id, pDeact.id);
    await transition(A, bizA.id, stDel2.id, "start");
    await countLine(A, bizA.id, stDel2.id, deactLine.id, 7);
    ok("Q1. count active product → 200 (snapshot 7)", (await detail(A, bizA.id, stDel2.id)).body?.data?.lines?.[0]?.systemQtyAtCount === 7);
    ok("Q2. PATCH isActive:false after count → 200", (await A(`/api/v1/products/${pDeact.id}`, { method: "PATCH", body: JSON.stringify({ isActive: false }) })).status === 200);
    await transition(A, bizA.id, stDel2.id, "review"); // COUNTING → REVIEW (finalize precondition)
    const deactFin = await A(`/api/v1/inventory/stocktakes/${stDel2.id}/finalize`, { method: "POST" });
    ok("Q3. finalize → 409 STOCKTAKE_PRODUCT_INACTIVE", deactFin.status === 409 && deactFin.body?.error?.code === "STOCKTAKE_PRODUCT_INACTIVE", JSON.stringify(deactFin.body?.error ?? ""));
    ok("Q4. product stock unchanged (7)", (await stockOf(pDeact.id)).stockQty === 7, JSON.stringify(await stockOf(pDeact.id)));

    // ===== U. PATCH draft edit (before R so status filters are settled) =====
    section("U PATCH draft edit");
    const stEdit = await createStocktake(A, bizA.id, refOf("P40-ST-EDIT"));
    aSts.push(stEdit); allSts.push(stEdit);
    const editRes = await A(`/api/v1/inventory/stocktakes/${stEdit.id}`, { method: "PATCH", body: JSON.stringify({ notes: "P40 edited notes" }) });
    ok("U1. DRAFT PATCH notes → 200", editRes.status === 200 && editRes.body?.data?.notes === "P40 edited notes", JSON.stringify(editRes.body ?? ""));
    ok("U2. detail carries edited notes", (await detail(A, bizA.id, stEdit.id)).body?.data?.notes === "P40 edited notes");
    ok("U3. PATCH {status:FINALIZED} → 422 (status never client input)", (await A(`/api/v1/inventory/stocktakes/${stEdit.id}`, { method: "PATCH", body: JSON.stringify({ status: "FINALIZED" }) })).status === 422);
    ok("U4. status stays DRAFT", (await detail(A, bizA.id, stEdit.id)).body?.data?.status === "DRAFT");

    // ===== V. reopen ========================================================
    section("V reopen");
    await transition(A, bizA.id, stPartial.id, "reopen");
    ok("V1. REVIEW → reopen → COUNTING", (await detail(A, bizA.id, stPartial.id)).body?.data?.status === "COUNTING");
    await transition(A, bizA.id, stPartial.id, "review");
    const vFin = await transition(A, bizA.id, stPartial.id, "finalize");
    ok("V2. review again + finalize → 200 FINALIZED", vFin.status === "FINALIZED");
    ok("V3. zero-variance finalize changed nothing (A=10, no adjustment)", (await stockOf(pA.id)).stockQty === 10 && (await db.inventoryAdjustment.count({ where: { businessId: bizA.id, reason: { startsWith: `Stocktake ${stPartial.reference}` } } })) === 0);

    // ===== R. list filters + pagination =====================================
    section("R list");
    const q1 = await retryRead(() => A(`/api/v1/inventory/stocktakes?q=${encodeURIComponent("P40-ST-001")}`));
    const q1d = q1.body?.data;
    const LIST_KEYS = ["id", "reference", "status", "countType", "lineCount", "countedLineCount", "netVarianceUnits", "createdAt", "createdBy"];
    ok("R1. q=reference-contains → exactly ST-001, exact DTO key set, countType SELECTED", q1d?.total === 1 && q1d?.items?.[0]?.id === st001.id && q1d?.items?.[0]?.reference === st001Ref && Object.keys(q1d.items[0]).sort().join() === [...LIST_KEYS].sort().join() && q1d.items[0].countType === "SELECTED", JSON.stringify(q1d?.items?.[0]));
    const qFin = await retryRead(() => A("/api/v1/inventory/stocktakes?status=FINALIZED&pageSize=100"));
    const finIds = new Set((qFin.body?.data?.items ?? []).map((i) => i.id));
    ok("R2. status=FINALIZED → exactly ST-001 + ST-STALE + ST-PARTIAL", qFin.body?.data?.total === 3 && finIds.has(st001.id) && finIds.has(stStale.id) && finIds.has(stPartial.id) && (qFin.body?.data?.items ?? []).every((i) => i.status === "FINALIZED"), `total ${qFin.body?.data?.total}`);
    const qToday = await retryRead(() => A(`/api/v1/inventory/stocktakes?from=${today()}&to=${today()}&pageSize=100`));
    ok("R3. from/to = today → every fixture stocktake, nothing else", qToday.body?.data?.total === aSts.length && (qToday.body?.data?.items ?? []).every((i) => aSts.some((s) => s.id === i.id)), `total ${qToday.body?.data?.total} expected ${aSts.length}`);
    const qFuture = await retryRead(() => A(`/api/v1/inventory/stocktakes?from=2030-01-01&to=2030-12-31`));
    ok("R4. future window → 0 rows", qFuture.body?.data?.total === 0);
    ok("R5. from=2026-02-31 → 422 (strict calendar date)", (await A(`/api/v1/inventory/stocktakes?from=2026-02-31`)).status === 422);
    ok("R6. from>to → 422", (await A(`/api/v1/inventory/stocktakes?from=2030-01-31&to=2030-01-01`)).status === 422);
    // pagination: 6 dedicated stocktakes, pageSize=2 → 3 exact pages
    const ppRefs = [];
    for (let i = 1; i <= 6; i++) {
      const pp = await createStocktake(A, bizA.id, refOf(`P40-PP-${i}`));
      aSts.push(pp); allSts.push(pp);
      ppRefs.push(pp.id);
    }
    const pageIds = [];
    for (let p = 1; p <= 3; p++) {
      const pg = await retryRead(() => A(`/api/v1/inventory/stocktakes?q=${encodeURIComponent("P40-PP")}&page=${p}&pageSize=2`));
      pageIds.push(...(pg.body?.data?.items ?? []).map((i) => i.id));
      if (p === 1) ok("R7a. total 6 across pages", pg.body?.data?.total === 6, `got ${pg.body?.data?.total}`);
      else ok(`R7${["b", "c"][p - 2]}. page ${p} has exactly 2 rows`, (pg.body?.data?.items ?? []).length === 2);
    }
    const page4 = await retryRead(() => A(`/api/v1/inventory/stocktakes?q=${encodeURIComponent("P40-PP")}&page=4&pageSize=2`));
    ok("R7d. 3 pages exact — no duplicates, no missing, page 4 empty", new Set(pageIds).size === 6 && ppRefs.every((id) => pageIds.includes(id)) && (page4.body?.data?.items ?? []).length === 0);

    // ===== S. detail line pagination ========================================
    section("S detail line pagination");
    const stPag = await createStocktake(A, bizA.id, refOf("P40-ST-PAG"));
    aSts.push(stPag); allSts.push(stPag);
    for (const p of [pA, pB, pC, pStale]) await addLine(A, bizA.id, stPag.id, p.id);
    const pag1 = await detail(A, bizA.id, stPag.id, "?page=1&pageSize=2");
    const pag2 = await detail(A, bizA.id, stPag.id, "?page=2&pageSize=2");
    const pagAll = await detail(A, bizA.id, stPag.id, "?pageSize=100");
    const p1ids = (pag1.body?.data?.lines ?? []).map((l) => l.id);
    const p2ids = (pag2.body?.data?.lines ?? []).map((l) => l.id);
    const allIds = (pagAll.body?.data?.lines ?? []).map((l) => l.id);
    ok("S1. page 1 → 2 lines, linesPage.total 4", p1ids.length === 2 && pag1.body?.data?.linesPage?.total === 4 && pag1.body?.data?.linesPage?.pageSize === 2);
    ok("S2. page 2 → 2 lines", p2ids.length === 2);
    ok("S3. 2 pages = 2+2, no duplicates, no missing (vs full fetch)", new Set([...p1ids, ...p2ids]).size === 4 && [...p1ids, ...p2ids].sort().join() === [...allIds].sort().join());

    // ===== T. bounded page size (line-cap note) =============================
    section("T bounded page size");
    // Live line-cap test SKIPPED by design: the cap needs the
    // INVENTORY_STOCKTAKE_MAX_LINES env on a server we must not restart with
    // overridden env (single shared dev server). The cap code path is
    // unit-covered (prompt40-unit.ts §16); here we assert the documented
    // pagination caps instead.
    ok("T1. list pageSize=101 → 422 (max 100)", (await A("/api/v1/inventory/stocktakes?pageSize=101")).status === 422);
    ok("T2. detail lines pageSize=101 → 422 (max 100)", (await detail(A, bizA.id, stPag.id, "?pageSize=101")).status === 422);

    // ===== W/X. financial non-interference ==================================
    section("W/X financial non-interference");
    const finAfter = {
      sales: await db.sale.count(),
      expenses: await db.expense.count(),
      payments: await db.payment.count(),
      customers: await db.customer.count(),
      suppliers: await db.supplier.count(),
    };
    ok("W1. sale rows unchanged by stocktake finalization", finAfter.sales === finBefore.sales);
    ok("W2. expense rows unchanged", finAfter.expenses === finBefore.expenses);
    ok("W3. payment rows unchanged", finAfter.payments === finBefore.payments);
    ok("W4. customer/supplier rows unchanged", finAfter.customers === finBefore.customers && finAfter.suppliers === finBefore.suppliers);
    ok("X1. statement sources (Sale/Expense/Payment) EXACT unchanged", finAfter.sales === finBefore.sales && finAfter.expenses === finBefore.expenses && finAfter.payments === finBefore.payments);

    // ===== Y. audit =========================================================
    section("Y audit");
    const stAuditActions = new Set(
      (await db.auditLog.findMany({ where: { businessId: bizA.id, action: { startsWith: "inventory.stocktake." } }, select: { action: true } })).map((r) => r.action),
    );
    const required = [
      "inventory.stocktake.create",
      "inventory.stocktake.start",
      "inventory.stocktake.line_add",
      "inventory.stocktake.count",
      "inventory.stocktake.recount", // from J
      "inventory.stocktake.review",
      "inventory.stocktake.reopen",
      "inventory.stocktake.finalize",
      "inventory.stocktake.cancel", // from N
    ];
    ok("Y1. all 9 lifecycle audit actions present", required.every((a) => stAuditActions.has(a)), `missing: ${required.filter((a) => !stAuditActions.has(a)).join(",")}`);
    ok("Y2. recount audit bound to ST-STALE", (await db.auditLog.count({ where: { businessId: bizA.id, action: "inventory.stocktake.recount", entityId: stStale.id } })) === 1);
    const auditBefore = await db.auditLog.count({ where: { businessId: bizA.id, action: { startsWith: "inventory.stocktake." } } });
    await retryRead(() => A("/api/v1/inventory/stocktakes?pageSize=5"));
    await detail(A, bizA.id, st001.id);
    const auditAfter = await db.auditLog.count({ where: { businessId: bizA.id, action: { startsWith: "inventory.stocktake." } } });
    ok("Y3. GET list+detail write NO audit rows", auditBefore === auditAfter);

    // ===== Z. sensitive DTO =================================================
    section("Z sensitive DTO");
    {
      const det = (await detail(A, bizA.id, st001.id)).body?.data;
      const raw = JSON.stringify(det);
      const keys = [];
      (function walk(o) {
        if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { keys.push(k.toLowerCase()); walk(v); }
      })(det);
      ok("Z1. detail has NO passwordHash/session/ip/userAgent/actorIp fields", keys.every((k) => !["passwordhash", "session", "ip", "useragent", "actorip"].includes(k)) && !/"(passwordHash|session|ip|userAgent|actorIp)"\s*:/.test(raw));
    }

    // ===== AA. business switch ==============================================
    section("AA business switch");
    {
      const bList = await retryRead(() => B("/api/v1/inventory/stocktakes?pageSize=100"));
      const bRefs = (bList.body?.data?.items ?? []).map((i) => i.reference);
      const aRefs = new Set(aSts.map((s) => s.reference));
      ok("AA1. B-scoped list has NO business-A stocktakes, only B's own", (bList.body?.data?.items ?? []).every((i) => !aRefs.has(i.reference) && !aSts.some((s) => s.id === i.id)) && bRefs.includes(refOf("P40-BIZB-ST")), JSON.stringify(bRefs));
    }

    // ===== AB. export dataset rows ==========================================
    section("AB export dataset rows exist");
    {
      const stRows = await db.inventoryStocktake.count({ where: { businessId: { in: [bizA.id, bizB.id] } } });
      const lineRows = await db.inventoryStocktakeLine.count({ where: { stocktake: { businessId: { in: [bizA.id, bizB.id] } } } });
      ok("AB1. InventoryStocktake rows exist for fixtures (export dataset source)", stRows === aSts.length + 1, `got ${stRows}`);
      ok("AB2. InventoryStocktakeLine rows exist for fixtures", lineRows >= 15, `got ${lineRows}`);
    }
  } catch (error) {
    console.error("E2E crashed mid-run:", error?.message ?? error);
    ok("RUN completed without crash", false, String(error?.message ?? error));
  }

  // ===== cleanup (zero residue) =============================================
  section("CLEANUP — zero residue");
  {
    const bizIds = (await db.business.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((b) => b.id);
    const userIds = (await db.user.findMany({ where: { email: { startsWith: USER_PREFIX } }, select: { id: true } })).map((u) => u.id);
    const linesBefore = await db.inventoryStocktakeLine.count({ where: { stocktake: { businessId: { in: bizIds } } } });
    const stocktakeIds = await db.inventoryStocktake.findMany({ where: { businessId: { in: bizIds } }, select: { id: true } });

    await purgeBusinesses(bizIds, userIds);

    const residue = {
      businesses: await db.business.count({ where: { name: { startsWith: TAG } } }),
      users: await db.user.count({ where: { email: { startsWith: USER_PREFIX } } }),
      products: await db.product.count({ where: { name: { startsWith: `${TAG}-` } } }),
      stocktakes: await db.inventoryStocktake.count({ where: { reference: { startsWith: `${TAG}-` } } }),
      lines: await db.inventoryStocktakeLine.count({ where: { stocktakeId: { in: stocktakeIds.map((s) => s.id) } } }),
      adjustments: await db.inventoryAdjustment.count({ where: { reason: { startsWith: `Stocktake ${TAG}-` } } }),
      audit: await db.auditLog.count({ where: { businessId: { in: bizIds }, action: { startsWith: "inventory.stocktake." } } }),
      sessions: await db.userSession.count({ where: { userId: { in: userIds } } }),
      memberships: await db.businessMember.count({ where: { businessId: { in: bizIds } } }),
      notifications: await db.notification.count({ where: { userId: { in: userIds } } }),
    };
    ok("H1. zero P40 businesses", residue.businesses === 0);
    ok("H2. zero p40-e2e users", residue.users === 0);
    ok("H3. zero P40- products", residue.products === 0);
    ok("H4. zero P40- stocktakes", residue.stocktakes === 0);
    ok("H5. zero stocktake lines (before === deleted, 0 remain)", residue.lines === 0 && linesBefore >= 15, `before=${linesBefore} remaining=${residue.lines}`);
    ok("H6. zero 'Stocktake P40-%' adjustments", residue.adjustments === 0);
    ok("H7. zero inventory.stocktake.* audit rows", residue.audit === 0);
    ok("H8. zero sessions/memberships/notifications", residue.sessions === 0 && residue.memberships === 0 && residue.notifications === 0);
    okCleanup = true;
  }

  console.log(`\nPROMPT 40 STOCKTAKE CHECK: ${passed}/${passed + failed} ${failed === 0 ? "PASS" : "FAIL"}`);
  if (failed > 0) {
    console.error("FAILURES:");
    for (const f of failures) console.error("  - " + f);
    process.exitCode = 1;
  } else {
    console.log("E2E GREEN ✓");
  }
}

main()
  .catch((error) => {
    console.error("E2E crashed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
