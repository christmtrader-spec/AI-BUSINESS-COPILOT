import "server-only";

/**
 * Operational event catalog — Prompt 29 §80/§81/§82/§83.
 *
 * FIXED vocabulary. Server code logs only these event names; no client input
 * can introduce an event name (client input never reaches this module as a
 * name). Durable/diagnostic split (§82): these events are STDOUT diagnostics;
 * durable history remains in domain audit tables (Audit/PlatformAuditLog/
 * SubscriptionEvent/billing events) — this module never writes to the DB.
 */

export const OPERATIONAL_EVENTS = {
  apiRequestFailed: "api.request.failed",
  apiRequestRateLimited: "api.request.rate_limited",
  authLoginFailed: "auth.login.failed",
  authLoginSuccess: "auth.login.success",
  authPasswordResetRequested: "auth.password_reset.requested",
  authPasswordResetSent: "auth.password_reset.sent",
  authPasswordResetFailed: "auth.password_reset.failed",
  billingPaymentVerificationFailed: "billing.payment.verification_failed",
  billingSubscriptionTransitionFailed: "billing.subscription.transition_failed",
  aiRequestFailed: "ai.request.failed",
  aiCostAttributionFailed: "ai.cost.attribution_failed",
  databaseConnectionFailed: "database.connection.failed",
  databaseMigrationStateChanged: "database.migration_state_changed",
  backupCreated: "backup.created",
  backupVerificationFailed: "backup.verification_failed",
  restoreDrillFailed: "restore.drill.failed",
} as const;

export type OperationalEvent = (typeof OPERATIONAL_EVENTS)[keyof typeof OPERATIONAL_EVENTS];

/** Coarse error classes (§83) — no internal detail leaves the server. */
export type ErrorClass =
  | "validation"
  | "authentication"
  | "authorization"
  | "rate_limit"
  | "not_found"
  | "conflict"
  | "dependency"
  | "database"
  | "provider"
  | "timeout"
  | "internal";

/** Classify an HTTP status into the coarse error taxonomy (§83/§84/§85). */
export function classifyStatus(status: number): ErrorClass {
  if (status === 400 || status === 402 || status === 422) return "validation";
  if (status === 401) return "authentication";
  if (status === 403) return "authorization";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limit";
  if (status === 503 || status === 504) return "dependency";
  if (status >= 500) return "internal";
  return "validation";
}
