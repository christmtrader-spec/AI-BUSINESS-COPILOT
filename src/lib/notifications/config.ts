import "server-only";

/**
 * Notification platform configuration — Prompt 32 §343/§344/§345.
 *
 * Every numeric value is parsed STRICTLY: integer, positive, bounded. An
 * invalid environment value falls back to the documented default (never
 * NaN/Infinity/negative — §345 forbids infinite defaults). All bounds are
 * conservative; notification infrastructure must never amplify load.
 */

function intFromEnv(
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    return fallback;
  }
  return value;
}

/**
 * Bounded retry cap for EMAIL deliveries (§45). After exhaustion the
 * delivery stays FAILED and an operational log is emitted.
 */
export function notificationEmailMaxAttempts(): number {
  return intFromEnv("NOTIFICATION_EMAIL_MAX_ATTEMPTS", 3, 1, 10);
}

/**
 * Operational retention for non-security notifications (days, §126).
 * Cleanup is OPERATIONAL data management — never a legal retention claim
 * (§59/§125).
 */
export function notificationRetentionDays(): number {
  return intFromEnv("NOTIFICATION_RETENTION_DAYS", 90, 7, 3650);
}

/**
 * Security notifications are kept longer (§127) — they are part of the
 * user's security-history experience.
 */
export function notificationSecurityRetentionDays(): number {
  return intFromEnv("NOTIFICATION_SECURITY_RETENTION_DAYS", 365, 30, 3650);
}

/** Max page size for notification list endpoints (§54). */
export function notificationMaxPageSize(): number {
  return intFromEnv("NOTIFICATION_MAX_PAGE_SIZE", 100, 10, 200);
}

/** Hard maximum for the serialized per-notification data payload (§231). */
export function notificationMaxDataBytes(): number {
  return intFromEnv("NOTIFICATION_MAX_DATA_BYTES", 32_768, 1024, 262_144);
}

/** Cleanup batch size (§425). */
export function notificationCleanupBatchSize(): number {
  return intFromEnv("NOTIFICATION_CLEANUP_BATCH_SIZE", 500, 50, 5000);
}

/**
 * A delivery stuck in PROCESSING longer than this is considered stale
 * (§146/§360). Stale rows are marked FAILED (never blindly resent — §146).
 */
export function notificationStaleDeliveryMinutes(): number {
  return intFromEnv("NOTIFICATION_STALE_DELIVERY_MINUTES", 30, 5, 1440);
}

/**
 * Upper bound of PENDING email deliveries per user (§343). Above the cap,
 * OPTIONAL email deliveries are skipped (in-app is never suppressed);
 * MANDATORY security email always bypasses the cap (§321/§139).
 */
export function notificationActiveDeliveryLimit(): number {
  return intFromEnv("NOTIFICATION_ACTIVE_DELIVERY_LIMIT", 100, 10, 1000);
}

/**
 * Conservative unread-count poll interval for the notification bell (ms).
 */
export function notificationPollIntervalMs(): number {
  return intFromEnv("NOTIFICATION_POLL_INTERVAL_MS", 45_000, 10_000, 600_000);
}

/**
 * True when a production email transport is configured (reuse of the
 * Prompt 29 wiring — never a second timeout system, §46).
 */
export function notificationEmailTransportConfigured(): boolean {
  if (process.env.NODE_ENV !== "production") return true; // dev console/test transports
  return Boolean(
    (process.env.EMAIL_PROVIDER ?? "").trim() === "test-memory"
      ? false
      : process.env.SMTP_HOST && process.env.SMTP_PORT,
  );
}
