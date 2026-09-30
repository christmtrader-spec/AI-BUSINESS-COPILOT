import "server-only";

/**
 * Notification domain types — Prompt 32.
 *
 * A NOTIFICATION is user communication DERIVED from a domain event; it is
 * never an authority layer (§4/§32 final principle). These types are the
 * fixed vocabulary for the whole platform — every value that reaches the
 * database or a DTO comes from an allowlisted constant here or in
 * catalog.ts, never from client input (§5/§187/§188).
 */

export const NOTIFICATION_CATEGORIES = [
  "SECURITY",
  "BILLING",
  "AI",
  "BUSINESS",
  "SYSTEM",
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return (
    typeof value === "string" &&
    (NOTIFICATION_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * PRIORITY controls delivery handling (urgency) — §6. It is decided by the
 * server catalog only; the browser can never select a priority (§6).
 */
export const NOTIFICATION_PRIORITIES = ["LOW", "NORMAL", "HIGH", "CRITICAL"] as const;

export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

export function isNotificationPriority(value: unknown): value is NotificationPriority {
  return (
    typeof value === "string" &&
    (NOTIFICATION_PRIORITIES as readonly string[]).includes(value)
  );
}

/**
 * SEVERITY controls presentation (tone) — §7. Deliberately distinct from
 * priority: a CRITICAL-priority notification may still be informational.
 */
export const NOTIFICATION_SEVERITIES = ["INFO", "SUCCESS", "WARNING", "ERROR"] as const;

export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export function isNotificationSeverity(value: unknown): value is NotificationSeverity {
  return (
    typeof value === "string" &&
    (NOTIFICATION_SEVERITIES as readonly string[]).includes(value)
  );
}

/**
 * CHANNELS (§9). IN_APP and EMAIL are implemented; PUSH/SMS remain future
 * adapter placeholders — never fake-implemented (§140/§141).
 */
export const NOTIFICATION_CHANNELS = ["IN_APP", "EMAIL"] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export function isNotificationChannel(value: unknown): value is NotificationChannel {
  return (
    typeof value === "string" &&
    (NOTIFICATION_CHANNELS as readonly string[]).includes(value)
  );
}

/**
 * Delivery statuses (§32/§142). The valid state machine (§143):
 *   PENDING → PROCESSING → SENT | FAILED
 *   PENDING → CANCELED
 *   FAILED  → PROCESSING (explicit, bounded retry only)
 * SENT is terminal — never back to PROCESSING (§143).
 */
export const DELIVERY_STATUSES = [
  "PENDING",
  "PROCESSING",
  "SENT",
  "FAILED",
  "SKIPPED",
  "CANCELED",
] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export function isDeliveryStatus(value: unknown): value is DeliveryStatus {
  return (
    typeof value === "string" &&
    (DELIVERY_STATUSES as readonly string[]).includes(value)
  );
}

/** Normalized email failure classes (§263) — never raw SMTP output. */
export const DELIVERY_FAILURE_CODES = [
  "SMTP_CONFIG",
  "SMTP_TIMEOUT",
  "SMTP_AUTH",
  "SMTP_CONNECTION",
  "TEMPLATE",
  "INVALID_RECIPIENT",
  "ATTEMPTS_EXHAUSTED",
  "STALE_PROCESSING",
  "RECIPIENT_UNVERIFIED",
  "UNKNOWN",
] as const;

export type DeliveryFailureCode = (typeof DELIVERY_FAILURE_CODES)[number];

/** Whether a channel is mandatory, optional or excluded for a catalog type. */
export type ChannelPolicy = "ALWAYS" | "IF_ENABLED" | "NEVER";

export type ChannelPolicySet = Record<NotificationChannel, ChannelPolicy>;

/** Internal allowlisted action routes (§102/§103). */
export const ACTION_ROUTES = [
  "security",
  "billing",
  "data",
  "usage",
  "notifications",
  "dashboard",
] as const;

export type ActionRoute = (typeof ACTION_ROUTES)[number];

export function isActionRoute(value: unknown): value is ActionRoute {
  return (
    typeof value === "string" &&
    (ACTION_ROUTES as readonly string[]).includes(value)
  );
}

/** In-app hash path for an allowlisted route key (single mapping point). */
export function actionRoutePath(route: ActionRoute): string {
  switch (route) {
    case "security":
      return "#/settings/security";
    case "billing":
      return "#/settings/billing";
    case "data":
      return "#/data";
    case "usage":
      return "#/settings/billing";
    case "notifications":
      return "#/notifications";
    case "dashboard":
      return "#/dashboard";
  }
}
