/**
 * POST /api/v1/platform/businesses/[id]/subscription/pause (Prompt 28 §25).
 *
 * Entitlement administration through the EXISTING billing service and state
 * machine — a route never mutates the Subscription table directly (§24).
 * Requires platform:subscriptions:manage, a reason, reauthentication
 * (current password) and is rate-limited + audited (§34/§56/§57).
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
import { pauseSubscription, BillingError } from "@/lib/billing";

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

  const rl = rateLimit(`platform:${ctx.operatorId}:subscription-pause`, 10, 15 * 60_000);
  if (!rl.allowed) {
    throw platformError(429, "PLATFORM_INVALID_OPERATION", "Too many attempts. Try again later.");
  }

  await assertPlatformReauth(ctx, body.password);

  const business = await db.business.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!business) throw new BillingError("SUBSCRIPTION_NOT_FOUND", "No subscription exists for this business.");

  const requestId = requestIdOf(req);
  const result = await pauseSubscription(id, {
    actorId: ctx.userId,
    source: "platform-admin",
    reason: body.reason,
  });

  await platformAudit(
    {
      operatorId: ctx.operatorId,
      operatorRole: ctx.role,
      action: "billing.subscription_paused",
      entityType: "Subscription",
      entityId: result.subscription.id,
      targetBusinessId: id,
      reason: body.reason,
      after: {
        status: result.subscription.status,
        planCode: result.subscription.plan.code,
        source: "platform-admin",
      },
      requestId,
      ip: getClientIp(req),
      userAgent: req.headers.get("user-agent"),
    },
  );

  return platformOk({ subscription: result.subscription, changed: result.changed, requestId });
});
