/**
 * POST /api/v1/platform/businesses/[id]/trial — operator trial operations
 * (Prompt 28 §29). ONLY the existing startTrial()/endTrial() services are
 * reachable; the one-trial rule, the configured duration and the state
 * machine are enforced INSIDE those services — nothing here bypasses them.
 * The trial duration always comes from the current configuration (never
 * from the request); trials disabled by config are reported honestly.
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
import { startTrial, endTrial, getTrialConfig, BillingError } from "@/lib/billing";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  action: z.enum(["start", "end"]),
  reason: z.string().trim().min(3).max(300),
  password: z.string().min(1).max(200).optional(),
});

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:subscriptions:manage");
  const { id } = await params;
  const body = await parsePlatformBody(req, bodySchema);

  const rl = rateLimit(`platform:${ctx.operatorId}:subscription-trial`, 10, 15 * 60_000);
  if (!rl.allowed) {
    throw platformError(429, "PLATFORM_INVALID_OPERATION", "Too many attempts. Try again later.");
  }

  await assertPlatformReauth(ctx, body.password);

  const business = await db.business.findUnique({ where: { id }, select: { id: true } });
  if (!business) throw new BillingError("SUBSCRIPTION_NOT_FOUND", "No subscription exists for this business.");

  const requestId = requestIdOf(req);
  let result;
  let auditAction: string;
  if (body.action === "start") {
    // Current policy: the configured trial plan/duration — never request data.
    const cfg = getTrialConfig();
    if (!cfg.enabled || cfg.trialDays == null) {
      throw new BillingError("TRIAL_DISABLED", "Trials are not available.", {
        reasons: cfg.reasons,
      });
    }
    result = await startTrial(id, cfg.trialDays, { actorId: ctx.userId, source: "platform-admin" });
    auditAction = "billing.trial_started";
  } else {
    result = await endTrial(id, { actorId: ctx.userId });
    auditAction = "billing.trial_ended";
  }

  await platformAudit({
    operatorId: ctx.operatorId,
    operatorRole: ctx.role,
    action: auditAction,
    entityType: "Subscription",
    entityId: result.subscription.id,
    targetBusinessId: id,
    reason: body.reason,
    after: {
      status: result.subscription.status,
      trialStart: result.subscription.trialStart,
      trialEnd: result.subscription.trialEnd,
      source: "platform-admin",
    },
    requestId,
    ip: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });

  return platformOk({ subscription: result.subscription, changed: result.changed, requestId });
});
