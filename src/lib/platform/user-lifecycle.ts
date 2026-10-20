import "server-only";
/**
 * Platform user lifecycle — Prompt 62 (§8.3): suspend & reactivate.
 *
 * Laws:
 *  - Reason is MANDATORY (min 10 chars) — validated by the route zod schema;
 *    the actor and timestamp are always recorded (§8.3 + §15.1).
 *  - Suspension NEVER deletes user data (§8.3) — nullable columns only.
 *  - Suspension NEVER targets platform operators (§8.3): the operator
 *    lifecycle is the sanctioned scripts/platform-operator.ts deactivate /
 *    super-admin UI path. This guard also structurally prevents the
 *    "last active super-admin lockout" class (§6.2).
 *  - Self-suspension is denied (§6.2 — no self-inflicted lockout).
 *  - Live sessions die IMMEDIATELY: sessionVersion is bumped, so every JWT
 *    stamped before the suspension fails the freshness gate in
 *    getPlatformContext AND the tenant getAuthContext (§8.3 — an already
 *    authenticated session cannot ride through).
 *  - Re-login is blocked in NextAuth authorize with a FIXED code
 *    (ACCOUNT_SUSPENDED) that is only revealed AFTER a valid password —
 *    no account-enumeration gain (src/lib/auth.ts).
 *  - Repeated requests are SAFE and explicit: 409 with a stable code.
 *  - Every operation is audited (PlatformAuditLog) and the user is notified
 *    through the mandatory notification channel when possible (§8.3).
 *  - Idempotency: all writes are conditional on the current DB state
 *    re-validated inside the mutation (§19.2).
 */
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-helpers";
import { platformAudit } from "./audit";
import { notifyFailSafe } from "@/lib/notifications";
import { recordSecurityEvent, SECURITY_EVENTS } from "@/lib/auth/security-events/service";

export class UserLifecycleError extends ApiError {
  constructor(
    status: number,
    code:
      | "PLATFORM_USER_NOT_FOUND"
      | "PLATFORM_USER_ALREADY_SUSPENDED"
      | "PLATFORM_USER_NOT_SUSPENDED"
      | "PLATFORM_USER_IS_OPERATOR"
      | "PLATFORM_USER_SELF_TARGET",
    message: string,
  ) {
    super(status, code, message);
    this.name = "UserLifecycleError";
  }
}

export const SUSPENSION_REASON_MIN = 10;
export const SUSPENSION_REASON_MAX = 500;

export type SuspendActor = {
  operatorId: string;
  operatorRole: string;
  userId: string;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

export async function suspendUser(params: {
  targetUserId: string;
  reason: string;
  actor: SuspendActor;
}): Promise<{ suspendedAt: Date; sessionVersion: number }> {
  const target = await db.user.findUnique({
    where: { id: params.targetUserId },
    select: {
      id: true,
      email: true,
      sessionVersion: true,
      suspendedAt: true,
      platformOperator: { select: { id: true, active: true, role: true } },
    },
  });
  if (!target) {
    throw new UserLifecycleError(404, "PLATFORM_USER_NOT_FOUND", "User not found.");
  }
  if (target.id === params.actor.userId) {
    throw new UserLifecycleError(
      422,
      "PLATFORM_USER_SELF_TARGET",
      "You cannot suspend your own account.",
    );
  }
  // Operator accounts are managed by the dedicated operator lifecycle —
  // suspending them here would blur two security boundaries (§6.2).
  if (target.platformOperator) {
    throw new UserLifecycleError(
      422,
      "PLATFORM_USER_IS_OPERATOR",
      "Platform operators are managed through the operator lifecycle, not user suspension.",
    );
  }
  if (target.suspendedAt) {
    throw new UserLifecycleError(
      409,
      "PLATFORM_USER_ALREADY_SUSPENDED",
      "This account is already suspended.",
    );
  }

  const now = new Date();
  const reason = params.reason.trim();
  const result = await db.$transaction(async (tx) => {
    // Conditional write — a concurrent suspend/reactivate between the read
    // above and this write makes the update a no-op (verified below, §19.2).
    const updated = await tx.user.updateMany({
      where: { id: target.id, suspendedAt: null },
      data: {
        suspendedAt: now,
        suspensionReason: reason,
        suspendedByOperatorId: params.actor.operatorId,
        sessionVersion: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new UserLifecycleError(
        409,
        "PLATFORM_USER_ALREADY_SUSPENDED",
        "This account was suspended concurrently.",
      );
    }
    await platformAudit(
      {
        operatorId: params.actor.operatorId,
        operatorRole: params.actor.operatorRole,
        action: "platform.user.suspend",
        entityType: "User",
        entityId: target.id,
        targetUserId: target.id,
        reason,
        before: { suspendedAt: null, sessionVersion: target.sessionVersion },
        after: { suspendedAt: now, sessionVersion: target.sessionVersion + 1 },
        requestId: params.actor.requestId ?? null,
        ip: params.actor.ip ?? null,
        userAgent: params.actor.userAgent ?? null,
      },
      tx,
    );
    return { suspendedAt: now, sessionVersion: target.sessionVersion + 1 };
  });

  // Security trail (durable, user-scoped, fixed vocabulary §423) + honest
  // notification. Both are fire-safe: they never roll the suspension back.
  await recordSecurityEvent({
    eventType: SECURITY_EVENTS.accountSuspended,
    userId: target.id,
    success: true,
    reasonCode: "PLATFORM_SUSPENSION",
  });

  await notifyFailSafe({
    userId: target.id,
    type: "SYSTEM_ACCOUNT_SUSPENDED",
    sourceEventId: `platform:suspended:${target.id}:${result.sessionVersion}`,
    data: { reason, suspendedAt: result.suspendedAt.toISOString() },
    requestId: params.actor.requestId ?? null,
  }).catch(() => undefined);

  return result;
}

export async function reactivateUser(params: {
  targetUserId: string;
  reason: string;
  actor: SuspendActor;
}): Promise<{ sessionVersion: number }> {
  const target = await db.user.findUnique({
    where: { id: params.targetUserId },
    select: {
      id: true,
      sessionVersion: true,
      suspendedAt: true,
      suspensionReason: true,
      platformOperator: { select: { id: true } },
    },
  });
  if (!target) {
    throw new UserLifecycleError(404, "PLATFORM_USER_NOT_FOUND", "User not found.");
  }
  if (!target.suspendedAt) {
    throw new UserLifecycleError(
      409,
      "PLATFORM_USER_NOT_SUSPENDED",
      "This account is not suspended.",
    );
  }

  const reason = params.reason.trim();
  const result = await db.$transaction(async (tx) => {
    const updated = await tx.user.updateMany({
      where: { id: target.id, suspendedAt: { not: null } },
      data: {
        suspendedAt: null,
        suspensionReason: null,
        suspendedByOperatorId: null,
        // Fresh version — sessions minted before reactivation stay invalid.
        sessionVersion: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new UserLifecycleError(
        409,
        "PLATFORM_USER_NOT_SUSPENDED",
        "This account was reactivated concurrently.",
      );
    }
    await platformAudit(
      {
        operatorId: params.actor.operatorId,
        operatorRole: params.actor.operatorRole,
        action: "platform.user.reactivate",
        entityType: "User",
        entityId: target.id,
        targetUserId: target.id,
        reason,
        before: { suspendedAt: target.suspendedAt, suspensionReason: target.suspensionReason },
        after: { suspendedAt: null, sessionVersion: target.sessionVersion + 1 },
        requestId: params.actor.requestId ?? null,
        ip: params.actor.ip ?? null,
        userAgent: params.actor.userAgent ?? null,
      },
      tx,
    );
    return { sessionVersion: target.sessionVersion + 1 };
  });

  await recordSecurityEvent({
    eventType: SECURITY_EVENTS.accountReactivated,
    userId: target.id,
    success: true,
    reasonCode: "PLATFORM_REACTIVATION",
  });

  await notifyFailSafe({
    userId: target.id,
    type: "SYSTEM_ACCOUNT_RESTORED",
    sourceEventId: `platform:restored:${target.id}:${result.sessionVersion}`,
    data: { restoredAt: new Date().toISOString() },
    requestId: params.actor.requestId ?? null,
  }).catch(() => undefined);

  return result;
}

/** Login-side block (src/lib/auth.ts calls this before session minting). */
export function isSuspended(user: { suspendedAt: Date | null }): boolean {
  return user.suspendedAt != null;
}

/** Fixed client-visible sign-in code — revealed only AFTER a valid password. */
export const SIGNIN_ERROR_ACCOUNT_SUSPENDED = "ACCOUNT_SUSPENDED";
