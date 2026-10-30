/**
 * GET   /api/v1/me — caller profile.
 * PATCH /api/v1/me — update profile (name, locale preference).
 * DELETE /api/v1/me — delete the account (Prompt 18 §17/§18).
 *
 * Account-scoped routes enforce the session-version freshness gate
 * (assertFreshSession): a JWT stamped before a password change/reset is
 * rejected here as well as on business APIs.
 *
 * User-vs-business law (§19): the USER row and user-private data (profile,
 * password, chat transcripts, memberships, reset tokens) are deleted;
 * BUSINESS-owned data is never touched. The user may NOT delete the account
 * while they still OWN a business — ownership must be resolved first via the
 * existing OWNER-only business-deletion flow, so Business.ownerId can never
 * dangle and a business shared with other members is never silently
 * destroyed. Non-owner memberships disappear with the user
 * (BusinessMember.userId cascade) and their businesses continue to exist.
 *
 * Session law (§16C): the User row is gone — every existing JWT resolves to
 * a missing user and fails the next checkpoint: all sessions are dead
 * immediately after deletion.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getServerSession } from "next-auth";
import { ApiError, getClientIp, ok, parseBody, route } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { assertFreshSession } from "@/lib/auth-security";

export const dynamic = "force-dynamic";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  locale: z.enum(["en", "fa"]).optional(),
  /** R108 (restored R136) — the user-level welcome-checklist dismissal.
   *  The request carries the BOOLEAN; the response carries the TIMESTAMP
   *  (checklistDismissedAt: ISO instant or null). Idempotent both ways;
   *  a non-boolean is a 422 VALIDATION_ERROR (the envelope law). */
  checklistDismissed: z.boolean().optional(),
});

const deleteSchema = z.object({
  password: z.string().min(1).max(200),
  /** Explicit typed confirmation phrase (destructive action, §31). */
  confirmation: z.literal("DELETE"),
  /** Prompt 30 §147 — REQUIRED when the account has MFA enabled: proves
   * the current TOTP factor. The legacy schema stays compatible (optional). */
  mfaCode: z.string().trim().min(6).max(12).optional(),
});

export const GET = route(async () => {
  const session = await getServerSession(authOptions);
  const userId = await assertFreshSession(session);

  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      locale: true,
      createdAt: true,
      checklistDismissedAt: true,
    },
  });
  if (!user) throw new ApiError(404, "NOT_FOUND", "Account not found.");

  return ok(user);
});

export const PATCH = route(async (req: NextRequest) => {
  const session = await getServerSession(authOptions);
  const userId = await assertFreshSession(session);

  const input = await parseBody(req, updateSchema);

  const user = await db.user.update({
    where: { id: userId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      ...(input.checklistDismissed !== undefined
        ? { checklistDismissedAt: input.checklistDismissed ? new Date() : null }
        : {}),
    },
    select: {
      id: true,
      name: true,
      email: true,
      locale: true,
      createdAt: true,
      checklistDismissedAt: true,
    },
  });

  return ok(user);
});

export const DELETE = route(async (req: NextRequest) => {
  const session = await getServerSession(authOptions);
  const userId = await assertFreshSession(session);

  // Bound attempts on the password check (destructive action).
  const rl = rateLimit(`account-delete:${userId}:${getClientIp(req)}`, 5, 15 * 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Please wait a moment.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const input = await parseBody(req, deleteSchema);

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, passwordHash: true },
  });
  if (!user) {
    throw new ApiError(401, "SESSION_INVALIDATED", "This session is no longer valid. Please sign in again.");
  }

  const passwordOk = await bcrypt.compare(input.password, user.passwordHash);
  if (!passwordOk) {
    throw new ApiError(400, "INVALID_CURRENT_PASSWORD", "The password is incorrect.");
  }

  // Prompt 30 §147/§471 — MFA-enabled accounts need the current TOTP factor
  // for deletion. The existing checks are NOT weakened: password + typed
  // DELETE remain mandatory. (Recovery codes are NOT accepted here — §318:
  // the documented recovery path for a lost device is disable-MFA first.)
  const mfaCredential = await db.mfaCredential.findUnique({
    where: { userId },
    select: { id: true, enabledAt: true, encryptedSecret: true },
  });
  if (mfaCredential?.enabledAt != null) {
    if (!input.mfaCode) {
      throw new ApiError(400, "MFA_CODE_REQUIRED", "Enter your authentication code to delete the account.");
    }
    const { verifyMfaCodeForCredential } = await import("@/lib/auth/mfa/service");
    const result = await verifyMfaCodeForCredential(
      {
        id: mfaCredential.id,
        userId,
        encryptedSecret: mfaCredential.encryptedSecret,
        enabledAt: mfaCredential.enabledAt,
        lastUsedTotpStep: null,
      },
      input.mfaCode,
      { enforceReplay: false },
    );
    if (!result.ok) {
      throw new ApiError(400, "MFA_INVALID_CODE", "Invalid authentication code.");
    }
  }

  // §18.8-10 — ownership constraint: resolve BEFORE destroying anything.
  const owned = await db.business.findMany({
    where: { ownerId: userId },
    select: { id: true, name: true, _count: { select: { members: true } } },
  });
  if (owned.length > 0) {
    throw new ApiError(
      409,
      "OWNED_BUSINESS_BLOCKED",
      "You still own a business. Delete the business first (Settings → Business → Danger zone) before deleting your account — ownership cannot be orphaned.",
      {
        ownedBusinesses: owned.map((b) => ({ id: b.id, name: b.name, members: b._count.members })),
      },
    );
  }

  await db.$transaction(async (tx) => {
    await audit(
      {
        businessId: null,
        actorId: userId,
        action: "auth.account_deleted",
        entityType: "User",
        entityId: userId,
        after: {
          // Safe metadata only — no password, no tokens.
          membershipsRemoved: true,
        },
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
    await tx.user.delete({ where: { id: userId } });
  });

  // §472 — cascade removes UserSession/MFA/recovery/challenge/verification
  // and SecurityEvent rows (schema onDelete: Cascade, documented §295).

  return ok({ deleted: true, sessionsInvalidated: true });
});
