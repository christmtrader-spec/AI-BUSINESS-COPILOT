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
import { changePlan, invalidateBillingCache } from "@/lib/billing";
import { isBillingPeriod, type BillingPeriod } from "@/lib/billing/state-machine";
import { buildMockEventBody, buildMockEventHeaders } from "./mock-provider";
import { priceFor } from "./pricing";
import { defaultProvider, isProviderUsable, resolveProvider } from "./registry";
import type { ProviderWebhookEvent } from "./types";
import { WebhookVerificationError } from "./types";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function checkoutNotAllowed(message: string, details?: unknown): ApiError {
  return new ApiError(422, "CHECKOUT_NOT_ALLOWED", message, details);
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export type CheckoutSessionDto = {
  id: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "EXPIRED" | "CANCELED";
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
  expiresAt: Date;
  completedAt: Date | null;
  fulfilledAt: Date | null;
  createdAt: Date;
};

function sessionDto(s: SessionRow, redirectUrl: string | null): CheckoutSessionDto {
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
  input: { planCode: string; billingPeriod: string },
  opts: { actorId?: string | null } = {},
): Promise<CheckoutSessionDto> {
  const price = priceFor(input.planCode, input.billingPeriod);
  if (!price) {
    // FREE needs no payment; ENTERPRISE is not self-service (§38).
    throw checkoutNotAllowed(
      "This plan cannot be purchased through self-service checkout.",
      { planCode: input.planCode },
    );
  }
  const billingPeriod = price.billingPeriod;

  // The plan must exist AND be active (defense in depth — priceFor already
  // guarantees it is a known purchasable code).
  const plan = await db.plan.findUnique({ where: { code: input.planCode } });
  if (!plan || !plan.active) {
    throw checkoutNotAllowed("The requested plan is not available.", {
      planCode: input.planCode,
    });
  }

  const provider = defaultProvider();

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
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      metaJson: JSON.stringify({ mode: provider.mode, displayName: provider.displayName }),
    },
  });

  const created = await provider.createCheckout({
    checkoutSessionId: session.id,
    businessId,
    planCode: input.planCode,
    billingPeriod,
    amountMinor: price.amountMinor,
    currency: price.currency,
  });

  const updated = await db.checkoutSession.update({
    where: { id: session.id },
    data: { providerRef: created.providerRef, expiresAt: created.expiresAt },
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
    },
  });

  return sessionDto(updated, created.redirectUrl);
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
  });
  if (!raw) {
    // Not found OR another tenant's session — indistinguishable on purpose.
    throw new ApiError(404, "CHECKOUT_NOT_FOUND", "Checkout session not found.");
  }
  // A historical session whose provider has since been disabled still reads
  // fine (redirectUrl degrades to null) — fail closed only on NEW checkouts.
  const provider = isProviderUsable(raw.provider) ? resolveProvider(raw.provider) : null;

  let s = raw;
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
  return sessionDto(
    s,
    provider?.slug === "mock" ? `/?checkout=${encodeURIComponent(s.id)}` : null,
  );
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
  // Amount guard: the provider's reported amount must match OUR snapshot
  // (server authority). A mismatch fails closed — never a wrong plan.
  if (event.amountMinor !== s.amountMinor || event.currency !== s.currency) {
    await db.$transaction([
      db.checkoutSession.update({
        where: { id: s.id },
        data: {
          status: "FAILED",
          completedAt: new Date(),
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
      action: "billing.payment_failed",
      entityType: "CheckoutSession",
      entityId: s.id,
      after: { reason: "amount-mismatch", planCode: s.planCode },
    });
    return { received: true, duplicate: false, sessionStatus: "FAILED" };
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

  const fresh = await db.checkoutSession.findUnique({ where: { id: sessionId } });
  return sessionDto(
    fresh as SessionRow,
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
