/**
 * Billing domain — public surface (Prompt 20).
 *
 * Import from "@/lib/billing" everywhere EXCEPT inside this folder.
 * The service layer (service.ts) is the only module that touches the
 * subscription tables — routes/components never query them directly.
 */
export * from "./catalog";
export * from "./errors";
export * from "./state-machine";
export * from "./service";
export * from "./usage";
export * from "./events";
export * from "./trial-config";
export * from "./trial";
export * from "./public-pricing";
