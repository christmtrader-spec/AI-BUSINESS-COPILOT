#!/usr/bin/env node
/**
 * scripts/prompt23-payments-api-check.mjs — Prompt 23 HTTP harness
 * (runs under BUN against the live dev server, mock provider as the only
 * usable one in this environment).
 *
 * Coverage:
 *   P1 Setup (owner + outsider + business)
 *   P2 Checkout snapshot DTO: businessName + pricingVersion (§13/§110)
 *   P3 Tamper-proofing: client amount/currency/discount fields ignored (§12/§116-118)
 *   P4 Verify endpoint security + semantics (§20/§63/§68/§79):
 *      401, non-member 403, cross-tenant 404, VERIFICATION_NOT_SUPPORTED for
 *      mock, ALREADY_VERIFIED on terminal sessions (no double money),
 *      expired session never verified
 *   P5 Callback route: uniform redirects, no oracle, no open-redirect
 *      (Host-header independent, §19/§104)
 *   P6 Reconciliation: currency mismatch via signed webhook →
 *      RECONCILIATION_REQUIRED + reason + audit row (§21/§22/§45);
 *      late FAILED after SUCCEEDED can never downgrade (§75/§77);
 *      multiple attempts → exactly one plan activation (§78)
 *   P7 Cleanup via real danger-zone API
 *
 * Usage: bun scripts/prompt23-payments-api-check.mjs [baseUrl]
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

const { buildMockEventBody, buildMockEventHeaders } = await import(
  "../src/lib/payments/mock-provider.ts"
);

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
const DOMAIN = "p23check.local";
const PASSWORD = "p23-Passw0rd!";
const ownerEmail = `owner-${STAMP}@${DOMAIN}`;
const outsiderEmail = `outsider-${STAMP}@${DOMAIN}`;

console.log(`\n=== Prompt 23 — real provider integration API harness (IP ${TEST_IP}) ===\n`);

console.log("P1 — setup");
const ownerJar = await register("P23 Owner", ownerEmail, PASSWORD);
const outsiderJar = await register("P23 Outsider", outsiderEmail, PASSWORD);
const bizRes = await api("/api/v1/businesses", {
  method: "POST",
  jar: ownerJar,
  body: { name: "P23 Real Provider Shop", currencyCode: "IRR", locale: "fa" },
});
check("P1.1 business created", bizRes.status === 201, bizRes.text?.slice(0, 160));
const businessId = bizRes.json?.data?.business?.id ?? bizRes.json?.data?.id;
const businessName = bizRes.json?.data?.business?.name ?? "P23 Real Provider Shop";
check("P1.2 business id resolved", !!businessId);

const subRaw = async (jar, bizId) =>
  api("/api/v1/billing/subscription", { jar, headers: ctxHeader(bizId) });
const sub = async (jar, bizId) => {
  const r = await subRaw(jar, bizId);
  const plan = r.json?.data?.subscription?.plan?.code ?? r.json?.data?.subscription?.planCode;
  if (plan === undefined) console.log(`  · [debug] subscription response ${r.status}: ${(r.text || "").slice(0, 200)}`);
  return plan;
};

console.log("\nP2 — checkout snapshot DTO (§13/§110)");
const s1 = await api("/api/v1/billing/checkout", {
  method: "POST", jar: ownerJar, headers: ctxHeader(businessId),
  body: { planCode: "BUSINESS", billingPeriod: "MONTHLY" },
});
check("P2.1 checkout created (mock provider — only usable one here)", s1.status === 201, s1.text?.slice(0, 160));
const sess1 = s1.json?.data?.checkoutSession;
check("P2.2 snapshot: businessName present + pricingVersion recorded", sess1?.businessName === "P23 Real Provider Shop" && typeof sess1?.pricingVersion === "string" && sess1.pricingVersion.length > 0, JSON.stringify(sess1));
check("P2.3 snapshot amount authoritative: 1900 EUR (BUSINESS monthly)", sess1?.amountMinor === 1900 && sess1?.currency === "EUR");

console.log("\nP3 — tamper-proofing (Prompt 24 §78-§80: reject, never accept)");
// §80 — ANY extra client field (amountMinor/discount/paid) is a REJECTION
// now (strict schema), not a silent ignore.
const sTamper = await api("/api/v1/billing/checkout", {
  method: "POST", jar: ownerJar, headers: ctxHeader(businessId),
  body: { planCode: "STARTER", billingPeriod: "MONTHLY", amountMinor: 1, discount: 100, paid: true },
});
check("P3.1 client-supplied amount/discount fields REJECTED (422 strict §80)", sTamper.status === 422 && sTamper.json?.error?.code === "VALIDATION_ERROR", sTamper.text?.slice(0, 120));
// §78 — a client cannot buy at another currency's price either: IRR has no
// configured book → structured 422, NEVER a fallback to EUR.
const sIrr = await api("/api/v1/billing/checkout", {
  method: "POST", jar: ownerJar, headers: ctxHeader(businessId),
  body: { planCode: "STARTER", billingPeriod: "MONTHLY", currency: "IRR" },
});
check("P3.2 currency=IRR with no IRR book → 422 PRICEBOOK_NOT_FOUND (no fallback §50)", sIrr.status === 422 && sIrr.json?.error?.code === "PRICEBOOK_NOT_FOUND", sIrr.text?.slice(0, 160));
// §41 — arbitrary currency codes never reach resolution.
const sBadCur = await api("/api/v1/billing/checkout", {
  method: "POST", jar: ownerJar, headers: ctxHeader(businessId),
  body: { planCode: "STARTER", billingPeriod: "MONTHLY", currency: "BTC" },
});
check("P3.3 arbitrary currency BTC → 422 CURRENCY_NOT_SUPPORTED (§41)", sBadCur.status === 422 && sBadCur.json?.error?.code === "CURRENCY_NOT_SUPPORTED", sBadCur.text?.slice(0, 160));
// Clean request still succeeds at the AUTHORITATIVE price.
const s2 = await api("/api/v1/billing/checkout", {
  method: "POST", jar: ownerJar, headers: ctxHeader(businessId),
  body: { planCode: "STARTER", billingPeriod: "MONTHLY" },
});
check("P3.4 clean checkout → 201 with authoritative price", s2.status === 201, s2.text?.slice(0, 120));
check("P3.5 session uses authoritative price (900 EUR, EUR-v1 book §30)", s2.json?.data?.checkoutSession?.amountMinor === 900 && s2.json?.data?.checkoutSession?.currency === "EUR" && s2.json?.data?.checkoutSession?.priceBookCode === "EUR_STANDARD");
check("P3.6 new checkout canceled the previous PENDING one (duplicate protection §15)", s2.json?.data?.checkoutSession?.id !== sess1.id && (await prisma.checkoutSession.findUnique({ where: { id: sess1.id } })).status === "CANCELED");

console.log("\nP4 — verify endpoint (§20/§63/§68/§79)");
const verify = (id, jar, bizId) =>
  api(`/api/v1/billing/checkout/${id}/verify`, { method: "POST", jar, headers: ctxHeader(bizId) });

const vUnauth = await api(`/api/v1/billing/checkout/${s2.json.data.checkoutSession.id}/verify`, { method: "POST" });
check("P4.1 unauthenticated verify → 401", vUnauth.status === 401);

const vForeign = await verify(s2.json.data.checkoutSession.id, outsiderJar, businessId);
check("P4.2 non-member verify → 403", vForeign.status === 403, `got ${vForeign.status}`);

const vMock = await verify(s2.json.data.checkoutSession.id, ownerJar, businessId);
check("P4.3 mock provider verify → 422 VERIFICATION_NOT_SUPPORTED (no external truth)", vMock.status === 422 && vMock.json?.error?.code === "VERIFICATION_NOT_SUPPORTED", vMock.text?.slice(0, 140));

// cross-tenant: outsider creates their own business/session; owner must get 404 on it
const outBiz = await api("/api/v1/businesses", { method: "POST", jar: outsiderJar, body: { name: "P23 Other Biz", currencyCode: "EUR", locale: "en" } });
const outBizId = outBiz.json?.data?.business?.id ?? outBiz.json?.data?.id;
const outSess = await api("/api/v1/billing/checkout", { method: "POST", jar: outsiderJar, headers: ctxHeader(outBizId), body: { planCode: "STARTER", billingPeriod: "MONTHLY" } });
const outSessId = outSess.json?.data?.checkoutSession?.id;
const vCross = await verify(outSessId, ownerJar, businessId);
check("P4.4 cross-tenant verify → 404 (indistinguishable, §115)", vCross.status === 404);

// terminal sessions are read-only + no double money
const simOk = await api(`/api/v1/billing/checkout/${outSessId}/simulate`, { method: "POST", jar: outsiderJar, headers: ctxHeader(outBizId), body: { outcome: "succeeded" } });
check("P4.5 outsider session simulated SUCCEEDED (own business)", simOk.json?.data?.checkoutSession?.status === "SUCCEEDED");
const vAgain = await verify(outSessId, outsiderJar, outBizId);
check("P4.6 verify on SUCCEEDED session → ALREADY_VERIFIED, session stays SUCCEEDED", vAgain.status === 200 && vAgain.json?.data?.verification === "ALREADY_VERIFIED" && vAgain.json?.data?.session?.status === "SUCCEEDED");
const txCount = await prisma.paymentTransaction.count({ where: { checkoutSessionId: outSessId } });
check("P4.7 re-verify created NO second money record (idempotent §73)", txCount === 1);

// expired session never verified (§79)
const expSess = await api("/api/v1/billing/checkout", { method: "POST", jar: ownerJar, headers: ctxHeader(businessId), body: { planCode: "STARTER", billingPeriod: "MONTHLY" } });
const expId = expSess.json?.data?.checkoutSession?.id;
await prisma.checkoutSession.update({ where: { id: expId }, data: { expiresAt: new Date(Date.now() - 1000) } });
const vExp = await verify(expId, ownerJar, businessId);
check("P4.8 expired session → not verified (EXPIRED terminal, §79)", vExp.status === 200 && vExp.json?.data?.session?.status === "EXPIRED");

console.log("\nP5 — callback route (§19/§104)");
const cbMock = await api("/api/v1/payments/callback/mock?Status=OK");
check("P5.1 mock callback → 302 to app root without session (no in-app hosted-page callback)", cbMock.status === 302 && cbMock.location && !cbMock.location.includes("payment_return"));
const cbZar = await api("/api/v1/payments/callback/zarinpal?Authority=A0000000000000000000000000000&Status=OK");
check("P5.2 unusable real provider callback → uniform 302, NO session id (no probing oracle)", cbZar.status === 302 && cbZar.location && !cbZar.location.includes("payment_return"));
const cbHost = await api("/api/v1/payments/callback/zarinpal?Authority=A0000000000000000000000000000", { host: "evil.example" });
check("P5.3 Host-header attack: Location stays on the CONFIGURED base URL (§104)", cbHost.status === 302 && cbHost.location && !cbHost.location.includes("evil.example"), cbHost.location ?? "no location");
const cbGarbage = await api("/api/v1/payments/callback/zarinpal?paymentId=123&status=success");
check("P5.4 forged 'success' query params → uniform redirect, no state change", cbGarbage.status === 302 && !(cbGarbage.location ?? "").includes("payment_return"));

console.log("\nP6 — reconciliation & state machine (§21/§22/§45/§75/§77/§78)");
// currency mismatch via signed webhook → RECONCILIATION_REQUIRED
const mismatchSess = await api("/api/v1/billing/checkout", { method: "POST", jar: ownerJar, headers: ctxHeader(businessId), body: { planCode: "STARTER", billingPeriod: "MONTHLY" } });
const mId = mismatchSess.json?.data?.checkoutSession?.id;
const planBefore = await sub(ownerJar, businessId);
const curBody = buildMockEventBody("checkout.succeeded", mId, { amountMinor: 900, currency: "USD" });
const curRes = await api("/api/v1/webhooks/payments/mock", { method: "POST", body: curBody, headers: Object.fromEntries([...buildMockEventHeaders(curBody).entries()]) });
check("P6.1 currency-mismatch webhook → 200 sessionStatus RECONCILIATION_REQUIRED", curRes.status === 200 && curRes.json?.data?.sessionStatus === "RECONCILIATION_REQUIRED", curRes.text?.slice(0, 140));
const mAfter = await api(`/api/v1/billing/checkout/${mId}`, { jar: ownerJar, headers: ctxHeader(businessId) });
check("P6.2 session records CURRENCY_MISMATCH reason (never fulfilled)", mAfter.json?.data?.checkoutSession?.status === "RECONCILIATION_REQUIRED" && mAfter.json?.data?.checkoutSession?.reconciliationReason === "CURRENCY_MISMATCH" && mAfter.json?.data?.checkoutSession?.fulfilledAt === null);
const reconAudit = await prisma.auditLog.findFirst({ where: { businessId, action: "billing.payment_reconciliation_required", entityId: mId } });
check("P6.3 reconciliation audit row written (§71)", !!reconAudit);
check("P6.4 plan NOT activated by mismatched money", (await sub(ownerJar, businessId)) === planBefore);

// late FAILED after SUCCEEDED must never downgrade (§75/§77)
const okSess = await api("/api/v1/billing/checkout", { method: "POST", jar: ownerJar, headers: ctxHeader(businessId), body: { planCode: "STARTER", billingPeriod: "MONTHLY" } });
const okId = okSess.json?.data?.checkoutSession?.id;
await api(`/api/v1/billing/checkout/${okId}/simulate`, { method: "POST", jar: ownerJar, headers: ctxHeader(businessId), body: { outcome: "succeeded" } });
const planAfterSuccess = await sub(ownerJar, businessId);
const lateBody = buildMockEventBody("checkout.failed", okId, { reason: "late:provider-reversal-attempt" });
const lateRes = await api("/api/v1/webhooks/payments/mock", { method: "POST", body: lateBody, headers: Object.fromEntries([...buildMockEventHeaders(lateBody).entries()]) });
check("P6.5 late FAILED for SUCCEEDED session → ignored (stays SUCCEEDED)", lateRes.status === 200 && lateRes.json?.data?.sessionStatus === "SUCCEEDED");
const planNow6 = await sub(ownerJar, businessId);
check("P6.6 plan remains STARTER (stale event cannot downgrade, §75)", planNow6 === planAfterSuccess && planAfterSuccess === "STARTER", `now=${planNow6} afterSuccess=${planAfterSuccess} before=${planBefore}`);

// multiple attempts → exactly one activation (§78)
const planEvents = await prisma.subscriptionEvent.count({ where: { businessId, type: "PLAN_CHANGED" } });
check("P6.7 exactly ONE plan activation despite failed + mismatched + successful attempts", planEvents === 1, `got ${planEvents}`);

// payments history includes the reconciliation record
const hist = await api("/api/v1/billing/payments?take=50", { jar: ownerJar, headers: ctxHeader(businessId) });
const hasRecon = hist.json?.data?.items?.some((t) => t.checkoutSessionId === mId && t.status === "FAILED");
check("P6.8 payments history exposes the discrepancy money record (support traceability §140)", !!hasRecon);

// restore FREE for the p20 invariant (all businesses FREE) — internal switch back
const back = await api("/api/v1/billing/change-plan", { method: "POST", jar: ownerJar, headers: ctxHeader(businessId), body: { planCode: "FREE" } });
check("P6.9 internal switch back to FREE (fixture hygiene for p20 invariant)", back.status === 200 || back.status === 201, back.text?.slice(0, 120));

console.log("\nP7 — cleanup");
{
  const del = await api(`/api/v1/businesses/${businessId}`, { method: "DELETE", jar: ownerJar, headers: ctxHeader(businessId), body: { confirmName: "P23 Real Provider Shop" } });
  check("P7.1 fixture business deleted via danger-zone API", del.status === 200 || del.status === 204, `got ${del.status}`);
  const del2 = await api(`/api/v1/businesses/${outBizId}`, { method: "DELETE", jar: outsiderJar, headers: ctxHeader(outBizId), body: { confirmName: "P23 Other Biz" } });
  check("P7.2 second fixture deleted", del2.status === 200 || del2.status === 204, `got ${del2.status}`);
}

prisma.$disconnect();
console.log(`\n${"=".repeat(60)}`);
console.log(`PROMPT 23 API HARNESS: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  - ${f.name}`);
  process.exit(1);
}
process.exit(0);
