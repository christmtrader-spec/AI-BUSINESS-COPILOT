/**
 * Payment configuration — Prompt 23 §6-§11, §88-§90.
 *
 * THE single place that reads payment-related environment variables and
 * decides whether (and how) payments may operate. Everything else
 * (registry, service, routes) asks this module — no route ever reads a
 * payment env var directly.
 *
 * Environment model (§6 — unambiguous values only):
 *   PAYMENT_ENV=mock        in-process sandbox provider (development/test)
 *   PAYMENT_ENV=sandbox     real provider test endpoints + sandbox credentials
 *   PAYMENT_ENV=production  real provider live endpoints + live credentials
 *
 * Fail-closed rules (every one of these produces an explicit BLOCKER):
 * - PAYMENTS_ENABLED=false → no payment initiation (§88), existing state untouched.
 * - In production-like runtime (NODE_ENV=production) payments require
 *   PAYMENTS_ENABLED=true EXPLICITLY — defaults never enable real money (§88).
 * - Mock is NEVER usable in production-like runtime (§7, §130) — no override.
 * - PAYMENT_ENV=sandbox|production with provider "mock" is invalid (§90 —
 *   no silent provider switch; the operator must name a real provider).
 * - A real provider with missing credentials is a blocker — the system
 *   NEVER falls back to mock (§89).
 * - production requires an HTTPS base URL for provider callbacks (§9).
 *
 * Secrets NEVER appear in blockers — only variable NAMES (§10/§56).
 */

import { isSupportedSettlementCurrency } from "./currency";

export type PaymentEnv = "mock" | "sandbox" | "production";

export const PAYMENT_ENVS: readonly PaymentEnv[] = ["mock", "sandbox", "production"];

export function isPaymentEnv(value: unknown): value is PaymentEnv {
  return typeof value === "string" && (PAYMENT_ENVS as readonly string[]).includes(value);
}

export type PaymentConfig = {
  /** Payments initiation allowed in THIS runtime. */
  enabled: boolean;
  /** Preferred provider slug (PAYMENT_PROVIDER; default "mock"). */
  providerSlug: string;
  /** Resolved environment (PAYMENT_ENV; default "mock" in development). */
  env: PaymentEnv;
  /** Canonical app origin for provider callback URLs (never a Host header). */
  baseUrl: string;
  /** Human-readable, secret-free reasons payments are unavailable (§10). */
  blockers: string[];
  /** NODE_ENV=production (the "production-like" gate). */
  productionLike: boolean;
};

function readEnv(env: NodeJS.ProcessEnv): PaymentConfig {
  const productionLike = env.NODE_ENV === "production";
  const rawEnabled = env.PAYMENTS_ENABLED?.trim().toLowerCase();
  const rawProvider = env.PAYMENT_PROVIDER?.trim().toLowerCase();
  const rawPaymentEnv = env.PAYMENT_ENV?.trim().toLowerCase();

  const providerSlug = rawProvider && rawProvider.length > 0 ? rawProvider : "mock";

  // PAYMENT_ENV must be unambiguous (§6). In development the absence of the
  // variable means the in-process mock; in production an unset/invalid value
  // is itself a blocker — it can never silently mean "mock" (§130).
  let paymentEnv: PaymentEnv | null = null;
  if (rawPaymentEnv) {
    paymentEnv = isPaymentEnv(rawPaymentEnv) ? rawPaymentEnv : null;
  } else if (!productionLike) {
    paymentEnv = "mock";
  }

  const enabled =
    rawEnabled === "false"
      ? false
      : productionLike
        ? rawEnabled === "true" // explicit opt-in in production (§88)
        : rawEnabled !== "false";

  // §10 — PAYMENT_BASE_URL is the canonical origin for provider callbacks;
  // APP_BASE_URL/NEXTAUTH_URL are accepted fallbacks so a single-origin
  // deployment needs no duplicate configuration. NEVER a request Host header.
  const baseUrl = (
    env.PAYMENT_BASE_URL?.trim() ||
    env.APP_BASE_URL?.trim() ||
    env.NEXTAUTH_URL?.trim() ||
    ""
  ).replace(/\/+$/, "");

  return {
    enabled,
    providerSlug,
    env: paymentEnv ?? "mock",
    baseUrl,
    blockers: [],
    productionLike,
  };
}

/**
 * Validate the resolved configuration. Returns the config with `blockers`
 * filled — an EMPTY list means payments may operate. Validation is pure:
 * the caller supplies the environment (tests pass explicit objects).
 */
export function validatePaymentConfig(input: NodeJS.ProcessEnv = process.env): PaymentConfig {
  const cfg = readEnv(input);
  const blockers: string[] = [];
  const zarinpalCreds = Boolean(input.ZARINPAL_MERCHANT_ID?.trim());

  if (input.PAYMENTS_ENABLED?.trim().toLowerCase() === "false") {
    blockers.push("PAYMENTS_ENABLED=false — payment initiation is disabled (existing subscriptions are unaffected).");
  }
  if (cfg.productionLike && input.PAYMENTS_ENABLED?.trim().toLowerCase() !== "true") {
    blockers.push("PAYMENTS_ENABLED must be explicitly \"true\" in production to enable payments.");
  }

  if (cfg.productionLike) {
    if (!input.PAYMENT_ENV?.trim()) {
      blockers.push("PAYMENT_ENV is required in production (sandbox | production) — it never defaults to mock.");
    } else if (!isPaymentEnv(input.PAYMENT_ENV.trim().toLowerCase())) {
      blockers.push("PAYMENT_ENV is invalid — allowed values: sandbox | production.");
    }
    // §7/§130 — mock NEVER activates in production, with or without intent.
    if (cfg.providerSlug === "mock") {
      blockers.push("PAYMENT_PROVIDER=mock is not allowed in production — configure a real payment provider.");
    }
  }

  // §90 — an explicitly chosen real provider with the mock environment is a
  // configuration error, not a reason to silently fall back to mock.
  if (cfg.providerSlug !== "mock" && cfg.env === "mock") {
    blockers.push(`PAYMENT_PROVIDER=${cfg.providerSlug} requires PAYMENT_ENV=sandbox or production — mock is development-only.`);
  }
  // §89 — a real provider with missing credentials fails CLOSED (never mock).
  if (cfg.providerSlug === "zarinpal" && cfg.env !== "mock") {
    if (!zarinpalCreds) {
      blockers.push("ZARINPAL_MERCHANT_ID is missing — the Zarinpal adapter cannot start without credentials.");
    }
    if (!cfg.baseUrl) {
      blockers.push("PAYMENT_BASE_URL (or APP_BASE_URL) is missing — provider callback URLs are built from it (never from Host headers).");
    }
    if (cfg.env === "production" && !cfg.baseUrl.startsWith("https://")) {
      blockers.push("PAYMENT_BASE_URL must be HTTPS in production (provider callback requirement).");
    }
  }
  if (cfg.env === "production" && cfg.baseUrl && !cfg.baseUrl.startsWith("https://")) {
    blockers.push("PAYMENT_BASE_URL must be HTTPS in production (provider callback requirement).");
  }

  return { ...cfg, blockers };
}

/**
 * Whether payment INITIATION may proceed in this runtime. Unavailable when
 * disabled or when any blocker exists (fail closed — §88/§89).
 */
export function paymentsAvailable(input: NodeJS.ProcessEnv = process.env): boolean {
  const cfg = validatePaymentConfig(input);
  return cfg.enabled && cfg.blockers.length === 0;
}

/** Safe diagnostic description for the providers endpoint (no secrets §10). */
export function paymentConfigSummary(): {
  enabled: boolean;
  provider: string;
  env: PaymentEnv;
  productionLike: boolean;
  blockers: string[];
} {
  const cfg = validatePaymentConfig();
  return {
    enabled: cfg.enabled,
    provider: cfg.providerSlug,
    env: cfg.env,
    productionLike: cfg.productionLike,
    blockers: cfg.blockers,
  };
}

/**
 * Prompt 24 §42/§97 — the deployment's DEFAULT platform settlement currency
 * used when a checkout/catalog request does not name one. NEVER derived
 * from browser locale/IP/UI text:
 * - PAYMENT_SETTLEMENT_CURRENCY (validated against the settlement allowlist)
 *   wins when set — an operator's explicit choice.
 * - Otherwise "EUR": the documented default while EUR-v1 is the only
 *   activated price book. Switching the default to IRR is an explicit
 *   operator action (activate an IRR book + set this variable) — it is
 *   never chosen silently, and it never changes historical sessions.
 */
export function defaultSettlementCurrency(): string {
  const raw = process.env.PAYMENT_SETTLEMENT_CURRENCY?.trim().toUpperCase();
  if (raw && isSupportedSettlementCurrency(raw)) return raw;
  return "EUR";
}
