#!/usr/bin/env node
/**
 * scripts/prompt22-payments-check.mjs — Prompt 22 payment provider
 * abstraction integration harness.
 *
 * Coverage:
 *   A  Pricing catalog: server-authoritative amounts, FREE/ENTERPRISE not
 *      purchasable, YEARLY = 10×monthly, settlement EUR
 *   A2 HMAC signature scheme: valid, tampered, stale (replay), malformed
 *   B  Checkout API: auth/permission/tenant isolation, amount snapshot,
 *      one-live-session rule (new checkout cancels old PENDING)
 *   C  Webhook security: unknown provider 404, unverified 401, bad shape
 *      401, unknown session ignored, amount mismatch → FAILED fail-closed
 *   D  Fulfillment: simulate success → session SUCCEEDED + transaction +
 *      plan change (payment-webhook source) + audit; idempotent replays
 *      (new eventId for terminal session, exact eventId replay); failure
 *      and expired outcomes; lazy expiry; fulfillment auto-heal
 *   E  History & catalog: payments endpoint + CSV export (BOM/CRLF),
 *      providers endpoint, plan catalog carries server pricing
 *
 * Fixtures are synthetic (@p22check.local) and cleaned at the end.
 *
 * Usage: bun scripts/prompt22-payments-check.mjs [baseUrl]
 * Exit:  0 = all checks passed · 1 = failures printed
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const ROOT = "/home/z/my-project";

// Per-run unique client IP so back-to-back harness runs do not exhaust the
// shared per-IP register/login rate-limit quotas.
const TEST_IP = `10.210.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = `${ROOT}/.env`;
  if (existsSync(envPath)) {
    const line = readFileSync(envPath, "utf8")
      .split("\n")
      .find((l) => l.trim().startsWith("DATABASE_URL="));
    if (line) return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("DATABASE_URL not available");
}

const prisma = new PrismaClient({ datasources: { db: { url: loadDatabaseUrl() } } });

const failures = [];
let passed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push({ name, detail });
    console.error(`  ✗ ${name}${detail ? ` — ${String(detail).slice(0, 260)}` : ""}`);
  }
}

/* ------------------------- service-level imports -------------------------- */

const { priceFor, priceCatalog, PLAN_PRICES, SETTLEMENT_CURRENCY } = await import(
  "../src/lib/payments/pricing.ts"
);
const { buildSignatureHeader, verifySignatureHeader, getWebhookSecret } = await import(
  "../src/lib/payments/signature.ts"
);
const { WebhookVerificationError } = await import("../src/lib/payments/types.ts");
const { listProviders, resolveProvider, defaultProvider } = await import(
  "../src/lib/payments/registry.ts"
);
const { buildMockEventBody, buildMockEventHeaders } = await import(
  "../src/lib/payments/mock-provider.ts"
);

/* ------------------------------ HTTP helpers ------------------------------ */

function newJar() {
  const cookies = new Map();
  return {
    capture(res) {
      const raw =
        typeof res.headers.getSetCookie === "function"
          ? res.headers.getSetCookie()
          : [res.headers.get("set-cookie")].filter(Boolean);
      for (const line of raw) {
        const [pair] = line.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    header() {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    get(nameSuffix) {
      for (const [k, v] of cookies) if (k.endsWith(nameSuffix)) return v;
      return null;
    },
  };
}

async function api(path, { method = "GET", body, headers = {}, jar } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect: "manual",
    headers: {
      "x-forwarded-for": TEST_IP,
      ...(body !== undefined && typeof body !== "string" ? { "content-type": "application/json" } : {}),
      ...(jar ? { cookie: jar.header() } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  if (jar) jar.capture(res);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text, res };
}

async function login(email, password) {
  const jar = newJar();
  const csrfRes = await api("/api/auth/csrf", { jar });
  const rawCookie = jar.get("csrf-token");
  const csrfToken = rawCookie ? decodeURIComponent(rawCookie).split("|")[0] : csrfRes.json?.csrfToken;
  await api("/api/auth/callback/credentials", {
    method: "POST",
    jar,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrfToken,
      email,
      password,
      callbackUrl: `${BASE}/`,
      json: "true",
    }).toString(),
  });
  if (!jar.get("session-token")) throw new Error(`login failed for ${email}`);
  return jar;
}

async function register(name, email, password) {
  const res = await api("/api/v1/auth/register", {
    method: "POST",
    body: { name, email, password },
    headers: { "x-forwarded-for": TEST_IP },
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`register failed for ${email}: ${res.status} ${res.text?.slice(0, 160)}`);
  }
  return login(email, password);
}

function ctxHeader(businessId) {
  return { "x-business-id": businessId };
}

/* -------------------------------- fixtures -------------------------------- */

const STAMP = Date.now();
const DOMAIN = "p22check.local";
const PASSWORD = "p22-Passw0rd!";
const ownerEmail = `owner-${STAMP}@${DOMAIN}`;
const outsiderEmail = `outsider-${STAMP}@${DOMAIN}`;

console.log(`\n=== Prompt 22 — payment provider abstraction (IP ${TEST_IP}) ===\n`);

/* ============================== A — pricing =============================== */

console.log("A — pricing catalog (server-authoritative)");
check("A1 monthly price STARTER = 900 EUR minor", priceFor("STARTER", "MONTHLY")?.amountMinor === 900);
check("A2 yearly price BUSINESS = 19000 (10×)", priceFor("BUSINESS", "YEARLY")?.amountMinor === 19000);
check("A3 currency settlement is EUR", priceFor("PRO", "MONTHLY")?.currency === SETTLEMENT_CURRENCY && SETTLEMENT_CURRENCY === "EUR");
check("A4 FREE not purchasable", priceFor("FREE", "MONTHLY") === null);
check("A5 ENTERPRISE not purchasable (not self-service)", priceFor("ENTERPRISE", "MONTHLY") === null);
check(
  "A6 catalog covers exactly the 3 paid plans",
  JSON.stringify(priceCatalog().map((p) => p.planCode).sort()) ===
    JSON.stringify(["BUSINESS", "PRO", "STARTER"]),
);
check("A7 catalog amounts deterministic", priceCatalog().every((p) => p.monthlyMinor === PLAN_PRICES[p.planCode] && p.yearlyMinor === p.monthlyMinor * 10));

/* ============================ A2 — signatures ============================= */

console.log("\nA2 — webhook signature scheme");
{
  const body = JSON.stringify({ hello: "world" });
  let okValid = false, okTamper = false, okStale = false, okMalformed = false, okWrongSecret = false;
  try { verifySignatureHeader(buildSignatureHeader(body), body); okValid = true; } catch { okValid = false; }
  try { verifySignatureHeader(buildSignatureHeader(body), body + "x"); okTamper = false; } catch (e) { okTamper = e instanceof WebhookVerificationError; }
  const stale = Math.floor(Date.now() / 1000) - 3600;
  try { verifySignatureHeader(`t=${stale},v1=` + buildSignatureHeader(body).split("v1=")[1], body); okStale = false; } catch (e) { okStale = e instanceof WebhookVerificationError; }
  try { verifySignatureHeader("garbage", body); okMalformed = false; } catch (e) { okMalformed = e instanceof WebhookVerificationError; }
  try { verifySignatureHeader(buildSignatureHeader(body, "another-secret-at-least-16ch"), body); okWrongSecret = false; } catch (e) { okWrongSecret = e instanceof WebhookVerificationError; }
  check("A2.1 valid signature verifies", okValid);
  check("A2.2 tampered body rejected", okTamper);
  check("A2.3 stale timestamp (replay) rejected", okStale);
  check("A2.4 malformed header rejected", okMalformed);
  check("A2.5 wrong secret rejected", okWrongSecret);
  check("A2.6 secret resolvable (env or derived)", typeof getWebhookSecret() === "string" && getWebhookSecret().length >= 32);
}

/* =========================== registry sanity ============================== */

console.log("\nRegistry");
{
  const providers = listProviders();
  check("R1 mock provider listed as usable SANDBOX",
    providers.some((p) => p.slug === "mock" && p.mode === "SANDBOX" && p.usable));
  check("R2 resolveProvider('mock') returns adapter", resolveProvider("mock").slug === "mock");
  let threw = null;
  try { resolveProvider("not-a-provider"); } catch (e) { threw = e; }
  check("R3 unknown slug fails closed PROVIDER_UNAVAILABLE", threw?.code === "PROVIDER_UNAVAILABLE");
  check("R4 defaultProvider resolves", defaultProvider().slug === "mock");
}

/* ============================== B — checkout API ========================== */

console.log("\nB — checkout API");
const ownerJar = await register("P22 Owner", ownerEmail, PASSWORD);
const outsiderJar = await register("P22 Outsider", outsiderEmail, PASSWORD);

const bizRes = await api("/api/v1/businesses", {
  method: "POST",
  jar: ownerJar,
  body: { name: "P22 Payments Shop", currencyCode: "IRR", locale: "fa" },
});
check("B0 business created (display currency IRR — settlement stays EUR)", bizRes.status === 201, bizRes.text?.slice(0, 160));
const businessId = bizRes.json?.data?.business?.id ?? bizRes.json?.data?.id;
check("B0.1 business id resolved", !!businessId);

{
  const unauth = await api("/api/v1/billing/checkout", {
    method: "POST",
    body: { planCode: "STARTER", billingPeriod: "MONTHLY" },
  });
  check("B1 unauthenticated checkout → 401", unauth.status === 401);

  const freeAttempt = await api("/api/v1/billing/checkout", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(businessId),
    body: { planCode: "FREE", billingPeriod: "MONTHLY" },
  });
  check("B2 FREE checkout → 422 CHECKOUT_NOT_ALLOWED", freeAttempt.status === 422 && freeAttempt.json?.error?.code === "CHECKOUT_NOT_ALLOWED", freeAttempt.text?.slice(0, 120));

  const entAttempt = await api("/api/v1/billing/checkout", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(businessId),
    body: { planCode: "ENTERPRISE", billingPeriod: "MONTHLY" },
  });
  check("B3 ENTERPRISE checkout → 422 (not self-service)", entAttempt.status === 422 && entAttempt.json?.error?.code === "CHECKOUT_NOT_ALLOWED");

  const outsiderAttempt = await api("/api/v1/billing/checkout", {
    method: "POST",
    jar: outsiderJar,
    headers: ctxHeader(businessId),
    body: { planCode: "STARTER", billingPeriod: "MONTHLY" },
  });
  check("B4 non-member checkout → 403 (membership gate)", outsiderAttempt.status === 403, `got ${outsiderAttempt.status}`);

  const okRes = await api("/api/v1/billing/checkout", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(businessId),
    body: { planCode: "STARTER", billingPeriod: "MONTHLY" },
  });
  check("B5 checkout created → 201 PENDING", okRes.status === 201 && okRes.json?.data?.checkoutSession?.status === "PENDING", okRes.text?.slice(0, 160));
  const s1 = okRes.json?.data?.checkoutSession;
  check("B6 amount snapshot = server price 900 EUR (browser never sends amount)", s1?.amountMinor === 900 && s1?.currency === "EUR");
  check("B7 provider is sandbox mock with in-app redirect", s1?.provider === "mock" && typeof s1?.redirectUrl === "string" && s1.redirectUrl.startsWith("/?checkout="));
  check("B8 session expires in ~30min", s1?.expiresAt && new Date(s1.expiresAt).getTime() - Date.now() > 25 * 60_000);

  // Tenant isolation on reads (403 FORBIDDEN for a non-member context —
  // the business header itself is rejected before the session is looked up;
  // an unknown id inside a valid membership yields 404).
  const asOutsider = await api(`/api/v1/billing/checkout/${s1.id}`, { jar: outsiderJar, headers: ctxHeader(businessId) });
  check("B9 other tenant's session read denied (403/404)", asOutsider.status === 403 || asOutsider.status === 404, `got ${asOutsider.status}`);
  const unknown = await api("/api/v1/billing/checkout/nonexistent-id", { jar: ownerJar, headers: ctxHeader(businessId) });
  check("B10 unknown session → 404", unknown.status === 404);

  // One-live-session rule: new checkout cancels the PENDING one
  const okRes2 = await api("/api/v1/billing/checkout", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(businessId),
    body: { planCode: "BUSINESS", billingPeriod: "MONTHLY" },
  });
  const s2 = okRes2.json?.data?.checkoutSession;
  check("B11 second checkout created (BUSINESS 1900)", okRes2.status === 201 && s2?.amountMinor === 1900);
  const s1After = await api(`/api/v1/billing/checkout/${s1.id}`, { jar: ownerJar, headers: ctxHeader(businessId) });
  check("B12 previous PENDING session auto-canceled", s1After.json?.data?.checkoutSession?.status === "CANCELED");

  // The WORKING session for section C/D
  globalThis.session = s2;
}

const session = globalThis.session;

/* ============================ C — webhook security ======================== */

console.log("\nC — webhook security");
{
  const url = `/api/v1/webhooks/payments`;
  const unknownProv = await api(`${url}/nope`, {
    method: "POST",
    body: "whatever",
    headers: { "content-type": "application/json" },
  });
  check("C1 unknown provider → 404", unknownProv.status === 404);

  const unsigned = await api(`${url}/mock`, { method: "POST", body: buildMockEventBody("checkout.succeeded", session.id, { amountMinor: 1900, currency: "EUR" }) });
  check("C2 unsigned webhook → 401 (opaque)", unsigned.status === 401 && unsigned.json?.error?.code === "WEBHOOK_UNVERIFIED");

  const body = buildMockEventBody("checkout.succeeded", session.id, { amountMinor: 1900, currency: "EUR" });
  const headers = buildMockEventHeaders(body);
  const tamperedSig = new Headers(headers);
  tamperedSig.set("mock-signature", headers.get("mock-signature").replace(/.$/, (c) => (c === "0" ? "1" : "0")));
  const tampered = await api(`${url}/mock`, { method: "POST", body, headers: Object.fromEntries([...tamperedSig.entries()]) });
  check("C3 tampered signature → 401", tampered.status === 401);

  const staleHeaders = new Headers();
  staleHeaders.set("content-type", "application/json");
  const old = Math.floor(Date.now() / 1000) - 3600;
  // sign with stale timestamp through the real builder's t/v1 format
  const { computeSignature } = await import("../src/lib/payments/signature.ts");
  staleHeaders.set("mock-signature", `t=${old},v1=${computeSignature(old, body, getWebhookSecret())}`);
  const stale = await api(`${url}/mock`, { method: "POST", body, headers: Object.fromEntries([...staleHeaders.entries()]) });
  check("C4 stale-timestamp (replay beyond 5min) → 401", stale.status === 401);

  const badShape = await api(`${url}/mock`, {
    method: "POST",
    body: JSON.stringify({ not: "an event" }),
    headers: { "mock-signature": buildSignatureHeader(JSON.stringify({ not: "an event" })) },
  });
  check("C5 signed but malformed shape → 401", badShape.status === 401);

  const unknownSessionBody = buildMockEventBody("checkout.succeeded", "no-such-session", { amountMinor: 1900, currency: "EUR" });
  const unknownSession = await api(`${url}/mock`, {
    method: "POST",
    body: unknownSessionBody,
    headers: Object.fromEntries([...buildMockEventHeaders(unknownSessionBody).entries()]),
  });
  check("C6 verified event for unknown session → 200 ignored (no gateway retry storm)", unknownSession.status === 200 && unknownSession.json?.data?.ignored === "unknown-session");

  // Amount mismatch → fail closed, session FAILED, plan unchanged
  const mismatchBody = buildMockEventBody("checkout.succeeded", session.id, { amountMinor: 1, currency: "EUR" });
  const mismatch = await api(`${url}/mock`, {
    method: "POST",
    body: mismatchBody,
    headers: Object.fromEntries([...buildMockEventHeaders(mismatchBody).entries()]),
  });
  check("C7 amount mismatch → 200 with sessionStatus FAILED", mismatch.status === 200 && mismatch.json?.data?.sessionStatus === "FAILED");
  const sAfter = await api(`/api/v1/billing/checkout/${session.id}`, { jar: ownerJar, headers: ctxHeader(businessId) });
  check("C8 session recorded FAILED (never fulfilled)", sAfter.json?.data?.checkoutSession?.status === "FAILED" && sAfter.json?.data?.checkoutSession?.fulfilledAt === null);
  const txMismatch = await prisma.paymentTransaction.findFirst({ where: { checkoutSessionId: session.id }, orderBy: { processedAt: "desc" } });
  check("C9 FAILED transaction recorded with amount-mismatch reason", txMismatch?.status === "FAILED" && JSON.parse(txMismatch.metaJson ?? "{}").reason === "amount-mismatch");

  // Fresh session for the happy path
  const okRes = await api("/api/v1/billing/checkout", {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(businessId),
    body: { planCode: "BUSINESS", billingPeriod: "MONTHLY" },
  });
  globalThis.session = okRes.json.data.checkoutSession;
}

const happy = globalThis.session;

/* =========================== D — fulfillment ============================== */

console.log("\nD — fulfillment (idempotent end-to-end)");
{
  const successBody = buildMockEventBody("checkout.succeeded", happy.id, { amountMinor: happy.amountMinor, currency: happy.currency });
  const delivery1 = await api(`/api/v1/webhooks/payments/mock`, {
    method: "POST",
    body: successBody,
    headers: Object.fromEntries([...buildMockEventHeaders(successBody).entries()]),
  });
  check("D1 verified success webhook → 200 SUCCEEDED", delivery1.status === 200 && delivery1.json?.data?.sessionStatus === "SUCCEEDED");

  const sNow = await api(`/api/v1/billing/checkout/${happy.id}`, { jar: ownerJar, headers: ctxHeader(businessId) });
  check("D2 session SUCCEEDED with fulfilledAt set", sNow.json?.data?.checkoutSession?.status === "SUCCEEDED" && !!sNow.json?.data?.checkoutSession?.fulfilledAt);

  const sub = await api("/api/v1/billing/subscription", { jar: ownerJar, headers: ctxHeader(businessId) });
  check("D3 subscription upgraded to BUSINESS/ACTIVE", sub.json?.data?.subscription?.plan?.code === "BUSINESS" && sub.json?.data?.subscription?.status === "ACTIVE");

  const events = await api("/api/v1/billing/events?pageSize=5", { jar: ownerJar, headers: ctxHeader(businessId) });
  const planChanged = events.json?.data?.items?.find?.((e) => e.type === "PLAN_CHANGED");
  check("D4 SubscriptionEvent PLAN_CHANGED → BUSINESS from payment webhook", planChanged?.toPlanCode === "BUSINESS" && planChanged?.data?.source === "payment-webhook:webhook");

  // Idempotency layer 2: NEW eventId for an already-SUCCEEDED session
  const replayBody = buildMockEventBody("checkout.succeeded", happy.id, { amountMinor: happy.amountMinor, currency: happy.currency });
  const replayNew = await api(`/api/v1/webhooks/payments/mock`, {
    method: "POST",
    body: replayBody,
    headers: Object.fromEntries([...buildMockEventHeaders(replayBody).entries()]),
  });
  check("D5 second delivery (new eventId) → duplicate=true, still 200", replayNew.status === 200 && replayNew.json?.data?.duplicate === true, replayNew.text?.slice(0, 160));

  const txCount = await prisma.paymentTransaction.count({ where: { checkoutSessionId: happy.id } });
  check("D6 exactly ONE transaction for the session (no double money)", txCount === 1);

  const sub2 = await api("/api/v1/billing/subscription", { jar: ownerJar, headers: ctxHeader(businessId) });
  check("D7 plan still BUSINESS (no state corruption)", sub2.json?.data?.subscription?.plan?.code === "BUSINESS");

  // Idempotency layer 3: simulate endpoint on a terminal session → 409
  const conflict = await api(`/api/v1/billing/checkout/${happy.id}/simulate`, {
    method: "POST",
    jar: ownerJar,
    headers: ctxHeader(businessId),
    body: { outcome: "succeeded" },
  });
  check("D8 simulate on terminal session → 409 CHECKOUT_STATE_CONFLICT", conflict.status === 409 && conflict.json?.error?.code === "CHECKOUT_STATE_CONFLICT");

  // failure outcome keeps the plan
  const beforeCount = await prisma.paymentTransaction.count({ where: { checkoutSession: { businessId } } });
  const failCheckout = await api("/api/v1/billing/checkout", {
    method: "POST", jar: ownerJar, headers: ctxHeader(businessId),
    body: { planCode: "PRO", billingPeriod: "MONTHLY" },
  });
  const failSession = failCheckout.json.data.checkoutSession;
  const simFail = await api(`/api/v1/billing/checkout/${failSession.id}/simulate`, {
    method: "POST", jar: ownerJar, headers: ctxHeader(businessId),
    body: { outcome: "failed" },
  });
  check("D9 simulate failure → session FAILED", simFail.status === 200 && simFail.json?.data?.checkoutSession?.status === "FAILED");
  const sub3 = await api("/api/v1/billing/subscription", { jar: ownerJar, headers: ctxHeader(businessId) });
  check("D10 plan unchanged after failed payment", sub3.json?.data?.subscription?.plan?.code === "BUSINESS");
  const afterCount = await prisma.paymentTransaction.count({ where: { checkoutSession: { businessId } } });
  check("D11 failed payment recorded as FAILED transaction", afterCount === beforeCount + 1);

  // expired outcome
  const expCheckout = await api("/api/v1/billing/checkout", {
    method: "POST", jar: ownerJar, headers: ctxHeader(businessId),
    body: { planCode: "PRO", billingPeriod: "YEARLY" },
  });
  const expSession = expCheckout.json.data.checkoutSession;
  check("D12 YEARLY session amount = 49000 (10×4900)", expSession?.amountMinor === 49000);
  const simExp = await api(`/api/v1/billing/checkout/${expSession.id}/simulate`, {
    method: "POST", jar: ownerJar, headers: ctxHeader(businessId),
    body: { outcome: "expired" },
  });
  check("D13 simulate expired → session EXPIRED", simExp.status === 200 && simExp.json?.data?.checkoutSession?.status === "EXPIRED");

  // Lazy expiry: past expiresAt flips on read
  const lazyCheckout = await api("/api/v1/billing/checkout", {
    method: "POST", jar: ownerJar, headers: ctxHeader(businessId),
    body: { planCode: "PRO", billingPeriod: "MONTHLY" },
  });
  const lazyId = lazyCheckout.json.data.checkoutSession.id;
  await prisma.checkoutSession.update({ where: { id: lazyId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const lazyRead = await api(`/api/v1/billing/checkout/${lazyId}`, { jar: ownerJar, headers: ctxHeader(businessId) });
  check("D14 lazy expiry on read → EXPIRED", lazyRead.json?.data?.checkoutSession?.status === "EXPIRED");

  // fulfillment AUTO-HEAL: SUCCEEDED without fulfilledAt re-fulfills idempotently
  const healCheckout = await api("/api/v1/billing/checkout", {
    method: "POST", jar: ownerJar, headers: ctxHeader(businessId),
    body: { planCode: "STARTER", billingPeriod: "MONTHLY" },
  });
  const healSession = healCheckout.json.data.checkoutSession;
  const healBody = buildMockEventBody("checkout.succeeded", healSession.id, { amountMinor: healSession.amountMinor, currency: healSession.currency });
  await api(`/api/v1/webhooks/payments/mock`, {
    method: "POST",
    body: healBody,
    headers: Object.fromEntries([...buildMockEventHeaders(healBody).entries()]),
  });
  // simulate the crash window: fulfilledAt cleared after the fact
  await prisma.checkoutSession.update({ where: { id: healSession.id }, data: { fulfilledAt: null } });
  const healed = await api(`/api/v1/billing/checkout/${healSession.id}`, { jar: ownerJar, headers: ctxHeader(businessId) });
  check("D15 auto-heal re-fulfills and sets fulfilledAt", healed.status === 200 && !!healed.json?.data?.checkoutSession?.fulfilledAt);
  const healTx = await prisma.paymentTransaction.count({ where: { checkoutSessionId: healSession.id } });
  check("D16 auto-heal did NOT duplicate the transaction", healTx === 1);

  // audit trail
  const audits = await prisma.auditLog.findMany({
    where: { businessId, action: { in: ["billing.checkout_created", "billing.payment_succeeded", "billing.payment_failed"] } },
    select: { action: true },
  });
  const actions = new Set(audits.map((a) => a.action));
  check("D17 audits recorded (created/succeeded/failed)", actions.has("billing.checkout_created") && actions.has("billing.payment_succeeded") && actions.has("billing.payment_failed"));

  // role gate on simulate: non-member → 403
  const simOutsider = await api(`/api/v1/billing/checkout/${happy.id}/simulate`, {
    method: "POST", jar: outsiderJar, headers: ctxHeader(businessId), body: { outcome: "succeeded" },
  });
  check("D18 non-member simulate → 403", simOutsider.status === 403);
}

/* ========================= E — history & catalog ========================== */

console.log("\nE — history, CSV, providers, catalog pricing");
{
  const history = await api("/api/v1/billing/payments", { jar: ownerJar, headers: ctxHeader(businessId) });
  check("E1 payments history lists 4 transactions (mismatch-FAILED + success + fail-FAILED + healed success)", history.json?.data?.total === 4, `got ${history.json?.data?.total}`);
  const items = history.json?.data?.items ?? [];
  check("E2 rows carry provider/plan/amount", items.every((i) => i.provider === "mock" && typeof i.amountMinor === "number" && i.planCode));

  // Dedicated raw fetch — the api() helper already consumed the body stream.
  const csvRes = await fetch(`${BASE}/api/v1/billing/payments?format=csv`, {
    headers: { "x-forwarded-for": TEST_IP, cookie: ownerJar.header(), "x-business-id": businessId },
  });
  check("E3 CSV export 200 text/csv with attachment", csvRes.status === 200 && (csvRes.headers.get("content-type") ?? "").includes("text/csv") && (csvRes.headers.get("content-disposition") ?? "").includes("payments-"));
  // res.text() strips the BOM per fetch spec — inspect RAW BYTES for UTF-8 BOM.
  const csvBytes = new Uint8Array(await csvRes.arrayBuffer());
  const raw = Buffer.from(csvBytes).toString("utf8");
  check("E4 CSV has BOM + CRLF + header + 4 rows", csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf && raw.includes("processed_at,status,plan_code") && raw.split("\r\n").filter((l) => l.length > 0).length === 5, `bytes0-2=${csvBytes[0]},${csvBytes[1]},${csvBytes[2]} lines=${raw.split("\r\n").filter((l) => l.length > 0).length}`);

  const unauthCsv = await api("/api/v1/billing/payments?format=csv");
  check("E5 CSV export requires auth → 401", unauthCsv.status === 401);

  const providers = await api("/api/v1/billing/providers", { jar: ownerJar, headers: ctxHeader(businessId) });
  check("E6 providers endpoint lists mock usable (no secrets in payload)",
    providers.json?.data?.providers?.[0]?.slug === "mock" && providers.json.data.providers[0].usable === true &&
    !JSON.stringify(providers.json).toLowerCase().includes("secret"));

  const plans = await api("/api/v1/billing/plans", { jar: ownerJar, headers: ctxHeader(businessId) });
  const starter = plans.json?.data?.plans?.find?.((p) => p.code === "STARTER");
  const free = plans.json?.data?.plans?.find?.((p) => p.code === "FREE");
  const ent = plans.json?.data?.plans?.find?.((p) => p.code === "ENTERPRISE");
  check("E7 plan catalog carries server pricing for STARTER (900/9000 EUR)", starter?.pricing?.monthlyMinor === 900 && starter?.pricing?.yearlyMinor === 9000 && starter?.pricing?.currency === "EUR");
  check("E8 FREE/ENTERPRISE have null pricing", free?.pricing === null && ent?.pricing === null);
  check("E9 settlementCurrency exposed (EUR)", plans.json?.data?.settlementCurrency === "EUR");
}

/* ------------------------------- cleanup ---------------------------------- */

console.log("\nCleanup");
{
  // Danger-zone deletion requires the exact business name as confirmation.
  const del = await api(`/api/v1/businesses/${businessId}`, {
    method: "DELETE",
    jar: ownerJar,
    headers: ctxHeader(businessId),
    body: { confirmName: "P22 Payments Shop" },
  });
  check("Z1 fixture business deleted via real danger-zone API", del.status === 200 || del.status === 204, `got ${del.status} ${del.text?.slice(0, 120)}`);
  const sessLeft = await prisma.checkoutSession.count({ where: { businessId } });
  const txLeft = await prisma.paymentTransaction.count({ where: { checkoutSession: { businessId } } });
  check("Z2 no checkout sessions / transactions remain", sessLeft === 0 && txLeft === 0);
  console.log(`  · note: ${await prisma.processedWebhookEvent.count({ where: { provider: "mock" } })} ProcessedWebhookEvent rows exist (harmless idempotency ledger, kept)`);
}

prisma.$disconnect();
console.log(`\n=== Prompt 22 harness: ${passed} passed, ${failures.length} failed ===\n`);
if (failures.length > 0) {
  console.error("FAILED CHECKS:");
  for (const f of failures) console.error(`  ✗ ${f.name}${f.detail ? ` — ${String(f.detail).slice(0, 200)}` : ""}`);
  process.exit(1);
}
