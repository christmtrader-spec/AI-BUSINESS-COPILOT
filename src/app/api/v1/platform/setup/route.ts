/**
 * /api/v1/platform/setup — R68 cold-start gate (first operator ONLY).
 *
 * GET  — status: is the platform still in the zero-operator setup window?
 * POST — activate: redeem a single-use offline-minted setup key; the calling
 *        session's EXISTING account becomes the first PLATFORM_SUPER_ADMIN.
 *
 * WHY this is §9-compliant (no public bootstrap / no default credentials):
 *  - Both calls require a LIVE authenticated session (getPlatformSessionUser:
 *    session → user → sessionVersion → per-device registry — the SAME
 *    session-side chain as every platform route, §81).
 *  - POST additionally requires the raw setup key, which is minted ONLY by
 *    the offline CLI (scripts/platform-setup-key.ts) — NEVER over HTTP — and
 *    is single-use, expiring, hashed-at-rest, display-once.
 *  - The window self-disables FOREVER once any operator exists (re-checked
 *    server-side on every call and inside the redemption transaction).
 *  - Every attempt (success or failure) lands in the fixed-vocabulary
 *    SecurityEvent feed + platform audit; the raw key NEVER enters any
 *    payload (§14/§90).
 *
 * prompt28 static-scan documented exception (R68): this route is
 * PRE-operator by definition — it gates on the session chain
 * (getPlatformSessionUser), NOT on getPlatformContext, exactly like the R67
 * anonymous-with-token invite redemption route.
 */
import { NextRequest } from "next/server";
import { route, ApiError, ok, getClientIp } from "@/lib/api-helpers";
import { parsePlatformBody } from "@/lib/platform/http";
import { rateLimit } from "@/lib/rate-limit";
import { getPlatformSessionUser } from "@/lib/platform/auth";
import {
  activateSetupKey,
  isPlatformSetupRequired,
  setupKeyRedeemSchema,
} from "@/lib/platform/setup";

export const dynamic = "force-dynamic";

function throwRateLimited(): never {
  throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Please wait and try again.");
}

/** 10 attempts / 15 min per IP+user — bounds key guessing (§141). */
function setupRateLimit(req: NextRequest, userId: string) {
  const ip = getClientIp(req);
  return rateLimit(`platform-setup:${ip ?? "unknown"}:${userId}`, 10, 15 * 60_000);
}

export const GET = route(async (req: NextRequest) => {
  const { userId } = await getPlatformSessionUser();
  const rl = setupRateLimit(req, userId);
  if (!rl.allowed) throwRateLimited();
  // Honest boolean only — nothing about keys, emails, or operator identity.
  return ok({ setupRequired: await isPlatformSetupRequired() });
});

export const POST = route(async (req: NextRequest) => {
  const { userId, email } = await getPlatformSessionUser();
  const rl = setupRateLimit(req, userId);
  if (!rl.allowed) throwRateLimited();

  const body = await parsePlatformBody(req, setupKeyRedeemSchema);
  const ip = getClientIp(req);
  const ua = req.headers.get("user-agent");

  const result = await activateSetupKey({
    key: body.key,
    userId,
    email,
    ip,
    userAgent: ua,
  });

  return ok({
    activated: true,
    role: result.role,
    // The console still fail-closes on MFA for policy roles (R65 §6.2) —
    // the client is told the honest next step.
    next: "mfa-enrollment" as const,
  });
});
