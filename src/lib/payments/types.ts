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

export type ProviderSlug = "mock";

export const PROVIDER_SLUGS = ["mock"] as const satisfies readonly ProviderSlug[];

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

/** The provider contract — every adapter implements exactly this. */
export interface PaymentProvider {
  readonly slug: ProviderSlug;
  readonly displayName: string;
  readonly mode: ProviderMode;
  /** Whether this provider is configured in the CURRENT environment. */
  readonly configured: boolean;
  createCheckout(input: CreateCheckoutInput): Promise<CreatedCheckout>;
  /**
   * Verify + parse a webhook delivery. Throws WebhookVerificationError on
   * ANY signature/timestamp/shape problem (route maps to 401 — never 400,
   * so gateways retry and probes learn nothing).
   */
  verifyWebhook(rawBody: string, headers: Headers): ProviderWebhookEvent;
  /** Authoritative session status for reconciliation (lazy expiry / heal). */
  getSessionStatus(providerRef: string): Promise<"PENDING" | "SUCCEEDED" | "FAILED" | "EXPIRED">;
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
