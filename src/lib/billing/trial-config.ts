/**
 * Free-trial configuration — Prompt 25.
 *
 * THE single place trial policy is read from the environment (mirrors the
 * payments/config.ts pattern — no route reads these env vars directly).
 *
 * Fail-safe semantics:
 * - BILLING_TRIALS_ENABLED=false → trials disabled everywhere (the pricing
 *   CTA matrix reports TRIAL capabilities honestly as disabled).
 * - Absent variable → DISABLED by default: trials are an explicit opt-in
 *   so no environment accidentally grants paid-plan entitlements.
 * - BILLING_TRIAL_DAYS validated server-side to 1..90.
 * - BILLING_TRIAL_PLAN must be an active, public, purchasable, self-service
 *   plan code (validated against the authoritative catalog at use time —
 *   an invalid configuration yields trials DISABLED with a reason, never a
 *   broken checkout flow).
 */

export type TrialConfig = {
  enabled: boolean;
  trialDays: number | null;
  trialPlanCode: string | null;
  /** Secret-free explanation when disabled (operator diagnostics only). */
  reasons: string[];
};

function readTrialConfig(env: NodeJS.ProcessEnv = process.env): TrialConfig {
  const reasons: string[] = [];
  const rawEnabled = env.BILLING_TRIALS_ENABLED?.trim().toLowerCase();
  const enabled = rawEnabled === "true";

  if (rawEnabled !== "true") {
    if (rawEnabled === "false") reasons.push("BILLING_TRIALS_ENABLED=false");
    else reasons.push("BILLING_TRIALS_ENABLED not set (default disabled)");
  }

  let trialDays: number | null = null;
  const rawDays = env.BILLING_TRIAL_DAYS?.trim();
  if (rawDays) {
    const parsed = Number(rawDays);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 90) {
      trialDays = parsed;
    } else {
      reasons.push("BILLING_TRIAL_DAYS invalid (must be integer 1..90)");
    }
  } else if (enabled) {
    reasons.push("BILLING_TRIAL_DAYS missing");
  }

  let trialPlanCode: string | null = null;
  const rawPlan = env.BILLING_TRIAL_PLAN?.trim().toUpperCase();
  if (rawPlan) {
    // Purchasable self-service plans only (FREE/ENTERPRISE are never trials).
    const purchasable = ["STARTER", "BUSINESS", "PRO"];
    if (purchasable.includes(rawPlan)) trialPlanCode = rawPlan;
    else reasons.push("BILLING_TRIAL_PLAN must be one of STARTER|BUSINESS|PRO");
  } else if (enabled) {
    reasons.push("BILLING_TRIAL_PLAN missing");
  }

  const effectivelyEnabled = enabled && trialDays !== null && trialPlanCode !== null;
  return {
    enabled: effectivelyEnabled,
    trialDays: effectivelyEnabled ? trialDays : null,
    trialPlanCode: effectivelyEnabled ? trialPlanCode : null,
    reasons: effectivelyEnabled ? [] : reasons,
  };
}

let cached: { at: number; value: TrialConfig } | null = null;
const CACHE_MS = 15_000;

/** Cached config read (15s) — enforcement still re-validates plan state. */
export function getTrialConfig(): TrialConfig {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const value = readTrialConfig();
  cached = { at: now, value };
  return value;
}

/** Test seam — clear the cache so harnesses observe fresh env values. */
export function resetTrialConfigCache(): void {
  cached = null;
}
