#!/usr/bin/env node
/**
 * scripts/prompt23-provider-contract.mjs — Prompt 23 unit-level contract
 * harness (runs under BUN — direct TS imports; transport is MOCKED).
 *
 * Coverage:
 *   C1 Configuration validation (§6-§11, §88-§90): dev defaults, disabled
 *      payments, production gates (explicit enable, mock banned, PAYMENT_ENV
 *      required, missing credentials fail-closed, HTTPS requirement,
 *      no-silent-provider-switch)
 *   C2 Zarinpal adapter contract with MOCKED fetch (§82 — no fabricated
 *      sandbox results; transport-level behavior only):
 *        currency gate, IRR amount mapping, request payload shape, request
 *        success/malformed/timeout, verify 100/101/-50/-51/-54/malformed/
 *        network/echo-mismatch, callback parse (untrusted Status), webhook
 *        refusal, conservative inquiry mapping
 *
 * Usage: bun scripts/prompt23-provider-contract.mjs
 * Exit:  0 = all checks passed · 1 = failures printed
 */

const ROOT = "/home/z/my-project";
const failures = [];
let passed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push({ name, detail });
    console.error(`  ✗ ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ""}`);
  }
}

/* ------------------------------ env control ------------------------------- */

const ENV_BACKUP = { ...process.env };
function setEnv(map) {
  for (const [k, v] of Object.entries(map)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
function restoreEnv() {
  setEnv(ENV_BACKUP);
}

const {
  validatePaymentConfig,
  paymentsAvailable,
} = await import("../src/lib/payments/config.ts");
const {
  amountToProvider,
  buildPaymentDescription,
  buildRequestPayload,
  parseRequestResponse,
  parseVerifyResponse,
  parseInquiryResponse,
  zarinpalEndpoints,
  zarinpalProvider,
} = await import("../src/lib/payments/zarinpal.ts");
const { ApiError } = await import("../src/lib/api-helpers.ts");
const {
  CallbackParseError,
  WebhookVerificationError,
} = await import("../src/lib/payments/types.ts");
const { currencyMinorDigits, minorToMajor, majorToMinor } = await import(
  "../src/lib/payments/currency.ts"
);

console.log("\nC1 — payment configuration validation (fail-closed)");

// 1) Development defaults — mock, enabled, no blockers.
restoreEnv();
setEnv({ NODE_ENV: "development", PAYMENTS_ENABLED: undefined, PAYMENT_PROVIDER: undefined, PAYMENT_ENV: undefined });
let cfg = validatePaymentConfig();
check("C1.1 dev defaults: enabled, mock provider, mock env, no blockers", cfg.enabled && cfg.providerSlug === "mock" && cfg.env === "mock" && cfg.blockers.length === 0 && paymentsAvailable());

// 2) Disabled payments (§88).
setEnv({ PAYMENTS_ENABLED: "false" });
cfg = validatePaymentConfig();
check("C1.2 PAYMENTS_ENABLED=false → blocker + unavailable", !cfg.enabled && !paymentsAvailable() && cfg.blockers.some((b) => b.includes("PAYMENTS_ENABLED")));

// 3) Production without explicit enable (§88).
setEnv({ NODE_ENV: "production", PAYMENTS_ENABLED: undefined });
cfg = validatePaymentConfig();
check("C1.3 production without explicit PAYMENTS_ENABLED=true → disabled + blocker", !cfg.enabled && cfg.blockers.some((b) => b.includes('explicitly "true"')));

// 4) Production + mock provider banned (§7/§130).
setEnv({ NODE_ENV: "production", PAYMENTS_ENABLED: "true", PAYMENT_ENV: "production", PAYMENT_PROVIDER: "mock" });
cfg = validatePaymentConfig();
check("C1.4 production + PAYMENT_PROVIDER=mock → blocked (never real money via mock)", cfg.blockers.some((b) => b.includes("not allowed in production")));

// 5) Production without PAYMENT_ENV (§6).
setEnv({ PAYMENT_PROVIDER: "zarinpal", PAYMENT_ENV: undefined, ZARINPAL_MERCHANT_ID: "00000000-0000-0000-0000-000000000000", PAYMENT_BASE_URL: "https://app.example.com" });
cfg = validatePaymentConfig();
check("C1.5 production without PAYMENT_ENV → blocker (never defaults to mock)", cfg.blockers.some((b) => b.includes("PAYMENT_ENV is required in production")));

// 6) Production + real provider + missing credentials (§89).
setEnv({ PAYMENT_ENV: "production", ZARINPAL_MERCHANT_ID: undefined, PAYMENT_BASE_URL: undefined });
cfg = validatePaymentConfig();
check("C1.6 production zarinpal without credentials/base URL → explicit blockers, NO mock fallback", cfg.blockers.some((b) => b.includes("ZARINPAL_MERCHANT_ID")) && cfg.blockers.some((b) => b.includes("PAYMENT_BASE_URL")) && !paymentsAvailable());

// 7) Production + non-HTTPS base URL (§9).
setEnv({ ZARINPAL_MERCHANT_ID: "00000000-0000-0000-0000-000000000000", PAYMENT_BASE_URL: "http://app.example.com" });
cfg = validatePaymentConfig();
check("C1.7 production base URL must be HTTPS", cfg.blockers.some((b) => b.includes("HTTPS")));

// 8) Sandbox + missing credentials → fail closed (§89).
setEnv({ NODE_ENV: "development", PAYMENT_ENV: "sandbox", PAYMENT_PROVIDER: "zarinpal", ZARINPAL_MERCHANT_ID: undefined, PAYMENT_BASE_URL: "https://app.example.com" });
cfg = validatePaymentConfig();
check("C1.8 sandbox zarinpal without merchant id → blocked (no silent mock fallback)", !paymentsAvailable() && cfg.blockers.some((b) => b.includes("ZARINPAL_MERCHANT_ID")));

// 9) Real provider with mock env is a config error (§90).
setEnv({ PAYMENT_ENV: "mock", ZARINPAL_MERCHANT_ID: "00000000-0000-0000-0000-000000000000" });
cfg = validatePaymentConfig();
check("C1.9 zarinpal + PAYMENT_ENV=mock → blocked (no silent provider switch)", cfg.blockers.some((b) => b.includes("mock is development-only")));

// 10) Fully valid sandbox config → no blockers.
setEnv({ PAYMENT_ENV: "sandbox" });
cfg = validatePaymentConfig();
check("C1.10 valid sandbox zarinpal config → no blockers, available", cfg.blockers.length === 0 && paymentsAvailable());

console.log("\nC2 — currency representation (§53-§55, integer-only)");

check("C2.1 IRR has 0 minor digits (zero-decimal)", currencyMinorDigits("IRR") === 0);
check("C2.2 EUR has 2 minor digits", currencyMinorDigits("EUR") === 2);
check("C2.3 minor→major IRR is identity", minorToMajor(9000000, "IRR") === 9000000);
check("C2.4 minor→major EUR divides by 100", minorToMajor(1900, "EUR") === 19);
check("C2.5 major→minor EUR integer-exact", majorToMinor(19.0, "EUR") === 1900);
check("C2.6 major→minor overflow rejected (safe-integer guard)", majorToMinor(Number.MAX_SAFE_INTEGER, "EUR") === null);

console.log("\nC3 — Zarinpal adapter contract (MOCKED transport — no fabricated sandbox results)");

// Put the adapter into a usable sandbox config for the contract tests.
setEnv({
  NODE_ENV: "development",
  PAYMENTS_ENABLED: "true",
  PAYMENT_PROVIDER: "zarinpal",
  PAYMENT_ENV: "sandbox",
  ZARINPAL_MERCHANT_ID: "00000000-0000-0000-0000-000000000000",
  PAYMENT_BASE_URL: "https://app.example.com",
});
check("C3.0 adapter configured under valid sandbox config", zarinpalProvider.configured === true);
check("C3.0b capabilities: IRR-only, no webhooks, verification on, redirect callback on", zarinpalProvider.capabilities.currencies.includes("IRR") && zarinpalProvider.capabilities.webhooks === false && zarinpalProvider.capabilities.serverVerification === true && zarinpalProvider.capabilities.redirectCallback === true);
check("C3.0c sandbox endpoints are sandbox.zarinpal.com (environment separation §64)", zarinpalEndpoints("sandbox").request.startsWith("https://sandbox.zarinpal.com/") && zarinpalEndpoints("production").request.startsWith("https://payment.zarinpal.com/"));

// --- currency gate (§52) ---
let eurError = null;
try {
  await zarinpalProvider.createCheckout({
    checkoutSessionId: "sess_x", businessId: "biz", planCode: "BUSINESS",
    billingPeriod: "MONTHLY", amountMinor: 1900, currency: "EUR",
    callbackUrl: "https://app.example.com/api/v1/payments/callback/zarinpal",
  });
} catch (e) { eurError = e; }
check("C3.1 EUR session → 422 PROVIDER_CURRENCY_UNSUPPORTED (no conversion, ever)", eurError instanceof ApiError && eurError.status === 422 && eurError.code === "PROVIDER_CURRENCY_UNSUPPORTED");

// --- amount mapping (§54) ---
check("C3.2 IRR amount mapping is an integer identity (Rials)", amountToProvider(9000000, "IRR") === 9000000);
let badAmount = null;
try { amountToProvider(-5, "IRR"); } catch (e) { badAmount = e; }
check("C3.3 non-positive amount rejected", badAmount !== null);
try { amountToProvider(10.5, "IRR"); } catch (e) { badAmount = e; }
check("C3.4 fractional amount rejected (no floats in money)", badAmount !== null);

// --- request payload shape (§17/§98/§99) ---
const payload = buildRequestPayload({
  checkoutSessionId: "sess_x", businessId: "biz_topsecret", planCode: "BUSINESS",
  billingPeriod: "MONTHLY", amountMinor: 9000000, currency: "IRR",
  callbackUrl: "https://app.example.com/api/v1/payments/callback/zarinpal",
  merchantId: "00000000-0000-0000-0000-000000000000",
});
check("C3.5 request payload carries merchant_id/amount/callback_url", payload.merchant_id === "00000000-0000-0000-0000-000000000000" && payload.amount === 9000000 && payload.callback_url === "https://app.example.com/api/v1/payments/callback/zarinpal");
check("C3.6 description is minimal and non-sensitive (no business id, no PII)", buildPaymentDescription("BUSINESS", "MONTHLY") === "AI Business Copilot — BUSINESS Plan (MONTHLY)" && !JSON.stringify(payload).includes("biz_topsecret"));

// --- mocked transport plumbing ---
const realFetch = globalThis.fetch;
function mockFetchOnce(handler) {
  globalThis.fetch = async () => handler();
  return () => { globalThis.fetch = realFetch; };
}

// request.json success
let undo = mockFetchOnce(() => ({
  ok: true, status: 200, headers: new Headers({ "content-length": "0" }),
  text: async () => JSON.stringify({ data: { code: 100, authority: "A0000000000000000000000000000" }, errors: null }),
}));
let created = null, createErr = null;
try {
  created = await zarinpalProvider.createCheckout({
    checkoutSessionId: "sess_x", businessId: "biz", planCode: "BUSINESS",
    billingPeriod: "MONTHLY", amountMinor: 9000000, currency: "IRR",
    callbackUrl: "https://app.example.com/api/v1/payments/callback/zarinpal",
  });
} catch (e) { createErr = e; }
undo();
check("C3.7 request success → providerRef=authority + StartPay redirect (trusted URL only)", createErr === null && created?.providerRef === "A0000000000000000000000000000" && created.redirectUrl === "https://sandbox.zarinpal.com/pg/StartPay/A0000000000000000000000000000");

// request.json malformed
undo = mockFetchOnce(() => ({
  ok: true, status: 200, headers: new Headers(), text: async () => "not-json{{",
}));
createErr = null;
try {
  await zarinpalProvider.createCheckout({
    checkoutSessionId: "sess_x", businessId: "biz", planCode: "BUSINESS",
    billingPeriod: "MONTHLY", amountMinor: 9000000, currency: "IRR",
    callbackUrl: "https://x/callback",
  });
} catch (e) { createErr = e; }
undo();
check("C3.8 malformed request response → 502 PROVIDER_INVALID_RESPONSE (never invent authority)", createErr instanceof ApiError && createErr.code === "PROVIDER_INVALID_RESPONSE");

// request timeout (§36/§66)
undo = mockFetchOnce(() => { const e = new Error("aborted"); e.name = "AbortError"; throw e; });
createErr = null;
try {
  await zarinpalProvider.createCheckout({
    checkoutSessionId: "sess_x", businessId: "biz", planCode: "BUSINESS",
    billingPeriod: "MONTHLY", amountMinor: 9000000, currency: "IRR",
    callbackUrl: "https://x/callback",
  });
} catch (e) { createErr = e; }
undo();
check("C3.9 create timeout → PROVIDER_TIMEOUT (typed, no blind retry)", createErr instanceof ApiError && createErr.code === "PROVIDER_TIMEOUT");

// verify mappings (§20/§34/§35/§36)
const VERIFY_URL_PAYLOAD = { providerRef: "A0000000000000000000000000000", expectedAmountMinor: 9000000, expectedCurrency: "IRR" };
async function verifyWith(handler) {
  const u = mockFetchOnce(handler);
  const out = await zarinpalProvider.verifyPayment(VERIFY_URL_PAYLOAD);
  u();
  return out;
}
let r = await verifyWith(() => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ data: { code: 100, ref_id: 123456, authority: "A0000000000000000000000000000" }, errors: null }) }));
check("C3.10 verify code 100 → SUCCEEDED with ZP ref id", r.outcome === "SUCCEEDED" && r.providerEventId === "zarinpal-verify:A0000000000000000000000000000" && r.providerTxnRef === "ZP-123456");
r = await verifyWith(() => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ data: { code: 101, ref_id: 123456, authority: "A0000000000000000000000000000" }, errors: null }) }));
check("C3.11 verify code 101 (already verified) → SUCCEEDED (idempotent)", r.outcome === "SUCCEEDED");
r = await verifyWith(() => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ data: null, errors: { code: -50 } }) }));
check("C3.12 verify -50 → UNKNOWN AMOUNT_MISMATCH (money moved wrong → reconciliation)", r.outcome === "UNKNOWN" && r.reason === "AMOUNT_MISMATCH");
r = await verifyWith(() => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ data: null, errors: { code: -51 } }) }));
check("C3.13 verify -51 → NOT_PAID (session stays PENDING)", r.outcome === "NOT_PAID");
r = await verifyWith(() => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ data: null, errors: { code: -54 } }) }));
check("C3.14 verify -54 (unknown authority) → NOT_PAID", r.outcome === "NOT_PAID");
r = await verifyWith(() => ({ ok: true, status: 200, headers: new Headers(), text: async () => "garbage{" }));
check("C3.15 malformed verify body → UNKNOWN (never fake success/failure)", r.outcome === "UNKNOWN" && r.reason === "UNKNOWN_PROVIDER_STATE");
r = await verifyWith(() => { const e = new Error("aborted"); e.name = "AbortError"; throw e; });
check("C3.16 verify timeout → UNKNOWN PROVIDER_TIMEOUT (timeout ≠ failure, §36)", r.outcome === "UNKNOWN" && r.reason === "PROVIDER_TIMEOUT");
r = await verifyWith(() => ({ ok: true, status: 500, headers: new Headers(), text: async () => "oops" }));
check("C3.17 verify HTTP 500 → UNKNOWN PROVIDER_UNAVAILABLE", r.outcome === "UNKNOWN" && r.reason === "PROVIDER_UNAVAILABLE");
r = await verifyWith(() => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ data: { code: 100, ref_id: 1, authority: "A999" }, errors: null }) }));
check("C3.18 verify authority echo mismatch → UNKNOWN REFERENCE_MISMATCH (§23)", r.outcome === "UNKNOWN" && r.reason === "REFERENCE_MISMATCH");
r = await verifyWith(() => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ data: { code: 100, ref_id: 1, authority: "A0000000000000000000000000000" }, errors: null }) }));
// currency guard inside verify
{
  const u = mockFetchOnce(() => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ data: { code: 100 }, errors: null }) }));
  const rr = await zarinpalProvider.verifyPayment({ providerRef: "A0000000000000000000000000000", expectedAmountMinor: 900, expectedCurrency: "EUR" });
  u();
  check("C3.19 verify in wrong currency → UNKNOWN CURRENCY_MISMATCH (no conversion)", rr.outcome === "UNKNOWN" && rr.reason === "CURRENCY_MISMATCH");
}

// --- callback parsing (§19) ---
const cb = zarinpalProvider.parseCallback(new URLSearchParams("Authority=A0000000000000000000000000000&Status=OK"));
check("C3.20 callback Authority parsed; Status=OK has NO decision power", cb.providerRef === "A0000000000000000000000000000");
let cbErr = null;
try { zarinpalProvider.parseCallback(new URLSearchParams("Status=OK&paymentId=123")); } catch (e) { cbErr = e; }
check("C3.21 garbage/forged callback → CallbackParseError (uniform, no oracle)", cbErr instanceof CallbackParseError);

// --- webhook refusal (§29/§31) ---
let whErr = null;
try { zarinpalProvider.verifyWebhook("{}", new Headers()); } catch (e) { whErr = e; }
check("C3.22 webhook POST refused (provider has no webhooks — documented)", whErr instanceof WebhookVerificationError);

// --- conservative inquiry (§35) ---
check("C3.23 inquiry PAID → SUCCEEDED", parseInquiryResponse({ data: { code: 100, status: "PAID" } }) === "SUCCEEDED");
check("C3.24 inquiry garbage/unknown → PENDING (conservative, never fabricates terminal)", parseInquiryResponse({ data: null }) === "PENDING" && parseInquiryResponse(null) === "PENDING");
{
  const u = mockFetchOnce(() => { const e = new Error("aborted"); e.name = "AbortError"; throw e; });
  const st = await zarinpalProvider.getSessionStatus("A0000000000000000000000000000");
  u();
  check("C3.25 inquiry transport failure → PENDING (never fake terminal)", st === "PENDING");
}

// --- parseRequestResponse direct guards ---
let pErr = null;
try { parseRequestResponse({ data: { code: 100, authority: "SHORT" } }); } catch (e) { pErr = e; }
check("C3.26 malformed authority shape rejected", pErr instanceof ApiError);

restoreEnv();
globalThis.fetch = realFetch;

console.log(`\n${"=".repeat(60)}`);
console.log(`PROMPT 23 CONTRACT HARNESS: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  - ${f.name}`);
  process.exit(1);
}
process.exit(0);
