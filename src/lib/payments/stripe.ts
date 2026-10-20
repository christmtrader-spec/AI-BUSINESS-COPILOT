/**
 * Stripe adapter — Prompt 23-style REAL payment provider (international).
 *
 * Provider: Stripe Checkout (REST API v1, form-encoded requests).
 * Documentation source: docs.stripe.com/api/checkout/sessions +
 * docs.stripe.com/webhooks (signature scheme). API version: the UNVERSIONED
 * v1 REST surface (account default) — only stable core fields are consumed
 * (id / url / expires_at / payment_status / amount_total / currency /
 * metadata), so no Stripe-Version pin is required for this adapter.
 *
 * NO SDK DEPENDENCY: this adapter uses `fetch` + `node:crypto` only — no npm
 * package was added (repo rule: package.json/bun.lock untouched).
 *
 * Keys (server-side env ONLY, never logged, never returned to the client):
 * - STRIPE_SECRET_KEY     — API key (sk_test_… / sk_live_…). Test-vs-live is
 *   decided by WHICH key is set; Stripe's api.stripe.com endpoint is the
 *   same for both modes.
 * - STRIPE_WEBHOOK_SECRET — endpoint signing secret (whsec_…). NOTE: this is
 *   NOT the generic PAYMENT_WEBHOOK_SECRET/mock fallback from signature.ts —
 *   when it is missing, webhook verification FAILS CLOSED (401), it never
 *   silently verifies against the development fallback secret.
 *
 * Money mapping: Stripe natively uses INTEGER MINOR UNITS (cents for USD/EUR)
 * — the same convention as our internal storage (A08), so unit_amount is a
 * deterministic 1:1 integer identity (§54/§55 spirit, mirrors zarinpal.ts).
 *
 * Currencies: USD + EUR only (§52 — no silent currency conversion; the
 * adapter declines any other settlement currency before any provider call).
 *
 * Session-id pairing (webhook → internal session): Stripe events reference
 * the provider-side session id (data.object.id — the stored providerRef),
 * while the fulfillment pipeline resolves attempts by our INTERNAL
 * CheckoutSession id. The bridge is created at checkout time:
 *   metadata[checkout_session_id] = <our CheckoutSession id>
 * Stripe echoes session metadata on every checkout.* event AND copies it
 * onto the resulting payment_intent, so checkout.session.* AND
 * payment_intent.payment_failed both carry the same anchor. When the anchor
 * is missing, the event falls back to data.object.id — which can never match
 * an internal session id, so the service records + benignly IGNORES it
 * (`ignored: "unknown-session"` — the null-safe no-op path of fulfillWebhook).
 *
 * Webhook event mapping (closed union, types.ts):
 *   checkout.session.completed   → checkout.succeeded
 *   checkout.session.expired     → checkout.expired
 *   payment_intent.payment_failed → checkout.failed (reason = last error)
 *   anything else                → benign no-op (unresolvable session id →
 *                                  the service ignores it and returns 200 so
 *                                  Stripe stops retrying; types.ts law:
 *                                  "unknown types are ignored").
 * Signature failures (missing/malformed header, stale timestamp, HMAC
 * mismatch) throw WebhookVerificationError → route maps to 401.
 *
 * SECURITY:
 * - Secrets live ONLY in process.env and are used solely in Authorization /
 *   HMAC computation — this file logs nothing (§56/§57).
 * - No retries inside the adapter (§67); 15s timeout (§66) matching http.ts.
 * - Response size bounded (§102) — bodies over the cap are rejected.
 */

import { timingSafeEqual } from "node:crypto";
import { ApiError } from "@/lib/api-helpers";
import { computeSignature } from "./signature";
import { CallbackParseError, WebhookVerificationError } from "./types";
import {
  type CreateCheckoutInput,
  type CreatedCheckout,
  type PaymentProvider,
  type ProviderWebhookEvent,
  type VerifyPaymentResult,
} from "./types";
import { PROVIDER_HTTP_TIMEOUT_MS } from "./http";

/** Stripe REST v1 — one endpoint for test and live keys (key decides mode). */
const STRIPE_API_BASE = "https://api.stripe.com/v1";

/** Currencies this adapter settles in (§52 — USD/EUR only). */
export const STRIPE_CURRENCIES: readonly string[] = ["USD", "EUR"];

/** Stripe's documented default Checkout session TTL (24h) — fallback only. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Mirrors http.ts's response bound (§102) — this adapter reads raw text. */
const MAX_RESPONSE_BYTES = 512 * 1024;

/** Webhook replay tolerance — Stripe's recommended 5 minutes. */
const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

function stripeSecretKey(): string | null {
  const raw = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  return raw.length >= 16 ? raw : null;
}

function stripeWebhookSecret(): string | null {
  const raw = process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
  return raw.length >= 16 ? raw : null;
}

/** Minimal typed fetch for the Stripe API — form-encoded, bounded, no retry. */
async function stripeRequest(
  method: "POST" | "GET",
  path: string,
  body?: URLSearchParams,
): Promise<{ ok: true; status: number; body: string } | { ok: false; kind: "TIMEOUT" | "NETWORK" | "TOO_LARGE" }> {
  const key = stripeSecretKey();
  if (!key) return { ok: false, kind: "NETWORK" }; // unconfigured — fail closed before any call
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${STRIPE_API_BASE}${path}`, {
      method,
      headers: {
        "authorization": `Bearer ${key}`,
        ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        "user-agent": "ai-business-copilot/1.0 (+payments)",
      },
      body: body ? body.toString() : undefined,
      redirect: "error", // §102 — never follow provider redirects blindly
      signal: controller.signal,
    });
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_RESPONSE_BYTES) return { ok: false, kind: "TOO_LARGE" };
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) return { ok: false, kind: "TOO_LARGE" };
    return { ok: true, status: res.status, body: text };
  } catch (error) {
    const isTimeout =
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError");
    return isTimeout ? { ok: false, kind: "TIMEOUT" } : { ok: false, kind: "NETWORK" };
  } finally {
    clearTimeout(timer);
  }
}

/** Guarded JSON parse — malformed bodies never crash the adapter (§35). */
function tryParseJson(body: string): unknown | null {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pure mapping helpers — exported for contract tests (no transport needed).
// ---------------------------------------------------------------------------

/**
 * Minimal, accurate, non-sensitive product name (§99) — identical wording to
 * the zarinpal adapter's payment description (same product, same discipline).
 */
export function buildProductName(planCode: string, billingPeriod: string): string {
  return `AI Business Copilot — ${planCode} Plan (${billingPeriod})`;
}

/**
 * Build the form-encoded create-session body. Stripe natively speaks integer
 * minor units — `unit_amount` is our `amountMinor` verbatim (1:1 identity).
 * `metadata[checkout_session_id]` is the providerRef↔session pairing anchor
 * (see header comment). Exported pure for tests.
 */
export function buildCheckoutForm(input: CreateCheckoutInput): URLSearchParams {
  const form = new URLSearchParams();
  form.set("mode", "payment");
  // The callback route is query-less, so the session id joins with "?";
  // (keep the join robust for query-bearing callback URLs too).
  const joiner = input.callbackUrl.includes("?") ? "&" : "?";
  form.set("success_url", `${input.callbackUrl}${joiner}session_id={CHECKOUT_SESSION_ID}`);
  form.set("cancel_url", input.callbackUrl);
  form.set("line_items[0][price_data][currency]", input.currency.toLowerCase());
  form.set("line_items[0][price_data][unit_amount]", String(input.amountMinor));
  form.set("line_items[0][price_data][product_data][name]", buildProductName(input.planCode, input.billingPeriod));
  form.set("line_items[0][quantity]", "1");
  form.set("client_reference_id", input.businessId);
  form.set("metadata[checkout_session_id]", input.checkoutSessionId);
  return form;
}

/** Response of POST /checkout/sessions — id/url are the provider contract. */
export function parseCreateResponse(payload: unknown): { providerRef: string; redirectUrl: string; expiresAt: Date } {
  const body = (typeof payload === "object" && payload !== null ? payload : {}) as {
    id?: unknown;
    url?: unknown;
    expires_at?: unknown;
  };
  const id = typeof body.id === "string" && body.id.length > 0 ? body.id : null;
  const url =
    typeof body.url === "string" && body.url.startsWith("https://") ? body.url : null;
  if (!id || !url) {
    // Malformed/ambiguous provider response → never invent a reference (§35).
    throw new ApiError(
      502,
      "PROVIDER_INVALID_RESPONSE",
      "The payment provider returned an unexpected response.",
    );
  }
  const expiresAt =
    typeof body.expires_at === "number" && Number.isFinite(body.expires_at) && body.expires_at > 0
      ? new Date(body.expires_at * 1000)
      : new Date(Date.now() + SESSION_TTL_MS);
  return { providerRef: id, redirectUrl: url, expiresAt };
}

/** GET /checkout/sessions/<id> → normalized reconciliation status (§35 conservative). */
export function parseSessionStatus(payload: unknown): "PENDING" | "SUCCEEDED" | "FAILED" | "EXPIRED" {
  const body = (typeof payload === "object" && payload !== null ? payload : {}) as {
    status?: unknown;
    payment_status?: unknown;
  };
  // A provider-declared expiry is authoritative for lazy expiry/reconciliation.
  if (body.status === "expired") return "EXPIRED";
  if (body.payment_status === "paid") return "SUCCEEDED";
  // no_payment_required → the session COMPLETED with nothing due — the
  // obligation is fulfilled by definition (nothing was owed), so this maps to
  // SUCCEEDED per the local "completed session" convention (documented).
  if (body.payment_status === "no_payment_required") return "SUCCEEDED";
  // unpaid / unknown → nothing provably terminal: stay PENDING (never fake).
  return "PENDING";
}

/** server-side verification claim (Prompt 23 §20) from the session object. */
export function parseVerifyClaim(
  payload: unknown,
): { outcome: "SUCCEEDED"; amountMinor: number; currency: string; providerEventId: string; providerTxnRef?: string } | { outcome: "NOT_PAID"; reason: string } | { outcome: "UNKNOWN"; reason: string } {
  const body = (typeof payload === "object" && payload !== null ? payload : {}) as {
    id?: unknown;
    payment_status?: unknown;
    amount_total?: unknown;
    currency?: unknown;
    payment_intent?: unknown;
  };
  const id = typeof body.id === "string" && body.id.length > 0 ? body.id : null;
  if (!id) return { outcome: "UNKNOWN", reason: "MALFORMED_PROVIDER_RESPONSE" };
  if (body.payment_status === "paid") {
    const amountMinor = typeof body.amount_total === "number" && Number.isSafeInteger(body.amount_total) && body.amount_total > 0 ? body.amount_total : null;
    const currency = typeof body.currency === "string" && /^[a-z]{3}$/.test(body.currency) ? body.currency.toUpperCase() : null;
    if (amountMinor === null || currency === null) {
      return { outcome: "UNKNOWN", reason: "MALFORMED_PROVIDER_RESPONSE" };
    }
    return {
      outcome: "SUCCEEDED",
      amountMinor,
      currency,
      providerEventId: `stripe-verify:${id}`,
      providerTxnRef: typeof body.payment_intent === "string" ? body.payment_intent : undefined,
    };
  }
  if (body.payment_status === "unpaid") {
    return { outcome: "NOT_PAID", reason: "PAYMENT_UNSUCCESSFUL" };
  }
  // no_payment_required on a paid-plan checkout is an ambiguity, not money —
  // never fabricate success (§35): leave it to reconciliation.
  return { outcome: "UNKNOWN", reason: "UNKNOWN_PROVIDER_STATE" };
}

/** Timing-safe hex comparison (never string ===). */
function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify the `stripe-signature` header over the RAW body.
 * Scheme: `t=<unix-seconds>,v1=<hex hmac>` (multiple v1 entries allowed,
 * space/comma separated — each is tried, any match passes). Signed payload
 * is `${t}.${rawBody}`, HMAC-SHA256 with STRIPE_WEBHOOK_SECRET. Throws
 * WebhookVerificationError on ANY problem — the caller learns nothing about
 * which check failed (route → opaque 401).
 */
export function verifyStripeSignatureHeader(
  header: string | null,
  rawBody: string,
  secret: string,
  now = Date.now(),
): void {
  if (!header) throw new WebhookVerificationError();
  const tValues: number[] = [];
  const v1Values: string[] = [];
  for (const part of header.split(/[,\s]+/)) {
    const t = /^t=(\d+)$/.exec(part);
    if (t) {
      tValues.push(Number(t[1]));
      continue;
    }
    const v1 = /^v1=([0-9a-f]{64})$/.exec(part);
    if (v1) v1Values.push(v1[1]);
  }
  if (tValues.length !== 1 || v1Values.length === 0) throw new WebhookVerificationError();
  const t = tValues[0];
  if (!Number.isSafeInteger(t)) throw new WebhookVerificationError();
  if (Math.abs(now - t * 1000) > WEBHOOK_TIMESTAMP_TOLERANCE_MS) {
    throw new WebhookVerificationError(); // replay beyond tolerance
  }
  const expected = computeSignature(t, rawBody, secret);
  for (const candidate of v1Values) {
    if (safeEqualHex(candidate, expected)) return;
  }
  throw new WebhookVerificationError();
}

/** Event id guard — every verified delivery needs a stable idempotency anchor. */
function eventIdOf(event: Record<string, unknown>): string {
  const id = typeof event.id === "string" && event.id.length > 0 ? event.id : null;
  if (!id) throw new WebhookVerificationError();
  return id;
}

/** data.object guard — mapped events always carry a payload object. */
function dataObjectOf(event: Record<string, unknown>): Record<string, unknown> {
  const data = event.data;
  const obj =
    typeof data === "object" && data !== null
      ? ((data as Record<string, unknown>).object as unknown)
      : undefined;
  if (typeof obj !== "object" || obj === null) throw new WebhookVerificationError();
  return obj as Record<string, unknown>;
}

/**
 * Resolve the internal session anchor from the event object. Preferred: the
 * metadata pairing set at checkout time; fallback: the provider-side id
 * (never matches an internal session id → the service benignly ignores it).
 */
function sessionAnchorOf(obj: Record<string, unknown>, fallback: string): string {
  const metadata = obj.metadata;
  if (typeof metadata === "object" && metadata !== null) {
    const anchor = (metadata as Record<string, unknown>).checkout_session_id;
    if (typeof anchor === "string" && anchor.length > 0) return anchor;
  }
  return typeof obj.id === "string" && obj.id.length > 0 ? obj.id : fallback;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const stripeProvider: PaymentProvider = {
  slug: "stripe",
  displayName: "Stripe",
  // LIVE once an API key exists; SANDBOX (unusable) otherwise. Read at module
  // init like zarinpal.ts — `configured` below stays runtime-dynamic.
  mode: process.env.STRIPE_SECRET_KEY?.trim() ? "LIVE" : "SANDBOX",
  configured: false, // assigned below — module-init order safe
  capabilities: {
    currencies: STRIPE_CURRENCIES,
    webhooks: true, // signed webhook events (t/v1 HMAC — verified manually)
    serverVerification: true, // GET /checkout/sessions/<id> (authoritative)
    redirectCallback: true, // success_url returns ?session_id=<ref>
  },

  async createCheckout(input: CreateCheckoutInput): Promise<CreatedCheckout> {
    // Currency gate (§52) — refuse unsupported settlements before any call.
    if (!STRIPE_CURRENCIES.includes(input.currency.toUpperCase())) {
      throw new ApiError(
        422,
        "PROVIDER_CURRENCY_UNSUPPORTED",
        "Stripe settles in USD or EUR only; this plan's settlement currency is not supported by this provider.",
        { currency: input.currency },
      );
    }
    if (!stripeSecretKey()) {
      throw new ApiError(422, "PROVIDER_UNAVAILABLE", "The payment provider is not configured.");
    }

    // NO retry (§67) — session creation is not idempotent here; a failed
    // create ends this attempt (the user can start a new one).
    const res = await stripeRequest("POST", "/checkout/sessions", buildCheckoutForm(input));
    if (!res.ok) {
      // §36 — a timeout here means no session exists yet, so the user never
      // left and no money can move; the service records a FAILED attempt.
      throw new ApiError(
        502,
        res.kind === "TIMEOUT" ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE",
        "The payment provider could not be reached.",
      );
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ApiError(502, "PROVIDER_UNAVAILABLE", "The payment provider rejected the request.");
    }
    const parsed = parseCreateResponse(tryParseJson(res.body));

    return {
      providerRef: parsed.providerRef,
      // §103 — the checkout URL comes ONLY from the trusted provider contract
      // (session.url); never from any request input.
      redirectUrl: parsed.redirectUrl,
      expiresAt: parsed.expiresAt,
    };
  },

  verifyWebhook(rawBody: string, headers: Headers): ProviderWebhookEvent {
    // 0) Configuration gate FIRST — without the endpoint secret nothing is
    // verifiable; fail closed (never fall back to the dev/mock secret).
    const secret = stripeWebhookSecret();
    if (!secret) throw new WebhookVerificationError();
    // 1) Signature FIRST — untrusted bytes are never trusted further.
    verifyStripeSignatureHeader(headers.get("stripe-signature"), rawBody, secret);
    // 2) Shape validation — malformed JSON is a verification failure (mock parity).
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new WebhookVerificationError();
    }
    if (typeof parsed !== "object" || parsed === null) throw new WebhookVerificationError();
    const event = parsed as Record<string, unknown>;

    switch (event.type) {
      case "checkout.session.completed": {
        const eventId = eventIdOf(event);
        const obj = dataObjectOf(event);
        const amountMinor =
          typeof obj.amount_total === "number" && Number.isSafeInteger(obj.amount_total)
            ? obj.amount_total
            : undefined;
        if (amountMinor === undefined) throw new WebhookVerificationError();
        const currency =
          typeof obj.currency === "string" && obj.currency.length > 0
            ? obj.currency.toUpperCase()
            : "EUR"; // mock parity: service compares against the session snapshot
        return {
          kind: "checkout.succeeded",
          eventId,
          checkoutSessionId: sessionAnchorOf(obj, eventId),
          amountMinor,
          currency,
        };
      }
      case "checkout.session.expired": {
        const eventId = eventIdOf(event);
        const obj = dataObjectOf(event);
        return {
          kind: "checkout.expired",
          eventId,
          checkoutSessionId: sessionAnchorOf(obj, eventId),
        };
      }
      case "payment_intent.payment_failed": {
        const eventId = eventIdOf(event);
        const obj = dataObjectOf(event);
        const lastError =
          typeof obj.last_payment_error === "object" && obj.last_payment_error !== null
            ? (obj.last_payment_error as Record<string, unknown>).message
            : undefined;
        return {
          kind: "checkout.failed",
          eventId,
          checkoutSessionId: sessionAnchorOf(obj, eventId),
          reason:
            typeof lastError === "string" && lastError.length > 0
              ? lastError.slice(0, 200)
              : "payment_failed",
        };
      }
      default:
        // types.ts law — "unknown types are ignored": emit a benign event
        // whose session id can never resolve, so the pipeline records the
        // delivery (eventId dedupe) and returns 200 without touching state.
        const eventId = eventIdOf(event);
        return {
          kind: "checkout.expired",
          eventId,
          checkoutSessionId: `unmapped:${eventId}`,
        };
    }
  },

  async getSessionStatus(providerRef: string) {
    // Conservative reconciliation mapping (§35): anything not provably
    // terminal stays PENDING; transport failures NEVER fabricate states.
    if (!stripeSecretKey()) return "PENDING";
    const res = await stripeRequest("GET", `/checkout/sessions/${encodeURIComponent(providerRef)}`);
    if (!res.ok || res.status < 200 || res.status >= 300) return "PENDING";
    return parseSessionStatus(tryParseJson(res.body));
  },

  async verifyPayment(input: {
    providerRef: string;
    expectedAmountMinor: number;
    expectedCurrency: string;
  }): Promise<VerifyPaymentResult> {
    if (!stripeSecretKey()) return { outcome: "UNKNOWN", reason: "PROVIDER_UNCONFIGURED" };
    const res = await stripeRequest("GET", `/checkout/sessions/${encodeURIComponent(input.providerRef)}`);
    if (!res.ok) {
      // §36 — transport failure is NOT payment failure: retry-able UNKNOWN.
      return { outcome: "UNKNOWN", reason: res.kind === "TIMEOUT" ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE" };
    }
    if (res.status < 200 || res.status >= 300) {
      return { outcome: "UNKNOWN", reason: "PROVIDER_UNAVAILABLE" };
    }
    const claim = parseVerifyClaim(tryParseJson(res.body));
    if (claim.outcome !== "SUCCEEDED") return claim;
    // Reference binding (§23): the fetched session must BE the asked-about one.
    if (!claim.providerEventId.endsWith(input.providerRef)) {
      return { outcome: "UNKNOWN", reason: "REFERENCE_MISMATCH" };
    }
    // The SERVICE compares amount/currency against the session snapshot and
    // routes mismatches to reconciliation — the adapter returns the claim.
    return claim;
  },

  parseCallback(params: URLSearchParams): { providerRef: string } {
    // §19 — treat EVERY value as untrusted. Only session_id LOCATES the
    // attempt; any other query flag is ignored (success is decided
    // exclusively by server-side verification).
    const sessionId = params.get("session_id") ?? "";
    if (!/^cs_(test|live)_[A-Za-z0-9]{10,255}$/.test(sessionId)) {
      throw new CallbackParseError();
    }
    return { providerRef: sessionId };
  },
};

// `configured` must reflect the CURRENT env at runtime; module init order
// makes a static literal unsafe, so the registry reads this accessor
// (same pattern as zarinpal.ts).
Object.defineProperty(stripeProvider, "configured", {
  get: () => stripeSecretKey() !== null,
  enumerable: true,
});
