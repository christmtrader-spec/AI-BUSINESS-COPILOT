/**
 * Prompt 36 — CRM Activity vocabulary (§6/§11).
 *
 * A CRM Activity is a HISTORICAL business interaction or manually recorded
 * event (NOTE/CALL/EMAIL/MEETING/OTHER). It is NOT an AuditLog row and NOT
 * a system event: system state changes stay in the CRM domain + AuditLog
 * (§6 — no "SYSTEM" type exists here, on purpose).
 *
 * CLIENT-SAFE: this file is pure constants/guards. UI modules import it
 * directly — never through the server-only barrel (Prompt 35 lesson).
 */

export const ACTIVITY_TYPES = [
  "NOTE",
  "CALL",
  "EMAIL",
  "MEETING",
  "OTHER",
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export function isActivityType(value: string): value is ActivityType {
  return (ACTIVITY_TYPES as readonly string[]).includes(value);
}

/**
 * Closed CRM context vocabulary (§19/§20) — the ONE entity an activity or
 * task is anchored to. Exactly one context is required (§8); the server
 * resolves the id against the caller's business and never trusts a client
 * businessId (§9/§70).
 */
export const CRM_CONTEXT_TYPES = ["CUSTOMER", "LEAD", "OPPORTUNITY"] as const;

export type CrmContextType = (typeof CRM_CONTEXT_TYPES)[number];

export function isCrmContextType(value: string): value is CrmContextType {
  return (CRM_CONTEXT_TYPES as readonly string[]).includes(value);
}
