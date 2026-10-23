/**
 * GET /api/v1/platform/self — operator capability probe (Prompt 28 §16).
 *
 * The ONLY platform endpoint the app calls for EVERY authenticated user
 * (once, after sign-in) to decide whether the platform console exists for
 * this session. Tenants get 403 — the UI then hides every platform entry
 * and never prefetches platform APIs (§16). Direct hash navigation to
 * #/platform/* without this row shows the not-authorized state.
 */
import { NextRequest } from "next/server";
import { route } from "@/lib/api-helpers";
import { getPlatformContext, platformError } from "@/lib/platform/auth";
import { platformOk } from "@/lib/platform/http";
import { userHasMfaEnabled } from "@/lib/auth/mfa/service";

export const dynamic = "force-dynamic";

export const GET = route(async (_req: NextRequest) => {
  try {
    const ctx = await getPlatformContext();
    // R65 (Prompt 65 §5.1/§6.2) — the shell needs the operator's identity
    // and MFA status (identity display + security chip + enrollment CTA).
    // mfaEnabled is the operator's OWN status, served to THEM only.
    const mfaEnabled = await userHasMfaEnabled(ctx.userId);
    return platformOk({
      isOperator: true,
      operatorId: ctx.operatorId,
      email: ctx.email,
      role: ctx.role,
      permissions: ctx.permissions,
      mfaEnabled,
    });
  } catch (error) {
    // Normalize every auth failure to a single 403 shape here: the probe's
    // job is a boolean answer, not error education. A session-invalidated
    // token still surfaces its own code so the client can re-authenticate.
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code: string }).code
        : null;
    if (
      code === "SESSION_INVALIDATED" ||
      code === "SESSION_REVOKED" || // R64 — per-device registry gate now enforced platform-side too
      code === "PLATFORM_UNAUTHENTICATED" ||
      code === "PLATFORM_MFA_REQUIRED" // R65 — surfaced honestly so the UI can offer enrollment (own-status only; tenants without an operator row still get the generic 403)
    ) {
      throw error;
    }
    throw platformError(403, "PLATFORM_FORBIDDEN", "You do not have platform access.");
  }
});
