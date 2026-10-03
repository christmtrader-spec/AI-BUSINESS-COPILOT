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
  portabilityExportFailed: "portability.export.failed",
  portabilityImportFailed: "portability.import.failed",
  // Prompt 32 — unified notification platform (§131/§310: safe fields only,
  // never dataJson/email bodies/SMTP transcripts).
  notificationCreated: "notification.created",
  notificationCreateFailed: "notification.create_failed",
  notificationDeliverySent: "notification.delivery.sent",
  notificationDeliveryFailed: "notification.delivery.failed",
  notificationDeliveryExhausted: "notification.delivery.exhausted",
  notificationDeliveryStaleReaped: "notification.delivery.stale_reaped",
  notificationDeliveryDispatchError: "notification.delivery.dispatch_error",
  // Prompt 33 — global search (§22: safe metrics only — counts/duration;
  // the raw query, its variants and result contents are NEVER logged
  // because search strings may carry emails/phones/invoice numbers).
  searchExecuted: "search.executed",
  // Prompt 37 (§170) — CRM reminder processor operational events. Payloads
  // carry counts/mode/run-id ONLY — never task contents, emails, titles or
  // notification bodies (§69/§170).
  crmReminderProcessorStarted: "crm.reminder.processor.started",
  crmReminderProcessorCompleted: "crm.reminder.processor.completed",
  crmReminderProcessorFailed: "crm.reminder.processor.failed",
  // Prompt 37-F (§17/§18) — post-commit assignment notification skipped by
  // the defensive re-check (deleted/reassigned/contextless). Safe category
  // only — never task ids, titles or recipient details (§11).
  crmAssignmentNotifySkipped: "crm.assignment.notify_skipped",
  // Prompt 38 (§38-a) — inventory low-stock processor operational events.
  // Payloads carry counts/mode/run-id ONLY — never product names, SKUs,
  // prices, quantities or recipient details (same safe-log law as P37).
  inventoryLowStockProcessorCompleted: "inventory.lowstock.processor.completed",
  inventoryLowStockProcessorFailed: "inventory.lowstock.processor.failed",
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
