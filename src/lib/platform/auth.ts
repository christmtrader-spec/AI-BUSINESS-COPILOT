/**
 * Platform authorization context — Prompt 28 (§11/§12/§56).
 *
 * THE single gate for every /api/v1/platform/* route:
 *
 *   session → userId → User → PlatformOperator row → active check
 *           → sessionVersion verification → platform context
 *
 * Security laws:
 * - Authorization is derived ONLY from the DB (PlatformOperator row + role).
 *   Nothing from the request (body/query/header/localStorage) can grant a
 *   role (§79/§132).
 * - businessId is NEVER a platform authorization key (§11).
 * - Anonymous → 401 PLATFORM_UNAUTHENTICATED.
 *   Authenticated tenant user (no operator row) → 403 PLATFORM_FORBIDDEN
 *   (does NOT reveal whether any platform resource exists, §12).
 *   Inactive operator → 403 PLATFORM_OPERATOR_INACTIVE.
 *   Invalidated session → 401 SESSION_INVALIDATED.
 * - High-risk mutations re-verify the CURRENT PASSWORD against the existing
 *   User.passwordHash (§56) — no second credential store, never logged.
 */
import { getServerSession } from "next-auth";
import type { Session } from "next-auth";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { ApiError } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { sessionVersionOf } from "@/lib/auth-security";
import {
  canPlatform,
  permissionsOfPlatformRole,
  type PlatformPermission,
  type PlatformRole,
} from "./rbac";

export type PlatformContext = {
  session: Session;
  operatorId: string;
  userId: string;
  email: string;
  role: PlatformRole;
  permissions: readonly PlatformPermission[];
};

/** Structured platform errors share the standard envelope (§86). */
export function platformError(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): ApiError {
  return new ApiError(status, code, message, details);
}

export async function getPlatformContext(req?: Request): Promise<PlatformContext> {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!session || !userId) {
    throw platformError(401, "PLATFORM_UNAUTHENTICATED", "Sign in to access the platform console.");
  }

  // Session invalidation (Prompt 18) applies to platform access too (§106):
  // a JWT stamped before a password change/reset can never reach the console.
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, sessionVersion: true, passwordHash: true },
  });
  if (!user) {
    throw platformError(401, "PLATFORM_UNAUTHENTICATED", "Sign in to access the platform console.");
  }
  if (sessionVersionOf(session) !== user.sessionVersion) {
    throw platformError(401, "SESSION_INVALIDATED", "Your session was invalidated. Please sign in again.");
  }

  // R64 FIX (Prompt 30 §81) — per-device registry gate: the TENANT chain has
  // always enforced this (assertFreshSession), but the platform chain did
  // NOT — a single-session revocation (per-device revokedAt, e.g. the
  // Operators-view revoke or self-service device sign-out) left the JWT
  // fully usable against every platform route. One validation path (§81):
  // sid-bearing sessions MUST be live (present, unrevoked, unexpired) here
  // exactly as they must be on the tenant side. Legacy sid-less JWTs keep
  // the documented compat-window behavior (§83/§226).
  const sid = (session.user as { sid?: string }).sid;
  if (sid) {
    const { checkSessionRegistry } = await import("@/lib/auth/sessions/service");
    const registry = await checkSessionRegistry(sid, user.id);
    if (!registry.ok) {
      throw platformError(
        401,
        registry.reason === "REVOKED" ? "SESSION_REVOKED" : "SESSION_INVALIDATED",
        "This device was signed out. Please sign in again.",
      );
    }
  }

  const operator = await db.platformOperator.findUnique({ where: { userId } });
  if (!operator) {
    // Tenant users are plain 403 — no information about the platform layer.
    throw platformError(403, "PLATFORM_FORBIDDEN", "You do not have platform access.");
  }
  if (!operator.active) {
    throw platformError(403, "PLATFORM_OPERATOR_INACTIVE", "This operator account is deactivated.");
  }

  return {
    session,
    operatorId: operator.id,
    userId: user.id,
    email: user.email,
    role: operator.role as PlatformRole,
    permissions: permissionsOfPlatformRole(operator.role as PlatformRole),
  };
}

/** Permission enforcement inside a resolved platform context (§13). */
export function requirePlatformPermission(
  ctx: PlatformContext,
  permission: PlatformPermission,
): void {
  if (!canPlatform(ctx.role, permission)) {
    throw platformError(403, "PLATFORM_PERMISSION_DENIED", "Your operator role does not allow this action.", {
      permission,
    });
  }
}

/* ------------------------- reauthentication (§56) ------------------------- */

export const reauthSchema = z.object({
  password: z.string().min(1, "Current password is required.").max(200),
});

/**
 * High-risk mutation gate: verify the CURRENT password against the existing
 * hash. The password is consumed from the parsed body only — it is never
 * logged, never audited, never echoed back.
 */
export async function assertPlatformReauth(
  ctx: PlatformContext,
  password: string | undefined,
): Promise<void> {
  if (!password) {
    throw platformError(403, "PLATFORM_REAUTH_REQUIRED", "Reauthentication with your current password is required.");
  }
  const user = await db.user.findUnique({
    where: { id: ctx.userId },
    select: { passwordHash: true },
  });
  if (!user) {
    throw platformError(401, "PLATFORM_UNAUTHENTICATED", "Sign in to continue.");
  }
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw platformError(403, "PLATFORM_REAUTH_FAILED", "Reauthentication failed — the current password was not correct.");
  }
}
