/**
 * RBAC — Constitution A02.
 * Role model + server-side permission matrix.
 * Authorization NEVER relies on frontend visibility; API routes call
 * `can()` from the request pipeline (see src/lib/tenant.ts).
 *
 * NOTE: roles stored as strings in DB (SQLite has no enums);
 * validated with zod at every boundary.
 */

export const ROLES = [
  "OWNER",
  "ADMIN",
  "MANAGER",
  "STAFF",
  "ACCOUNTANT",
  "VIEWER",
] as const;

export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "data:read",
  "data:write",
  "settings:read",
  "settings:manage",
  "members:read",
  "members:manage",
  "audit:read",
  "copilot:use",
  "finance:manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  OWNER: PERMISSIONS, // everything
  ADMIN: [
    "data:read",
    "data:write",
    "settings:read",
    "settings:manage",
    "members:read",
    "members:manage",
    "audit:read",
    "copilot:use",
    "finance:manage",
  ],
  MANAGER: [
    "data:read",
    "data:write",
    "settings:read",
    "members:read",
    "copilot:use",
    "finance:manage",
  ],
  STAFF: ["data:read", "data:write", "settings:read", "members:read", "copilot:use"],
  ACCOUNTANT: [
    "data:read",
    "data:write",
    "settings:read",
    "members:read",
    "audit:read",
    "copilot:use",
    "finance:manage",
  ],
  VIEWER: ["data:read", "settings:read", "members:read"],
};

/** Ordinal rank for hierarchy checks (higher = more authority). */
export const ROLE_RANK: Record<Role, number> = {
  OWNER: 60,
  ADMIN: 50,
  MANAGER: 40,
  STAFF: 30,
  ACCOUNTANT: 30,
  VIEWER: 10,
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function asRole(value: unknown): Role {
  return isRole(value) ? value : "VIEWER";
}

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsOf(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}
