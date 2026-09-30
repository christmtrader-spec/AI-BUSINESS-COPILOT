import "server-only";
import { notificationMaxDataBytes } from "./config";

/**
 * Notification data safety — Prompt 32 §25/§26/§231/§246/§346.
 *
 * `dataJson` is a server-constructed, per-type-schema-validated object.
 * `sanitizeNotificationData` is the DEFENSE-IN-DEPTH gate that rejects
 * forbidden keys at ANY depth and bounds the serialized size — even if a
 * future mapper is written carelessly, a secret can never reach the
 * database through this path.
 */

/** Forbidden key fragments (§25/§26/§390). Matching is case-insensitive and
 * fragment-based so `apiKey`, `providerApiKey`, `smtpPassword` etc. all trip. */
const FORBIDDEN_KEY_FRAGMENTS = [
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "authorization",
  "auth",
  "cookie",
  "otp",
  "mfa",
  "recoverycode",
  "recovery_code",
  "session",
  "reset",
  "credential",
  "privatekey",
  "private_key",
  "merchant",
  "signature",
  "authorizationheader",
  "bearer",
] as const;

/** Keys that would leak prohibited CONTENT even with innocuous names (§25). */
const FORBIDDEN_EXACT_KEYS = [
  "prompt",
  "response",
  "aiprompt",
  "airesponse",
  "messages",
  "cost",
  "rate",
  "margin",
  "providercost",
  "ip",
  "ipaddress",
  "ipaddresshash",
  "useragent",
] as const;

function keyIsForbidden(rawKey: string): boolean {
  const key = rawKey.toLowerCase().replace(/[^a-z0-9_]/g, "");
  if ((FORBIDDEN_EXACT_KEYS as readonly string[]).includes(key)) return true;
  return (FORBIDDEN_KEY_FRAGMENTS as readonly string[]).some((fragment) =>
    key.includes(fragment),
  );
}

export class NotificationDataViolation extends Error {
  constructor(public readonly reason: string) {
    super(`Notification data rejected: ${reason}`);
    this.name = "NotificationDataViolation";
  }
}

function assertSafeValue(key: string, value: unknown, depth: number): void {
  if (depth > 2) {
    throw new NotificationDataViolation(`key "${key}" exceeds nesting depth`);
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 32) {
      throw new NotificationDataViolation(`key "${key}" array too long`);
    }
    for (const item of value) assertSafeValue(key, item, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      if (keyIsForbidden(childKey)) {
        throw new NotificationDataViolation(`forbidden key "${childKey}"`);
      }
      assertSafeValue(childKey, childValue, depth + 1);
    }
    return;
  }
  throw new NotificationDataViolation(`key "${key}" has unsupported type ${typeof value}`);
}

/**
 * Validate + return the data object (never mutates the input). Throws
 * `NotificationDataViolation` on ANY forbidden key, unsupported value type,
 * excessive nesting or oversized payload (§231 suggests ≤32 KB — the
 * configured default; §346 rejects above the configured maximum).
 */
export function sanitizeNotificationData(
  data: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (data === null || data === undefined) return null;
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new NotificationDataViolation("data must be a plain object");
  }
  for (const key of Object.keys(data)) {
    if (keyIsForbidden(key)) {
      throw new NotificationDataViolation(`forbidden key "${key}"`);
    }
  }
  assertSafeValue("", data, 0);
  const serialized = JSON.stringify(data);
  if (serialized.length > notificationMaxDataBytes()) {
    throw new NotificationDataViolation("payload exceeds the configured size limit");
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

/**
 * Server-side idempotency key composition (§29). Mappers build semantic
 * keys from DURABLE server identifiers (event row ids / period boundaries) —
 * never timestamps alone, never client-generated strings (§29/§333).
 */
export function composeSourceEventId(...parts: readonly string[]): string {
  return parts
    .map((part) => part.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 120))
    .filter(Boolean)
    .join(":")
    .slice(0, 300);
}
