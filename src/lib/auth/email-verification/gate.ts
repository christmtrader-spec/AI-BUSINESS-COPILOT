import "server-only";
import { db } from "@/lib/db";
import { emailVerificationMode } from "@/lib/auth/email-verification/service";

/**
 * REQUIRED-mode gating — Prompt 30 §10/§120/§473.
 *
 * When AUTH_EMAIL_VERIFICATION_MODE=REQUIRED, an UNVERIFIED account is
 * blocked from business-sensitive commercial capabilities:
 *   - business creation (POST /api/v1/businesses),
 *   - trial start (POST /api/v1/billing/trial/start),
 *   - paid checkout (POST /api/v1/billing/checkout).
 *
 * Login and browsing are NEVER blocked (§10/§120); existing business data
 * stays intact (§473); password reset remains usable (§476); invitations
 * are unaffected (§474/§475 — joining an existing business is NOT gated).
 *
 * §11: enforcement happens ONLY when the mode is REQUIRED — the default
 * (OFF) and OPTIONAL never gate anything, so an accidental default can
 * never lock users out (§42/§403).
 */
export async function assertEmailVerifiedForCommercialAction(userId: string): Promise<void> {
  if (emailVerificationMode() !== "REQUIRED") return;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { emailVerifiedAt: true },
  });
  if (user?.emailVerifiedAt == null) {
    const { ApiError } = await import("@/lib/api-helpers");
    throw new ApiError(
      403,
      "EMAIL_VERIFICATION_REQUIRED",
      "Verify your email address before performing this action.",
    );
  }
}
