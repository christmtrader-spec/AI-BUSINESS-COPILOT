/**
 * POST /api/v1/platform/ai-cost/anomalies/[id]/acknowledge — (§53).
 * Status transition OPEN → ACKNOWLEDGED only (idempotent when already
 * acknowledged). Audited as ai_cost.anomaly_acknowledged (§53). This is a
 * REVIEW workflow — it never suspends or unblocks anything (§50).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { route, ApiError } from "@/lib/api-helpers";
import { getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { parsePlatformBody, platformOk } from "@/lib/platform/http";
import { platformAudit, requestIdOf } from "@/lib/platform/audit";
import { getClientIp } from "@/lib/api-helpers";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  note: z.string().trim().max(300).optional(),
});

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:ai-cost:manage");
  const { id } = await params;
  const body = await parsePlatformBody(req, bodySchema);

  const anomaly = await db.aiCostAnomaly.findUnique({ where: { id } });
  if (!anomaly) {
    throw new ApiError(404, "PLATFORM_INVALID_OPERATION", "Anomaly not found.");
  }
  if (anomaly.status === "RESOLVED") {
    throw new ApiError(422, "PLATFORM_INVALID_OPERATION", "A resolved anomaly cannot be re-acknowledged.");
  }

  const requestId = requestIdOf(req);
  await db.$transaction(async (tx) => {
    await tx.aiCostAnomaly.update({
      where: { id },
      data: { status: "ACKNOWLEDGED" },
    });
    await platformAudit(
      {
        operatorId: ctx.operatorId,
        operatorRole: ctx.role,
        action: "ai_cost.anomaly_acknowledged",
        entityType: "AiCostAnomaly",
        entityId: id,
        targetBusinessId: anomaly.businessId,
        reason: body.note ?? null,
        before: { status: anomaly.status },
        after: { status: "ACKNOWLEDGED" },
        requestId,
        ip: getClientIp(req),
        userAgent: req.headers.get("user-agent"),
      },
      tx as Parameters<typeof platformAudit>[1],
    );
  });

  return platformOk({ acknowledged: true, requestId });
});
