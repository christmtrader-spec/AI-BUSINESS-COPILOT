/**
 * Tenant resolution — Constitution A01/A02 (SECURITY CRITICAL).
 *
 * Every business-scoped API request goes through `getAuthContext`:
 *   session -> userId -> X-Business-Id header -> membership lookup (DB)
 *   -> role -> permission check.
 * A valid session WITHOUT verified membership can never read or write
 * business data. The client-supplied business id is never trusted
 * without a membership row.
 */
import { getServerSession } from "next-auth";
import type { Session } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-helpers";
import { asRole, can, type Permission, type Role } from "@/lib/rbac";
import { sessionVersionOf, assertSessionRegistry } from "@/lib/auth-security";

export type AuthContext = {
  session: Session;
  userId: string;
  businessId: string;
  business: {
    id: string;
    name: string;
    slug: string;
    currencyCode: string;
    currencySymbol: string;
    decimalPrecision: number;
    locale: string;
    timezone: string;
    vatEnabled: boolean;
    vatRateBp: number;
    ownerId: string;
    updatedAt: string;
  };
  member: { id: string; role: Role };
  role: Role;
};

export async function getAuthContext(req: Request): Promise<AuthContext> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!session || !userId) {
    throw new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  }

  const businessId = req.headers.get("x-business-id");
  if (!businessId) {
    throw new ApiError(400, "NO_BUSINESS_CONTEXT", "No active business selected.");
  }

  const member = await db.businessMember.findUnique({
    where: { businessId_userId: { businessId, userId } },
    include: {
      business: true,
      // Prompt 18: the user row rides along so the session-version freshness
      // gate costs zero extra queries. A JWT stamped before a password
      // change/reset fails here exactly as it does on account-scoped APIs.
      user: { select: { sessionVersion: true } },
    },
  });
  if (!member) {
    throw new ApiError(403, "FORBIDDEN", "You do not have access to this business.");
  }

  // Session invalidation checkpoint (§16) — see auth-security.ts.
  if (sessionVersionOf(session) !== member.user.sessionVersion) {
    throw new ApiError(
      401,
      "SESSION_INVALIDATED",
      "Your session was invalidated (password changed). Please sign in again.",
    );
  }

  // Prompt 30 §81 — per-device session registry check for sid-bearing
  // JWTs (revocation/expiry effective immediately on the next request).
  // Legacy JWTs without sid bypass the registry during the documented
  // compatibility window (sessionVersion above is still their kill switch).
  await assertSessionRegistry(session, userId);

  return {
    session,
    userId,
    businessId: member.businessId,
    business: {
      id: member.business.id,
      name: member.business.name,
      slug: member.business.slug,
      currencyCode: member.business.currencyCode,
      currencySymbol: member.business.currencySymbol,
      decimalPrecision: member.business.decimalPrecision,
      locale: member.business.locale,
      timezone: member.business.timezone,
      // Prompt 52 §F3 — VAT engine config rides on every auth context.
      vatEnabled: member.business.vatEnabled,
      vatRateBp: member.business.vatRateBp,
      ownerId: member.business.ownerId,
      updatedAt: member.business.updatedAt.toISOString(),
    },
    member: { id: member.id, role: asRole(member.role) },
    role: asRole(member.role),
  };
}

/** Enforce a permission inside a resolved context (A02). */
export function requirePermission(ctx: AuthContext, permission: Permission): void {
  if (!can(ctx.role, permission)) {
    throw new ApiError(
      403,
      "PERMISSION_DENIED",
      "Your role does not allow this action.",
      { permission, role: ctx.role },
    );
  }
}
