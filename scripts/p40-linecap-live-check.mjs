#!/usr/bin/env node
/**
 * p40-linecap-live-check.mjs — LIVE trigger of the InventoryStocktake line
 * cap (INVENTORY_STOCKTAKE_MAX_LINES) against the RUNNING dev server.
 *
 * Closes the P40 honesty note: "Live line-cap trigger (custom env) NOT
 * exercised against the running server." Run this ONLY while the dev server
 * is started with INVENTORY_STOCKTAKE_MAX_LINES=100 (see the run recipe in
 * worklog / the round log):
 *
 *   pkill -f "next dev -p 3000"; pkill -f next-server; sleep 1
 *   INVENTORY_STOCKTAKE_MAX_LINES=100 setsid nohup bun run dev >> dev.log 2>&1 < /dev/null &
 *   node scripts/p40-linecap-live-check.mjs
 *   bash scripts/ensure-dev.sh   # restore normal server afterwards
 *
 * Scenario:
 *   A. Fixture (direct prisma, TAG "P40CAP-"): owner user + business +
 *      OWNER membership + 105 products (password testpass123, bcryptjs).
 *   B. Real NextAuth credentials login → session cookies.
 *   C. Create stocktake (API) → add lines 1..100 → ALL succeed.
 *   D. Line 101 → 422 STOCKTAKE_LINE_LIMIT_REACHED (exact §61 error code).
 *   E. Also prove the cap is the ENV value, not the default: with the
 *      default (1000) the 101st line would have succeeded — 100 lines were
 *      added and blocked exactly at 101.
 *   F. Full teardown to ZERO (fixture-owned patterns only).
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();
const BASE = process.argv[2] ?? "http://localhost:3000";
const PASS = "testpass123";
const STAMP = `${Date.now()}`;
const CAP = 100; // must match the env the server was started with

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

// --- cookie-jar fetch (house pattern) ----------------------------------------
function makeFetch(xff) {
  const jar = new Map();
  return async function f(path, init = {}) {
    const headers = { ...(init.headers ?? {}) };
    if (init.body && !headers["content-type"]) headers["content-type"] = "application/json";
    if (xff) headers["x-forwarded-for"] = xff;
    const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookieHeader) headers.cookie = cookieHeader;
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers,
      redirect: "manual",
    });
    const setCookies = [].concat(res.headers.getSetCookie?.() ?? []);
    for (const raw of setCookies) {
      const [pair] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    let body = null;
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body, headers: res.headers };
  };
}

async function cleanup() {
  // Sweep ALL fixture-owned rows by prefix pattern (any run's leftovers),
  // never just the current stamp — a crashed previous run must be recoverable.
  const users = await prisma.user.findMany({ where: { email: { contains: "@p40cap-" } } });
  for (const u of users) {
    const owned = await prisma.business.findMany({ where: { ownerId: u.id } });
    for (const b of owned) {
      await prisma.inventoryStocktakeLine.deleteMany({ where: { stocktake: { businessId: b.id } } });
      await prisma.inventoryStocktake.deleteMany({ where: { businessId: b.id } });
      await prisma.inventoryAdjustment.deleteMany({ where: { businessId: b.id } });
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
  console.log(`\nP40 LINE-CAP LIVE CHECK — target ${BASE} (expect cap=${CAP})\n`);
  if (!(await waitServer())) {
    console.error("server never became reachable — is it started with INVENTORY_STOCKTAKE_MAX_LINES=100?");
    process.exit(1);
  }

  /* A. fixture ------------------------------------------------------------- */
  const email = `owner@p40cap-${STAMP}.test`;
  const user = await prisma.user.create({
    data: {
      email,
      name: "P40 Cap Owner",
      passwordHash: bcrypt.hashSync(PASS, 10),
      emailVerifiedAt: new Date(),
    },
  });
  const business = await prisma.business.create({
    data: {
      name: `P40CAP-BIZ ${STAMP}`,
      slug: `p40cap-biz-${STAMP}`,
      currencyCode: "USD",
      currencySymbol: "$",
      locale: "en",
      timezone: "Asia/Tehran",
      ownerId: user.id,
    },
  });
  await prisma.businessMember.create({
    data: { businessId: business.id, userId: user.id, role: "OWNER" },
  });
  const productCount = CAP + 5; // 105 products: enough to hit the 100 cap and try a 101st
  await prisma.product.createMany({
    data: Array.from({ length: productCount }, (_, i) => ({
      businessId: business.id,
      name: `Cap Widget ${String(i + 1).padStart(3, "0")}`,
      sku: `P40CAP-${String(i + 1).padStart(3, "0")}`,
      unit: "piece",
      stockQty: 0,
      isActive: true,
    })),
  });
  const products = await prisma.product.findMany({
    where: { businessId: business.id },
    orderBy: { sku: "asc" },
  });
  console.log(`fixture: user+business+OWNER membership+${products.length} products`);

  try {
    /* B. login ------------------------------------------------------------- */
    const f = makeFetch(`10.210.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`);
    const csrf = (await f("/api/auth/csrf")).body?.csrfToken;
    const loginRes = await f("/api/auth/callback/credentials", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrfToken: csrf, email, password: PASS, redirect: "false", json: "true" }).toString(),
    });
    check("B1. credentials login accepted", loginRes.status === 200 || loginRes.status === 302, `status ${loginRes.status}`);
    const me = await f("/api/v1/me");
    check("B2. session works (/api/v1/me)", me.status === 200, `status ${me.status}`);

    const biz = (body, extra = {}) => (path, init = {}) =>
      f(path, { ...init, headers: { ...(init.headers ?? {}), "x-business-id": business.id }, body: init.body });

    /* C. create stocktake + fill to the cap -------------------------------- */
    const createRes = await biz()("/api/v1/inventory/stocktakes", {
      method: "POST",
      body: JSON.stringify({ reference: `P40CAP-${STAMP.slice(-6)}`, notes: "live line-cap trigger" }),
    });
    check("C1. stocktake created", createRes.status === 201 || createRes.status === 200, `status ${createRes.status}`);
    const stId = createRes.body?.data?.id ?? createRes.body?.data?.stocktake?.id;
    check("C2. stocktake id present", !!stId, stId ?? "missing");

    let added = 0;
    let lastOk = null;
    for (let i = 0; i < CAP; i++) {
      lastOk = await biz()(`/api/v1/inventory/stocktakes/${stId}/lines`, {
        method: "POST",
        body: JSON.stringify({ productId: products[i].id }),
      });
      if (lastOk.status === 201 || lastOk.status === 200) added++;
    }
    check(`C3. exactly ${CAP} lines added`, added === CAP, `added=${added}, last status ${lastOk?.status}`);

    /* D. the 101st line must be rejected with the exact code --------------- */
    const over = await biz()(`/api/v1/inventory/stocktakes/${stId}/lines`, {
      method: "POST",
      body: JSON.stringify({ productId: products[CAP].id }),
    });
    check("D1. line 101 rejected", over.status === 422, `status ${over.status}`);
    check(
      "D2. exact error code STOCKTAKE_LINE_LIMIT_REACHED",
      over.body?.error?.code === "STOCKTAKE_LINE_LIMIT_REACHED",
      `code=${over.body?.error?.code}`,
    );
    check(
      "D3. message surfaces the live cap value",
      typeof over.body?.error?.message === "string" && over.body.error.message.includes(`(${CAP})`),
      over.body?.error?.message ?? "no message",
    );

    /* E. detail reflects 100 lines (none of the 105th product leaked in) --- */
    const detail = await biz()(`/api/v1/inventory/stocktakes/${stId}`);
    check("E1. detail readable after cap", detail.status === 200, `status ${detail.status}`);
    const lineCount = detail.body?.data?.summary?.lineCount ?? detail.body?.data?.lineCount;
    check("E2. detail lineCount == 100", Number(lineCount) === CAP, `lineCount=${lineCount}`);
    const lines = detail.body?.data?.lines?.items ?? detail.body?.data?.lines ?? [];
    check(
      "E3. capped product NOT present in lines",
      !lines.some((l) => l.productId === products[CAP].id),
      "no leak",
    );
  } finally {
    /* F. teardown ---------------------------------------------------------- */
    const removed = await cleanup();
    const resUsers = await prisma.user.count({ where: { email: { contains: "@p40cap-" } } });
    const resBiz = await prisma.business.count({ where: { name: { startsWith: "P40CAP-" } } });
    const resProducts = await prisma.product.count({ where: { sku: { startsWith: "P40CAP-" } } });
    console.log(`\ncleanup: ${removed} fixture user(s) removed · residue users=${resUsers} biz=${resBiz} products=${resProducts}`);
    check("F1. zero fixture residue", resUsers === 0 && resBiz === 0 && resProducts === 0);
  }

  console.log(`\n== P40 LINE-CAP LIVE CHECK: ${passCount} passed, ${failCount} failed ==`);
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
