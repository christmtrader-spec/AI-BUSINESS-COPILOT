/**
 * Payment provider abstraction — Prompt 22 core types.
 *
 * A payment provider is an ADAPTER behind a strict interface. The rest of
 * the application (service, routes, UI) only ever talks to these types —
 * swapping the sandbox "mock" provider for Stripe/Zarinpal later touches
 * exactly one file per provider and nothing else.
 *
 * Security posture (fail closed):
 * - Providers never receive or store payment instruments here; they return
 *   references the webhook can verify.
 * - Webhook verification is per-provider: raw body bytes + headers in,
 *   a typed event out — or a VerificationError that the route maps to 401
 *   WITHOUT leaking which check failed.
 * - Every provider event carries a unique eventId (idempotency anchor for
 *   ProcessedWebhookEvent) and a type from a closed union.
 */

export type ProviderSlug = "mock" | "zarinpal" | "stripe";

export const PROVIDER_SLUGS = ["mock", "zarinpal", "stripe"] as const satisfies readonly ProviderSlug[];

export function isProviderSlug(value: unknown): value is ProviderSlug {
  return typeof value === "string" && (PROVIDER_SLUGS as readonly string[]).includes(value);
}

export type ProviderMode = "SANDBOX" | "LIVE";

/** Input to provider.createCheckout — ids are resolved by the service. */
export type CreateCheckoutInput = {
  /** Our CheckoutSession id — the provider echoes it back in every event. */
  checkoutSessionId: string;
  businessId: string;
  planCode: string;
  billingPeriod: "MONTHLY" | "YEARLY";
  amountMinor: number;
  currency: string;
  /** Prompt 23 §18 — built from the CONFIGURED app base URL by the
   *  service; adapters must never derive it from request headers. */
  callbackUrl: string;
};

/** Prompt 23 §81 — what a provider can do in THIS runtime (static, safe). */
export type ProviderCapabilities = {
  /** Settlement currencies the adapter accepts at session creation. */
  currencies: readonly string[];
  /** Provider PUSHES webhook events (POST /api/v1/webhooks/payments/<slug>).
   *  false → callback + server-side verification is the authoritative
   *  mechanism (documented — Prompt 23 §29). */
  webhooks: boolean;
  /** Adapter implements verifyPayment() (server-side verification, §20). */
  serverVerification: boolean;
  /** Provider redirects the user back to GET /api/v1/payments/callback/<slug>. */
  redirectCallback: boolean;
};

export type CreatedCheckout = {
  /** Provider-side reference stored on the session (unique per provider). */
  providerRef: string;
  /** Where the user completes payment. The mock provider points back into
   *  the in-app sandbox dialog (`/?checkout=<session>`). */
  redirectUrl: string;
  expiresAt: Date;
};

/** A verified, provider-originated event. */
export type ProviderWebhookEvent =
  | {
      kind: "checkout.succeeded";
      eventId: string;
      checkoutSessionId: string;
      amountMinor: number;
      currency: string;
    }
  | { kind: "checkout.failed"; eventId: string; checkoutSessionId: string; reason: string }
  | { kind: "checkout.expired"; eventId: string; checkoutSessionId: string };

export class WebhookVerificationError extends Error {
  constructor(message = "Webhook verification failed") {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

/** A provider redirect callback could not be resolved to an attempt. */
export class CallbackParseError extends Error {
  constructor(message = "Invalid provider callback") {
    super(message);
    this.name = "CallbackParseError";
  }
}

/**
 * Normalized server-side verification result (Prompt 23 §20/§34/§35/§36).
 * The SERVICE — never the adapter — compares amounts/currencies against
 * the session snapshot and decides state transitions.
 */
export type VerifyPaymentResult =
  | {
      /** Provider authoritatively confirmed the payment. */
      outcome: "SUCCEEDED";
      /** Stable provider event/transaction id — the idempotency anchor. */
      providerEventId: string;
      /** Provider-reported amount/currency (provider units already normalized). */
      amountMinor: number;
      currency: string;
      providerTxnRef?: string;
    }
  | { outcome: "NOT_PAID"; reason: string }
  | { outcome: "FAILED"; reason: string }
  /** Unknown/ambiguous outcome (timeout, malformed, contradiction) —
   *  NEVER mapped to success or failure (§35/§36). */
  | { outcome: "UNKNOWN"; reason: string };

/** The provider contract — every adapter implements exactly this. */
export interface PaymentProvider {
  readonly slug: ProviderSlug;
  readonly displayName: string;
  readonly mode: ProviderMode;
  /** Whether this provider is configured in the CURRENT environment. */
  readonly configured: boolean;
  readonly capabilities: ProviderCapabilities;
  createCheckout(input: CreateCheckoutInput): Promise<CreatedCheckout>;
  /**
   * Verify + parse a webhook delivery. Throws WebhookVerificationError on
   * ANY signature/timestamp/shape problem (route maps to 401 — never 400,
   * so gateways retry and probes learn nothing).
   */
  verifyWebhook(rawBody: string, headers: Headers): ProviderWebhookEvent;
  /** Authoritative session status for reconciliation (lazy expiry / heal). */
  getSessionStatus(providerRef: string): Promise<"PENDING" | "SUCCEEDED" | "FAILED" | "EXPIRED">;
  /**
   * Server-side verification (Prompt 23 §20) — MANDATORY for redirect-based
   * real providers. Present exactly when capabilities.serverVerification.
   * Pure provider call: returns the provider's normalized claim; the service
   * validates it against the internal snapshot.
   */
  verifyPayment?(input: {
    providerRef: string;
    expectedAmountMinor: number;
    expectedCurrency: string;
  }): Promise<VerifyPaymentResult>;
  /**
   * Parse a redirect callback's query params down to the providerRef ONLY
   * (Prompt 23 §19 — callback values are UNTRUSTED; query status flags are
   * never success evidence). Present exactly when capabilities.redirectCallback.
   */
  parseCallback?(params: URLSearchParams): { providerRef: string };
}

/** Events a provider emits (closed union — unknown types are ignored). */
export const WEBHOOK_EVENT_KINDS = [
  "checkout.succeeded",
  "checkout.failed",
  "checkout.expired",
] as const;

export type WebhookEventKind = (typeof WEBHOOK_EVENT_KINDS)[number];

export function isWebhookEventKind(value: unknown): value is WebhookEventKind {
  return (
    typeof value === "string" &&
    (WEBHOOK_EVENT_KINDS as readonly string[]).includes(value)
  );
}
