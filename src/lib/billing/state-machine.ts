/**
 * Subscription lifecycle state machine — Prompt 20 (§16/§17/§20/§46).
 *
 * PURE module (no imports) so it is unit-testable in isolation
 * (scripts/prompt20-state-machine.test.ts) and reusable by the service
 * layer and the seed script.
 *
 * SQLite has no enums → statuses/event types are validated HERE at every
 * boundary (zod schemas in schemas.ts reference these sets).
 */

// ---------------------------------------------------------------------------
// Subscription status (§16/§17)
// ---------------------------------------------------------------------------

export const SUBSCRIPTION_STATUSES = [
  "TRIALING",
  "ACTIVE",
  "PAST_DUE",
  "CANCELED",
  "EXPIRED",
  "PAUSED",
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const STATUS_SEMANTICS: Record<SubscriptionStatus, string> = {
  TRIALING:
    "Temporary valid subscription (trial of the plan's features). Entitled until trialEnd.",
  ACTIVE: "Fully entitled to the plan's features.",
  PAST_DUE:
    "Payment issue state — RESERVED for the future payment phase; keeps grace-period access. Nothing sets it yet (§17: no payment assumptions).",
  CANCELED:
    "Canceled but access continues until currentPeriodEnd (cancelAtPeriodEnd semantics, §44).",
  EXPIRED: "No longer entitled to the paid plan — the business falls back to FREE-level entitlements (§13) without touching its data.",
  PAUSED:
    "Temporarily restricted — RESERVED for future administrative workflows; nothing sets it yet.",
};

// ---------------------------------------------------------------------------
// Valid transitions (§46) — arbitrary state hopping is forbidden
// ---------------------------------------------------------------------------

/**
 * Allowed transitions. Notes:
 * - CANCELED → ACTIVE is the REACTIVATION path (undo cancelAtPeriodEnd
 *   while the period is still running).
 * - EXPIRED → ACTIVE exists ONLY through the explicit internal change-plan
 *   tool (a deliberate renewal decision) — it can never happen
 *   automatically without a payment mechanism (§45).
 * - PAUSED is reachable from ACTIVE and leaves via ACTIVE (resume) or
 *   CANCELED. Nothing sets PAUSED in this phase.
 */
export const VALID_TRANSITIONS: Record<SubscriptionStatus, readonly SubscriptionStatus[]> = {
  TRIALING: ["ACTIVE", "CANCELED", "EXPIRED"],
  ACTIVE: ["PAST_DUE", "CANCELED", "PAUSED", "EXPIRED", "TRIALING"],
  PAST_DUE: ["ACTIVE", "CANCELED", "EXPIRED"],
  CANCELED: ["EXPIRED", "ACTIVE"],
  EXPIRED: ["ACTIVE"],
  PAUSED: ["ACTIVE", "CANCELED"],
};

export function isValidTransition(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return (
    typeof value === "string" && (SUBSCRIPTION_STATUSES as readonly string[]).includes(value)
  );
}

export function asSubscriptionStatus(value: unknown): SubscriptionStatus {
  return isSubscriptionStatus(value) ? value : "ACTIVE";
}

// ---------------------------------------------------------------------------
// Subscription event types (§20) — NO payment events in this phase
// ---------------------------------------------------------------------------

export const SUBSCRIPTION_EVENT_TYPES = [
  "CREATED",
  "PLAN_CHANGED",
  "TRIAL_STARTED",
  "TRIAL_ENDED",
  "CANCELED",
  "REACTIVATED",
  "EXPIRED",
  "PAUSED",
  "RESUMED",
] as const;

export type SubscriptionEventType = (typeof SUBSCRIPTION_EVENT_TYPES)[number];

export function isSubscriptionEventType(value: unknown): value is SubscriptionEventType {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_EVENT_TYPES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Billing period (§18) — period DURATION only, never prices (§39/§40)
// ---------------------------------------------------------------------------

export const BILLING_PERIODS = ["MONTHLY", "YEARLY"] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

export function isBillingPeriod(value: unknown): value is BillingPeriod {
  return typeof value === "string" && (BILLING_PERIODS as readonly string[]).includes(value);
}

/**
 * Advance a period boundary from `start` (UTC, timezone-safe — §70).
 * Uses date-component arithmetic on UTC so month-end/year-end/leap-year
 * behave deterministically (Jan 31 + 1 month = Feb 28/29, never Mar 3).
 */
export function periodEnd(start: Date, period: BillingPeriod): Date {
  const end = new Date(start.getTime());
  if (period === "MONTHLY") {
    const month = end.getUTCMonth();
    end.setUTCMonth(month + 1);
    // Guard against JS Date overflow (Jan 31 → Mar 2/3): clamp back into
    // the intended month when the day-of-month overflowed.
    if (end.getUTCMonth() !== (month + 1) % 12) {
      end.setUTCDate(0); // last day of the previous (intended) month
    }
  } else {
    end.setUTCFullYear(end.getUTCFullYear() + 1);
  }
  return end;
}

/**
 * Entitlement decision for a subscription row (§17 + §13 expiry fallback).
 *
 * Pure policy — the SERVICE resolves "own plan" vs the FREE fallback from
 * the subscription's relation; this layer only decides WHICH applies:
 *
 * - "own-plan"        → subscription's plan entitlements apply.
 * - "fallback-free"   → FREE plan entitlements apply instead:
 *   - EXPIRED / PAUSED (paid features gone, core app stays usable — the
 *     business falls back without touching its data, §42/§65)
 *   - TRIALING past trialEnd (trial clock ran out)
 *   - CANCELED whose period-end grace has passed (or canceled without
 *     grace) — lazy expiry should then move the row to EXPIRED.
 *
 * `now` is injectable for tests.
 */
export type PlanDecision =
  | { kind: "own-plan"; entitled: true }
  | { kind: "fallback-free"; entitled: true }
  | { kind: "fallback-free"; entitled: false; expired: boolean };

export function decidePlan(
  sub: {
    status: string;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: Date | null;
    trialEnd: Date | null;
  },
  now: Date = new Date(),
): PlanDecision {
  const status = asSubscriptionStatus(sub.status);
  if (status === "EXPIRED" || status === "PAUSED") {
    return { kind: "fallback-free", entitled: true };
  }
  // Trial clock: a TRIALING subscription past its trialEnd is expired.
  if (status === "TRIALING" && sub.trialEnd && sub.trialEnd.getTime() <= now.getTime()) {
    return { kind: "fallback-free", entitled: false, expired: true };
  }
  // Canceled: access continues until the period ends (§44), then expires.
  if (status === "CANCELED") {
    const graceOver =
      !sub.cancelAtPeriodEnd ||
      !sub.currentPeriodEnd ||
      sub.currentPeriodEnd.getTime() <= now.getTime();
    if (graceOver) return { kind: "fallback-free", entitled: false, expired: true };
  }
  return { kind: "own-plan", entitled: true };
}
