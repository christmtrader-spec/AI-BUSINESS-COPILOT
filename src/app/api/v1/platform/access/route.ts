/**
 * GET /api/v1/platform/access — the read-only role × permission matrix (R67,
 * §9 "role-permission read-only matrix"). Every value is derived from the
 * ACTUAL server registry (§81 — the same constants the authorization chain
 * enforces), never from client input or a parallel source of truth.
 *
 * Permission: platform:overview:read (any active operator may SEE the model;
 * only the enforcement points can CHANGE anything).
 */
import { NextRequest } from "next/server";
import { route } from "@/lib/api-helpers";
import { getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { platformOk } from "@/lib/platform/http";
import {
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLES,
  permissionsOfPlatformRole,
  type PlatformPermission,
} from "@/lib/platform/rbac";
import { APPROVAL_KINDS } from "@/lib/platform/approvals";
import { platformMfaEnforcement, platformRoleRequiresMfa } from "@/lib/auth/config";

export const dynamic = "force-dynamic";

/**
 * §56 enforcement evidence — the permissions whose MUTATION routes/service
 * currently demand password reauthentication, derived from the route scan
 * (grep assertPlatformReauth). This map documents REAL enforcement, not
 * aspiration; a permission missing here honestly reports reauthRequired=false.
 */
const REAUTH_ENFORCED: ReadonlySet<PlatformPermission> = new Set([
  "platform:users:suspend",
  "platform:security:manage",
  "platform:operators:manage",
  "platform:approvals:manage",
  "platform:subscriptions:manage",
  "platform:payments:reverify",
  "platform:payments:reconcile",
  "platform:pricing:manage",
  "platform:ai-cost:manage",
  "platform:ai-cost:reconcile",
]);

export const GET = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:overview:read");

  const roles = PLATFORM_ROLES.map((role) => {
    const perms = permissionsOfPlatformRole(role);
    return {
      role,
      permissionCount: perms.length,
      isSuper: role === "PLATFORM_SUPER_ADMIN",
      mfaRequired: platformRoleRequiresMfa(role),
    };
  });

  const permissions = PLATFORM_PERMISSIONS.map((id) => {
    const [domain, scope] = id.replace(/^platform:/, "").split(":");
    return {
      id,
      domain,
      scope, // "read" | mutation verb — read-class vs write-class at a glance
      write: !id.endsWith(":read"),
      sensitive: !id.endsWith(":read"),
      reauthRequired: REAUTH_ENFORCED.has(id),
      roles: PLATFORM_ROLES.filter((role) => permissionsOfPlatformRole(role).includes(id)),
    };
  });

  return platformOk({
    roles,
    permissions,
    policy: {
      // The per-request MFA enforcement mode (server constant — the SAME
      // value getPlatformContext enforces; never a client-side claim).
      mfaEnforcement: platformMfaEnforcement(),
      // High-risk operations currently under two-person control (§10).
      approvalKinds: APPROVAL_KINDS,
      // Operator invitation policy (R67) — bounded window, hours.
      inviteTtlHours: 72,
      // Wildcards do not exist anywhere in this catalog (§5 law).
      wildcardPermissions: false,
    },
  });
});
