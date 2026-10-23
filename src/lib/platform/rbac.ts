/**
 * Platform RBAC — Prompt 28 (§4/§5/§6/§13).
 *
 * The PLATFORM role model is deliberately SEPARATE from the tenant role
 * model (src/lib/rbac.ts). No identifier, permission or rank is shared:
 *
 *   TENANT roles   OWNER/ADMIN/MANAGER/STAFF/ACCOUNTANT/VIEWER
 *   PLATFORM roles PLATFORM_SUPER_ADMIN/PLATFORM_SUPPORT/PLATFORM_BILLING/
 *                  PLATFORM_AI_COST/PLATFORM_SECURITY/PLATFORM_READONLY
 *
 * A BUSINESS OWNER != PLATFORM OPERATOR (§3): platform authorization is
 * derived exclusively from the PlatformOperator table (see auth.ts) — it can
 * never come from a request body, query param, header or localStorage
 * (§79/§132 role-tampering law).
 */

// ---------------------------------------------------------------------------
// Roles (§4) — validated with zod at every boundary (SQLite has no enums)
// ---------------------------------------------------------------------------

export const PLATFORM_ROLES = [
  "PLATFORM_SUPER_ADMIN",
  "PLATFORM_SUPPORT",
  "PLATFORM_BILLING",
  "PLATFORM_AI_COST",
  "PLATFORM_SECURITY",
  "PLATFORM_READONLY",
] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];

// ---------------------------------------------------------------------------
// Permission catalog (§5) — explicit, NO wildcard permission exists
// ---------------------------------------------------------------------------

export const PLATFORM_PERMISSIONS = [
  "platform:overview:read",
  "platform:businesses:read",
  "platform:users:read",
  "platform:users:suspend", // Prompt 62 §8.3 — suspend/reactivate (with reason + audit)
  "platform:subscriptions:read",
  "platform:subscriptions:manage",
  "platform:payments:read",
  "platform:payments:reverify",
  "platform:payments:reconcile",
  "platform:pricing:read",
  "platform:pricing:manage",
  "platform:ai-cost:read",
  "platform:ai-cost:manage",
  "platform:ai-cost:reconcile",
  "platform:support:read", // Prompt 62 §10 — Support Center
  "platform:support:assign",
  "platform:support:update",
  "platform:support:resolve",
  "platform:security:read",
  "platform:security:manage",
  "platform:audit:read",
  "platform:operators:read",
  "platform:operators:manage",
  "platform:approvals:read", // Prompt 65 §10 — two-person approval transparency (all roles)
  "platform:approvals:manage", // create/approve/reject/cancel/execute approvals (approve/execute ALSO require the target operation's permission)
  "platform:system:read",
] as const;

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

const ALL_PLATFORM_PERMISSIONS: readonly PlatformPermission[] = PLATFORM_PERMISSIONS;

// ---------------------------------------------------------------------------
// Role → permission matrix (§6) — read it like the prompt, no surprises
// ---------------------------------------------------------------------------

const ROLE_PERMISSIONS: Record<PlatformRole, readonly PlatformPermission[]> = {
  PLATFORM_SUPER_ADMIN: ALL_PLATFORM_PERMISSIONS,

  PLATFORM_SUPPORT: [
    "platform:overview:read",
    "platform:businesses:read",
    "platform:users:read",
    "platform:users:suspend",
    "platform:approvals:read", // R65 §10 — approval transparency (read-only)
    "platform:subscriptions:read",
    "platform:payments:read",
    "platform:support:read",
    "platform:support:assign",
    "platform:support:update",
    "platform:support:resolve",
    "platform:audit:read",
    "platform:system:read",
  ],

  PLATFORM_BILLING: [
    "platform:overview:read",
    "platform:businesses:read",
    "platform:subscriptions:read",
    "platform:subscriptions:manage",
    "platform:payments:read",
    "platform:payments:reverify",
    "platform:payments:reconcile",
    "platform:pricing:read",
    "platform:pricing:manage",
    "platform:approvals:read", // R65 §10 — approval transparency (read-only)
    "platform:approvals:manage", // R65 §10 — request/approve pricing activations (target-op permission still required)
    "platform:support:read", // sees tickets; billing mutations stay in the billing domain
    "platform:audit:read",
    "platform:system:read",
  ],

  PLATFORM_AI_COST: [
    "platform:overview:read",
    "platform:businesses:read",
    "platform:approvals:read", // R65 §10 — approval transparency (read-only)
    "platform:subscriptions:read",
    "platform:ai-cost:read",
    "platform:ai-cost:manage",
    "platform:ai-cost:reconcile",
    "platform:support:read", // AI-quota diagnostics inside ticket threads
    "platform:audit:read",
    "platform:system:read",
  ],

  PLATFORM_SECURITY: [
    "platform:overview:read",
    "platform:businesses:read",
    "platform:users:read",
    "platform:users:suspend", // security response — reason-mandatory, audited
    "platform:support:read", // ticket context for incident response
    "platform:security:read",
    "platform:security:manage",
    "platform:approvals:read", // R65 §10 — approval transparency (read-only)
    "platform:approvals:manage", // R65 §10 — security governance of approval requests (target-op permission still required)
    "platform:audit:read",
    "platform:system:read",
  ],

  // READONLY: read-only visibility ONLY — no mutation permission at all.
  PLATFORM_READONLY: [
    "platform:overview:read",
    "platform:businesses:read",
    "platform:approvals:read", // R65 §10 — approval transparency (read-only)
    "platform:users:read",
    "platform:subscriptions:read",
    "platform:payments:read",
    "platform:pricing:read",
    "platform:ai-cost:read",
    "platform:support:read",
    "platform:security:read",
    "platform:audit:read",
    "platform:operators:read",
    "platform:system:read",
  ],
};

export function isPlatformRole(value: unknown): value is PlatformRole {
  return typeof value === "string" && (PLATFORM_ROLES as readonly string[]).includes(value);
}

export function asPlatformRole(value: unknown): PlatformRole | null {
  return isPlatformRole(value) ? value : null;
}

export function permissionsOfPlatformRole(role: PlatformRole): readonly PlatformPermission[] {
  return ROLE_PERMISSIONS[role];
}

export function canPlatform(role: PlatformRole, permission: PlatformPermission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** True only for the mutation-capable operator-management roles (§54). */
export function isOperatorManagerRole(role: PlatformRole): boolean {
  return role === "PLATFORM_SUPER_ADMIN";
}

/** Roles allowed to invalidate user sessions (§22). */
export function canInvalidateSessions(role: PlatformRole): boolean {
  return role === "PLATFORM_SECURITY" || role === "PLATFORM_SUPER_ADMIN";
}
