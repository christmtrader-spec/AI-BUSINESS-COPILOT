/**
 * POST /api/v1/imports/[jobId]/commit — the ONE mutating step
 * (Prompt 31 §91/§92/§93/§102/§277/§279/§281).
 *
 * SECURITY CHAIN (all re-checked at commit time):
 *  1. Authenticated session + live membership (getAuthContext).
 *  2. OWNER/ADMIN role, re-read NOW (§277 — a role change blocks commit).
 *  3. Step-up: recent password authentication; when the account has MFA
 *     enabled, a recent strong (password + MFA) verification (§93/§279).
 *     The server alone decides recency via SecurityEvent (§116).
 *  4. Typed confirmation "IMPORT DATA" (§92/§281).
 *  5. Fresh file checksum + fresh validation + fresh duplicates inside the
 *     commit transaction (§309/§311) — ALL_OR_NOTHING (§95).
 *  6. Idempotency via the server-side commit token (§102/§163/§374).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, getClientIp, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { assertFreshSession } from "@/lib/auth-security";
import { requireRecentPasswordAuth, requireRecentStrongAuth, accountRequiresMfaFactor, StepUpError } from "@/lib/auth/step-up";
import { commitImportJob, assertImportRole } from "@/lib/data-portability/import-service";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  confirmation: z.literal("IMPORT DATA"),
});

export const POST = route(async (req: NextRequest, params: { params: Promise<{ jobId: string }> }) => {
  const ctx = await getAuthContext(req);
  assertImportRole(ctx); // §277 — re-check NOW (fresh from getAuthContext)
  const { jobId } = await params.params;
  if (!/^[a-z0-9]{20,40}$/i.test(jobId)) {
    throw new ApiError(404, "IMPORT_NOT_FOUND", "Import job not found.");
  }

  const limit = rateLimit(`imports-commit:${ctx.businessId}:${ctx.userId}:${getClientIp(req)}`, 10, 60 * 60_000);
  if (!limit.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many commit attempts. Please wait a few minutes.");
  }

  const body = await parseBody(req, bodySchema);
  void body; // schema gate only — the literal is the confirmation (§92)

  // §93/§278/§279 — step-up with the SAME sanctioned step-up service every
  // other high-risk flow uses (no bespoke auth checks).
  const session = await getServerSession(authOptions);
  await assertFreshSession(session);
  try {
    if (await accountRequiresMfaFactor(ctx.userId)) {
      await requireRecentStrongAuth(ctx.userId);
    } else {
      await requireRecentPasswordAuth(ctx.userId);
    }
  } catch (error) {
    if (error instanceof StepUpError) {
      throw new ApiError(
        401,
        error.code === "INVALID_CURRENT_PASSWORD" ? "INVALID_CURRENT_PASSWORD" : "STEP_UP_REQUIRED",
        "Confirm your identity (Settings → Security → Verify it's you) before importing.",
      );
    }
    throw error;
  }

  const result = await commitImportJob(ctx, jobId, { confirmation: "IMPORT DATA" }, { requestId: req.headers.get("x-request-id") ?? "" });
  return ok(result);
});
