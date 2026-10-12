#!/usr/bin/env node
/**
 * scripts/prompt25-pricing-ui-check.mjs — Prompt 25 harness (bun, live dev
 * server). Public pricing layer / trial / onboarding / conversion events.
 *
 * Prompt 46 baseline recovery: the obsolete public-commerce endpoints
 * (GET /api/v1/public/pricing, POST /api/v1/public/analytics,
 * POST /api/v1/public/contact, POST /api/v1/onboarding/dismiss) were REMOVED
 * from the codebase — they referenced Prisma models that do not exist
 * (AnalyticsEvent, ContactLead, Business.onboardingDismissedAt). This harness
 * now exercises the CANONICAL architecture that actually ships:
 *   - public pricing  → GET /api/public/pricing   (src/lib/billing/public-pricing.ts)
 *   - funnel events   → POST /api/public/events   (CommercialEvent, src/lib/billing/events.ts)
 *   - onboarding      → GET /api/v1/onboarding/status + POST /api/v1/onboarding/complete
 * and asserts the legacy endpoints return 404.
 *
 * Coverage:
 *   Q1  Setup (owner + outsider, business A for owner)
 *   Q2  Public pricing API (canonical): no session, id-free catalog, prices
 *       == DB PlanPrice rows (one source of truth, §136), funnel cookie issued
 *   Q3  Currency behavior: EUR canonicalized, IRR listed only when actually
 *       priced (no FX numbers anywhere), USD/EURO → 422
 *   Q4  Price tampering: checkout strict schema rejects client
 *       amount/priceVersion/priceBookId (§162)
 *   Q5  Public funnel events (canonical): legacy ingest 404, strict allowlist
 *       (forged lifecycle events → 404), server-side dimension capping +
 *       schema sanitization, in-memory rate limit (60/min per IP)
 *   Q6  Contact honesty: legacy /api/v1/public/contact 404; /pricing ships
 *       no fake contact form; contactSalesUrl only when configured
 *   Q7  Onboarding status/complete (canonical): server-derived checklist,
 *       cross-tenant 403, legacy dismiss 404, idempotent completion, RBAC
 *   Q8  Server-authoritative funnel events: signup/business/onboarding/
 *       checkout — exactly-once via dedupe keys (CommercialEvent ledger)
 *   Q9  FREE/ENTERPRISE honesty: no price rows, checkout 422 (§165/§166)
 *   Q10 Trial (self-adapting to the live trial configuration):
 *        disabled → 422; enabled → TRIALING lifecycle + TRIAL_STARTED once
 *   Q11 Cleanup via the real danger-zone API + synthetic funnel rows
 *
 * Usage: bun scripts/prompt25-pricing-ui-check.mjs [baseUrl]
 * Exit:  0 = all checks passed · 1 = failures printed
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const ROOT = "/home/z/my-project";
const TEST_IP = `10.211.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
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

async function api(path, { method = "GET", body, headers = {}, jar, session } = {}) {
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
  } catch {}
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
const DOMAIN = "p25check.local";
const PASSWORD = "p25-Passw0rd!";
const ownerEmail = `owner-${STAMP}@${DOMAIN}`;
const managerEmail = `manager-${STAMP}@${DOMAIN}`;
// A server-issued funnel identity we control: every anonymous event this
// harness posts carries it (copilot_funnel cookie), so the synthetic rows
// are traceable and removable in the cleanup section.
const FUNNEL_KEY = crypto.randomUUID();
const FUNNEL_COOKIE = `copilot_funnel=${FUNNEL_KEY}`;

console.log(`\n=== Prompt 25 — public pricing / trial / onboarding harness (IP ${TEST_IP}) ===\n`);

// ---------------------------------------------------------------------------
console.log("Q1 — setup");
const ownerJar = await register("P25 Owner", ownerEmail, PASSWORD);
const managerJar = await register("P25 Manager", managerEmail, PASSWORD);
const bizRes = await api("/api/v1/businesses", {
  method: "POST",
  jar: ownerJar,
  body: { name: `P25 Pricing Shop ${STAMP}`, currencyCode: "EUR", locale: "en" },
});
check("Q1.1 business created", bizRes.status === 201, bizRes.text?.slice(0, 160));
const businessId = bizRes.json?.data?.business?.id;
check("Q1.2 business id resolved", Boolean(businessId));
// Onboarding state no longer lives on the Business row (the dismissal column
// was removed with the dead /api/v1/onboarding/dismiss endpoint): completion
// is a server-recorded CommercialEvent surfaced via GET /api/v1/onboarding/status.
const bizFlags = bizRes.json?.data?.business ?? {};
check(
  "Q1.3 business payload carries no onboarding-dismissal state (state lives in the event ledger + status API)",
  !("onboardingDismissedAt" in bizFlags) && !("onboardingCompletedAt" in bizFlags),
  Object.keys(bizFlags).filter((k) => k.startsWith("onboarding")).join(","),
);

// ---------------------------------------------------------------------------
console.log("\nQ2 — public pricing API (canonical GET /api/public/pricing, §116/§125/§136)");
const pub = await api("/api/public/pricing");
check("Q2.1 public pricing reachable WITHOUT a session (§62)", pub.status === 200, pub.status);
const payload = pub.json?.data;
check("Q2.2 payload resolved", Boolean(payload?.plans?.length));
check("Q2.3 default settlement currency is EUR (deployment default)", payload?.currency === "EUR", payload?.currency);
const orderCodes = (payload?.plans ?? []).map((p) => p.code);
check("Q2.4 stable catalog order FREE→STARTER→BUSINESS→PRO→ENTERPRISE (§7)", JSON.stringify(orderCodes) === JSON.stringify(["FREE", "STARTER", "BUSINESS", "PRO", "ENTERPRISE"]), orderCodes.join(","));
check("Q2.5 availability flags honest (FREE/STARTER/ENTERPRISE)", payload?.plans?.[0]?.availability === "NOT_PURCHASABLE" && payload?.plans?.[1]?.availability === "AVAILABLE" && payload?.plans?.[4]?.availability === "NOT_SELF_SERVICE", JSON.stringify(payload?.plans?.map((p) => [p.code, p.availability])));
check("Q2.6 EUR exposed as a supported currency (active+effective book)", payload?.supportedCurrencies?.includes("EUR") === true, JSON.stringify(payload?.supportedCurrencies));
const irrBook = await prisma.priceBook.findFirst({
  where: { currency: "IRR", active: true, effectiveFrom: { lte: new Date() }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }] },
  orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
});
check("Q2.7 IRR listed as supported ONLY when an active+effective IRR book exists (never assumed)", payload?.supportedCurrencies?.includes("IRR") === Boolean(irrBook), String(Boolean(irrBook)));
check("Q2.8 every plan carries the full 9-entitlement feature matrix (§10/§70)", (payload?.plans?.length ?? 0) > 0 && payload.plans.every((p) => p.features?.length === 9 && p.features.every((f) => typeof f.code === "string" && (f.type === "LIMIT" || f.type === "BOOLEAN"))));
const rawText = pub.text ?? "";
check("Q2.9 NO internal DB ids / book ids in payload (§116)", !/"id":/.test(rawText) && !/"priceBookId"/.test(rawText) && !/"userId"/.test(rawText));
// Price truth vs DB (§77: assert DB values, never literals)
const eurBook = await prisma.priceBook.findFirst({
  where: { currency: "EUR", active: true, effectiveFrom: { lte: new Date() }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }] },
  orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
});
const dbRows = eurBook ? await prisma.planPrice.findMany({ where: { priceBookId: eurBook.id } }) : [];
let pricesMatch = Boolean(eurBook);
for (const plan of ["STARTER", "BUSINESS", "PRO"]) {
  const p = payload?.plans?.find((x) => x.code === plan);
  const m = dbRows.find((r) => r.planCode === plan && r.billingPeriod === "MONTHLY");
  const y = dbRows.find((r) => r.planCode === plan && r.billingPeriod === "YEARLY");
  if (p?.pricing?.monthlyMinor !== m?.amountMinor || p?.pricing?.yearlyMinor !== y?.amountMinor || p?.pricing?.priceVersion !== eurBook?.version) pricesMatch = false;
}
check("Q2.10 payload prices == DB PlanPrice rows + version (§136/§137)", pricesMatch);
check("Q2.11 yearly rows are EXPLICIT (no derived ×10 assumption)", ["STARTER", "BUSINESS", "PRO"].every((c) => dbRows.some((r) => r.planCode === c && r.billingPeriod === "YEARLY")));
check("Q2.12 capability flags exposed honestly (payments/trial/trialDays)", typeof payload?.paymentsEnabled === "boolean" && typeof payload?.trialAvailable === "boolean" && (payload?.trialDays === null || typeof payload?.trialDays === "number"));
check("Q2.13 anonymous funnel cookie issued on the public read (first-party, server-issued)", (pub.res?.headers?.getSetCookie?.() ?? []).some((c) => c.startsWith("copilot_funnel=")) || (pub.res?.headers?.get("set-cookie") ?? "").includes("copilot_funnel="));

// ---------------------------------------------------------------------------
console.log("\nQ3 — currency behavior (§19/§78/§163)");
const pubIrr = await api("/api/public/pricing?currency=IRR");
const irrPayload = pubIrr.json?.data;
check("Q3.1 IRR request returns a valid payload (not an error)", pubIrr.status === 200 && Boolean(irrPayload), pubIrr.status);
const irrRows = irrBook ? await prisma.planPrice.findMany({ where: { priceBookId: irrBook.id } }) : [];
const irrPriced = (code) =>
  irrRows.some((r) => r.planCode === code && r.billingPeriod === "MONTHLY") &&
  irrRows.some((r) => r.planCode === code && r.billingPeriod === "YEARLY");
check("Q3.2 IRR support flag matches the DB books (unavailable → not listed)", irrPayload?.supportedCurrencies?.includes("IRR") === Boolean(irrBook), String(Boolean(irrBook)));
check("Q3.3 IRR paid plans priced exactly when the DB says so (never guessed)", ["STARTER", "BUSINESS", "PRO"].every((c) => {
  const p = irrPayload?.plans?.find((x) => x.code === c);
  return irrPriced(c) ? p?.availability === "AVAILABLE" : p?.availability === "NOT_PRICED" && p?.pricing === null;
}));
check("Q3.4 NO fabricated IRR numbers in the payload (no FX)", ["STARTER", "BUSINESS", "PRO"].every((c) => (irrPriced(c) ? true : irrPayload?.plans?.find((x) => x.code === c)?.pricing === null)));
const pubEurLower = await api("/api/public/pricing?currency=eur");
check("Q3.5 lowercase currency canonicalized to EUR", pubEurLower.json?.data?.currency === "EUR", pubEurLower.json?.data?.currency);
const pubUsd = await api("/api/public/pricing?currency=USD");
check("Q3.6 USD → 422 CURRENCY_NOT_SUPPORTED (allowlist, no display fallback)", pubUsd.status === 422 && pubUsd.json?.error?.code === "CURRENCY_NOT_SUPPORTED", pubUsd.text?.slice(0, 120));
const pubBad = await api("/api/public/pricing?currency=EURO");
check("Q3.7 malformed currency → 422 (never guessed)", pubBad.status === 422);

// ---------------------------------------------------------------------------
console.log("\nQ4 — price tampering (§162)");
const tamper = await api("/api/v1/billing/checkout", {
  method: "POST",
  jar: ownerJar,
  headers: ctxHeader(businessId),
  body: { planCode: "STARTER", billingPeriod: "MONTHLY", amountMinor: 1, priceVersion: "v0-evil", priceBookId: "cuspidevil" },
});
check("Q4.1 client amount/priceVersion/priceBookId → 422 (strict schema)", tamper.status === 422, tamper.text?.slice(0, 140));
const tamper2 = await api("/api/v1/billing/checkout", {
  method: "POST",
  jar: ownerJar,
  headers: ctxHeader(businessId),
  body: { planCode: "STARTER", billingPeriod: "MONTHLY", currency: "EUR" },
});
check("Q4.2 clean checkout still 201 (mock sandbox)", tamper2.status === 201, tamper2.text?.slice(0, 140));
// Response envelope: { checkoutSession: {...} } — the session DTO exposes
// pricingVersion but NEVER priceBookId (§12/§29).
const session4 = tamper2.json?.data?.checkoutSession ?? tamper2.json?.data ?? {};
const sessionId4 = session4.id;
check("Q4.3 session snapshot carries book version, never a book id (§12)", Boolean(session4.pricingVersion) && !("priceBookId" in session4), JSON.stringify(session4).slice(0, 140));
// Checkout limiter is 10/min/user — Q4 used 2 of them; pace the rest.
await new Promise((r) => setTimeout(r, 1500));

// ---------------------------------------------------------------------------
console.log("\nQ5 — public funnel events (canonical POST /api/public/events, §54/§104/§122/§159)");
const legacyAnalytics = await api("/api/v1/public/analytics", {
  method: "POST",
  body: { name: "PRICING_VIEWED", sessionId: "legacy-probe", props: { page: "pricing" } },
});
check("Q5.1 legacy /api/v1/public/analytics removed (404)", legacyAnalytics.status === 404, legacyAnalytics.status);
const ev1 = await api("/api/public/events", {
  method: "POST",
  headers: { cookie: FUNNEL_COOKIE },
  body: { eventType: "PRICING_VIEWED", planCode: "STARTER", currency: "EUR", source: "p25-check", route: "pricing" },
});
check("Q5.2 allowlisted anonymous event accepted", ev1.status === 200 && ev1.json?.data?.recorded === true, ev1.text?.slice(0, 120));
const evRow1 = await prisma.commercialEvent.findFirst({
  where: { anonymousSessionKey: FUNNEL_KEY, eventType: "PRICING_VIEWED", planCode: "STARTER" },
  orderBy: { createdAt: "desc" },
});
check("Q5.3 event recorded under the server-issued funnel identity with allowlisted dimensions", evRow1 !== null && evRow1.currency === "EUR" && evRow1.source === "p25-check" && evRow1.route === "pricing", JSON.stringify(evRow1)?.slice(0, 160));
const longCode = "X".repeat(40);
const ev2 = await api("/api/public/events", {
  method: "POST",
  headers: { cookie: FUNNEL_COOKIE },
  body: { eventType: "PRICING_VIEWED", planCode: longCode },
});
const evRow2 = await prisma.commercialEvent.findFirst({
  where: { anonymousSessionKey: FUNNEL_KEY, planCode: longCode },
});
check(
  "Q5.4 over-long caller dimension rejected server-side (planCode max 32 → 422, nothing stored)",
  ev2.status === 422 && evRow2 === null,
  `${ev2.status}`,
);
const forge1 = await api("/api/public/events", { method: "POST", headers: { cookie: FUNNEL_COOKIE }, body: { eventType: "CHECKOUT_COMPLETED" } });
const forge2 = await api("/api/public/events", { method: "POST", headers: { cookie: FUNNEL_COOKIE }, body: { eventType: "TRIAL_STARTED" } });
const forge3 = await api("/api/public/events", { method: "POST", headers: { cookie: FUNNEL_COOKIE }, body: { eventType: "SIGNUP_COMPLETED" } });
check("Q5.5 forged CHECKOUT_COMPLETED rejected (404 — lifecycle events are server-only)", forge1.status === 404, forge1.status);
check("Q5.6 forged TRIAL_STARTED rejected (404)", forge2.status === 404, forge2.status);
check("Q5.7 forged SIGNUP_COMPLETED rejected (404)", forge3.status === 404, forge3.status);
const evilProps = await api("/api/public/events", {
  method: "POST",
  headers: { cookie: FUNNEL_COOKIE },
  body: { eventType: "PRICING_PLAN_VIEWED", planCode: "STARTER", billingPeriod: "MONTHLY", password: "hunter2", card: "4111" },
});
const evilRow = await prisma.commercialEvent.findFirst({
  where: { anonymousSessionKey: FUNNEL_KEY, eventType: "PRICING_PLAN_VIEWED" },
  orderBy: { createdAt: "desc" },
});
check("Q5.8 unsafe props (password/card) never stored (§172)", evilProps.status === 200 && evilRow !== null && !JSON.stringify(evilRow).includes("hunter2") && !JSON.stringify(evilRow).includes("4111"), evilProps.status);
const badPeriod = await api("/api/public/events", {
  method: "POST",
  headers: { cookie: FUNNEL_COOKIE },
  body: { eventType: "PRICING_PLAN_VIEWED", planCode: "STARTER", billingPeriod: "WEEKLY" },
});
check("Q5.9 invalid dimension value → 422 validation error (schema-enforced)", badPeriod.status === 422, badPeriod.status);
// Rate limit: 60/min per IP (in-memory limiter). Fill it with cheap
// invalid-type posts (404 path — no DB writes), then assert engagement.
let sawLimited = null;
for (let i = 0; i < 80 && !sawLimited; i++) {
  const r = await api("/api/public/events", { method: "POST", headers: { cookie: FUNNEL_COOKIE }, body: { eventType: "RATE_LIMIT_FILLER" } });
  if (r.status === 429) sawLimited = r;
}
check("Q5.10 public-events rate limit engages (429 RATE_LIMITED)", sawLimited !== null && sawLimited.json?.error?.code === "RATE_LIMITED", sawLimited?.status);

// ---------------------------------------------------------------------------
console.log("\nQ6 — contact honesty (no fake form; contactSalesUrl only when configured)");
const legacyContact = await api("/api/v1/public/contact", {
  method: "POST",
  body: { name: "P25 Enterprise Lead", email: `lead-${STAMP}@${DOMAIN}`, company: "P25 Corp", message: "We need Enterprise limits for 400 staff." },
});
check("Q6.1 legacy /api/v1/public/contact removed (404 — no lead intake exists)", legacyContact.status === 404, legacyContact.status);
const pricingPage = await fetch(`${BASE}/pricing`, { headers: { "x-forwarded-for": TEST_IP } });
const pricingHtml = await pricingPage.text();
check("Q6.2 /pricing serves (200, html)", pricingPage.status === 200 && (pricingPage.headers.get("content-type") ?? "").includes("text/html"), pricingPage.status);
check("Q6.3 /pricing references no dead contact endpoint", !pricingHtml.includes("/api/v1/public/contact"));
check("Q6.4 contactSalesUrl surfaced only when configured (null or non-empty)", payload?.contactSalesUrl === null || (typeof payload?.contactSalesUrl === "string" && payload.contactSalesUrl.length > 0), JSON.stringify(payload?.contactSalesUrl));
check(
  "Q6.5 no sales contact configured → /pricing ships no fake form and no invented mailto",
  payload?.contactSalesUrl !== null || (!pricingHtml.includes("mailto:") && !/<form[\s>]/i.test(pricingHtml)),
);

// ---------------------------------------------------------------------------
console.log("\nQ7 — onboarding status / isolation / RBAC (canonical §160/§161)");
const managerPre = await api("/api/v1/onboarding/status", { jar: managerJar });
check("Q7.1 status before any business → 200 hasBusiness:false (empty checklist)", managerPre.status === 200 && managerPre.json?.data?.hasBusiness === false && managerPre.json?.data?.checklist === null, managerPre.text?.slice(0, 160));
const status1 = await api(`/api/v1/onboarding/status?businessId=${businessId}`, { jar: ownerJar });
check("Q7.2 status returns the server-derived checklist (real data, §100)", status1.status === 200 && status1.json?.data?.hasBusiness === true && status1.json?.data?.checklist?.customersCreated === false && status1.json?.data?.onboardingCompleted === false, status1.text?.slice(0, 200));
const crossTenant = await api(`/api/v1/onboarding/status?businessId=${businessId}`, { jar: managerJar });
check("Q7.3 non-member cannot read onboarding state (§123)", crossTenant.status === 403, crossTenant.status);
const dismiss1 = await api("/api/v1/onboarding/dismiss", { method: "POST", jar: ownerJar, headers: ctxHeader(businessId), body: {} });
check("Q7.4 legacy /api/v1/onboarding/dismiss removed (404 — skipping is not server state anymore)", dismiss1.status === 404, dismiss1.status);
const complete1 = await api("/api/v1/onboarding/complete", { method: "POST", jar: ownerJar, headers: ctxHeader(businessId), body: {} });
check("Q7.5 complete records onboarding completion server-side", complete1.status === 200 && complete1.json?.data?.completed === true && complete1.json?.data?.already === false, complete1.text?.slice(0, 140));
const complete2 = await api("/api/v1/onboarding/complete", { method: "POST", jar: ownerJar, headers: ctxHeader(businessId), body: {} });
check("Q7.6 completion is idempotent (already=true, no duplicate ledger row)", complete2.status === 200 && complete2.json?.data?.already === true, complete2.text?.slice(0, 140));
// Manager membership for RBAC checks
const mint = await api(`/api/v1/businesses/${businessId}/invites`, {
  method: "POST", jar: ownerJar, headers: ctxHeader(businessId),
  body: { email: managerEmail, role: "MANAGER" },
});
const managerToken = mint.json?.data?.token ?? mint.json?.data?.invite?.token;
const accepted = managerToken ? await api(`/api/v1/invites/${managerToken}`, { method: "POST", jar: managerJar }) : { status: 0 };
check("Q7.7 manager joined business A", accepted.status === 200 || accepted.status === 201, accepted.status);
const trialAsManager = await api("/api/v1/billing/trial", { method: "POST", jar: managerJar, headers: ctxHeader(businessId), body: { action: "start" } });
check("Q7.8 MANAGER cannot start a trial (settings:manage → 403 §161)", trialAsManager.status === 403, trialAsManager.status);
const statusAfterComplete = await api(`/api/v1/onboarding/status?businessId=${businessId}`, { jar: ownerJar });
check("Q7.9 status reflects the recorded completion", statusAfterComplete.json?.data?.onboardingCompleted === true, JSON.stringify(statusAfterComplete.json?.data)?.slice(0, 160));

// ---------------------------------------------------------------------------
console.log("\nQ8 — server-authoritative funnel events (CommercialEvent ledger, §55/§54)");
const owner = await prisma.user.findUnique({ where: { email: ownerEmail } });
const manager = await prisma.user.findUnique({ where: { email: managerEmail } });
const signupEvents = await prisma.commercialEvent.count({ where: { eventType: "SIGNUP_COMPLETED", dedupeKey: `signup:${owner.id}` } });
check("Q8.1 SIGNUP_COMPLETED once per user (server-side)", signupEvents === 1, signupEvents);
const bizEvents = await prisma.commercialEvent.count({ where: { eventType: "BUSINESS_CREATED", dedupeKey: `business:${businessId}` } });
check("Q8.2 BUSINESS_CREATED once per business", bizEvents === 1, bizEvents);
const onbStart1 = await prisma.commercialEvent.count({ where: { eventType: "ONBOARDING_STARTED", dedupeKey: `onb-start:${manager.id}` } });
check("Q8.3 ONBOARDING_STARTED once per user before any business (Q7.1/Q7.3 deduped)", onbStart1 === 1, onbStart1);
const onbDone = await prisma.commercialEvent.count({ where: { eventType: "ONBOARDING_COMPLETED", dedupeKey: `onb-done:${businessId}` } });
check("Q8.4 ONBOARDING_COMPLETED once (idempotent completion, Q7.5/Q7.6)", onbDone === 1, onbDone);
const checkoutEvents = await prisma.commercialEvent.count({ where: { eventType: "CHECKOUT_CREATED", dedupeKey: `checkout:${sessionId4}` } });
check("Q8.5 CHECKOUT_CREATED server-generated once (§52)", checkoutEvents === 1, checkoutEvents);

// ---------------------------------------------------------------------------
console.log("\nQ9 — FREE / ENTERPRISE honesty (§165/§166)");
check("Q9.1 FREE has NO PlanPrice rows in the book (§38)", !dbRows.some((r) => r.planCode === "FREE"));
check("Q9.2 ENTERPRISE has NO PlanPrice rows (§39)", !dbRows.some((r) => r.planCode === "ENTERPRISE"));
const buyFree = await api("/api/v1/billing/checkout", { method: "POST", jar: ownerJar, headers: ctxHeader(businessId), body: { planCode: "FREE", billingPeriod: "MONTHLY" } });
check("Q9.3 checkout FREE → 422 PLAN_NOT_PURCHASABLE", buyFree.status === 422 && buyFree.json?.error?.code === "PLAN_NOT_PURCHASABLE", buyFree.text?.slice(0, 120));
await new Promise((r) => setTimeout(r, 1200));
const buyEnt = await api("/api/v1/billing/checkout", { method: "POST", jar: ownerJar, headers: ctxHeader(businessId), body: { planCode: "ENTERPRISE", billingPeriod: "MONTHLY" } });
check("Q9.4 checkout ENTERPRISE → 422 (contact-sales only)", buyEnt.status === 422, buyEnt.status);

// ---------------------------------------------------------------------------
console.log("\nQ10 — trial behavior (self-adapting to the live flag, §157)");
const liveTrialsEnabled = payload?.trialAvailable === true;
const trialDisabled = await api("/api/v1/billing/trial", { method: "POST", jar: ownerJar, headers: ctxHeader(businessId), body: { action: "start" } });
if (!liveTrialsEnabled) {
  check("Q10.1 trials DISABLED → trial API 422 BUSINESS_NOT_ELIGIBLE", trialDisabled.status === 422 && trialDisabled.json?.error?.code === "BUSINESS_NOT_ELIGIBLE", trialDisabled.status);
  check("Q10.2 payload hides trialDays when trials are off (§34)", payload?.trialDays === null && payload?.trialAvailable === false);
  console.log("  · [info] trials are disabled in this deployment — the enabled-path (TRIALING lifecycle, TRIAL_STARTED event) is exercised when the operator enables them; state-machine coverage lives in prompt20-state-machine.test.ts.");
} else {
  check("Q10.1 payload advertises the CONFIGURED trialDays (§34)", typeof payload?.trialDays === "number" && payload.trialDays >= 1 && payload.trialDays <= 90);
  check("Q10.2 trial start → 200", trialDisabled.status === 200, trialDisabled.text?.slice(0, 140));
  const subAfter = await api("/api/v1/billing/subscription", { jar: ownerJar, headers: ctxHeader(businessId) });
  check("Q10.3 subscription now TRIALING", subAfter.json?.data?.subscription?.status === "TRIALING");
  const trialEvents = await prisma.commercialEvent.count({ where: { eventType: "TRIAL_STARTED", dedupeKey: `trial-start:${businessId}` } });
  check("Q10.4 TRIAL_STARTED exactly once (server §55)", trialEvents === 1, trialEvents);
  await new Promise((r) => setTimeout(r, 1200));
  const trialAgain = await api("/api/v1/billing/trial", { method: "POST", jar: ownerJar, headers: ctxHeader(businessId), body: { action: "start" } });
  check("Q10.5 second trial → 422 (one per business §32)", trialAgain.status === 422);
  const endTrial = await api("/api/v1/billing/trial", { method: "POST", jar: ownerJar, headers: ctxHeader(businessId), body: { action: "end" } });
  check("Q10.6 end trial → 200 (back through the standing state machine)", endTrial.status === 200, endTrial.status);
  const trialEvents2 = await prisma.commercialEvent.count({ where: { eventType: "TRIAL_STARTED", dedupeKey: `trial-start:${businessId}` } });
  check("Q10.7 still exactly one TRIAL_STARTED", trialEvents2 === 1, trialEvents2);
}

// ---------------------------------------------------------------------------
console.log("\nQ11 — cleanup (danger-zone API, fixture hygiene)");
const bizName = `P25 Pricing Shop ${STAMP}`;
const del = await api(`/api/v1/businesses/${businessId}`, { method: "DELETE", jar: ownerJar, headers: ctxHeader(businessId), body: { confirmName: bizName } });
check("Q11.1 fixture business deleted via real API", del.status === 200 || del.status === 204, del.status);
await prisma.commercialEvent.deleteMany({ where: { anonymousSessionKey: FUNNEL_KEY } });
check("Q11.2 harness funnel rows removed (server lifecycle events intentionally kept as synthetic ledger history)", (await prisma.commercialEvent.count({ where: { anonymousSessionKey: FUNNEL_KEY } })) === 0);

console.log(`\n=== Prompt 25 harness: ${passed} passed, ${failures.length} failed ===\n`);
if (failures.length > 0) {
  console.error("FAILED CHECKS:");
  for (const f of failures) console.error(`  ✗ ${f.name}${f.detail ? ` — ${String(f.detail).slice(0, 240)}` : ""}`);
  await prisma.$disconnect();
  process.exit(1);
}
await prisma.$disconnect();
process.exit(0);
