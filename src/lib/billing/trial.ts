/**
 * Free-trial domain service — Prompt 25.
 *
 * A trial is a time-boxed trial OF A PAID PLAN (BILLING_TRIAL_PLAN), owned by
 * a BUSINESS (never a user), executed through the EXISTING Prompt-20 state
 * machine: changePlan() (handles reactivation honestly) then startTrial()
 * (TRIALING + trialStart/trialEnd + TRIAL_STARTED event). Nothing here
 * invents a second state machine or a second quota authority.
 *
 * Eligibility rules (server-validated EVERY time — the browser is never the
 * authority):
 *   1. trial capability enabled + policy valid (BILLING_TRIALS_*)
 *   2. the business exists (trials are never created before the business)
 *   3. the business never consumed a trial before (one trial per business)
 *   4. the business is not currently on a paid plan (good standing)
 *   5. the business is not currently trialing
 *   6. the configured trial plan is active/public/purchasable
 *   7. the caller holds OWNER/ADMIN permission (route layer + re-checked)
 *
 * Idempotency: repeated start calls return the existing valid trial state
 * (started=false) instead of duplicating anything.
 */

import { db } from "@/lib/db";
import { BillingError } from "@/lib/billing/errors";
import {
  changePlan,
  getEntitlementContextFresh,
  startTrial,
  type SubscriptionDto,
} from "@/lib/billing/service";
import { getTrialConfig } from "@/lib/billing/trial-config";

export type TrialEligibilityReason =
  | "ELIGIBLE"
  | "NO_BUSINESS"
  | "ALREADY_TRIAL_USED"
  | "CURRENTLY_PAID"
  | "CURRENTLY_TRIALING"
  | "TRIAL_DISABLED"
  | "BUSINESS_NOT_ELIGIBLE";

export type TrialEligibility = {
  eligible: boolean;
  reason: TrialEligibilityReason;
  /** Effective trial length when the capability is configured (else null). */
  trialDays: number | null;
  /** Configured trial plan code (else null). */
  trialPlanCode: string | null;
  /** Plan whose entitlements currently apply to the business. */
  currentPlan: string | null;
  /** Raw subscription status row value (honest state, not a guess). */
  subscriptionStatus: string | null;
  previousTrialUsed: boolean;
  businessExists: boolean;
};

/** Paid statuses that BLOCK a new trial (good-standing paid access). */
const PAID_BLOCKING_STATUSES = new Set(["ACTIVE", "PAST_DUE", "CANCELED"]);

export async function getTrialEligibility(
  businessId: string,
): Promise<TrialEligibility> {
  const config = getTrialConfig();

  const base: TrialEligibility = {
    eligible: false,
    reason: "ELIGIBLE",
    trialDays: config.trialDays,
    trialPlanCode: config.trialPlanCode,
    currentPlan: null,
    subscriptionStatus: null,
    previousTrialUsed: false,
    businessExists: false,
  };

  if (!businessId) return { ...base, reason: "NO_BUSINESS" };

  const business = await db.business.findUnique({
    where: { id: businessId },
    select: { id: true },
  });
  if (!business) return { ...base, reason: "NO_BUSINESS" };
  base.businessExists = true;

  if (!config.enabled) return { ...base, reason: "TRIAL_DISABLED" };

  // The configured trial plan must be a real, active, public, purchasable
  // plan — a stale configuration degrades to BUSINESS_NOT_ELIGIBLE, never
  // to a broken subscription.
  if (config.trialPlanCode) {
    const plan = await db.plan.findUnique({ where: { code: config.trialPlanCode } });
    const purchasable =
      plan?.active && plan.isPublic && !["FREE", "ENTERPRISE"].includes(plan.code);
    if (!plan || !purchasable) {
      return { ...base, reason: "BUSINESS_NOT_ELIGIBLE" };
    }
  } else {
    return { ...base, reason: "TRIAL_DISABLED" };
  }

  const ctx = await getEntitlementContextFresh(businessId);
  const sub = ctx.subscription;
  base.currentPlan = sub.effectivePlanCode;
  base.subscriptionStatus = sub.status;

  const now = Date.now();
  const trialStartAt = sub.trialStart ? Date.parse(sub.trialStart) : null;
  const trialEndAt = sub.trialEnd ? Date.parse(sub.trialEnd) : null;
  base.previousTrialUsed = trialStartAt !== null;

  if (trialStartAt !== null) {
    // A trial row exists: currently inside the window → trialing; past it →
    // the trial was already consumed (lazy expiry never re-grants it).
    if (sub.status === "TRIALING" && trialEndAt !== null && trialEndAt > now) {
      return { ...base, reason: "CURRENTLY_TRIALING" };
    }
    return { ...base, reason: "ALREADY_TRIAL_USED" };
  }

  if (sub.status === "TRIALING") {
    // Defensive: TRIALING without trialStart is an integrity anomaly.
    return { ...base, reason: "ALREADY_TRIAL_USED" };
  }

  if (PAID_BLOCKING_STATUSES.has(sub.status) && sub.effectivePlanCode !== "FREE") {
    return { ...base, reason: "CURRENTLY_PAID" };
  }

  base.eligible = true;
  base.reason = "ELIGIBLE";
  return base;
}

export type TrialStartResult = {
  started: boolean;
  /** True when the call found an existing valid trial (idempotent replay). */
  already: boolean;
  subscription: SubscriptionDto;
};

/**
 * Start the configured trial for a business. Idempotent: an existing valid
 * trial is returned as-is. Plan switch + state transitions run through the
 * Prompt-20 service so every event/audit record stays canonical.
 */
export async function startBusinessTrial(
  businessId: string,
  opts: { actorId?: string | null; source?: string } = {},
): Promise<TrialStartResult> {
  const config = getTrialConfig();
  if (!config.enabled || !config.trialDays || !config.trialPlanCode) {
    throw new BillingError("TRIAL_DISABLED", "Trials are not available.");
  }

  const eligibility = await getTrialEligibility(businessId);
  if (!eligibility.businessExists) {
    throw new BillingError("NO_BUSINESS", "No business exists for this trial.");
  }
  if (eligibility.reason === "CURRENTLY_TRIALING" && eligibility.currentPlan === config.trialPlanCode) {
    // Idempotent replay: return the existing trial without mutating.
    const ctx = await getEntitlementContextFresh(businessId);
    return { started: false, already: true, subscription: ctx.subscription };
  }
  if (!eligibility.eligible) {
    // Map reasons to honest, structured billing errors.
    const statusByReason: Partial<
      Record<TrialEligibilityReason, "TRIAL_DISABLED" | "NO_BUSINESS" | "BUSINESS_NOT_ELIGIBLE">
    > = {
      TRIAL_DISABLED: "TRIAL_DISABLED",
      ALREADY_TRIAL_USED: "BUSINESS_NOT_ELIGIBLE",
      CURRENTLY_PAID: "BUSINESS_NOT_ELIGIBLE",
      CURRENTLY_TRIALING: "BUSINESS_NOT_ELIGIBLE",
      BUSINESS_NOT_ELIGIBLE: "BUSINESS_NOT_ELIGIBLE",
      NO_BUSINESS: "NO_BUSINESS",
      ELIGIBLE: "BUSINESS_NOT_ELIGIBLE",
    };
    const code = statusByReason[eligibility.reason] ?? "BUSINESS_NOT_ELIGIBLE";
    throw new BillingError(code, "This business cannot start a trial.", {
      reason: eligibility.reason,
    });
  }

  // Switch to the trial plan first (handles FREE→trial-plan and honest
  // reactivation from EXPIRED through the canonical changePlan path), then
  // flip the state machine into TRIALING with the trial clock.
  await changePlan(businessId, config.trialPlanCode, {
    actorId: opts.actorId ?? null,
    source: "trial",
  });
  const result = await startTrial(businessId, config.trialDays, {
    actorId: opts.actorId ?? null,
    source: opts.source ?? "api",
  });
  return { started: true, already: false, subscription: result.subscription };
}
