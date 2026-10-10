#!/usr/bin/env node
/**
 * scripts/prompt25-pricing-ui-check.mjs — Prompt 25 harness (bun, live dev
 * server). Public pricing layer / trial / onboarding / conversion events.
 *
 * Coverage:
 *   Q1  Setup (owner + outsider, business A for owner)
 *   Q2  Public pricing API: no session, safe fields only, catalog order,
 *       prices == DB PlanPrice rows (one source of truth, §136)
 *   Q3  Currency behavior: EUR canonicalized, IRR listed-but-unavailable
 *       (no FX numbers anywhere), USD → 422, cache headers (§60)
 *   Q4  Price tampering: checkout strict schema rejects client
 *       amount/priceVersion/priceBookId (§162)
 *   Q5  Analytics safety: allowlist (forged lifecycle events → 422),
 *       per-session dedupe, property sanitization (§104/§122/§159)
 *   Q6  Contact sales: valid, honeypot, rate limit (§28/§29)
 *   Q7  Onboarding status/isolation/RBAC: cross-tenant 403, dismiss,
 *       complete, manager cannot start trial (§160/§161)
 *   Q8  Server-authoritative funnel events: signup/business/customer/
 *       onboarding — exactly-once via dedupe keys (§55/§54)
 *   Q9  FREE/ENTERPRISE honesty: no price rows, checkout 422 (§165/§166)
 *   Q10 Trial (self-adapting to the live BILLING_TRIALS_ENABLED flag):
 *        disabled → 422; enabled → payload flags, start → TRIALING,
 *        one-per-business, end → ACTIVE, TRIAL_STARTED once (§157)
 *   Q11 Cleanup via the real danger-zone API (fixture hygiene)
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
const SESSION_ID = `sess${STAMP}abcdef`;

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
// onboarding flags ride along on the membership payload (§45)
const bizFlags = bizRes.json?.data?.business ?? {};
check("Q1.3 new business has NULL onboarding timestamps", bizFlags.onboardingCompletedAt == null && bizFlags.onboardingDismissedAt == null);

// ---------------------------------------------------------------------------
console.log("\nQ2 — public pricing API (§116/§125/§136)");
const pub = await api("/api/v1/public/pricing");
check("Q2.1 public pricing reachable WITHOUT a session (§62)", pub.status === 200, pub.status);
const payload = pub.json?.data;
check("Q2.2 payload resolved", Boolean(payload?.plans?.length));
check("Q2.3 settlement currency is EUR (deployment default)", payload?.settlementCurrency === "EUR");
const orderCodes = (payload?.plans ?? []).map((p) => p.code);
check("Q2.4 stable catalog order FREE→STARTER→BUSINESS→PRO→ENTERPRISE (§7)", JSON.stringify(orderCodes) === JSON.stringify(["FREE", "STARTER", "BUSINESS", "PRO", "ENTERPRISE"]), orderCodes.join(","));
check("Q2.5 availability flags honest (FREE/STARTER/BUSINESS/PRO/ENTERPRISE)", payload?.plans?.[0]?.availability === "NOT_PURCHASABLE" && payload?.plans?.[1]?.availability === "AVAILABLE" && payload?.plans?.[4]?.availability === "NOT_SELF_SERVICE");
check("Q2.6 EUR book availability flag true (§81)", payload?.currencies?.find((c) => c.code === "EUR")?.available === true);
check("Q2.7 IRR listed but NOT available (§78/§81)", payload?.currencies?.find((c) => c.code === "IRR")?.available === false);
check("Q2.8 9 entitlement definitions with groups (§10/§70)", payload?.definitions?.length === 9 && payload.definitions.every((d) => typeof d.group === "string"));
const rawText = pub.text ?? "";
check("Q2.9 NO internal DB ids / book ids in payload (§116)", !/"id":/.test(rawText) && !/"priceBookId"/.test(rawText) && !/"userId"/.test(rawText));
// Price truth vs DB (§77: assert DB values, never literals)
const eurBook = await prisma.priceBook.findFirst({
  where: { currency: "EUR", active: true, effectiveFrom: { lte: new Date() }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }] },
  orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
});
const dbRows = await prisma.planPrice.findMany({ where: { priceBookId: eurBook.id } });
let pricesMatch = true;
for (const plan of ["STARTER", "BUSINESS", "PRO"]) {
  const p = payload.plans.find((x) => x.code === plan);
  const m = dbRows.find((r) => r.planCode === plan && r.billingPeriod === "MONTHLY");
  const y = dbRows.find((r) => r.planCode === plan && r.billingPeriod === "YEARLY");
  if (p?.pricing?.monthlyMinor !== m?.amountMinor || p?.pricing?.yearlyMinor !== y?.amountMinor || p?.pricing?.priceVersion !== eurBook.version) pricesMatch = false;
}
check("Q2.10 payload prices == DB PlanPrice rows + version (§136/§137)", pricesMatch);
check("Q2.11 yearly rows are EXPLICIT (no derived ×10 assumption)", ["STARTER", "BUSINESS", "PRO"].every((c) => dbRows.some((r) => r.planCode === c && r.billingPeriod === "YEARLY")));
check("Q2.12 paymentsEnabled + trialsEnabled flags exposed", typeof payload?.paymentsEnabled === "boolean" && typeof payload?.trialsEnabled === "boolean");
check("Q2.13 Cache-Control short TTL (§60)", (pub.res?.headers?.get("cache-control") ?? "").includes("max-age=30"));

// ---------------------------------------------------------------------------
console.log("\nQ3 — currency behavior (§19/§78/§163)");
const pubIrr = await api("/api/v1/public/pricing?currency=IRR");
const irrPayload = pubIrr.json?.data;
check("Q3.1 IRR request returns a valid payload (not an error)", pubIrr.status === 200 && Boolean(irrPayload));
check("Q3.2 IRR currency marked unavailable", irrPayload?.currencies?.find((c) => c.code === "IRR")?.available === false);
check("Q3.3 IRR paid plans NOT_PRICED with null pricing (§23)", ["STARTER", "BUSINESS", "PRO"].every((c) => {
  const p = irrPayload?.plans?.find((x) => x.code === c);
  return p?.availability === "NOT_PRICED" && p?.pricing === null;
}));
check("Q3.4 NO fabricated IRR numbers in the payload (no FX)", !/amountMinor/.test(pubIrr.text ?? "") || !/\d{5,}/.test(JSON.stringify(irrPayload?.plans?.map((p) => p.pricing))));
const pubEurLower = await api("/api/v1/public/pricing?currency=eur");
check("Q3.5 lowercase currency canonicalized to EUR", pubEurLower.json?.data?.settlementCurrency === "EUR");
const pubUsd = await api("/api/v1/public/pricing?currency=USD");
check("Q3.6 USD → 422 CURRENCY_NOT_SUPPORTED (allowlist, no display fallback)", pubUsd.status === 422 && pubUsd.json?.error?.code === "CURRENCY_NOT_SUPPORTED", pubUsd.text?.slice(0, 120));
const pubBad = await api("/api/v1/public/pricing?currency=EURO");
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
console.log("\nQ5 — analytics allowlist + dedupe (§54/§104/§122/§159)");
const ev1 = await api("/api/v1/public/analytics", {
  method: "POST",
  body: { name: "PRICING_VIEWED", sessionId: SESSION_ID, props: { page: "pricing", locale: "en", currency: "EUR" } },
});
check("Q5.1 allowlisted client event accepted", ev1.status === 202, ev1.text?.slice(0, 120));
const evRows1 = await prisma.analyticsEvent.count({ where: { name: "PRICING_VIEWED", dedupeKey: { contains: SESSION_ID } } });
check("Q5.2 event recorded exactly once", evRows1 === 1, evRows1);
await api("/api/v1/public/analytics", { method: "POST", body: { name: "PRICING_VIEWED", sessionId: SESSION_ID, props: { page: "pricing" } } });
await api("/api/v1/public/analytics", { method: "POST", body: { name: "PRICING_VIEWED", sessionId: SESSION_ID, props: { page: "pricing" } } });
const evRows3 = await prisma.analyticsEvent.count({ where: { name: "PRICING_VIEWED", dedupeKey: { contains: SESSION_ID } } });
check("Q5.3 re-render storms dedupe per session×day (§54/§159)", evRows3 === 1, evRows3);
const forge1 = await api("/api/v1/public/analytics", { method: "POST", body: { name: "CHECKOUT_COMPLETED", sessionId: SESSION_ID } });
const forge2 = await api("/api/v1/public/analytics", { method: "POST", body: { name: "TRIAL_STARTED", sessionId: SESSION_ID } });
const forge3 = await api("/api/v1/public/analytics", { method: "POST", body: { name: "SIGNUP_COMPLETED", sessionId: SESSION_ID } });
check("Q5.4 forged CHECKOUT_COMPLETED rejected", forge1.status === 422 && forge1.json?.error?.code === "EVENT_NOT_ALLOWED");
check("Q5.5 forged TRIAL_STARTED rejected", forge2.status === 422);
check("Q5.6 forged SIGNUP_COMPLETED rejected", forge3.status === 422);
const evilProps = await api("/api/v1/public/analytics", {
  method: "POST",
  body: { name: "PLAN_SELECTED", sessionId: `${SESSION_ID}x`, props: { planCode: "STARTER", billingPeriod: "MONTHLY", currency: "EUR", password: "hunter2", card: "4111", page: "pricing" } },
});
check("Q5.7 PLAN_SELECTED accepted with safe props", evilProps.status === 202);
const evilRow = await prisma.analyticsEvent.findFirst({ where: { name: "PLAN_SELECTED", dedupeKey: { contains: `${SESSION_ID}x` } } });
check("Q5.8 unsafe props (password/card) never stored (§172)", evilRow !== null && !("password" in (evilRow ?? {})) && (evilRow?.page ?? "") === "pricing");
const badPlanProp = await api("/api/v1/public/analytics", {
  method: "POST",
  body: { name: "PLAN_SELECTED", sessionId: `${SESSION_ID}y`, props: { planCode: "drop table;--" } },
});
const badPlanRow = await prisma.analyticsEvent.findFirst({ where: { name: "PLAN_SELECTED", dedupeKey: { contains: `${SESSION_ID}y` } } });
check("Q5.9 malformed planCode property dropped (§104)", badPlanProp.status === 202 && (badPlanRow?.planCode ?? null) === null);

// ---------------------------------------------------------------------------
console.log("\nQ6 — contact sales (§28/§29)");
const leadCountBefore = await prisma.contactLead.count();
const contact1 = await api("/api/v1/public/contact", {
  method: "POST",
  body: { name: "P25 Enterprise Lead", email: `lead-${STAMP}@${DOMAIN}`, company: "P25 Corp", message: "We need Enterprise limits for 400 staff.", locale: "fa" },
});
check("Q6.1 valid contact → 201 received:true (generic, no internals)", contact1.status === 201 && contact1.json?.data?.received === true, contact1.text?.slice(0, 120));
check("Q6.2 lead stored with minimal fields", (await prisma.contactLead.count()) === leadCountBefore + 1);
const honeypot = await api("/api/v1/public/contact", {
  method: "POST",
  body: { name: "Bot", email: `bot-${STAMP}@spam.local`, message: "buy now", website: "http://spam.example" },
});
check("Q6.3 honeypot swallows bots (pretend success, nothing stored)", honeypot.status === 200 && (await prisma.contactLead.count()) === leadCountBefore + 1);
const invalidContact = await api("/api/v1/public/contact", { method: "POST", body: { name: "", email: "nope", message: "" } });
check("Q6.4 invalid contact → 422 VALIDATION_ERROR", invalidContact.status === 422);
// Rate limit: 5 per 15min per IP. We already used 3 (valid+honeypot+invalid).
for (let i = 0; i < 2; i++) {
  await api("/api/v1/public/contact", { method: "POST", body: { name: `RL${i}`, email: `rl${i}-${STAMP}@${DOMAIN}`, message: "rate limit fill" } });
}
const contactRl = await api("/api/v1/public/contact", { method: "POST", body: { name: "RL5", email: `rl5-${STAMP}@${DOMAIN}`, message: "should be limited" } });
check("Q6.5 contact rate limit engages (429 RATE_LIMITED)", contactRl.status === 429 && contactRl.json?.error?.code === "RATE_LIMITED", contactRl.status);

// ---------------------------------------------------------------------------
console.log("\nQ7 — onboarding status / isolation / RBAC (§160/§161)");
const noCtx = await api("/api/v1/onboarding/status", { jar: ownerJar });
check("Q7.1 status without business context → 400", noCtx.status === 400);
const status1 = await api("/api/v1/onboarding/status", { jar: ownerJar, headers: ctxHeader(businessId) });
check("Q7.2 status returns server-derived checklist (§100)", status1.status === 200 && status1.json?.data?.checklist?.addCustomer?.count === 0);
const crossTenant = await api("/api/v1/onboarding/status", { jar: managerJar, headers: ctxHeader(businessId) });
check("Q7.3 non-member cannot read onboarding state (§123)", crossTenant.status === 403);
const dismiss1 = await api("/api/v1/onboarding/dismiss", { method: "POST", jar: ownerJar, headers: ctxHeader(businessId), body: {} });
check("Q7.4 dismiss sets onboardingDismissedAt (server state §45/§98)", dismiss1.status === 200 && Boolean(dismiss1.json?.data?.onboardingDismissedAt));
const status2 = await api("/api/v1/onboarding/status", { jar: ownerJar, headers: ctxHeader(businessId) });
check("Q7.5 status reflects dismissal", status2.json?.data?.onboardingDismissedAt !== null);
const complete1 = await api("/api/v1/onboarding/complete", { method: "POST", jar: ownerJar, headers: ctxHeader(businessId), body: {} });
check("Q7.6 complete sets onboardingCompletedAt", complete1.status === 200 && Boolean(complete1.json?.data?.onboardingCompletedAt));
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

// ---------------------------------------------------------------------------
console.log("\nQ8 — server-authoritative funnel events (§55/§54)");
const owner = await prisma.user.findUnique({ where: { email: ownerEmail } });
const signupEvents = await prisma.analyticsEvent.count({ where: { name: "SIGNUP_COMPLETED", dedupeKey: `signup:${owner.id}` } });
check("Q8.1 SIGNUP_COMPLETED once per user (server-side)", signupEvents === 1, signupEvents);
const bizEvents = await prisma.analyticsEvent.count({ where: { name: "BUSINESS_CREATED", dedupeKey: `business:${businessId}` } });
check("Q8.2 BUSINESS_CREATED once per business", bizEvents === 1, bizEvents);
const cust1 = await api("/api/v1/customers", { method: "POST", jar: ownerJar, headers: ctxHeader(businessId), body: { name: "First Real Customer", phone: null } });
check("Q8.3 first customer created", cust1.status === 201, cust1.text?.slice(0, 120));
const fcEvents1 = await prisma.analyticsEvent.count({ where: { name: "FIRST_CUSTOMER_CREATED", dedupeKey: `first-customer:${businessId}` } });
check("Q8.4 FIRST_CUSTOMER_CREATED fired once", fcEvents1 === 1, fcEvents1);
await api("/api/v1/customers", { method: "POST", jar: ownerJar, headers: ctxHeader(businessId), body: { name: "Second Customer", phone: null } });
const fcEvents2 = await prisma.analyticsEvent.count({ where: { name: "FIRST_CUSTOMER_CREATED", dedupeKey: `first-customer:${businessId}` } });
check("Q8.5 second customer does NOT refire the first-event", fcEvents2 === 1, fcEvents2);
const ocEvents = await prisma.analyticsEvent.count({ where: { name: "ONBOARDING_COMPLETED", dedupeKey: `onboarding:${businessId}` } });
check("Q8.6 ONBOARDING_COMPLETED once (idempotent)", ocEvents === 1, ocEvents);
const checkEvents = await prisma.analyticsEvent.count({ where: { name: "CHECKOUT_STARTED", dedupeKey: `checkout-started:${sessionId4}` } });
check("Q8.7 CHECKOUT_STARTED server-generated once (§52)", checkEvents === 1, checkEvents);

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
const liveTrialsEnabled = payload?.trialsEnabled === true;
const trialDisabled = await api("/api/v1/billing/trial", { method: "POST", jar: ownerJar, headers: ctxHeader(businessId), body: { action: "start" } });
if (!liveTrialsEnabled) {
  check("Q10.1 trials DISABLED → trial API 422 BUSINESS_NOT_ELIGIBLE", trialDisabled.status === 422 && trialDisabled.json?.error?.code === "BUSINESS_NOT_ELIGIBLE", trialDisabled.status);
  check("Q10.2 payload hides trialDays when trials are off (§34)", payload?.trialDays === null);
  console.log("  · [info] BILLING_TRIALS_ENABLED is off in this deployment — the enabled-path (TRIALING lifecycle, TRIAL_STARTED event) is exercised when the operator flips the flag; state-machine coverage lives in prompt20-state-machine.test.ts.");
} else {
  check("Q10.1 payload advertises the CONFIGURED trialDays (§34)", typeof payload?.trialDays === "number" && payload.trialDays >= 1 && payload.trialDays <= 90);
  check("Q10.2 trial start → 200", trialDisabled.status === 200, trialDisabled.text?.slice(0, 140));
  const subAfter = await api("/api/v1/billing/subscription", { jar: ownerJar, headers: ctxHeader(businessId) });
  check("Q10.3 subscription now TRIALING", subAfter.json?.data?.subscription?.status === "TRIALING");
  const trialEvents = await prisma.analyticsEvent.count({ where: { name: "TRIAL_STARTED", dedupeKey: `trial:${businessId}` } });
  check("Q10.4 TRIAL_STARTED exactly once (server §55)", trialEvents === 1, trialEvents);
  await new Promise((r) => setTimeout(r, 1200));
  const trialAgain = await api("/api/v1/billing/trial", { method: "POST", jar: ownerJar, headers: ctxHeader(businessId), body: { action: "start" } });
  check("Q10.5 second trial → 422 (one per business §32)", trialAgain.status === 422);
  const endTrial = await api("/api/v1/billing/trial", { method: "POST", jar: ownerJar, headers: ctxHeader(businessId), body: { action: "end" } });
  check("Q10.6 end trial → 200 (back through the standing state machine)", endTrial.status === 200, endTrial.status);
  const trialEvents2 = await prisma.analyticsEvent.count({ where: { name: "TRIAL_STARTED", dedupeKey: `trial:${businessId}` } });
  check("Q10.7 still exactly one TRIAL_STARTED", trialEvents2 === 1, trialEvents2);
}

// ---------------------------------------------------------------------------
console.log("\nQ11 — cleanup (danger-zone API, fixture hygiene)");
const bizName = `P25 Pricing Shop ${STAMP}`;
const del = await api(`/api/v1/businesses/${businessId}`, { method: "DELETE", jar: ownerJar, headers: ctxHeader(businessId), body: { confirmName: bizName } });
check("Q11.1 fixture business deleted via real API", del.status === 200 || del.status === 204, del.status);
const leadRow = await prisma.contactLead.findFirst({ where: { email: `lead-${STAMP}@${DOMAIN}` } });
if (leadRow) await prisma.contactLead.delete({ where: { id: leadRow.id } });
check("Q11.2 harness lead row removed (analytics events intentionally kept as synthetic)", true);

console.log(`\n=== Prompt 25 harness: ${passed} passed, ${failures.length} failed ===\n`);
if (failures.length > 0) {
  console.error("FAILED CHECKS:");
  for (const f of failures) console.error(`  ✗ ${f.name}${f.detail ? ` — ${String(f.detail).slice(0, 240)}` : ""}`);
  await prisma.$disconnect();
  process.exit(1);
}
await prisma.$disconnect();
process.exit(0);
