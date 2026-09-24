/**
 * Payment error codes — Prompt 22 (closed set, mirrors billing/errors.ts).
 * Codes are API-stable contracts; messages are server logs only (the UI
 * maps codes to localized strings).
 */

export const PAYMENT_ERROR_CODES = [
  "CHECKOUT_NOT_ALLOWED",
  "CHECKOUT_NOT_FOUND",
  "PROVIDER_UNAVAILABLE",
  "SIMULATE_NOT_SUPPORTED",
  "CHECKOUT_STATE_CONFLICT",
  "WEBHOOK_UNVERIFIED",
] as const;

export type PaymentErrorCode = (typeof PAYMENT_ERROR_CODES)[number];
