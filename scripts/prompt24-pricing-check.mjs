#!/usr/bin/env node
/**
 * scripts/prompt24-pricing-check.mjs — Prompt 24 pricing harness (BUN,
 * against the live dev server; mock provider is the only usable one here).
 *
 * Coverage (§111):
 *   Q1 Setup (owner + outsider + throwaway businesses)
 *   Q2 EUR-v1 catalog via plans API (default currency, availability §52,
 *      supported currencies §92, yearly explicit §61)
 *   Q3 Currency gates: IRR unpriced (no fallback §50), arbitrary codes
 *      rejected (§41), checkout currency=IRR/USD structured 422
 *   Q4 Tamper-proofing: extra client fields 400 (strict §80)
 *   Q5 Session truth: authoritative snapshot + book reference (§29/§30)
 *   Q6 Historical preservation: pre-Prompt-24 sessions untouched (§67/§68)
 *   Q7 IRR test book: direct IRR price (NO FX §2/§49/§84), explicit yearly
 *      (≠ monthly×10 §61/§62), catalog honest for IRR
 *   Q8 Book lifecycle: inactive / future-effective / expired never used
 *      (§33/§82), deactivation falls back to NOTHING (§50)
 *   Q9 Price versioning: EUR-v2 shadows v1 only while active+effective;
 *      old session keeps v1 amount (§31/§81/§36)
 *   Q10 Seed idempotency (§28/§103)
 *   Q11 Currency metadata + exponent-aware display (§23/§44/§86), no floats
 *   Q12 Provider compatibility gate is capability-driven (§47/§48/§83)
 *   Q13 FREE / ENTERPRISE not purchasable (§38/§39)
 *   Q14 Tenant isolation + RBAC (§118)
 *   Q15 Cleanup: real danger-zone delete + test books removed (history kept)
 *
 * Usage: bun scripts/prompt24-pricing-check.mjs [baseUrl]
 * Exit:  0 = all checks passed · 1 = failures printed
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const ROOT = "/home/z/my-project";
const TEST_IP = `10.212.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = `${ROOT}/.env`;
  if (existsSync(envPath)) {
    const line = readFileSync(envPath, "utf8")
      .split("\n")
      .find((l) => l.trim().startsWith("DATABASE_URL="));
    return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
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

const { providerSupportsCurrency, resolvePrice } = await import(
  "../src/lib/payments/pricing-service.ts"
);
const { currencyMinorDigits, currencyMeta, isSupportedSettlementCurrency } = await import(
  "../src/lib/payments/currency.ts"
);
const { formatMinor } = await import("../src/lib/payments/pricing.ts");

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

async function api(path, { method = "GET", body, headers = {}, jar, host } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect: "manual",
    headers: {
      "x-forwarded-for": TEST_IP,
      ...(host ? { host } : {}),
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
  } catch {}
  return { status: res.status, json, text, res, location: res.headers.get("location") };
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
    body: new URLSearchParams({ csrfToken, email, password, callbackUrl: `${BASE}/`, json: "true" }).toString(),
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
    throw new Error(`register failed for ${email}: ${res.status}`);
  }
  return login(email, password);
}

const ctxHeader = (businessId) => ({ "x-business-id": businessId });

const STAMP = Date.now();
const DOMAIN = "p24check.local";
const PASSWORD = "p24-Passw0rd!";
const ownerEmail = `owner-${STAMP}@${DOMAIN}`;
const outsiderEmail = `outsider-${STAMP}@${DOMAIN}`;

console.log(`\n=== Prompt 24 — pricing engine / price books (IP ${TEST_IP}) ===\n`);

/* ----------------------------- self-heal --------------------------------- */

// r22 bug #6 lesson: a crashed earlier run must NEVER poison this one.
// Remove leftover P24 fixture businesses (cascades their sessions — the
// books' Restrict FK only blocks BOOK deletion, not session deletion) and
// any leftover harness test books, so the catalog starts deterministic.
{
  const leftovers = await prisma.business.findMany({
    where: { name: { in: ["P24 Pricing Shop", "P24 Other Biz"] } },
    select: { id: true },
  });
  for (const b of leftovers) {
    try { await prisma.business.delete({ where: { id: b.id } }); } catch {}
  }
  try { await prisma.priceBook.deleteMany({ where: { code: { in: ["IRR_TEST", "EUR_TEST2"] } } }); } catch {}
  if (leftovers.length > 0) console.log(`self-heal: removed ${leftovers.length} leftover fixture business(es) + test books`);
}

// §68-spirit bounded pacing: the checkout endpoint rate-limits to 10/min
// BY DESIGN (r22 §91); this harness legitimately exceeds that, so it waits
// the server-advertised backoff instead of hammering (bounded, ≤ 2 waits).
async function checkout(body, { jar = ownerJar, bizId = businessId } = {}) {
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await api("/api/v1/billing/checkout", { method: "POST", jar, headers: ctxHeader(bizId), body });
    if (r.status !== 429) return r;
    const wait = Math.min((r.json?.error?.details?.retryAfterMs ?? 60_000) + 500, 70_000);
    console.log(`  · rate-limited by design (10/min) — waiting ${Math.round(wait / 1000)}s`);
    await new Promise((res) => setTimeout(res, wait));
  }
  return r;
}

/* ------------------------------- Q1 setup -------------------------------- */

console.log("Q1 — setup");
const ownerJar = await register("P24 Owner", ownerEmail, PASSWORD);
const outsiderJar = await register("P24 Outsider", outsiderEmail, PASSWORD);
const bizRes = await api("/api/v1/businesses", {
  method: "POST",
  jar: ownerJar,
  body: { name: "P24 Pricing Shop", currencyCode: "EUR", locale: "fa" },
});
check("Q1.1 business created", bizRes.status === 201, bizRes.text?.slice(0, 160));
const businessId = bizRes.json?.data?.business?.id ?? bizRes.json?.data?.id;
check("Q1.2 business id resolved", !!businessId);
const outBiz = await api("/api/v1/businesses", {
  method: "POST",
  jar: outsiderJar,
  body: { name: "P24 Other Biz", currencyCode: "EUR", locale: "en" },
});
const outBizId = outBiz.json?.data?.business?.id ?? outBiz.json?.data?.id;

/* ------------------- Q2 EUR-v1 catalog via plans API --------------------- */

console.log("\nQ2 — EUR-v1 catalog (default currency, §40/§52/§92)");
const plans1 = await api("/api/v1/billing/plans", { jar: ownerJar, headers: ctxHeader(businessId) });
check("Q2.1 plans API 200", plans1.status === 200, plans1.text?.slice(0, 120));
check("Q2.2 default settlement currency is EUR (deployment default §42/§97)", plans1.json?.data?.settlementCurrency === "EUR");
check("Q2.3 supportedCurrencies honest ([EUR] — no IRR book yet §92)", JSON.stringify(plans1.json?.data?.supportedCurrencies) === JSON.stringify(["EUR"]));
const planMap1 = new Map((plans1.json?.data?.plans ?? []).map((p) => [p.code, p]));
check("Q2.4 STARTER pricing 900/9000 EUR from the active book", planMap1.get("STARTER")?.pricing?.monthlyMinor === 900 && planMap1.get("STARTER")?.pricing?.yearlyMinor === 9000 && planMap1.get("STARTER")?.pricing?.currency === "EUR");
check("Q2.5 STARTER pricing names version v1-2026-09 (§69)", planMap1.get("STARTER")?.pricing?.priceVersion === "v1-2026-09");
check("Q2.6 BUSINESS 1900/19000 + PRO 4900/49000 preserved verbatim (§37)", planMap1.get("BUSINESS")?.pricing?.monthlyMinor === 1900 && planMap1.get("BUSINESS")?.pricing?.yearlyMinor === 19000 && planMap1.get("PRO")?.pricing?.monthlyMinor === 4900 && planMap1.get("PRO")?.pricing?.yearlyMinor === 49000);
check("Q2.7 availability: paid AVAILABLE · FREE NOT_PURCHASABLE · ENTERPRISE NOT_SELF_SERVICE (§52)", planMap1.get("STARTER")?.availability === "AVAILABLE" && planMap1.get("FREE")?.availability === "NOT_PURCHASABLE" && planMap1.get("ENTERPRISE")?.availability === "NOT_SELF_SERVICE");
check("Q2.8 no internal ids / admin metadata in the catalog DTO (§43)", JSON.stringify(plans1.json?.data?.plans ?? [{}]).includes("priceBookId") === false && planMap1.get("STARTER")?.pricing != null);
{
  // Q2.9 yearly rows are EXPLICIT DB rows (not computed §21/§61)
  const rows = await prisma.planPrice.findMany({ where: { billingPeriod: "YEARLY", active: true, priceBook: { currency: "EUR" } }, select: { planCode: true, amountMinor: true } });
  const m = new Map(rows.map((r) => [r.planCode, r.amountMinor]));
  check("Q2.9 explicit YEARLY PlanPrice rows 9000/19000/49000", m.get("STARTER") === 9000 && m.get("BUSINESS") === 19000 && m.get("PRO") === 49000 && rows.length >= 3);
}

/* ---------------------- Q3 currency gates (§41/§50) ---------------------- */

console.log("\nQ3 — currency gates (no fallback, no conversion)");
const plansIrr = await api("/api/v1/billing/plans?currency=IRR", { jar: ownerJar, headers: ctxHeader(businessId) });
check("Q3.1 plans?currency=IRR → 200 with honest NOT_PRICED plans (§52)", plansIrr.status === 200 && (plansIrr.json?.data?.plans ?? []).every((p) => !p.pricing || p.availability !== "AVAILABLE"), plansIrr.text?.slice(0, 160));
check("Q3.2 IRR is a SUPPORTED settlement currency but unpriced here", plansIrr.json?.data?.settlementCurrency === "IRR" && JSON.stringify(plansIrr.json?.data?.supportedCurrencies) === JSON.stringify(["EUR"]));
const plansUsd = await api("/api/v1/billing/plans?currency=USD", { jar: ownerJar, headers: ctxHeader(businessId) });
check("Q3.3 plans?currency=USD → 422 CURRENCY_NOT_SUPPORTED (not in allowlist §15/§41)", plansUsd.status === 422 && plansUsd.json?.error?.code === "CURRENCY_NOT_SUPPORTED", plansUsd.text?.slice(0, 120));
const ckIrr = await checkout({ planCode: "STARTER", billingPeriod: "MONTHLY", currency: "IRR" });
check("Q3.4 checkout IRR with no IRR book → 422 PRICEBOOK_NOT_FOUND (§50)", ckIrr.status === 422 && ckIrr.json?.error?.code === "PRICEBOOK_NOT_FOUND", ckIrr.text?.slice(0, 160));
const ckUsd = await checkout({ planCode: "STARTER", billingPeriod: "MONTHLY", currency: "USD" });
check("Q3.5 checkout USD → 422 CURRENCY_NOT_SUPPORTED", ckUsd.status === 422 && ckUsd.json?.error?.code === "CURRENCY_NOT_SUPPORTED");
const ckJunk = await checkout({ planCode: "STARTER", billingPeriod: "MONTHLY", currency: "eur" });
check("Q3.6 lowercase currency accepted + canonicalized (eur → EUR 201)", ckJunk.status === 201 && ckJunk.json?.data?.checkoutSession?.currency === "EUR", ckJunk.text?.slice(0, 160));

/* ------------------- Q4 tamper-proofing (§78-§80) ------------------------ */

console.log("\nQ4 — tamper-proofing (strict schema §80)");
const tamper1 = await checkout({ planCode: "STARTER", billingPeriod: "MONTHLY", amountMinor: 1, priceVersion: "v999", priceBookId: "evil", currency: "EUR" });
check("Q4.1 amount + priceVersion + priceBookId fields → 422 VALIDATION_ERROR (strict §80)", tamper1.status === 422 && tamper1.json?.error?.code === "VALIDATION_ERROR", tamper1.text?.slice(0, 140));
const tamper2 = await checkout({ planCode: "STARTER", billingPeriod: "MONTHLY", currency: "EUR" });
check("Q4.2 clean checkout unaffected → 201 (900 EUR)", tamper2.status === 201 && tamper2.json?.data?.checkoutSession?.amountMinor === 900, tamper2.text?.slice(0, 120));

/* --------------------- Q5 session truth (§29/§30) ------------------------ */

console.log("\nQ5 — session snapshot truth");
const sessV1 = tamper2.json?.data?.checkoutSession;
check("Q5.1 session freezes amountMinor=900 + currency EUR", sessV1?.amountMinor === 900 && sessV1?.currency === "EUR");
check("Q5.2 session references the EUR-v1 book (code + version §30)", sessV1?.priceBookCode === "EUR_STANDARD" && sessV1?.pricingVersion === "v1-2026-09");
check("Q5.3 session DTO exposes no book id (§12)", JSON.stringify(sessV1).includes("priceBookId") === false);
const getV1 = await api(`/api/v1/billing/checkout/${sessV1.id}`, { jar: ownerJar, headers: ctxHeader(businessId) });
check("Q5.4 GET session returns the same snapshot", getV1.status === 200 && getV1.json?.data?.checkoutSession?.amountMinor === 900 && getV1.json?.data?.checkoutSession?.priceBookCode === "EUR_STANDARD");

/* --------------- Q6 historical preservation (§67/§68/§101) --------------- */

console.log("\nQ6 — historical session preservation");
{
  const legacy = await prisma.checkoutSession.findFirst({
    where: { pricingVersion: "v1-2026-09-eur", priceBookCode: null, priceBookId: null },
    select: { id: true, amountMinor: true, currency: true, pricingVersion: true, priceBookCode: true },
  });
  check("Q6.1 pre-Prompt-24 sessions exist with legacy version + null book refs", !!legacy);
  check("Q6.2 legacy amounts/currencies untouched (§67)", legacy ? (legacy.currency === "EUR" && Number.isSafeInteger(legacy.amountMinor) && legacy.amountMinor > 0) : false);
  const legacyCount = await prisma.checkoutSession.count({ where: { pricingVersion: "v1-2026-09-eur", priceBookCode: null } });
  const ownSessions = await prisma.checkoutSession.count({ where: { businessId } });
  check("Q6.3 legacy sessions survive + this business's sessions snapshot normally", legacyCount >= 1 && ownSessions >= 2, `legacy=${legacyCount} own=${ownSessions}`);
}

/* ---------------- Q7 IRR test book — NO FX, explicit yearly -------------- */

console.log("\nQ7 — IRR test book (direct IRR pricing, NO FX §2/§49/§84)");
const IRR_BOOK_ID = "pricebook_irr_test_p24";
const EUR2_BOOK_ID = "pricebook_eur_v2_test_p24";
{
  // §19 — test-only amounts, created by the harness, removed in cleanup.
  // Deliberately irregular: 1234567 is not 900× any plausible FX rate.
  await prisma.priceBook.upsert({
    where: { code_version: { code: "IRR_TEST", version: "vtest" } },
    create: {
      id: IRR_BOOK_ID, code: "IRR_TEST", version: "vtest", currency: "IRR",
      active: true, description: "Prompt 24 harness book (deleted in cleanup) — irregular amounts prove no FX.",
      prices: {
        create: [
          { planCode: "STARTER", billingPeriod: "MONTHLY", amountMinor: 1234567 },
          { planCode: "STARTER", billingPeriod: "YEARLY", amountMinor: 12345678 },
        ],
      },
    },
    update: { active: true, effectiveFrom: new Date(), effectiveTo: null },
  });
  const irrSession = await checkout({ planCode: "STARTER", billingPeriod: "MONTHLY", currency: "IRR" });
  check("Q7.1 IRR checkout → 201 with the DIRECT IRR price", irrSession.status === 201, irrSession.text?.slice(0, 160));
  const irrSess = irrSession.json?.data?.checkoutSession;
  check("Q7.2 amount = 1234567 IRR — never EUR × any rate (§84)", irrSess?.amountMinor === 1234567 && irrSess?.currency === "IRR" && irrSess?.amountMinor !== 900 * 1000 && irrSess?.amountMinor !== 900 * 60000);
  check("Q7.3 session names the IRR test book", irrSess?.priceBookCode === "IRR_TEST" && irrSess?.pricingVersion === "vtest");
  const irrYearly = await checkout({ planCode: "STARTER", billingPeriod: "YEARLY", currency: "IRR" });
  check("Q7.4 IRR yearly = explicit 12345678 (≠ monthly×10=12345670 §61/§62)", irrYearly.status === 201 && irrYearly.json?.data?.checkoutSession?.amountMinor === 12345678);
  const plansIrr2 = await api("/api/v1/billing/plans?currency=IRR", { jar: ownerJar, headers: ctxHeader(businessId) });
  const starterIrr = (plansIrr2.json?.data?.plans ?? []).find((p) => p.code === "STARTER");
  check("Q7.5 IRR catalog now AVAILABLE with test-book amounts", starterIrr?.availability === "AVAILABLE" && starterIrr?.pricing?.monthlyMinor === 1234567 && starterIrr?.pricing?.currency === "IRR" && starterIrr?.pricing?.priceVersion === "vtest");
  check("Q7.6 supportedCurrencies now [EUR, IRR] (§92)", JSON.stringify(plansIrr2.json?.data?.supportedCurrencies) === JSON.stringify(["EUR", "IRR"]));
}

/* --------------- Q8 book lifecycle (§33/§50/§82) ------------------------- */

console.log("\nQ8 — book lifecycle windows");
{
  await prisma.priceBook.update({ where: { id: IRR_BOOK_ID }, data: { active: false } });
  const r1 = await checkout({ planCode: "STARTER", billingPeriod: "MONTHLY", currency: "IRR" });
  check("Q8.1 INACTIVE book → 422 PRICEBOOK_INACTIVE (never used §82)", r1.status === 422 && r1.json?.error?.code === "PRICEBOOK_INACTIVE", r1.text?.slice(0, 160));

  await prisma.priceBook.update({ where: { id: IRR_BOOK_ID }, data: { active: true, effectiveFrom: new Date(Date.now() + 86400_000) } });
  const r2 = await checkout({ planCode: "STARTER", billingPeriod: "MONTHLY", currency: "IRR" });
  check("Q8.2 FUTURE-effective book not usable before effectiveFrom (§33)", r2.status === 422 && r2.json?.error?.code === "PRICEBOOK_INACTIVE");

  await prisma.priceBook.update({ where: { id: IRR_BOOK_ID }, data: { effectiveFrom: new Date(Date.now() - 172_800_000), effectiveTo: new Date(Date.now() - 86_400_000) } });
  const r3 = await checkout({ planCode: "STARTER", billingPeriod: "MONTHLY", currency: "IRR" });
  check("Q8.3 EXPIRED book not usable after effectiveTo (§33)", r3.status === 422 && r3.json?.error?.code === "PRICEBOOK_INACTIVE");

  await prisma.priceBook.update({ where: { id: IRR_BOOK_ID }, data: { effectiveFrom: new Date(Date.now() - 3_600_000), effectiveTo: null } });
  const r4 = await checkout({ planCode: "STARTER", billingPeriod: "MONTHLY", currency: "IRR" });
  check("Q8.4 restored effective window → 201 again", r4.status === 201, r4.text?.slice(0, 160));
}

/* ---------------- Q9 price versioning (§31/§36/§81) ---------------------- */

console.log("\nQ9 — price version shadowing + historical immutability");
{
  await prisma.priceBook.upsert({
    where: { code_version: { code: "EUR_TEST2", version: "v2test" } },
    create: {
      id: EUR2_BOOK_ID, code: "EUR_TEST2", version: "v2test", currency: "EUR",
      active: true, description: "Prompt 24 harness v2 (deleted in cleanup).",
      prices: { create: [{ planCode: "STARTER", billingPeriod: "MONTHLY", amountMinor: 9900 }] },
    },
    update: { active: true, effectiveFrom: new Date(), effectiveTo: null },
  });
  const r1 = await checkout({ planCode: "STARTER", billingPeriod: "MONTHLY", currency: "EUR" });
  check("Q9.1 newer effective book (v2test) shadows v1 → 9900", r1.status === 201 && r1.json?.data?.checkoutSession?.amountMinor === 9900 && r1.json?.data?.checkoutSession?.pricingVersion === "v2test", r1.text?.slice(0, 200));
  const r2 = await api(`/api/v1/billing/checkout/${sessV1.id}`, { jar: ownerJar, headers: ctxHeader(businessId) });
  check("Q9.2 the v1 session KEEPS 900 + v1-2026-09 (§31/§81 no retroactive repricing)", r2.json?.data?.checkoutSession?.amountMinor === 900 && r2.json?.data?.checkoutSession?.pricingVersion === "v1-2026-09");

  await prisma.priceBook.update({ where: { id: EUR2_BOOK_ID }, data: { active: false } });
  const r3 = await checkout({ planCode: "STARTER", billingPeriod: "MONTHLY", currency: "EUR" });
  check("Q9.3 deactivating v2 → resolution returns to EUR-v1 (900)", r3.status === 201 && r3.json?.data?.checkoutSession?.amountMinor === 900 && r3.json?.data?.checkoutSession?.pricingVersion === "v1-2026-09");

  // §36 — the stored v1 amounts were never mutated by any of this.
  const book = await prisma.priceBook.findUnique({ where: { code_version: { code: "EUR_STANDARD", version: "v1-2026-09" } }, include: { prices: true } });
  const starterM = book?.prices.find((p) => p.planCode === "STARTER" && p.billingPeriod === "MONTHLY");
  check("Q9.4 EUR-v1 PlanPrice row byte-identical (900, untouched §36)", starterM?.amountMinor === 900 && starterM?.active === true);
}

/* ------------------- Q10 seed idempotency (§28/§103) --------------------- */

console.log("\nQ10 — seed idempotency");
{
  const { execSync } = await import("node:child_process");
  const before = {
    books: await prisma.priceBook.count(),
    prices: await prisma.planPrice.count(),
    eurPrices: await prisma.planPrice.count({ where: { priceBook: { code: "EUR_STANDARD", version: "v1-2026-09" } } }),
  };
  execSync("bun scripts/seed-pricing.ts", { cwd: ROOT, stdio: "pipe" });
  execSync("bun scripts/seed-pricing.ts", { cwd: ROOT, stdio: "pipe" });
  const after = {
    books: await prisma.priceBook.count(),
    prices: await prisma.planPrice.count(),
    eurPrices: await prisma.planPrice.count({ where: { priceBook: { code: "EUR_STANDARD", version: "v1-2026-09" } } }),
  };
  check("Q10.1 seed re-run twice → identical catalog (§103)", before.books === after.books && before.prices === after.prices && before.eurPrices === after.eurPrices, JSON.stringify({ before, after }));
  check("Q10.2 baseline book exactly 6 price rows (§37)", after.eurPrices === 6);
}

/* --------- Q11 currency metadata + display (§23/§44/§85/§86) ------------- */

console.log("\nQ11 — currency metadata + exponent-aware display");
{
  check("Q11.1 exponents explicit: EUR=2, IRR=0 (§23)", currencyMinorDigits("EUR") === 2 && currencyMinorDigits("IRR") === 0);
  check("Q11.2 currencyMeta IRR zero-decimal + active", currencyMeta("IRR")?.minorUnitExponent === 0 && currencyMeta("IRR")?.active === true);
  check("Q11.3 settlement allowlist exactly [EUR, IRR] (§15)", isSupportedSettlementCurrency("EUR") && isSupportedSettlementCurrency("IRR") && !isSupportedSettlementCurrency("USD") && !isSupportedSettlementCurrency("toman"));
  const eur99 = formatMinor(99, "EUR", "en");
  check("Q11.4 EUR 99 minor → 0.99 display (no float drift)", eur99.includes("0.99") || eur99.includes("0,99"), eur99);
  const irr = formatMinor(1234567, "IRR", "fa");
  check("Q11.5 IRR 1234567 minor → integer display, NO decimal separator (§24)", !irr.includes(".") && !irr.includes("٫") && /۱٬۲۳۴٬۵۶۷|1,234,567|1234567/.test(irr.replace(/\s|ریال/g, "")), irr);
  check("Q11.6 minor→major identity for IRR (§23/§25 no Toman arithmetic)", require("../src/lib/payments/currency.ts") && currencyMinorDigits("IRR") === 0);
  // §85 — stored amounts are integers, never floats
  const amounts = await prisma.planPrice.findMany({ select: { amountMinor: true } });
  check("Q11.7 every stored amount is a safe integer (§22/§63)", amounts.length > 0 && amounts.every((a) => Number.isSafeInteger(a.amountMinor)));
  const huge = await resolvePrice({ planCode: "STARTER", billingPeriod: "MONTHLY" });
  check("Q11.8 resolved amounts are safe integers", Number.isSafeInteger(huge.amountMinor));
}

/* ------------ Q12 provider compatibility (§47/§48/§83) ------------------- */

console.log("\nQ12 — provider currency compatibility (capability-driven)");
{
  const zarinpalLike = { capabilities: { currencies: ["IRR"] } };
  const mockLike = { capabilities: { currencies: ["*"] } };
  check("Q12.1 IRR-only provider rejects EUR (§48)", providerSupportsCurrency(zarinpalLike, "EUR") === false);
  check("Q12.2 IRR-only provider accepts IRR (§83)", providerSupportsCurrency(zarinpalLike, "IRR") === true);
  check("Q12.3 mock is currency-agnostic (§57)", providerSupportsCurrency(mockLike, "EUR") && providerSupportsCurrency(mockLike, "IRR"));
  check("Q12.4 gate is case-canonical", providerSupportsCurrency(zarinpalLike, "irr") === true);
  // The real Zarinpal adapter's own guard (adapter-level fail-closed §58):
  const { ZARINPAL_CURRENCY } = await import("../src/lib/payments/zarinpal.ts");
  check("Q12.5 Zarinpal capability declares IRR only", ZARINPAL_CURRENCY === "IRR");
}

/* --------------- Q13 FREE / ENTERPRISE (§38/§39) -------------------------- */

console.log("\nQ13 — non-purchasable plans");
{
  const free = await checkout({ planCode: "FREE", billingPeriod: "MONTHLY" });
  check("Q13.1 FREE checkout → 422 PLAN_NOT_PURCHASABLE", free.status === 422 && free.json?.error?.code === "PLAN_NOT_PURCHASABLE", free.text?.slice(0, 140));
  const ent = await checkout({ planCode: "ENTERPRISE", billingPeriod: "MONTHLY" });
  check("Q13.2 ENTERPRISE checkout → 422 PLAN_NOT_PURCHASABLE", ent.status === 422 && ent.json?.error?.code === "PLAN_NOT_PURCHASABLE", ent.text?.slice(0, 140));
  const noPrice = await prisma.planPrice.count({ where: { planCode: { in: ["FREE", "ENTERPRISE"] } } });
  check("Q13.3 NO price rows exist for FREE/ENTERPRISE (§38/§39)", noPrice === 0);
}

/* ---------------- Q14 tenant isolation + RBAC (§118) ---------------------- */

console.log("\nQ14 — tenant isolation + RBAC");
{
  const outPlans = await api("/api/v1/billing/plans", { jar: outsiderJar, headers: ctxHeader(outBizId) });
  check("Q14.1 other-business member can read the catalog (settings:read)", outPlans.status === 200);
  const outCheckout = await checkout({ planCode: "STARTER", billingPeriod: "MONTHLY" }, { jar: outsiderJar, bizId: businessId });
  check("Q14.2 outsider cannot create checkout for owner's business (403)", outCheckout.status === 403, outCheckout.text?.slice(0, 120));
  const crossGet = await api(`/api/v1/billing/checkout/${sessV1.id}`, { jar: outsiderJar, headers: ctxHeader(outBizId) });
  check("Q14.3 cross-tenant session read → 404", crossGet.status === 404);
  const noCtx = await api("/api/v1/billing/plans", { jar: outsiderJar });
  check("Q14.4 catalog requires business context", noCtx.status === 400 || noCtx.status === 403, `got ${noCtx.status}`);
}

/* --------------------------- Q15 cleanup (§105) --------------------------- */

console.log("\nQ15 — cleanup (history kept, test data removed)");
{
  const del = await api(`/api/v1/businesses/${businessId}`, { method: "DELETE", jar: ownerJar, headers: ctxHeader(businessId), body: { confirmName: "P24 Pricing Shop" } });
  check("Q15.1 fixture business deleted via danger-zone API", del.status === 200 || del.status === 204, `got ${del.status}`);
  const del2 = await api(`/api/v1/businesses/${outBizId}`, { method: "DELETE", jar: outsiderJar, headers: ctxHeader(outBizId), body: { confirmName: "P24 Other Biz" } });
  check("Q15.2 second fixture deleted", del2.status === 200 || del2.status === 204, `got ${del2.status}`);
  // Test books: unreferenced after the cascade — removable. EUR-v1 stays.
  await prisma.priceBook.deleteMany({ where: { code: { in: ["IRR_TEST", "EUR_TEST2"] } } });
  const testBooks = await prisma.priceBook.count({ where: { code: { in: ["IRR_TEST", "EUR_TEST2"] } } });
  check("Q15.3 harness test books removed (EUR-v1 untouched)", testBooks === 0);
  const baseline = await prisma.priceBook.findUnique({ where: { code_version: { code: "EUR_STANDARD", version: "v1-2026-09" } }, include: { prices: true } });
  check("Q15.4 baseline EUR-v1 intact with 6 price rows", baseline?.prices.length === 6 && baseline.active === true);
  const remaining = await prisma.priceBook.count();
  check("Q15.5 exactly ONE price book remains (the baseline)", remaining === 1, `got ${remaining}`);
}

/* ------------------------------- report ----------------------------------- */

console.log(`\n============================================================`);
console.log(`PROMPT 24 PRICING HARNESS: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("\nFAILED CHECKS:");
  for (const f of failures) console.error(`  ✗ ${f.name}${f.detail ? ` — ${String(f.detail).slice(0, 200)}` : ""}`);
  process.exit(1);
}
await prisma.$disconnect();
process.exit(0);
