import "server-only";

/**
 * Platform operator invitations — R67 ("admin registration", §9/§61-safe).
 *
 * THE single sanctioned write path for PlatformOperatorInvite. The model:
 * an EXISTING authorized operator (super admin only) mints a single-use,
 * expiring opaque token for a named email + role. The invitee redeems it at
 * #/platform-join/<token> by setting their OWN password.
 *
 * LAWS:
 *  - NO public bootstrap, NO default credentials, NO auto-creation from
 *    tenant requests (§9). Every invite is created by an authenticated
 *    operator with platform:operators:manage + reauth + reason, and every
 *    transition is audited.
 *  - Opaque 48-char token (crypto.randomBytes) — unique lookup, never
 *    guessable; the token NEVER appears in audit payloads, logs, or
 *    analytics (§14 — it IS a credential).
 *  - Token never returned except ONCE, in the create response to the
 *    authorizing operator (same display-once law as recovery codes §60).
 *  - Acceptance binds to the REAL account: if the email already exists the
 *    invitee must prove account control with the CURRENT password; if the
 *    account is new the invitee sets the initial password (password policy
 *    enforced server-side). emailVerifiedAt is set at redemption — the
 *    honest model is "token delivered out-of-band by an operator = mailbox
 *    proof"; documented limitation, no email is sent in this sandbox.
 *  - MFA enforcement is NOT bypassed: a newly minted operator still gets
 *    the per-request platform MFA gate (getPlatformContext) on first
 *    privileged call — fail-closed for policy roles.
 *  - The redemption preview NEVER discloses whether any OTHER email is an
 *    operator; it only describes THIS invite (holder already knows the
 *    email — the inviter chose it).
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { passwordSchema } from "@/lib/auth-security";
import { db } from "@/lib/db";
import { PLATFORM_ROLES, type PlatformRole } from "@/lib/platform/rbac";
import { ApiError } from "@/lib/api-helpers";

/** 72 hours — a bounded window; long enough for onboarding, short enough
 * to limit a leaked link's lifetime. Documented policy (§16). */
export const OPERATOR_INVITE_TTL_MS = 72 * 60 * 60 * 1000;

export const operatorInviteSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(2).max(80),
  role: z.enum(PLATFORM_ROLES),
  reason: z.string().trim().min(3).max(300),
});

export type OperatorInviteInput = z.infer<typeof operatorInviteSchema>;

/** Redemption body — one password for a NEW account, or the CURRENT
 * password for an existing one (both policies enforced server-side). */
export const operatorInviteRedeemSchema = z.object({
  password: z.string().min(1).max(200),
});

export type OperatorInviteRedeemInput = z.infer<typeof operatorInviteRedeemSchema>;

export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * R69 (Prompt 69 §3.4 F1) — raw invitation tokens are NEVER stored.
 * Only this SHA-256 digest is persisted; the unique lookup happens over the
 * digest (same law as PlatformSetupKey.keyHash). A database read (backup,
 * support dump, SQL injection elsewhere) can therefore no longer redeem a
 * PENDING invite — the raw token exists ONLY in the one-time disclosure
 * response and the operator's out-of-band handoff.
 */
export function hashInviteToken(rawToken: string): string {
  return createHash("sha256").update(`platform-invite-v1:${rawToken.trim()}`).digest("hex");
}

export function inviteExpiry(): Date {
  return new Date(Date.now() + OPERATOR_INVITE_TTL_MS);
}

export type InviteStatus = "PENDING" | "ACCEPTED" | "REVOKED" | "EXPIRED";

export function inviteStatusOf(invite: {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}): InviteStatus {
  if (invite.revokedAt !== null) return "REVOKED";
  if (invite.acceptedAt !== null) return "ACCEPTED";
  if (invite.expiresAt.getTime() < Date.now()) return "EXPIRED";
  return "PENDING";
}

/** Invite DTO — NEVER includes the token (§14). */
export function operatorInviteDto(invite: {
  id: string;
  email: string;
  name: string;
  role: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  createdBy: { name: string | null; email: string } | null;
  acceptedUser: { email: string } | null;
}) {
  return {
    id: invite.id,
    email: invite.email,
    name: invite.name,
    role: invite.role as PlatformRole,
    status: inviteStatusOf(invite),
    expiresAt: invite.expiresAt.toISOString(),
    acceptedAt: invite.acceptedAt?.toISOString() ?? null,
    createdAt: invite.createdAt.toISOString(),
    createdBy: invite.createdBy
      ? { name: invite.createdBy.name, email: invite.createdBy.email }
      : null,
    acceptedByAccount: invite.acceptedUser ? { email: invite.acceptedUser.email } : null,
  };
}

/** Anonymous redemption-preview DTO (token-gated). Describes THIS invite
 * only; accountExists binds the form's password semantics. */
export function operatorInvitePreviewDto(invite: {
  email: string;
  name: string;
  role: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdBy: { name: string | null; email: string } | null;
}, accountExists: boolean) {
  return {
    email: invite.email,
    name: invite.name,
    role: invite.role as PlatformRole,
    status: inviteStatusOf(invite),
    expiresAt: invite.expiresAt.toISOString(),
    inviter: invite.createdBy
      ? { name: invite.createdBy.name, email: invite.createdBy.email }
      : null,
    accountExists,
  };
}

/**
 * Atomic single-use redemption claim — PENDING→ACCEPTED inside the same
 * transaction that creates/binds the account + operator row (§10-style
 * exactly-once law: two concurrent redemptions can both read PENDING, but
 * the conditional UPDATE claims the row exactly once and the loser rolls
 * back with a clean 409).
 */
export async function redeemOperatorInvite(
  token: string,
  input: OperatorInviteRedeemInput,
  meta: { ip: string | null; userAgent: string | null },
): Promise<{ userId: string; email: string; operatorId: string; role: PlatformRole; accountCreated: boolean }> {
  return db.$transaction(async (tx) => {
    const invite = await tx.platformOperatorInvite.findUnique({
      where: { tokenHash: hashInviteToken(token) },
      select: {
        id: true, email: true, name: true, role: true, expiresAt: true,
        acceptedAt: true, revokedAt: true,
      },
    });
    if (!invite) {
      throw new ApiError(404, "PLATFORM_INVITE_INVALID", "This invitation link is not valid.");
    }
    if (invite.revokedAt !== null || invite.acceptedAt !== null || invite.expiresAt.getTime() < Date.now()) {
      throw new ApiError(410, "PLATFORM_INVITE_UNAVAILABLE", "This invitation is no longer available.");
    }

    const password = passwordSchema.parse(input.password);
    const bcrypt = (await import("bcryptjs")).default;
    const passwordHash = bcrypt.hashSync(password, 10);

    const existing = await tx.user.findUnique({
      where: { email: invite.email },
      select: { id: true, passwordHash: true, emailVerifiedAt: true },
    });

    let userId: string;
    let accountCreated = false;

    if (existing) {
      // Account exists: the invitee must prove account control with the
      // CURRENT password (§56-style binding — never reset someone's password
      // via an invite token).
      const valid = await bcrypt.compare(password, existing.passwordHash);
      if (!valid) {
        throw new ApiError(403, "PLATFORM_INVITE_PASSWORD_MISMATCH", "The current password for this account is not correct.");
      }
      userId = existing.id;
      if (!existing.emailVerifiedAt) {
        await tx.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
      }
    } else {
      // New account: the invitee sets the initial password (policy-parsed
      // above). The out-of-band token delivered by the operator is the
      // mailbox proof (documented limitation — no email in this sandbox).
      const created = await tx.user.create({
        data: {
          email: invite.email,
          name: invite.name,
          passwordHash,
          emailVerifiedAt: new Date(),
        },
        select: { id: true },
      });
      userId = created.id;
      accountCreated = true;
    }

    const existingOperator = await tx.platformOperator.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (existingOperator) {
      // Keep the invite PENDING — the admin can revoke it; never silently
      // double-grant or fake-accept.
      throw new ApiError(409, "PLATFORM_INVALID_OPERATION", "This account already has an operator record.");
    }

    let operator: { id: string };
    try {
      operator = await tx.platformOperator.create({
        data: { userId, role: invite.role, active: true },
        select: { id: true },
      });
    } catch (err) {
      // Concurrent redemption lost the userId unique race — a clean 409
      // instead of a raw P2002 500 (§86 — no driver text leaks).
      if (
        typeof err === "object" && err !== null && "code" in err &&
        (err as { code?: string }).code === "P2002"
      ) {
        throw new ApiError(409, "PLATFORM_INVALID_OPERATION", "This invitation was just redeemed from another session.");
      }
      throw err;
    }

    // Atomic exactly-once claim: only succeeds while still PENDING.
    const claimed = await tx.platformOperatorInvite.updateMany({
      where: { id: invite.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { acceptedAt: new Date(), acceptedUserId: userId },
    });
    if (claimed.count !== 1) {
      throw new ApiError(409, "PLATFORM_INVALID_OPERATION", "This invitation was just redeemed from another session.");
    }

    return { userId, email: invite.email, operatorId: operator.id, role: invite.role as PlatformRole, accountCreated };
  });
}
