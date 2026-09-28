/**
 * POST /api/v1/platform/ai-cost/rates/[id]/deactivate — (§40/§44).
 * A USED RATE IS NEVER DELETED — only deactivated; historical AiCostRecord
 * snapshots stay intact. platform:ai-cost:manage + reauth + audit (§53).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { route, ApiError } from "@/lib/api-helpers";
import { assertPlatformReauth, getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { parsePlatformBody, platformOk } from "@/lib/platform/http";
import { platformAudit, requestIdOf } from "@/lib/platform/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-helpers";
import { deactivateAiCostRate, AiCostRateError } from "@/lib/ai/cost/rates";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  reason: z.string().trim().min(3).max(300),
  password: z.string().min(1).max(200).optional(),
});

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:ai-cost:manage");
  const { id } = await params;
  const body = await parsePlatformBody(req, bodySchema);

  const rl = rateLimit(`platform:${ctx.operatorId}:ai-rate-deactivate`, 10, 15 * 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "PLATFORM_INVALID_OPERATION", "Too many attempts. Try again later.");
  }

  await assertPlatformReauth(ctx, body.password);

  const requestId = requestIdOf(req);
  try {
    const dto = await deactivateAiCostRate(id, { actorId: ctx.userId });
    await platformAudit({
      operatorId: ctx.operatorId,
      operatorRole: ctx.role,
      action: "ai_cost.rate_deactivated",
      entityType: "AiCostRate",
      entityId: id,
      reason: body.reason,
      after: { provider: dto.provider, model: dto.model, version: dto.version },
      requestId,
      ip: getClientIp(req),
      userAgent: req.headers.get("user-agent"),
    });
    return platformOk({ deactivated: true, requestId });
  } catch (error) {
    if (error instanceof AiCostRateError) {
      throw new ApiError(422, "PLATFORM_AI_RATE_INVALID", error.message, { reason: error.code });
    }
    throw error;
  }
});
