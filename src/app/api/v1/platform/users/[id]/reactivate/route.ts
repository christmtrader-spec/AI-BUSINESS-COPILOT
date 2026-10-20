/**
 * POST /api/v1/platform/users/[id]/reactivate — Prompt 62 (§8.3).
 *
 * Restores ONLY the suspended capability (§8.3 — no data was deleted, so
 * nothing else to restore). Reason mandatory; reauth required (§56);
 * not-suspended → 409; sessionVersion++ so pre-reactivation sessions stay
 * invalid; audited; user notified.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { route, getClientIp } from "@/lib/api-helpers";
import { assertPlatformReauth, getPlatformContext, platformError, requirePlatformPermission } from "@/lib/platform/auth";
import { parsePlatformBody, platformOk } from "@/lib/platform/http";
import { requestIdOf } from "@/lib/platform/audit";
import { reactivateUser, SUSPENSION_REASON_MAX, SUSPENSION_REASON_MIN } from "@/lib/platform/user-lifecycle";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const reactivateSchema = z.object({
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
  const body = await parsePlatformBody(req, reactivateSchema);

  const rl = rateLimit(`platform:${ctx.operatorId}:user-suspend`, 10, 15 * 60_000);
  if (!rl.allowed) {
    throw platformError(429, "PLATFORM_INVALID_OPERATION", "Too many attempts. Try again later.");
  }

  await assertPlatformReauth(ctx, body.password);

  const requestId = requestIdOf(req);
  const result = await reactivateUser({
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
    user: { id, suspendedAt: null, sessionVersion: result.sessionVersion },
  });
});
