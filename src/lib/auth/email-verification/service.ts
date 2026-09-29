import "server-only";
import { db } from "@/lib/db";
import { EMAIL_VERIFICATION_TTL_MINUTES, emailVerificationMode, type EmailVerificationMode } from "@/lib/auth/config";
import { appBaseUrl, generateResetToken, hashResetToken } from "@/lib/auth-security";
import { isPlausibleEmailVerificationToken } from "./token-format";

/**
 * Email-verification service — Prompt 30 §4-§26, §130-§132, §221-§222.
 *
 * PURPOSE SEPARATION (§314/§315): verification tokens and password-reset
 * tokens are separate MODELS and separate flows. A verification token can
 * NEVER reset a password; a reset token can NEVER verify an email. The
 * token generator/hash helpers are REUSED (identical crypto properties:
 * 32 random bytes, base64url, SHA-256-at-rest) but the models never mix.
 *
 * Token law: the raw token exists ONLY inside the emailed link; the DB
 * stores SHA-256(tokenHash); tokens are never logged, never returned from
 * APIs after the initial send (§5/§18).
 *
 * TTL (§6): EMAIL_VERIFICATION_TTL_MINUTES (30) — single authority.
 *
 * Single active token (§7): issuing a new token invalidates all prior
 * outstanding tokens for the user — no unlimited buildup.
 *
 * Send-before-persist (§12/§13/§221/§222): the token row is created ONLY
 * after provider.send() resolves. If persistence fails AFTER a successful
 * send, the honest outcome is a FAILED state (never a usable-looking
 * success) — documented in docs/security/email-verification.md §222.
 *
 * Claim race (§19): conditional updateMany on usedAt IS NULL — exactly one
 * concurrent confirmation wins.
 *
 * Enumeration (§20/§22/§281): confirm is anonymous but generic; resend and
 * status are authenticated-only; no public per-email endpoint exists.
 */

export { EMAIL_VERIFICATION_TTL_MINUTES, emailVerificationMode };

export { isPlausibleEmailVerificationToken } from "./token-format";

/**
 * Build the verification link from CONFIGURED base URL only — never from
 * the request Host (§17, same law as the reset link builder).
 */
export function buildEmailVerificationLink(rawToken: string): string {
  return `${appBaseUrl()}/#/verify-email/${rawToken}`;
}

/**
 * Opportunistic bounded cleanup (§132): this user's dead tokens + globally
 * expired tokens. Never a full-table scan on hot paths — invoked from the
 * same rate-limited flows that issue/confirm tokens.
 */
export async function cleanupEmailVerificationTokens(userId?: string): Promise<void> {
  const now = new Date();
  if (userId) {
    await db.emailVerificationToken.deleteMany({
      where: { userId, OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }] },
    });
  }
  await db.emailVerificationToken.deleteMany({ where: { expiresAt: { lt: now } } });
}

/**
 * Invalidate any outstanding tokens for the user (§7) — called before a
 * fresh token is issued so at most ONE active link exists at a time.
 */
export async function invalidateOutstandingTokens(userId: string): Promise<void> {
  await db.emailVerificationToken.deleteMany({ where: { userId, usedAt: null } });
}

export type IssueTokenInput = {
  userId: string;
  /** Pre-generated raw token — the caller SENDS it first (send-before-
   * persist, §12) and passes the SAME value here so the persisted hash
   * matches the emailed link exactly. */
  rawToken: string;
  ip: string | null;
  userAgent: string | null;
};

export type IssuedToken = {
  tokenHash: string;
  expiresAt: Date;
};

/**
 * Persist a verification token AFTER the caller's send resolved (§12).
 * Invalidates outstanding tokens first (§7) so at most ONE active link
 * exists at a time. The raw token is never logged (§5/§18).
 */
export async function issueEmailVerificationToken(
  input: IssueTokenInput,
): Promise<IssuedToken> {
  await invalidateOutstandingTokens(input.userId);
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MINUTES * 60_000);
  const tokenHash = hashResetToken(input.rawToken);
  await db.emailVerificationToken.create({
    data: {
      userId: input.userId,
      tokenHash,
      expiresAt,
      requestedIp: input.ip,
      userAgent: input.userAgent?.slice(0, 255) ?? null,
    },
    select: { id: true },
  });
  return { tokenHash, expiresAt };
}

export type ConfirmOutcome =
  | "VERIFIED"
  | "ALREADY_VERIFIED_NO_TOKEN"
  | "INVALID_OR_EXPIRED";

/**
 * Atomic token claim (§18/§19/§20): format gate → hash → single-use claim
 * → emailVerifiedAt. Exactly one concurrent confirmation wins (§19).
 * Repeated verification of an already-verified account with a VALID unused
 * token still claims it and reports VERIFIED (idempotent, §20).
 */
export async function confirmEmailVerificationToken(rawToken: string): Promise<ConfirmOutcome> {
  if (!isPlausibleEmailVerificationToken(rawToken)) return "INVALID_OR_EXPIRED";
  const tokenHash = hashResetToken(rawToken);
  const now = new Date();

  const token = await db.emailVerificationToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true },
  });
  if (!token) return "INVALID_OR_EXPIRED";

  // Atomic single-use claim (§19) — updateMany on usedAt IS NULL.
  const claimed = await db.emailVerificationToken.updateMany({
    where: { id: token.id, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });
  if (claimed.count !== 1) return "INVALID_OR_EXPIRED"; // used or expired — generic (§20/§282)

  const user = await db.user.findUnique({
    where: { id: token.userId },
    select: { id: true, emailVerifiedAt: true },
  });
  if (!user) return "INVALID_OR_EXPIRED"; // deleted account — generic

  if (user.emailVerifiedAt === null) {
    await db.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: now },
      select: { id: true },
    });
    return "VERIFIED";
  }
  // Already verified (e.g. double-click / second tab) — safe idempotent
  // outcome; the token itself is now consumed (§20).
  return "ALREADY_VERIFIED_NO_TOKEN";
}
