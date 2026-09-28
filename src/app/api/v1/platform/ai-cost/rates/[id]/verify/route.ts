/**
 * POST /api/v1/platform/ai-cost/rates/[id]/verify — production verification
 * (§41/§53). verifiedAt is SERVER-generated via the existing service; the
 * client supplies only verifiedBy + sourceReference evidence (§82: a tenant
 * — or anyone else — can never submit verification as authoritative state
 * through any customer surface; this is the ONLY sanctioned path and it is
 * platform:ai-cost:manage gated + reauth + audited).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { route, ApiError } from "@/lib/api-helpers";
import { assertPlatformReauth, getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { parsePlatformBody, platformOk } from "@/lib/platform/http";
import { platformAudit, requestIdOf } from "@/lib/platform/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-helpers";
import { verifyAiCostRate, AiCostRateError } from "@/lib/ai/cost/rates";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  verifiedBy: z.string().trim().min(2).max(128),
  sourceReference: z.string().trim().min(2).max(512),
  reason: z.string().trim().min(3).max(300),
  password: z.string().min(1).max(200).optional(),
});

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:ai-cost:manage");
  const { id } = await params;
  const body = await parsePlatformBody(req, bodySchema);

  const rl = rateLimit(`platform:${ctx.operatorId}:ai-rate-verify`, 10, 15 * 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "PLATFORM_INVALID_OPERATION", "Too many attempts. Try again later.");
  }

  await assertPlatformReauth(ctx, body.password);

  const requestId = requestIdOf(req);
  try {
    const dto = await verifyAiCostRate(
      id,
      { verifiedBy: body.verifiedBy, sourceReference: body.sourceReference },
      { actorId: ctx.userId },
    );
    await platformAudit({
      operatorId: ctx.operatorId,
      operatorRole: ctx.role,
      action: "ai_cost.rate_verified",
      entityType: "AiCostRate",
      entityId: id,
      reason: body.reason,
      after: { provider: dto.provider, model: dto.model, version: dto.version, verifiedBy: body.verifiedBy },
      requestId,
      ip: getClientIp(req),
      userAgent: req.headers.get("user-agent"),
    });
    return platformOk({ verified: true, requestId });
  } catch (error) {
    if (error instanceof AiCostRateError) {
      throw new ApiError(422, "PLATFORM_AI_RATE_INVALID", error.message, { reason: error.code });
    }
    throw error;
  }
});
