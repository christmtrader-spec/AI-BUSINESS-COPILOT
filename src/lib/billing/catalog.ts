/**
 * Billing catalog — Prompt 20 (§37/§38/§72).
 *
 * SINGLE SOURCE OF TRUTH for the internal plan + entitlement catalog.
 * The database (Plan / EntitlementDefinition / PlanEntitlement) is the
 * runtime authority; this file is what the idempotent seed writes into it
 * and what code uses for typed constants. Values are INTERNAL DEFAULTS
 * (§38) — configurable through seed data, never hard-coded pricing
 * (§39: no price coupling; prices belong to a future payment phase).
 *
 * This module is intentionally dependency-free (pure data + types) so the
 * seed script (scripts/seed-billing.ts, run with bun) can import it
 * without pulling in the Next.js runtime.
 */

// ---------------------------------------------------------------------------
// Entitlement codes (§72 — constants, never scattered string literals)
// ---------------------------------------------------------------------------

export const ENTITLEMENT_CODES = [
  "CUSTOMERS_MAX",
  "PRODUCTS_MAX",
  "TEAM_MEMBERS_MAX",
  "BUSINESSES_MAX",
  "AI_REQUESTS_MAX",
  "AI_MESSAGES_MAX",
  "AI_COPILOT",
  "ADVANCED_REPORTS",
  "CSV_EXPORT",
] as const;

export type EntitlementCode = (typeof ENTITLEMENT_CODES)[number];

export type EntitlementType = "LIMIT" | "BOOLEAN";

export type EntitlementUnit =
  | "COUNT"
  | "USERS"
  | "BUSINESSES"
  | "REQUESTS"
  | "MESSAGES"
  | "MEGABYTES";

export type EntitlementSpec = {
  code: EntitlementCode;
  type: EntitlementType;
  /** LIMIT only — null for BOOLEAN. */
  unit: EntitlementUnit | null;
  description: string;
};

/**
 * The complete entitlement catalog. Every plan must define EVERY code
 * (seed enforces completeness) so resolution can fail closed on corruption
 * without ever silently granting unlimited access (§68/§93).
 */
export const ENTITLEMENTS: readonly EntitlementSpec[] = [
  {
    code: "CUSTOMERS_MAX",
    type: "LIMIT",
    unit: "COUNT",
    description:
      "Maximum non-deleted customers. Enforced at customer creation (POST /api/v1/customers).",
  },
  {
    code: "PRODUCTS_MAX",
    type: "LIMIT",
    unit: "COUNT",
    description:
      "Maximum non-deleted products (active AND inactive count; deactivation is not deletion). Enforced at product creation (POST /api/v1/products).",
  },
  {
    code: "TEAM_MEMBERS_MAX",
    type: "LIMIT",
    unit: "USERS",
    description:
      "Maximum business members INCLUDING the owner (§108). Pending invites do NOT count (§31). Enforced at member add + invite minting.",
  },
  {
    code: "BUSINESSES_MAX",
    type: "LIMIT",
    unit: "BUSINESSES",
    description:
      "Maximum businesses a user OWNS (ownerId = user; memberships as staff never count, §107). Enforced at business creation (POST /api/v1/businesses).",
  },
  {
    code: "AI_REQUESTS_MAX",
    type: "LIMIT",
    unit: "REQUESTS",
    description:
      "Maximum AI Copilot executions per usage period (Prompt 21). One accepted user question = one metered AI request, regardless of internal tool calls or stream chunks. Enforced server-side at the copilot endpoints; consumed usage rolls with the subscription billing period.",
  },
  {
    code: "AI_MESSAGES_MAX",
    type: "LIMIT",
    unit: "MESSAGES",
    description:
      "Maximum user AI messages entering the Copilot pipeline per usage period (Prompt 21). Metered together with AI_REQUESTS under the same idempotency key so a network retry never double-charges.",
  },
  {
    code: "AI_COPILOT",
    type: "BOOLEAN",
    unit: null,
    description:
      "AI Copilot availability. Enforced server-side at POST /api/v1/copilot. Usage QUANTITY metering is Prompt 21 — this flag gates presence only (§36).",
  },
  {
    code: "ADVANCED_REPORTS",
    type: "BOOLEAN",
    unit: null,
    description:
      "Advanced report insights (growth/concentration analytics beyond the deterministic MVP reports). Enforced at GET /api/v1/reports/summary — the server omits the `advanced` block when not entitled (§35: existing basic reports stay available to every plan).",
  },
  {
    code: "CSV_EXPORT",
    type: "BOOLEAN",
    unit: null,
    description:
      "Server-side CSV export. Enforced at GET /api/v1/reports/export (§34). Client-side CSV of already-fetched rows is plain UI, not an authorization surface.",
  },
] as const;

export const ENTITLEMENT_CODES_SET: ReadonlySet<string> = new Set(ENTITLEMENT_CODES);

export function isEntitlementCode(value: unknown): value is EntitlementCode {
  return typeof value === "string" && (ENTITLEMENT_CODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Plan catalog (§37/§38) — internal defaults, no prices (§39)
// ---------------------------------------------------------------------------

export const PLAN_CODES = [
  "FREE",
  "STARTER",
  "BUSINESS",
  "PRO",
  "ENTERPRISE",
] as const;

export type PlanCode = (typeof PLAN_CODES)[number];

export type PlanSpec = {
  code: PlanCode;
  name: string;
  description: string;
  sortOrder: number;
  isPublic: boolean;
  /**
   * LIMIT value: number = the limit; null = UNLIMITED.
   * BOOLEAN value: boolean = the flag.
   * Every plan lists EVERY entitlement (seed validates completeness).
   */
  entitlements: Record<EntitlementCode, number | null | boolean>;
};

export const PLANS: readonly PlanSpec[] = [
  {
    code: "FREE",
    name: "Free",
    description:
      "The deterministic default plan. Every business — new or migrated — starts here. Core business management included.",
    sortOrder: 10,
    isPublic: true,
    entitlements: {
      CUSTOMERS_MAX: 50,
      PRODUCTS_MAX: 25,
      TEAM_MEMBERS_MAX: 2,
      BUSINESSES_MAX: 1,
      AI_REQUESTS_MAX: 25,
      AI_MESSAGES_MAX: 25,
      AI_COPILOT: true,
      ADVANCED_REPORTS: false,
      // §38 leaves "no advanced exports if desired" — CSV stays ENABLED on
      // FREE so the migration never removes a capability businesses already
      // rely on (§65 backwards compatibility). The gate still exists and is
      // tested; a future business decision may flip it via seed data.
      CSV_EXPORT: true,
    },
  },
  {
    code: "STARTER",
    name: "Starter",
    description:
      "Higher limits and advanced report insights for growing one-person businesses.",
    sortOrder: 20,
    isPublic: true,
    entitlements: {
      CUSTOMERS_MAX: 500,
      PRODUCTS_MAX: 200,
      TEAM_MEMBERS_MAX: 5,
      BUSINESSES_MAX: 2,
      AI_REQUESTS_MAX: 150,
      AI_MESSAGES_MAX: 150,
      AI_COPILOT: true,
      ADVANCED_REPORTS: true,
      CSV_EXPORT: true,
    },
  },
  {
    code: "BUSINESS",
    name: "Business",
    description: "Larger limits and multi-member team access for established shops.",
    sortOrder: 30,
    isPublic: true,
    entitlements: {
      CUSTOMERS_MAX: 2500,
      PRODUCTS_MAX: 1000,
      TEAM_MEMBERS_MAX: 15,
      BUSINESSES_MAX: 5,
      AI_REQUESTS_MAX: 500,
      AI_MESSAGES_MAX: 500,
      AI_COPILOT: true,
      ADVANCED_REPORTS: true,
      CSV_EXPORT: true,
    },
  },
  {
    code: "PRO",
    name: "Pro",
    description:
      "High limits for larger operations — advanced AI and reporting included.",
    sortOrder: 40,
    isPublic: true,
    entitlements: {
      CUSTOMERS_MAX: 25000,
      PRODUCTS_MAX: 10000,
      TEAM_MEMBERS_MAX: 50,
      BUSINESSES_MAX: 10,
      AI_REQUESTS_MAX: 2000,
      AI_MESSAGES_MAX: 2000,
      AI_COPILOT: true,
      ADVANCED_REPORTS: true,
      CSV_EXPORT: true,
    },
  },
  {
    code: "ENTERPRISE",
    name: "Enterprise",
    description:
      "Customizable limits for large organizations. Negotiated per customer.",
    sortOrder: 50,
    isPublic: true,
    entitlements: {
      CUSTOMERS_MAX: null,
      PRODUCTS_MAX: null,
      TEAM_MEMBERS_MAX: null,
      BUSINESSES_MAX: null,
      AI_REQUESTS_MAX: null,
      AI_MESSAGES_MAX: null,
      AI_COPILOT: true,
      ADVANCED_REPORTS: true,
      CSV_EXPORT: true,
    },
  },
] as const;

export const FREE_PLAN_CODE: PlanCode = "FREE";

/** Statuses that keep the subscription's OWN plan entitled (§17). */
export const ENTITLED_STATUSES = ["TRIALING", "ACTIVE", "PAST_DUE", "CANCELED"] as const;

/**
 * Plans the UI advertises for internal switching. ENTERPRISE is excluded
 * from self-service switching (customizable per customer, §38) but still
 * exists in the catalog and can be assigned server-side.
 */
export function selfServicePlanCodes(): PlanCode[] {
  return PLANS.filter((p) => p.isPublic && p.code !== "ENTERPRISE").map((p) => p.code);
}

/**
 * Prompt 25 — the trial length the PUBLIC pricing surface advertises.
 * Delegates to THE trial-config authority (billing/trial-config.ts — the
 * one place trial policy is read from the environment): when trials are
 * disabled or misconfigured this returns null and the pricing page
 * honestly renders "no trial" instead of inventing a number.
 */
import { getTrialConfig } from "./trial-config";

export function configuredTrialDays(): number | null {
  return getTrialConfig().trialDays;
}
