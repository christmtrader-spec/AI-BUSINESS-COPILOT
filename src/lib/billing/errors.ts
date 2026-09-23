/**
 * Billing domain errors — Prompt 20 (§49/§27/§28).
 *
 * Structured domain failures — NEVER generic Error("something went wrong").
 * These extend ApiError so the standard route pipeline maps them to the
 * documented envelope { ok:false, error:{ code, message, details } }.
 *
 * Status-code policy:
 * - 403 ENTITLEMENT_NOT_AVAILABLE → feature boolean is false (§26/§34)
 * - 422 ENTITLEMENT_LIMIT_REACHED → usage would exceed a LIMIT (§27/§28)
 * - 422 INVALID_PLAN              → unknown/inactive plan code
 * - 404 SUBSCRIPTION_NOT_FOUND    → no subscription row for the business
 * - 409 INVALID_SUBSCRIPTION_STATE → transition not allowed by the
 *   state machine (§45/§46)
 * - 422 BUSINESS_NOT_ELIGIBLE     → trial/eligibility policy violation
 * - 422 USAGE_LIMIT_REACHED       → metered consumption quota exhausted for
 *   the current usage period (Prompt 21) — structured body carries metric,
 *   limit, used, remaining, periodEnd (§23); never a 500, never DB internals
 * - 503 BILLING_UNAVAILABLE       → billing lookup FAILED (fail closed,
 *   §68) — retryable, never mapped to "unlimited access"
 */
import { ApiError } from "@/lib/api-helpers";

export const BILLING_ERROR_CODES = [
  "ENTITLEMENT_NOT_AVAILABLE",
  "ENTITLEMENT_LIMIT_REACHED",
  "INVALID_PLAN",
  "SUBSCRIPTION_NOT_FOUND",
  "INVALID_SUBSCRIPTION_STATE",
  "BUSINESS_NOT_ELIGIBLE",
  "USAGE_LIMIT_REACHED",
  "BILLING_UNAVAILABLE",
] as const;

export type BillingErrorCode = (typeof BILLING_ERROR_CODES)[number];

const STATUS_BY_CODE: Record<BillingErrorCode, number> = {
  ENTITLEMENT_NOT_AVAILABLE: 403,
  ENTITLEMENT_LIMIT_REACHED: 422,
  INVALID_PLAN: 422,
  SUBSCRIPTION_NOT_FOUND: 404,
  INVALID_SUBSCRIPTION_STATE: 409,
  BUSINESS_NOT_ELIGIBLE: 422,
  USAGE_LIMIT_REACHED: 422,
  BILLING_UNAVAILABLE: 503,
};

export class BillingError extends ApiError {
  constructor(code: BillingErrorCode, message: string, details?: unknown) {
    super(STATUS_BY_CODE[code], code, message, details);
    this.name = "BillingError";
  }
}

/** Structured limit error body (§28) — no internal DB details (§113). */
export function limitReachedError(feature: string, limit: number, current: number): BillingError {
  return new BillingError("ENTITLEMENT_LIMIT_REACHED", `The plan limit for ${feature} has been reached.`, {
    feature,
    limit,
    current,
    upgradeAvailable: true,
  });
}

/**
 * Metered-consumption quota error (Prompt 21 §23) — structured, localized
 * by the client from `details` ({ metric, limit, used, remaining, periodEnd,
 * upgradeAvailable }). Never exposes DB internals; never a 500.
 */
export function usageLimitReachedError(
  metric: string,
  limit: number,
  used: number,
  periodEnd: string | null,
): BillingError {
  return new BillingError(
    "USAGE_LIMIT_REACHED",
    `The included ${metric} quota for the current period has been used up.`,
    {
      metric,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      periodEnd,
      upgradeAvailable: true,
    },
  );
}
