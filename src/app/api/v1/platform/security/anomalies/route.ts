/**
 * GET /api/v1/platform/security/anomalies — failed-login burst detail (R64).
 *
 * The identity-bearing companion of the Security Center summary: WHERE the
 * summary keeps its COUNT-only law, this endpoint names the burst buckets
 * (emails / hashed-IP prefixes) so a SECURITY operator can act. Every
 * identity here is already visible in the events feed under the SAME
 * permission — this is aggregation of visible data, never an escalation.
 *
 * Guards: session → sessionVersion → operator-active → platform:security:read
 * → per-operator rate limit → bounded groupBy window.
 */
import { NextRequest } from "next/server";
import { route } from "@/lib/api-helpers";
import { getPlatformContext, platformError, requirePlatformPermission } from "@/lib/platform/auth";
import { platformOk } from "@/lib/platform/http";
import { computeFailedLoginBursts } from "@/lib/platform/security-anomalies";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:security:read");

  const rl = rateLimit(`platform:${ctx.operatorId}:security-read`, 60, 60_000);
  if (!rl.allowed) {
    throw platformError(429, "PLATFORM_INVALID_OPERATION", "Too many requests. Try again later.");
  }

  const bursts = await computeFailedLoginBursts();
  return platformOk(bursts);
});
