/**
 * Mock provider — the Prompt 22 sandbox adapter.
 *
 * A deterministic, fully in-process payment provider for development and
 * testing. It NEVER performs a real charge and is explicitly labeled as a
 * sandbox in the UI. Its job is to exercise the COMPLETE payment path —
 * session creation → provider reference → SIGNED webhook → verification →
 * idempotent fulfillment — without any external dependency.
 *
 * Mechanics:
 * - createCheckout returns providerRef `mock_<session-id>` and a redirect
 *   URL back into the in-app sandbox dialog (`/?checkout=<session-id>`).
 * - verifyWebhook validates the exact same HMAC scheme production
 *   providers use (timing-safe compare + timestamp tolerance), so tests
 *   that pass here prove the real webhook contract.
 * - getSessionStatus derives deterministically from the ref (a mock
 *   "gateway" would be a DB — here the service's own state is the truth).
 *
 * The `buildMockEventBody`/`buildMockEventHeaders` helpers are what the
 * sandbox checkout dialog (via the simulate endpoint) uses to drive
 * outcomes; they produce the byte-identical payload + signature header a
 * real gateway would POST.
 */

import { randomUUID } from "node:crypto";
import {
  buildSignatureHeader,
  getWebhookSecret,
  verifySignatureHeader,
} from "./signature";
import {
  WebhookVerificationError,
  type CreateCheckoutInput,
  type CreatedCheckout,
  type PaymentProvider,
  type ProviderWebhookEvent,
} from "./types";

export type MockEventKind = "checkout.succeeded" | "checkout.failed" | "checkout.expired";

export type MockEventPayload = {
  id: string;
  type: MockEventKind;
  created: number;
  data: {
    checkoutSessionId: string;
    amountMinor?: number;
    currency?: string;
    reason?: string;
  };
};

/** Byte-identical body a real gateway would POST for this outcome. */
export function buildMockEventBody(
  kind: MockEventKind,
  checkoutSessionId: string,
  overrides: { amountMinor?: number; currency?: string; reason?: string } = {},
): string {
  const payload: MockEventPayload = {
    id: `evt_mock_${randomUUID()}`,
    type: kind,
    created: Math.floor(Date.now() / 1000),
    data: { checkoutSessionId, ...overrides },
  };
  return JSON.stringify(payload);
}

/** Signed headers for that body (exactly what the webhook route expects). */
export function buildMockEventHeaders(body: string): Headers {
  const h = new Headers();
  h.set("content-type", "application/json");
  h.set("mock-signature", buildSignatureHeader(body, getWebhookSecret()));
  return h;
}

function isMockEventPayload(value: unknown): value is MockEventPayload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    v.id.length > 0 &&
    typeof v.type === "string" &&
    ["checkout.succeeded", "checkout.failed", "checkout.expired"].includes(v.type) &&
    typeof v.data === "object" &&
    v.data !== null &&
    typeof (v.data as Record<string, unknown>).checkoutSessionId === "string"
  );
}

export const mockProvider: PaymentProvider = {
  slug: "mock",
  displayName: "Sandbox (Mock)",
  mode: "SANDBOX",
  configured: true,
  capabilities: {
    // Test adapter: accepts every settlement currency so any catalog works.
    currencies: ["*"],
    webhooks: true, // signed in-process webhook events (the real contract)
    serverVerification: false, // no external truth to verify against — the
    // session row itself is the mock gateway's state.
    redirectCallback: false, // in-app dialog, no provider-hosted page
  },

  async createCheckout(input: CreateCheckoutInput): Promise<CreatedCheckout> {
    void input.callbackUrl; // mock ignores it (in-app hosted page)
    // Deterministic ref: our session id echoed with a scheme prefix.
    const providerRef = `mock_${input.checkoutSessionId}`;
    return {
      providerRef,
      // Single-page app: the sandbox "hosted page" is an in-app dialog.
      redirectUrl: `/?checkout=${encodeURIComponent(input.checkoutSessionId)}`,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    };
  },

  verifyWebhook(rawBody: string, headers: Headers): ProviderWebhookEvent {
    // 1) Signature FIRST — untrusted bytes are never trusted further.
    verifySignatureHeader(headers.get("mock-signature"), rawBody, getWebhookSecret());
    // 2) Shape validation — closed union or verification failure.
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new WebhookVerificationError();
    }
    if (!isMockEventPayload(parsed)) throw new WebhookVerificationError();
    const amountMinor =
      typeof parsed.data.amountMinor === "number" && Number.isSafeInteger(parsed.data.amountMinor)
        ? parsed.data.amountMinor
        : undefined;
    const currency = typeof parsed.data.currency === "string" ? parsed.data.currency : undefined;
    const reason = typeof parsed.data.reason === "string" ? parsed.data.reason : "unknown";
    switch (parsed.type) {
      case "checkout.succeeded":
        if (amountMinor === undefined) throw new WebhookVerificationError();
        return {
          kind: "checkout.succeeded",
          eventId: parsed.id,
          checkoutSessionId: parsed.data.checkoutSessionId,
          amountMinor,
          currency: currency ?? "EUR",
        };
      case "checkout.failed":
        return {
          kind: "checkout.failed",
          eventId: parsed.id,
          checkoutSessionId: parsed.data.checkoutSessionId,
          reason,
        };
      case "checkout.expired":
        return {
          kind: "checkout.expired",
          eventId: parsed.id,
          checkoutSessionId: parsed.data.checkoutSessionId,
        };
    }
  },

  async getSessionStatus() {
    // The mock gateway keeps no external state: the checkout session row
    // (our DB) is the single source of truth for reconciliation.
    return "PENDING" as const;
  },
};

export { WebhookVerificationError };
