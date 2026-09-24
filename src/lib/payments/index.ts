/**
 * Payments lib barrel — Prompt 22. Import surface for routes and UI.
 */
export * from "./pricing";
export * from "./types";
export * from "./signature";
export * from "./registry";
export * from "./errors";
export * from "./mock-provider";
export {
  createCheckout,
  getCheckoutSession,
  fulfillWebhook,
  simulateWebhook,
  listPayments,
  expireStaleSessions,
  type CheckoutSessionDto,
  type PaymentRowDto,
  type FulfillResult,
  type SimulateOutcome,
} from "./service";
