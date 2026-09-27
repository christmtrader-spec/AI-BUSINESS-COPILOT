/**
 * Payments service — Prompt 22. The ONLY sanctioned path to checkout
 * sessions, payment transactions and webhook fulfillment (mirrors the
 * Prompt 20 billing service discipline).
 *
 * Invariants:
 * - The browser never supplies amounts, plan prices, or "paid" state.
 *   It supplies at most { planCode, billingPeriod }; everything else is
 *   resolved server-side (§23/§24).
 * - Fulfillment is IDEMPOTENT end to end:
 *     webhook eventId → ProcessedWebhookEvent unique row (replay guard)
 *     session terminal state → single fulfillment per session
 *     plan change → Prompt 20 changePlan (idempotent by itself)
 * - Crash-safety: session SUCCEEDED is committed together with the
 *   transaction record; the plan change runs right after. A crash in
 *   between leaves `fulfilledAt = null`, and every read of the session
 *   AUTO-HEALS by re-running the idempotent plan change (documented
 *   reconciliation, deterministic outcome).
 * - A `checkout.succeeded` arriving for a locally EXPIRED session is
 *   still honored (money moved — never lose it, §fail-open only for
 *   paid truth); CANCELED sessions ignore late webhooks.
 * - Audits: every state transition writes an audit log row.
 */

import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { changePlan, invalidateBillingCache, recordCommercialEvent } from "@/lib/billing";
import { isBillingPeriod, type BillingPeriod } from "@/lib/billing/state-machine";
import { validatePaymentConfig } from "./config";
import { buildMockEventBody, buildMockEventHeaders } from "./mock-provider";
import { providerSupportsCurrency, resolvePrice } from "./pricing-service";
import { defaultProvider, isProviderUsable, resolveProvider } from "./registry";
import { CallbackParseError, WebhookVerificationError, type ProviderWebhookEvent } from "./types";

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export type CheckoutSessionDto = {
  id: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "EXPIRED" | "CANCELED" | "RECONCILIATION_REQUIRED";
  planCode: string;
  billingPeriod: BillingPeriod;
  provider: string;
  amountMinor: number;
  currency: string;
  expiresAt: string;
  completedAt: string | null;
  fulfilledAt: string | null;
  createdAt: string;
  redirectUrl: string | null;
  /** Prompt 23 §45 — set only on RECONCILIATION_REQUIRED sessions. */
  reconciliationReason: string | null;
  /** Prompt 23 §13 — catalog edition that priced this intent. */
  pricingVersion: string | null;
  /** Prompt 24 §30 — readable code of the price book that priced this intent. */
  priceBookCode: string | null;
  /** Prompt 23 §110 — confirmation screen shows the charged business. */
  businessName: string;
};

export type PaymentRowDto = {
  id: string;
  checkoutSessionId: string;
  provider: string;
  status: string;
  planCode: string;
  billingPeriod: BillingPeriod;
  amountMinor: number;
  currency: string;
  processedAt: string;
};

type SessionRow = {
  id: string;
  businessId: string;
  planCode: string;
  billingPeriod: string;
  provider: string;
  providerRef: string;
  amountMinor: number;
  currency: string;
  status: string;
  reconciliationReason: string | null;
  pricingVersion: string | null;
  priceBookCode: string | null;
  expiresAt: Date;
  completedAt: Date | null;
  fulfilledAt: Date | null;
  createdAt: Date;
  metaJson: string | null;
};

type SessionWithBusiness = SessionRow & { business?: { name: string } | null };

function parseSessionMeta(metaJson: string | null): { redirectUrl?: string } {
  try {
    const meta = metaJson ? (JSON.parse(metaJson) as Record<string, unknown>) : {};
    return { redirectUrl: typeof meta.redirectUrl === "string" ? meta.redirectUrl : undefined };
  } catch {
    return {};
  }
}

function sessionDto(
  s: SessionRow,
  businessName: string,
  redirectUrl: string | null,
): CheckoutSessionDto {
  return {
    id: s.id,
    status: s.status as CheckoutSessionDto["status"],
    planCode: s.planCode,
    billingPeriod: (isBillingPeriod(s.billingPeriod) ? s.billingPeriod : "MONTHLY") as BillingPeriod,
    provider: s.provider,
    amountMinor: s.amountMinor,
    currency: s.currency,
    expiresAt: s.expiresAt.toISOString(),
    completedAt: s.completedAt?.toISOString() ?? null,
    fulfilledAt: s.fulfilledAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    redirectUrl: s.status === "PENDING" ? redirectUrl : null,
    reconciliationReason: s.reconciliationReason,
    pricingVersion: s.pricingVersion,
    priceBookCode: s.priceBookCode,
    businessName,
  };
}

// ---------------------------------------------------------------------------
// Lazy expiry — PENDING sessions past expiresAt become EXPIRED on sight.
// ---------------------------------------------------------------------------

export async function expireStaleSessions(businessId?: string): Promise<number> {
  const stale = await db.checkoutSession.findMany({
    where: {
      status: "PENDING",
      expiresAt: { lt: new Date() },
      ...(businessId ? { businessId } : {}),
    },
    select: { id: true },
    take: 100,
  });
  if (stale.length === 0) return 0;
  const res = await db.checkoutSession.updateMany({
    where: { id: { in: stale.map((s) => s.id) }, status: "PENDING" },
    data: { status: "EXPIRED", completedAt: new Date() },
  });
  return res.count;
}

// ---------------------------------------------------------------------------
// Create a checkout session
// ---------------------------------------------------------------------------

export async function createCheckout(
  businessId: string,
  input: { planCode: string; billingPeriod: string; currency?: string },
  opts: { actorId?: string | null } = {},
): Promise<CheckoutSessionDto> {
  // Prompt 23 §88 — a disabled or mis-configured payment system refuses to
  // start ANY intent (fail closed, §89). Existing sessions stay untouched.
  const cfg = validatePaymentConfig();
  if (!cfg.enabled || cfg.blockers.length > 0) {
    throw new ApiError(422, "PAYMENTS_UNAVAILABLE", "Payment initiation is not available.");
  }

  // Prompt 24 §54 — resolve plan → price → provider IN ORDER. resolvePrice
  // validates the plan (purchasable + active), the currency (allowlist) and
  // the book window, and throws the structured §55 codes — the browser
  // never influences anything beyond { planCode, billingPeriod, currency }.
  const price = await resolvePrice({
    planCode: input.planCode,
    billingPeriod: input.billingPeriod,
    currency: input.currency,
  });
  const billingPeriod = price.billingPeriod;

  const provider = defaultProvider();

  // §110 — the confirmation screen shows the charged business; resolve the
  // name once here (the business context was already authorized upstream).
  const business = await db.business.findUnique({
    where: { id: businessId },
    select: { name: true },
  });
  if (!business) {
    throw new ApiError(404, "BUSINESS_NOT_FOUND", "Business not found.");
  }

  // Prompt 23 §52 / Prompt 24 §16-§17 — the provider must actually support
  // the settlement currency, decided ONLY by its declared capabilities (§47:
  // no `if provider === …` anywhere). No silent conversion, no silent
  // provider switch: an unsupported currency is a 422 before ANY provider
  // interaction (§17/§18).
  if (!providerSupportsCurrency(provider, price.currency)) {
    throw new ApiError(
      422,
      "PROVIDER_CURRENCY_UNSUPPORTED",
      "The configured payment provider does not support this plan's settlement currency.",
      { currency: price.currency },
    );
  }

  // Prompt 23 §18 — callback URLs come from the CONFIGURED base URL only,
  // never from request headers (open-redirect / host-injection safe, §104).
  const callbackUrl = `${cfg.baseUrl}/api/v1/payments/callback/${provider.slug}`;

  // Clean up: creating a new checkout cancels the business's still-PENDING
  // sessions (one live checkout per business — deterministic state).
  await db.checkoutSession.updateMany({
    where: { businessId, status: "PENDING" },
    data: { status: "CANCELED", completedAt: new Date() },
  });

  const session = await db.checkoutSession.create({
    data: {
      businessId,
      planCode: input.planCode,
      billingPeriod,
      provider: provider.slug,
      providerRef: "", // filled by the provider below (needs our id first)
      amountMinor: price.amountMinor,
      currency: price.currency,
      status: "PENDING",
      pricingVersion: price.priceVersion, // §13/§30 price snapshot reference
      priceBookId: price.priceBookId, // §29/§30 immutable book reference
      priceBookCode: price.priceBookCode,
      initiatedByUserId: opts.actorId ?? null, // §149 payment initiator
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      metaJson: JSON.stringify({ mode: provider.mode, displayName: provider.displayName }),
    },
  });

  try {
    const created = await provider.createCheckout({
      checkoutSessionId: session.id,
      businessId,
      planCode: input.planCode,
      billingPeriod,
      amountMinor: price.amountMinor,
      currency: price.currency,
      callbackUrl,
    });

    const updated = await db.checkoutSession.update({
      where: { id: session.id },
      data: {
        providerRef: created.providerRef,
        expiresAt: created.expiresAt,
        metaJson: JSON.stringify({
          mode: provider.mode,
          displayName: provider.displayName,
          redirectUrl: created.redirectUrl, // safe provider URL (no secrets, §56)
        }),
      },
    });

    await audit({
      businessId,
      actorId: opts.actorId ?? null,
      action: "billing.checkout_created",
      entityType: "CheckoutSession",
      entityId: session.id,
      after: {
        planCode: input.planCode,
        billingPeriod,
        amountMinor: price.amountMinor,
        currency: price.currency,
        provider: provider.slug,
        pricingVersion: price.priceVersion,
        priceBookCode: price.priceBookCode,
      },
    });

    return sessionDto(updated, business.name, created.redirectUrl);
  } catch (error) {
    // §35/§36 — the attempt could not be created on the provider. No
    // authority was issued (or none received), so no money can move: the
    // session is recorded as a FAILED historical attempt with the typed
    // reason and the error surfaces to the caller.
    const reason =
      error instanceof ApiError
        ? error.code
        : "PROVIDER_UNAVAILABLE";
    await db.checkoutSession.update({
      where: { id: session.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        metaJson: JSON.stringify({
          mode: provider.mode,
          displayName: provider.displayName,
          failureReason: reason,
        }),
      },
    });
    await audit({
      businessId,
      actorId: opts.actorId ?? null,
      action: "billing.payment_failed",
      entityType: "CheckoutSession",
      entityId: session.id,
      after: { reason, stage: "create", planCode: input.planCode },
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Session read (membership-scoped) — lazy expiry + fulfillment auto-heal.
// ---------------------------------------------------------------------------

export async function getCheckoutSession(
  businessId: string,
  sessionId: string,
): Promise<CheckoutSessionDto> {
  const raw = await db.checkoutSession.findFirst({
    where: { id: sessionId, businessId },
    include: { business: { select: { name: true } } },
  });
  if (!raw) {
    // Not found OR another tenant's session — indistinguishable on purpose.
    throw new ApiError(404, "CHECKOUT_NOT_FOUND", "Checkout session not found.");
  }
  const businessName = raw.business?.name ?? "";
  // A historical session whose provider has since been disabled still reads
  // fine (redirectUrl degrades to null) — fail closed only on NEW checkouts.
  const provider = isProviderUsable(raw.provider) ? resolveProvider(raw.provider) : null;

  let s: SessionRow = raw;
  if (s.status === "PENDING" && s.expiresAt.getTime() <= Date.now()) {
    s = await db.checkoutSession.update({
      where: { id: s.id },
      data: { status: "EXPIRED", completedAt: new Date() },
    });
  }
  if (s.status === "SUCCEEDED" && !s.fulfilledAt) {
    // Crash window after the webhook committed but before the plan change
    // finished — re-run the IDEMPOTENT fulfillment now.
    await fulfillSession(s, "auto-heal");
    s = (await db.checkoutSession.findUnique({ where: { id: s.id } })) ?? s;
  }
  // Prompt 22: mock sessions re-enter the in-app sandbox dialog.
  // Prompt 23: redirect-based providers resume from the stored provider URL.
  let redirect: string | null = null;
  if (provider?.slug === "mock") {
    redirect = `/?checkout=${encodeURIComponent(s.id)}`;
  } else if (provider?.capabilities.redirectCallback && s.status === "PENDING") {
    redirect = parseSessionMeta(s.metaJson).redirectUrl ?? null;
  }
  return sessionDto(s, businessName, redirect);
}

// ---------------------------------------------------------------------------
// Fulfillment — from a VERIFIED provider event to a plan change.
// ---------------------------------------------------------------------------

async function fulfillSession(s: SessionRow, source: string): Promise<SessionRow> {
  // changePlan is idempotent (same plan → no-op) and re-engages ACTIVE.
  await changePlan(s.businessId, s.planCode, {
    actorId: null, // provider-actor — the webhook event is the evidence
    source: `payment-webhook:${source}`,
  });
  const done = await db.checkoutSession.update({
    where: { id: s.id },
    data: { fulfilledAt: new Date() },
  });
  invalidateBillingCache(s.businessId);
  // Funnel: CHECKOUT_COMPLETED (Prompt 25) — fire-safe analytics, idempotent
  // per session; payment truth itself stays in the checkout session row.
  void recordCommercialEvent({
    eventType: "CHECKOUT_COMPLETED",
    businessId: s.businessId,
    planCode: s.planCode,
    currency: s.currency,
    dedupeKey: `checkout-done:${s.id}`,
  });
  return done;
}

export type FulfillResult = {
  received: true;
  duplicate: boolean;
  ignored?: "unknown-session" | "canceled";
  sessionStatus?: CheckoutSessionDto["status"];
};

/**
 * Handle a VERIFIED provider event. Idempotency layers:
 *   1) (provider, eventId) unique → ProcessedWebhookEvent (replay guard)
 *   2) session status guards (terminal states never re-fulfill)
 *   3) changePlan itself (same-plan no-op)
 */
export async function fulfillWebhook(
  providerSlug: string,
  event: ProviderWebhookEvent,
): Promise<FulfillResult> {
  const provider = resolveProvider(providerSlug);

  // Layer 1 — event dedupe. Insert-first: if this exact delivery was
  // already processed, short-circuit BEFORE any state mutation.
  try {
    await db.processedWebhookEvent.create({
      data: { provider: provider.slug, eventId: event.eventId, eventType: event.kind },
    });
  } catch {
    return { received: true, duplicate: true };
  }

  // Resolve the session via the provider reference (gateway echoes our id).
  const sessionId = event.checkoutSessionId;
  const s = await db.checkoutSession.findFirst({
    where: { id: sessionId, provider: provider.slug },
  });
  if (!s) return { received: true, duplicate: false, ignored: "unknown-session" };

  if (event.kind === "checkout.failed") {
    if (s.status === "PENDING") {
      await db.$transaction([
        db.checkoutSession.update({
          where: { id: s.id },
          data: { status: "FAILED", completedAt: new Date() },
        }),
        db.paymentTransaction.create({
          data: {
            checkoutSessionId: s.id,
            provider: provider.slug,
            providerEventId: event.eventId,
            status: "FAILED",
            amountMinor: s.amountMinor,
            currency: s.currency,
            metaJson: JSON.stringify({ reason: event.reason }),
          },
        }),
      ]);
      await audit({
        businessId: s.businessId,
        actorId: null,
        action: "billing.payment_failed",
        entityType: "CheckoutSession",
        entityId: s.id,
        after: { reason: event.reason, planCode: s.planCode },
      });
      return { received: true, duplicate: false, sessionStatus: "FAILED" };
    }
    return { received: true, duplicate: false, sessionStatus: s.status as CheckoutSessionDto["status"] };
  }

  if (event.kind === "checkout.expired") {
    if (s.status === "PENDING") {
      await db.checkoutSession.update({
        where: { id: s.id },
        data: { status: "EXPIRED", completedAt: new Date() },
      });
      return { received: true, duplicate: false, sessionStatus: "EXPIRED" };
    }
    return { received: true, duplicate: false, sessionStatus: s.status as CheckoutSessionDto["status"] };
  }

  // checkout.succeeded — the only money-moving event.
  // Amount/currency guard: the provider's reported values must match OUR
  // snapshot (server authority). A mismatch NEVER activates a plan and is
  // NEVER silently "failed" (Prompt 23 §21/§22/§45): the session goes to
  // RECONCILIATION_REQUIRED with the discrepancy recorded for review.
  if (event.amountMinor !== s.amountMinor || event.currency !== s.currency) {
    const reason = event.currency !== s.currency ? "CURRENCY_MISMATCH" : "AMOUNT_MISMATCH";
    await db.$transaction([
      db.checkoutSession.update({
        where: { id: s.id },
        data: {
          status: "RECONCILIATION_REQUIRED",
          completedAt: new Date(),
          reconciliationReason: reason,
          metaJson: JSON.stringify({
            discrepancy: {
              expected: { amountMinor: s.amountMinor, currency: s.currency },
              reported: { amountMinor: event.amountMinor, currency: event.currency },
            },
          }),
        },
      }),
      db.paymentTransaction.create({
        data: {
          checkoutSessionId: s.id,
          provider: provider.slug,
          providerEventId: event.eventId,
          status: "FAILED",
          amountMinor: event.amountMinor,
          currency: event.currency,
          metaJson: JSON.stringify({ reason: "amount-mismatch" }),
        },
      }),
    ]);
    await audit({
      businessId: s.businessId,
      actorId: null,
      action: "billing.payment_reconciliation_required",
      entityType: "CheckoutSession",
      entityId: s.id,
      after: {
        reason,
        planCode: s.planCode,
        expected: { amountMinor: s.amountMinor, currency: s.currency },
        reported: { amountMinor: event.amountMinor, currency: event.currency },
      },
    });
    return { received: true, duplicate: false, sessionStatus: "RECONCILIATION_REQUIRED" };
  }

  if (s.status === "CANCELED") {
    return { received: true, duplicate: false, ignored: "canceled" };
  }

  const alreadySucceeded = s.status === "SUCCEEDED";
  if (!alreadySucceeded) {
    await db.$transaction([
      db.checkoutSession.update({
        where: { id: s.id },
        data: { status: "SUCCEEDED", completedAt: new Date() },
      }),
      db.paymentTransaction.create({
        data: {
          checkoutSessionId: s.id,
          provider: provider.slug,
          providerEventId: event.eventId,
          status: "SUCCEEDED",
          amountMinor: s.amountMinor,
          currency: s.currency,
        },
      }),
    ]);
  }

  const current = await db.checkoutSession.findUnique({ where: { id: s.id } });
  if (!current) return { received: true, duplicate: alreadySucceeded };

  if (!current.fulfilledAt) {
    await fulfillSession(current, "webhook");
    await audit({
      businessId: current.businessId,
      actorId: null,
      action: "billing.payment_succeeded",
      entityType: "CheckoutSession",
      entityId: current.id,
      after: { planCode: current.planCode, amountMinor: current.amountMinor, currency: current.currency },
    });
  }
  return { received: true, duplicate: alreadySucceeded, sessionStatus: "SUCCEEDED" };
}

// ---------------------------------------------------------------------------
// Server-side verification — Prompt 23 §20 (MANDATORY for redirect-based
// providers). The browser NEVER decides the outcome: the ADAPTER talks to
// the provider, the SERVICE compares the provider's claim against the
// session snapshot (amount §21, currency §22, reference §23) and only a
// fully verified success reaches the plan change (§48 strict order).
// ---------------------------------------------------------------------------

/** UNKNOWN reasons that indicate money may have moved WRONG → reconciliation. */
const RECONCILIATION_REASONS = new Set(["AMOUNT_MISMATCH", "CURRENCY_MISMATCH", "REFERENCE_MISMATCH", "GATEWAY_IP_MISMATCH"]);

export type VerifyOutcome = {
  session: CheckoutSessionDto;
  verification: "SUCCEEDED" | "NOT_PAID" | "FAILED" | "UNKNOWN" | "ALREADY_VERIFIED" | "UNSUPPORTED";
};

export async function verifyCheckoutSession(
  businessId: string,
  sessionId: string,
): Promise<VerifyOutcome> {
  const raw = await db.checkoutSession.findFirst({
    where: { id: sessionId, businessId },
    include: { business: { select: { name: true } } },
  });
  if (!raw) {
    // Tenant-isolated: another business's session is indistinguishable.
    throw new ApiError(404, "CHECKOUT_NOT_FOUND", "Checkout session not found.");
  }
  const businessName = raw.business?.name ?? "";
  let s: SessionRow = raw;

  // Lazy expiry first — an expired session is never verified (§79).
  if (s.status === "PENDING" && s.expiresAt.getTime() <= Date.now()) {
    s = await db.checkoutSession.update({
      where: { id: s.id },
      data: { status: "EXPIRED", completedAt: new Date() },
    });
  }

  if (s.status === "SUCCEEDED" && !s.fulfilledAt) {
    await fulfillSession(s, "verify-auto-heal");
    s = (await db.checkoutSession.findUnique({ where: { id: s.id } })) ?? s;
    return { session: sessionDto(s, businessName, null), verification: "ALREADY_VERIFIED" };
  }
  if (s.status !== "PENDING") {
    // Terminal states are read-only here: RECONCILIATION_REQUIRED/FAILED/
    // EXPIRED/CANCELED are never re-litigated through the verify endpoint.
    return { session: sessionDto(s, businessName, null), verification: "ALREADY_VERIFIED" };
  }

  const provider = isProviderUsable(s.provider) ? resolveProvider(s.provider) : null;
  if (!provider || !provider.capabilities.serverVerification || !provider.verifyPayment) {
    throw new ApiError(
      422,
      "VERIFICATION_NOT_SUPPORTED",
      "This payment provider does not support server-side verification.",
    );
  }
  if (!s.providerRef) {
    throw new ApiError(422, "VERIFICATION_NOT_SUPPORTED", "This session has no provider reference to verify.");
  }

  const result = await provider.verifyPayment({
    providerRef: s.providerRef,
    expectedAmountMinor: s.amountMinor,
    expectedCurrency: s.currency,
  });

  if (result.outcome === "SUCCEEDED") {
    // Route the provider-confirmed claim through the SAME fulfillment
    // pipeline a webhook would use (§26/§74 — one transition, ever).
    const event: ProviderWebhookEvent = {
      kind: "checkout.succeeded",
      eventId: result.providerEventId,
      checkoutSessionId: s.id,
      amountMinor: result.amountMinor,
      currency: result.currency,
    };
    const fulfilled = await fulfillWebhook(provider.slug, event);
    const fresh = (await db.checkoutSession.findUnique({ where: { id: s.id } })) as SessionRow;
    await audit({
      businessId: s.businessId,
      actorId: null,
      action: "billing.payment_verified",
      entityType: "CheckoutSession",
      entityId: s.id,
      after: { result: "SUCCEEDED", duplicate: fulfilled.duplicate, providerTxnRef: result.providerTxnRef ?? null },
    });
    return { session: sessionDto(fresh, businessName, null), verification: fulfilled.duplicate ? "ALREADY_VERIFIED" : "SUCCEEDED" };
  }

  if (result.outcome === "FAILED") {
    const event: ProviderWebhookEvent = {
      kind: "checkout.failed",
      eventId: `verify-failed:${s.providerRef}`,
      checkoutSessionId: s.id,
      reason: result.reason,
    };
    await fulfillWebhook(provider.slug, event);
    const fresh = (await db.checkoutSession.findUnique({ where: { id: s.id } })) as SessionRow;
    await audit({
      businessId: s.businessId,
      actorId: null,
      action: "billing.payment_verified",
      entityType: "CheckoutSession",
      entityId: s.id,
      after: { result: "FAILED", reason: result.reason },
    });
    return { session: sessionDto(fresh, businessName, null), verification: "FAILED" };
  }

  if (result.outcome === "NOT_PAID") {
    // §44 — unknown outcome for the USER, but the provider definitively has
    // no completed payment: the session stays PENDING (retry before expiry).
    await audit({
      businessId: s.businessId,
      actorId: null,
      action: "billing.payment_verified",
      entityType: "CheckoutSession",
      entityId: s.id,
      after: { result: "NOT_PAID", reason: result.reason },
    });
    return { session: sessionDto(s, businessName, null), verification: "NOT_PAID" };
  }

  // UNKNOWN (§35/§36) — never success, never failure.
  if (RECONCILIATION_REASONS.has(result.reason)) {
    // Money may have moved under a different amount/currency/reference:
    // terminal reconciliation (§45) — recorded, never auto-resolved.
    await db.checkoutSession.update({
      where: { id: s.id, status: "PENDING" },
      data: {
        status: "RECONCILIATION_REQUIRED",
        completedAt: new Date(),
        reconciliationReason: result.reason,
        metaJson: JSON.stringify({ discrepancyReason: result.reason, providerRef: s.providerRef }),
      },
    });
    await audit({
      businessId: s.businessId,
      actorId: null,
      action: "billing.payment_reconciliation_required",
      entityType: "CheckoutSession",
      entityId: s.id,
      after: { reason: result.reason, providerRef: s.providerRef, planCode: s.planCode },
    });
    const fresh = (await db.checkoutSession.findUnique({ where: { id: s.id } })) as SessionRow;
    return { session: sessionDto(fresh, businessName, null), verification: "UNKNOWN" };
  }
  // Transport-level UNKNOWN (timeout/unavailable) → stay PENDING (§36);
  // the user may re-verify through the rate-limited endpoint (§68).
  await audit({
    businessId: s.businessId,
    actorId: null,
    action: "billing.payment_verified",
    entityType: "CheckoutSession",
    entityId: s.id,
    after: { result: "UNKNOWN", reason: result.reason },
  });
  return { session: sessionDto(s, businessName, null), verification: "UNKNOWN" };
}

// ---------------------------------------------------------------------------
// Provider redirect callback — Prompt 23 §19. Callback values are UNTRUSTED:
// the query string only LOCATES the attempt; the success decision comes
// exclusively from server-side verification against the provider.
// ---------------------------------------------------------------------------

export type CallbackOutcome = {
  found: boolean;
  sessionId?: string;
};

export async function handleProviderCallback(
  providerSlug: string,
  params: URLSearchParams,
): Promise<CallbackOutcome> {
  let provider;
  try {
    provider = resolveProvider(providerSlug);
  } catch {
    return { found: false };
  }
  if (!provider.capabilities.redirectCallback || !provider.parseCallback) {
    return { found: false };
  }

  let providerRef: string;
  try {
    ({ providerRef } = provider.parseCallback(params));
  } catch (error) {
    if (error instanceof CallbackParseError) return { found: false };
    throw error;
  }

  const s = await db.checkoutSession.findFirst({
    where: { provider: provider.slug, providerRef },
  });
  if (!s) return { found: false };

  await audit({
    businessId: s.businessId,
    actorId: null,
    action: "billing.payment_started",
    entityType: "CheckoutSession",
    entityId: s.id,
    after: { provider: provider.slug, stage: "callback" },
  });

  // One bounded server-side verification attempt (§68) — failures leave the
  // session PENDING; the return page polls and may re-verify via the
  // rate-limited endpoint. Query params NEVER mutate state (§19).
  if (s.status === "PENDING" && s.expiresAt.getTime() > Date.now()) {
    try {
      await verifyCheckoutSession(s.businessId, s.id);
    } catch {
      // provider unreachable — stay PENDING, return page keeps polling
    }
  }
  return { found: true, sessionId: s.id };
}

// ---------------------------------------------------------------------------
// Sandbox simulation — MOCK PROVIDER ONLY. Drives the REAL webhook path
// (signed body → verifyWebhook → fulfillWebhook) so the sandbox dialog
// exercises the exact production contract, deterministically.
// ---------------------------------------------------------------------------

export type SimulateOutcome = "succeeded" | "failed" | "expired";

export async function simulateWebhook(
  businessId: string,
  sessionId: string,
  outcome: SimulateOutcome,
  opts: { actorId?: string | null } = {},
): Promise<CheckoutSessionDto> {
  const raw = await db.checkoutSession.findFirst({
    where: { id: sessionId, businessId },
  });
  if (!raw) throw new ApiError(404, "CHECKOUT_NOT_FOUND", "Checkout session not found.");
  if (raw.provider !== "mock") {
    throw new ApiError(422, "SIMULATE_NOT_SUPPORTED", "Simulation is only available for the sandbox provider.");
  }
  if (raw.status !== "PENDING") {
    throw new ApiError(409, "CHECKOUT_STATE_CONFLICT", `This checkout is already ${raw.status.toLowerCase()}.`);
  }
  if (raw.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(409, "CHECKOUT_STATE_CONFLICT", "This checkout has expired.");
  }

  const provider = resolveProvider("mock");

  // Build the byte-identical gateway request and push it through the real
  // verification + fulfillment pipeline.
  const body =
    outcome === "succeeded"
      ? buildMockEventBody("checkout.succeeded", raw.id, {
          amountMinor: raw.amountMinor,
          currency: raw.currency,
        })
      : outcome === "failed"
        ? buildMockEventBody("checkout.failed", raw.id, { reason: "sandbox:declined" })
        : buildMockEventBody("checkout.expired", raw.id);
  const event = provider.verifyWebhook(body, buildMockEventHeaders(body));
  await fulfillWebhook("mock", event);

  await audit({
    businessId,
    actorId: opts.actorId ?? null,
    action: "billing.checkout_simulated",
    entityType: "CheckoutSession",
    entityId: sessionId,
    after: { outcome, provider: "mock" },
  });

  const fresh = await db.checkoutSession.findUnique({
    where: { id: sessionId },
    include: { business: { select: { name: true } } },
  });
  return sessionDto(
    fresh as SessionRow,
    (fresh as SessionWithBusiness | null)?.business?.name ?? "",
    fresh && fresh.status === "PENDING" ? `/?checkout=${encodeURIComponent(sessionId)}` : null,
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export async function listPayments(
  businessId: string,
  opts: { take?: number } = {},
): Promise<{ items: PaymentRowDto[]; total: number }> {
  await expireStaleSessions(businessId);
  const take = Math.min(Math.max(opts.take ?? 50, 1), 200);
  const [rows, total] = await Promise.all([
    db.paymentTransaction.findMany({
      where: { checkoutSession: { businessId } },
      orderBy: { processedAt: "desc" },
      take,
      include: { checkoutSession: { select: { planCode: true, billingPeriod: true } } },
    }),
    db.paymentTransaction.count({ where: { checkoutSession: { businessId } } }),
  ]);
  return {
    items: rows.map((t) => ({
      id: t.id,
      checkoutSessionId: t.checkoutSessionId,
      provider: t.provider,
      status: t.status,
      planCode: t.checkoutSession.planCode,
      billingPeriod: (isBillingPeriod(t.checkoutSession.billingPeriod)
        ? t.checkoutSession.billingPeriod
        : "MONTHLY") as BillingPeriod,
      amountMinor: t.amountMinor,
      currency: t.currency,
      processedAt: t.processedAt.toISOString(),
    })),
    total,
  };
}

export { WebhookVerificationError };
