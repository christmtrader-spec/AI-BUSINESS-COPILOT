/**
 * POST /api/v1/platform/users/[id]/suspend — Prompt 62 (§8.3).
 *
 * Guards (all server-side, deny-by-default):
 *  - permission platform:users:suspend (SUPPORT / SECURITY / SUPER only)
 *  - reauthentication with the operator's CURRENT password (§56)
 *  - reason MANDATORY (10..500 chars)
 *  - self-suspension denied; platform operators NOT targetable (their
 *    lifecycle is the operator deactivate path — prevents admin lockout)
 *  - already-suspended → 409 (explicit, safe repeats)
 * Effects: sessionVersion++ (all live JWTs die), SecurityEvent, mandatory
 * notification to the user, audited with reason + before/after.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { route, getClientIp } from "@/lib/api-helpers";
import { assertPlatformReauth, getPlatformContext, platformError, requirePlatformPermission } from "@/lib/platform/auth";
import { parsePlatformBody, platformOk } from "@/lib/platform/http";
import { requestIdOf } from "@/lib/platform/audit";
import { suspendUser, SUSPENSION_REASON_MAX, SUSPENSION_REASON_MIN } from "@/lib/platform/user-lifecycle";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const suspendSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(SUSPENSION_REASON_MIN, `A reason of at least ${SUSPENSION_REASON_MIN} characters is required.`)
    .max(SUSPENSION_REASON_MAX),
  password: z.string().min(1).max(200).optional(),
});

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:users:suspend");

  const { id } = await params;
  const body = await parsePlatformBody(req, suspendSchema);

  const rl = rateLimit(`platform:${ctx.operatorId}:user-suspend`, 10, 15 * 60_000);
  if (!rl.allowed) {
    throw platformError(429, "PLATFORM_INVALID_OPERATION", "Too many attempts. Try again later.");
  }

  // High-risk mutation — current-password reauthentication (§56).
  await assertPlatformReauth(ctx, body.password);

  const requestId = requestIdOf(req);
  const result = await suspendUser({
    targetUserId: id,
    reason: body.reason,
    actor: {
      operatorId: ctx.operatorId,
      operatorRole: ctx.role,
      userId: ctx.userId,
      requestId,
      ip: getClientIp(req),
      userAgent: req.headers.get("user-agent"),
    },
  });

  return platformOk({
    user: { id, suspendedAt: result.suspendedAt.toISOString(), sessionVersion: result.sessionVersion },
  });
});
