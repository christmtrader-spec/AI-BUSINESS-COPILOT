/**
 * Zarinpal adapter — Prompt 23 REAL payment provider (the primary one).
 *
 * Provider: Zarinpal Payment Gateway, REST API v4 (PG v4).
 * Documentation source: doc.zarinpal.com (Payment Gateway v4 — payment
 * request / verify), corroborated by independent v4 SDKs (Rust/Go/Dart/TS).
 * API version: v4 (recorded per Prompt 23 §152).
 *
 * Jurisdiction rationale (Prompt 23 §2): this product's UI is Persian/English
 * and its primary market is Iran; Zarinpal is a legitimate, widely used
 * Iranian PSP. It settles in IRR (Rials) ONLY — therefore the adapter
 * DECLINES any checkout session whose settlement currency is not IRR
 * (Prompt 23 §52: no silent currency conversion, ever).
 *
 * Endpoints (environment-separated, §64 — never client-selectable):
 *   sandbox:    https://sandbox.zarinpal.com/pg/v4/payment/{request,verify}.json
 *   production: https://payment.zarinpal.com/pg/v4/payment/{request,verify}.json
 *   StartPay:   {base}/pg/StartPay/{authority}
 *
 * Flow (redirect-based, §17-§20):
 *   createCheckout → POST request.json → { authority } → StartPay redirect
 *   provider redirects the user back to OUR callback with
 *     ?Authority=…&Status=OK|NOK  (query values are UNTRUSTED, §19)
 *   verifyPayment → POST verify.json (server-to-server) → normalized result
 *
 * WEBHOOKS: Zarinpal v4 does NOT push payment webhooks. capabilities.webhooks
 * is false and verifyWebhook refuses everything — callback + server-side
 * verification is the authoritative mechanism (documented, Prompt 23 §29).
 *
 * SECURITY:
 * - merchant_id lives ONLY in process.env (server-side, §11).
 * - Safe logging only: no raw payloads/credentials (§56/§57) — the service
 *   logs refs and normalized results, this file logs nothing.
 * - No retries inside the adapter (§67); 15s timeout (§66).
 * - Amount mapping: internal IRR minor unit = 1 Rial (ISO exponent 0) —
 *   the provider amount equals our minor units, a deterministic integer
 *   identity (§54/§55, unit-tested).
 */

import { ApiError } from "@/lib/api-helpers";
import { postJson, tryParseJson } from "./http";
import { CallbackParseError, WebhookVerificationError } from "./types";
import {
  type CreateCheckoutInput,
  type CreatedCheckout,
  type PaymentProvider,
  type ProviderWebhookEvent,
  type VerifyPaymentResult,
} from "./types";
import { validatePaymentConfig } from "./config";

const SANDBOX_BASE = "https://sandbox.zarinpal.com";
const PRODUCTION_BASE = "https://payment.zarinpal.com";

/** Zarinpal v4 settles in Iranian Rials only (§52/§53). */
export const ZARINPAL_CURRENCY = "IRR";

/** Conservative session TTL guidance from the provider (default 30 min). */
const SESSION_TTL_MS = 30 * 60 * 1000;

type ZarinpalEnv = "sandbox" | "production";

function endpointEnv(): ZarinpalEnv {
  return validatePaymentConfig().env === "production" ? "production" : "sandbox";
}

export function zarinpalEndpoints(env: ZarinpalEnv): { request: string; verify: string; inquiry: string; startPay: string } {
  const base = env === "production" ? PRODUCTION_BASE : SANDBOX_BASE;
  return {
    request: `${base}/pg/v4/payment/request.json`,
    verify: `${base}/pg/v4/payment/verify.json`,
    inquiry: `${base}/pg/v4/payment/inquiry.json`,
    startPay: `${base}/pg/StartPay`,
  };
}

// ---------------------------------------------------------------------------
// Pure mapping helpers — exported for contract tests (mocked transport).
// ---------------------------------------------------------------------------

/** §53 mapping: internal IRR minor units (Rials) → provider amount. 1:1 int. */
export function amountToProvider(amountMinor: number, currency: string): number {
  if (currency !== ZARINPAL_CURRENCY) {
    throw new Error(`zarinpal: currency ${currency} is not supported (IRR only)`);
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new Error("zarinpal: amount must be a positive integer of Rials");
  }
  return amountMinor; // zero-decimal currency → identity mapping
}

/** Minimal, accurate, non-sensitive payment description (§99). */
export function buildPaymentDescription(planCode: string, billingPeriod: string): string {
  return `AI Business Copilot — ${planCode} Plan (${billingPeriod})`;
}

export type ZarinpalRequestPayload = {
  merchant_id: string;
  amount: number;
  callback_url: string;
  description: string;
};

export function buildRequestPayload(
  input: CreateCheckoutInput & { merchantId: string },
): ZarinpalRequestPayload {
  return {
    merchant_id: input.merchantId,
    amount: amountToProvider(input.amountMinor, input.currency),
    callback_url: input.callbackUrl,
    description: buildPaymentDescription(input.planCode, input.billingPeriod),
  };
}

/** Response of request.json — authority issued, or a typed config failure. */
export function parseRequestResponse(payload: unknown): { authority: string } {
  const body = (typeof payload === "object" && payload !== null ? payload : {}) as {
    data?: { code?: unknown; authority?: unknown } | null;
    errors?: { code?: unknown; message?: unknown } | null;
  };
  const code = typeof body.data?.code === "number" ? body.data.code : null;
  const authority = typeof body.data?.authority === "string" ? body.data.authority : null;
  if (code === 100 && authority && /^A[0-9a-zA-Z]{10,80}$/.test(authority)) {
    return { authority };
  }
  // Malformed/ambiguous provider response → never invent an authority (§35).
  throw new ApiError(
    502,
    "PROVIDER_INVALID_RESPONSE",
    "The payment provider returned an unexpected response.",
  );
}

export type ZarinpalVerifyPayload = {
  merchant_id: string;
  amount: number;
  authority: string;
};

/**
 * Map a verify.json response to the normalized result (§34/§35/§36).
 * - code 100 → verified; 101 → already verified (idempotent — same money).
 * - -50 → the PAID amount differs from the verify amount: money moved but
 *   NOT for our exact amount → UNKNOWN (service marks RECONCILIATION_REQUIRED).
 * - -51 → payment unsuccessful/canceled → NOT_PAID (session stays PENDING).
 * - -53 → gateway IP control tripped → UNKNOWN (security control, manual review).
 * - -54 → authority unknown → NOT_PAID (nothing was ever completed).
 * - anything else / malformed / transport failure → UNKNOWN (never fake).
 */
export function parseVerifyResponse(
  payload: unknown,
  expected: { amountMinor: number; currency: string; authority: string },
): VerifyPaymentResult {
  const body = (typeof payload === "object" && payload !== null ? payload : {}) as {
    data?: {
      code?: unknown;
      ref_id?: unknown;
      authority?: unknown;
    } | null;
    errors?: { code?: unknown } | null;
  };

  const dataCode = typeof body.data?.code === "number" ? body.data.code : null;
  const errCode = typeof body.errors?.code === "number" ? body.errors.code : null;

  if (errCode !== null) {
    if (errCode === -50) return { outcome: "UNKNOWN", reason: "AMOUNT_MISMATCH" };
    if (errCode === -51) return { outcome: "NOT_PAID", reason: "PAYMENT_UNSUCCESSFUL" };
    if (errCode === -53) return { outcome: "UNKNOWN", reason: "GATEWAY_IP_MISMATCH" };
    if (errCode === -54) return { outcome: "NOT_PAID", reason: "AUTHORITY_NOT_FOUND" };
    return { outcome: "UNKNOWN", reason: "UNKNOWN_PROVIDER_STATE" };
  }

  if (dataCode === 100 || dataCode === 101) {
    // The provider verifies the payment FOR the exact amount sent — any
    // discrepancy is provider error -50 (handled above). The authority must
    // echo back the one we asked about (§23 reference binding).
    const echoed = typeof body.data?.authority === "string" ? body.data.authority : expected.authority;
    if (echoed !== expected.authority) {
      return { outcome: "UNKNOWN", reason: "REFERENCE_MISMATCH" };
    }
    const refId = typeof body.data?.ref_id === "number" ? body.data.ref_id : null;
    return {
      outcome: "SUCCEEDED",
      providerEventId: `zarinpal-verify:${expected.authority}`,
      amountMinor: expected.amountMinor,
      currency: expected.currency,
      providerTxnRef: refId !== null ? `ZP-${refId}` : undefined,
    };
  }

  return { outcome: "UNKNOWN", reason: "UNKNOWN_PROVIDER_STATE" };
}

/** Conservative inquiry mapping — anything not provably terminal is PENDING. */
export function parseInquiryResponse(payload: unknown): "PENDING" | "SUCCEEDED" | "FAILED" {
  const body = (typeof payload === "object" && payload !== null ? payload : {}) as {
    data?: { code?: unknown; status?: unknown } | null;
    errors?: { code?: unknown } | null;
  };
  const status = typeof body.data?.status === "string" ? body.data.status.toUpperCase() : null;
  if (status === "PAID") return "SUCCEEDED";
  // UNPAID/EXPIRED/CANCELED or unknown → PENDING: inquiry support/shape MUST
  // be re-confirmed against current provider docs at activation time; the
  // conservative mapping can never fabricate a terminal state.
  return "PENDING";
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

function merchantId(): string | null {
  const raw = process.env.ZARINPAL_MERCHANT_ID?.trim() ?? "";
  // Zarinpal v4 merchant_id is a UUID-shaped terminal id; accept 32..64
  // alphanumeric/dash chars — validation errors are a config blocker, not a
  // runtime secret leak.
  return /^[0-9a-fA-F-]{32,64}$/.test(raw) ? raw : null;
}

export const zarinpalProvider: PaymentProvider = {
  slug: "zarinpal",
  displayName: "Zarinpal",
  mode: validatePaymentConfig().env === "production" ? "LIVE" : "SANDBOX",
  configured: false, // assigned below — module-init order safe
  capabilities: {
    currencies: [ZARINPAL_CURRENCY],
    webhooks: false, // §29 — callback + server verification is authoritative
    serverVerification: true,
    redirectCallback: true,
  },

  async createCheckout(input: CreateCheckoutInput): Promise<CreatedCheckout> {
    // Currency gate (§52) — refuse non-IRR sessions before any provider call.
    if (input.currency !== ZARINPAL_CURRENCY) {
      throw new ApiError(
        422,
        "PROVIDER_CURRENCY_UNSUPPORTED",
        "Zarinpal settles in IRR only; this plan's settlement currency is not supported by this provider.",
        { currency: input.currency },
      );
    }
    const mid = merchantId();
    if (!mid) {
      throw new ApiError(422, "PROVIDER_UNAVAILABLE", "The payment provider is not configured.");
    }
    const env = endpointEnv();
    const eps = zarinpalEndpoints(env);

    // NO retry (§67) — request.json is not provider-idempotent; a failed
    // create ends this attempt (the user can start a new one).
    const res = await postJson(eps.request, buildRequestPayload({ ...input, merchantId: mid }));
    if (!res.ok) {
      // §36 — a timeout here means we never received an authority, so the
      // user never left and no money can move; the service records a FAILED
      // attempt with the typed reason (documented, §37/§80).
      throw new ApiError(
        502,
        res.kind === "TIMEOUT" ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE",
        "The payment provider could not be reached.",
      );
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ApiError(502, "PROVIDER_UNAVAILABLE", "The payment provider rejected the request.");
    }
    const parsed = parseRequestResponse(tryParseJson(res.body));

    return {
      providerRef: parsed.authority,
      // §103 — the checkout URL comes ONLY from the trusted provider contract
      // (StartPay + our stored authority); never from any request input.
      redirectUrl: `${eps.startPay}/${encodeURIComponent(parsed.authority)}`,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    };
  },

  verifyWebhook(): ProviderWebhookEvent {
    // §29/§31 — the provider has no webhook mechanism; ANY POST to our
    // generic webhook route is not a legitimate provider call. Opaque 401.
    throw new WebhookVerificationError("Provider does not support webhooks");
  },

  async getSessionStatus(providerRef: string) {
    const mid = merchantId();
    if (!mid) return "PENDING";
    const env = endpointEnv();
    const res = await postJson(zarinpalEndpoints(env).inquiry, {
      merchant_id: mid,
      authority: providerRef,
    });
    if (!res.ok || res.status < 200 || res.status >= 300) return "PENDING"; // §35 conservative
    return parseInquiryResponse(tryParseJson(res.body));
  },

  async verifyPayment(input: {
    providerRef: string;
    expectedAmountMinor: number;
    expectedCurrency: string;
  }): Promise<VerifyPaymentResult> {
    if (input.expectedCurrency !== ZARINPAL_CURRENCY) {
      return { outcome: "UNKNOWN", reason: "CURRENCY_MISMATCH" };
    }
    const mid = merchantId();
    if (!mid) return { outcome: "UNKNOWN", reason: "PROVIDER_UNCONFIGURED" };
    const env = endpointEnv();
    const res = await postJson(zarinpalEndpoints(env).verify, {
      merchant_id: mid,
      amount: amountToProvider(input.expectedAmountMinor, input.expectedCurrency),
      authority: input.providerRef,
    } satisfies ZarinpalVerifyPayload);
    if (!res.ok) {
      // §36 — transport failure is NOT payment failure: PENDING + retry-able.
      return { outcome: "UNKNOWN", reason: res.kind === "TIMEOUT" ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE" };
    }
    if (res.status < 200 || res.status >= 300) {
      return { outcome: "UNKNOWN", reason: "PROVIDER_UNAVAILABLE" };
    }
    return parseVerifyResponse(tryParseJson(res.body), {
      amountMinor: input.expectedAmountMinor,
      currency: input.expectedCurrency,
      authority: input.providerRef,
    });
  },

  parseCallback(params: URLSearchParams): { providerRef: string } {
    // §19 — treat EVERY value as untrusted. Only the Authority is used to
    // LOCATE the attempt; the Status flag is ignored completely (success is
    // decided exclusively by server-side verification).
    const authority = params.get("Authority") ?? params.get("authority") ?? "";
    if (!/^A[0-9a-zA-Z]{10,80}$/.test(authority)) {
      throw new CallbackParseError();
    }
    return { providerRef: authority };
  },
};

// `configured` must reflect the CURRENT config at runtime; module init order
// makes a static literal unsafe, so the registry reads this accessor.
Object.defineProperty(zarinpalProvider, "configured", {
  get: () => {
    const cfg = validatePaymentConfig();
    return cfg.enabled && cfg.providerSlug === "zarinpal" && cfg.blockers.length === 0;
  },
  enumerable: true,
});
