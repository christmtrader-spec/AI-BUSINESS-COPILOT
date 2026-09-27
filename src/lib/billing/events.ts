/**
 * Commercial conversion events — Prompt 25.
 *
 * Server-authoritative funnel tracking for pricing → signup → business →
 * trial → checkout. THE fixed event directory lives here; every write path
 * validates against it, so arbitrary event names can never enter the ledger.
 *
 * Data minimization (hard rules):
 * - Only the allowlisted dimensions below are ever stored: planCode,
 *   billingPeriod, currency, locale (in `source` semantics), source, route
 *   + identity fields resolved SERVER-SIDE from the session.
 * - NEVER: full emails, customer/business names, AI prompts, payment
 *   credentials, raw IPs, or anything else the caller might send — unknown
 *   body fields are stripped by the schemas, not stored.
 * - "Omitted beats hashed": dimensions we do not have stay null.
 * - Timestamps are always server-generated (`createdAt` default now()).
 * - Idempotency: lifecycle-once events pass an explicit dedupeKey which is
 *   enforced by the (eventType, dedupeKey) unique constraint.
 */

import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";

/** The complete, closed directory of commercial funnel events. */
export const COMMERCIAL_EVENT_TYPES = [
  // Pricing page (public, anonymous-capable)
  "PRICING_VIEWED",
  "PRICING_PLAN_VIEWED",
  "PRICING_BILLING_PERIOD_CHANGED",
  "PRICING_CURRENCY_CHANGED",
  "PRICING_CTA_CLICKED",
  // Signup
  "SIGNUP_STARTED",
  "SIGNUP_COMPLETED",
  // Onboarding
  "ONBOARDING_STARTED",
  "BUSINESS_CREATED",
  "ONBOARDING_COMPLETED",
  // Trial
  "TRIAL_ELIGIBILITY_VIEWED",
  "TRIAL_STARTED",
  "TRIAL_SKIPPED",
  // Checkout (payment DISABLED — the funnel stops honestly at the intent)
  "CHECKOUT_INTENT_STARTED",
  "CHECKOUT_CREATED",
  "CHECKOUT_COMPLETED",
] as const;

export type CommercialEventType = (typeof COMMERCIAL_EVENT_TYPES)[number];

export function isCommercialEventType(value: unknown): value is CommercialEventType {
  return (
    typeof value === "string" &&
    (COMMERCIAL_EVENT_TYPES as readonly string[]).includes(value)
  );
}

/** Public (anonymous) subset — the only events a visitor may emit. */
export const PUBLIC_EVENT_TYPES: readonly CommercialEventType[] = [
  "PRICING_VIEWED",
  "PRICING_PLAN_VIEWED",
  "PRICING_BILLING_PERIOD_CHANGED",
  "PRICING_CURRENCY_CHANGED",
  "PRICING_CTA_CLICKED",
];

export function isPublicEventType(value: string): value is CommercialEventType {
  return (PUBLIC_EVENT_TYPES as readonly string[]).includes(value);
}

export type CommercialEventInput = {
  eventType: CommercialEventType;
  anonymousSessionKey?: string | null;
  userId?: string | null;
  businessId?: string | null;
  planCode?: string | null;
  billingPeriod?: string | null;
  currency?: string | null;
  source?: string | null;
  route?: string | null;
  dedupeKey?: string | null;
};

/**
 * Record one commercial event. Fire-and-forget safe by contract: callers on
 * critical paths (AI, signup, checkout fulfillment) may `void` it — a
 * failure to record analytics must NEVER break a user-facing operation.
 * Idempotent when dedupeKey is provided (unique constraint).
 */
export async function recordCommercialEvent(
  input: CommercialEventInput,
): Promise<boolean> {
  try {
    if (!isCommercialEventType(input.eventType)) {
      console.error("[events] rejected unknown commercial event type:", input.eventType);
      return false;
    }
    await db.commercialEvent.create({
      data: {
        eventType: input.eventType,
        anonymousSessionKey: input.anonymousSessionKey ?? null,
        userId: input.userId ?? null,
        businessId: input.businessId ?? null,
        planCode: input.planCode ?? null,
        billingPeriod: input.billingPeriod ?? null,
        currency: input.currency ?? null,
        source: input.source ?? null,
        route: input.route ?? null,
        dedupeKey: input.dedupeKey ?? null,
      },
    });
    return true;
  } catch (error) {
    // Unique-violation (idempotent replay) is fine — it means the event was
    // already recorded. Everything else is logged loudly and swallowed:
    // analytics must never break a primary operation.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return false;
    }
    console.error("[events] failed to record commercial event:", error);
    return false;
  }
}

// (db import is hoisted to module scope — see top of file.)

/** Safe bounded dimension cleaner — trims and caps any caller-supplied label. */
export function cleanDimension(value: unknown, max = 64): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}
