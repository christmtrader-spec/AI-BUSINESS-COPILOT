/**
 * POST /api/v1/me/security/mfa/setup/start — begin TOTP enrollment
 * (Prompt 30 §37 steps 1-5, §39/§40/§106, §162).
 *
 * Authorization: authenticated + FRESH session + RECENT password auth
 * (§162 — requireRecentPasswordAuth via the reauth endpoint).
 *
 * Semantics:
 *  - MFA capability must be enabled for the deployment (§184) and the
 *    encryption key must be valid (§34/§190) — else MFA_NOT_CONFIGURED.
 *  - An ALREADY ENABLED credential → MFA_ALREADY_ENABLED (no silent
 *    overwrite of a live secret — §67).
 *  - The pending credential is UPSERTED (enabledAt stays NULL — never
 *    trusted by login, §38); a previous abandoned setup secret is replaced
 *    (§106 — no permanently usable abandoned secret; the old envelope dies
 *    here) and stale pending rows are pruned by scripts/prune-auth-security.
 *  - Response returns the otpauth URI, a manual key (§42) and a QR PNG
 *    data URI — ONCE, over an authenticated response (§40). NEVER logged
 *    (§105/§253), never placed in a URL.
 */
import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { ApiError, getClientIp, ok, route } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertFreshSession } from "@/lib/auth-security";
import { rateLimit } from "@/lib/rate-limit";
import {
  assertMfaFeatureAvailable,
  assertMfaKeyConfigured,
  buildProvisioningUri,
  generateTotpSecret,
} from "@/lib/auth/mfa/service";
import { encryptSecret } from "@/lib/security/secret-box";
import { requireRecentPasswordAuth, StepUpError } from "@/lib/auth/step-up";
import { SECURITY_EVENTS, recordSecurityEvent } from "@/lib/auth/security-events/service";
import QRCode from "qrcode";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest) => {
  const session = await getServerSession(authOptions);
  const userId = await assertFreshSession(session);
  const ip = getClientIp(req);

  const rl = rateLimit(`mfa-setup:${userId}:${ip}`, 5, 15 * 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "MFA_RATE_LIMITED", "Too many attempts. Please wait a moment.");
  }

  // §184/§34/§190 — capability + key gates (fail closed, value-free).
  assertMfaFeatureAvailable();
  assertMfaKeyConfigured();

  // §162 — recent password authentication (server-authoritative, §116).
  try {
    await requireRecentPasswordAuth(userId);
  } catch (error) {
    if (error instanceof StepUpError) {
      throw new ApiError(403, "MFA_REAUTH_REQUIRED", "Please confirm your password to continue.");
    }
    throw error;
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true },
  });
  if (!user) {
    throw new ApiError(401, "SESSION_INVALIDATED", "This session is no longer valid. Please sign in again.");
  }

  const existing = await db.mfaCredential.findUnique({
    where: { userId },
    select: { enabledAt: true },
  });
  if (existing?.enabledAt != null) {
    throw new ApiError(409, "MFA_ALREADY_ENABLED", "Two-factor authentication is already enabled. Disable it first to re-enroll.");
  }

  // §31 — fresh cryptographically random secret (never derived from
  // email/userId/password/time).
  const secretBase32 = generateTotpSecret();
  const otpauthUri = buildProvisioningUri(secretBase32, user.email);
  // §41/§287 — QR as a self-contained PNG data URI rendered client-side in
  // an <img>; no third-party QR service, no CSP changes, nothing logged.
  const qrDataUri = await QRCode.toDataURL(otpauthUri, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 220,
  });
  const encryptedSecret = encryptSecret(secretBase32);

  // §106/§213 — upsert the PENDING credential (enabledAt stays NULL).
  // userId-unique guarantees a single credential row (§213).
  await db.mfaCredential.upsert({
    where: { userId },
    create: {
      userId,
      encryptedSecret,
      secretVersion: 1,
      enabledAt: null,
    },
    update: {
      encryptedSecret,
      secretVersion: 1,
      enabledAt: null,
      lastUsedTotpStep: null,
    },
    select: { id: true },
  });

  await recordSecurityEvent({
    eventType: SECURITY_EVENTS.mfaEnrollmentStarted,
    userId,
    success: true,
    ip,
    userAgent: req.headers.get("user-agent"),
  });

  // §40 — the secret (via otpauth URI + manual key + QR) is returned ONCE.
  return ok({
    otpauthUri,
    manualKey: secretBase32,
    qrDataUri,
  });
});
