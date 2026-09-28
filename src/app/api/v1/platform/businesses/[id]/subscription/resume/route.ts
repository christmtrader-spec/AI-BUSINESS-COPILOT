/**
 * POST /api/v1/platform/businesses/[id]/subscription/resume (Prompt 28 §26).
 * PAUSED → ACTIVE through the existing state machine + service. Same
 * authorization/audit law as pause. Entitlement cache is invalidated
 * inside the service.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { route } from "@/lib/api-helpers";
import { assertPlatformReauth, getPlatformContext, platformError, requirePlatformPermission } from "@/lib/platform/auth";
import { parsePlatformBody, platformOk } from "@/lib/platform/http";
import { platformAudit, requestIdOf } from "@/lib/platform/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { resumePausedSubscription, BillingError } from "@/lib/billing";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  reason: z.string().trim().min(3).max(300),
  password: z.string().min(1).max(200).optional(),
});

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:subscriptions:manage");
  const { id } = await params;
  const body = await parsePlatformBody(req, bodySchema);

  const rl = rateLimit(`platform:${ctx.operatorId}:subscription-resume`, 10, 15 * 60_000);
  if (!rl.allowed) {
    throw platformError(429, "PLATFORM_INVALID_OPERATION", "Too many attempts. Try again later.");
  }

  await assertPlatformReauth(ctx, body.password);

  const business = await db.business.findUnique({ where: { id }, select: { id: true } });
  if (!business) throw new BillingError("SUBSCRIPTION_NOT_FOUND", "No subscription exists for this business.");

  const requestId = requestIdOf(req);
  const result = await resumePausedSubscription(id, {
    actorId: ctx.userId,
    source: "platform-admin",
    reason: body.reason,
  });

  await platformAudit({
    operatorId: ctx.operatorId,
    operatorRole: ctx.role,
    action: "billing.subscription_resumed",
    entityType: "Subscription",
    entityId: result.subscription.id,
    targetBusinessId: id,
    reason: body.reason,
    after: { status: result.subscription.status, source: "platform-admin" },
    requestId,
    ip: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });

  return platformOk({ subscription: result.subscription, changed: result.changed, requestId });
});
