/**
 * Webhook signature scheme — Prompt 22 (Stripe-style, provider-agnostic).
 *
 *   header: t=<unix-seconds>,v1=<hex hmac>
 *   signed payload: `${t}.${rawBody}`
 *   hmac: HMAC-SHA256(webhookSecret, signedPayload)
 *
 * Guarantees:
 * - timing-safe comparison (timingSafeEqual — never string ===)
 * - replay protection: |now − t| must be within TOLERANCE (5 min) or the
 *   signature is rejected even though it is cryptographically valid
 * - constant behavior on every failure path: the caller only sees a
 *   WebhookVerificationError (route → 401) and learns nothing about which
 *   check failed
 *
 * Secret resolution: PAYMENT_WEBHOOK_SECRET when set; otherwise a stable
 * value derived from NEXTAUTH_SECRET (so signatures survive restarts in
 * development without extra env setup). A real deployment MUST set an
 * explicit PAYMENT_WEBHOOK_SECRET — documented in docs/payments.md.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookVerificationError } from "./types";

export const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

let cachedSecret: string | null = null;

export function getWebhookSecret(): string {
  if (cachedSecret) return cachedSecret;
  const explicit = process.env.PAYMENT_WEBHOOK_SECRET;
  if (explicit && explicit.length >= 16) {
    cachedSecret = explicit;
    return cachedSecret;
  }
  // Stable dev fallback derived from NEXTAUTH_SECRET (never the raw value).
  const base = process.env.NEXTAUTH_SECRET ?? "insecure-dev-fallback-secret";
  cachedSecret = createHmac("sha256", "payments:webhook-secret").update(base).digest("hex");
  return cachedSecret;
}

export function computeSignature(timestamp: number, rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

/** Build a ready-to-send signature header (used by the sandbox provider). */
export function buildSignatureHeader(rawBody: string, secret?: string, now = Date.now()): string {
  const s = secret ?? getWebhookSecret();
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${computeSignature(t, rawBody, s)}`;
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a `t=…,v1=…` header against the raw body. Throws
 * WebhookVerificationError on any problem (missing/malformed header,
 * out-of-tolerance timestamp, signature mismatch).
 */
export function verifySignatureHeader(
  header: string | null,
  rawBody: string,
  secret?: string,
  now = Date.now(),
): void {
  if (!header) throw new WebhookVerificationError();
  const tMatch = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!tMatch) throw new WebhookVerificationError();
  const t = Number(tMatch[1]);
  if (!Number.isSafeInteger(t)) throw new WebhookVerificationError();
  if (Math.abs(now - t * 1000) > WEBHOOK_TIMESTAMP_TOLERANCE_MS) {
    throw new WebhookVerificationError(); // replay beyond tolerance
  }
  const expected = computeSignature(t, rawBody, secret ?? getWebhookSecret());
  if (!safeEqualHex(tMatch[2], expected)) throw new WebhookVerificationError();
}
