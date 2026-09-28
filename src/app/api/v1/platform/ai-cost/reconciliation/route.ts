/**
 * POST /api/v1/platform/ai-cost/reconciliation — dry-run / apply (§45/§46).
 *
 * SEQUENCE LAW (§46/§93): a dry-run NEVER mutates (§42 enforced inside
 * reconcileAiCosts). APPLY requires platform:ai-cost:reconcile +
 * reauthentication (current password) + a TYPED confirmation
 * ("RECONCILE") + a reason — and re-validates every record itself at
 * apply time (never trusts stale dry-run data, §186). Idempotent:
 * compare-and-update semantics prevent double attribution (§187/§74).
 * Apply is audited (§53). The guard/anomaly behavior is NOT changed here.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { route, ApiError } from "@/lib/api-helpers";
import { assertPlatformReauth, getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { parsePlatformBody, platformOk } from "@/lib/platform/http";
import { platformAudit, requestIdOf } from "@/lib/platform/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-helpers";
import { reconcileAiCosts } from "@/lib/ai/cost/ledger";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  reason: z.string().trim().min(3).max(300),
  confirmation: z.string().optional(),
  password: z.string().min(1).max(200).optional(),
});

export const POST = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:ai-cost:reconcile");
  const body = await parsePlatformBody(req, bodySchema);

  const rl = rateLimit(`platform:${ctx.operatorId}:ai-reconciliation`, 10, 15 * 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "PLATFORM_RECONCILIATION_BLOCKED", "Too many attempts. Try again later.");
  }

  if (body.mode === "apply") {
    if (body.confirmation !== "RECONCILE") {
      throw new ApiError(422, "PLATFORM_RECONCILIATION_BLOCKED", "Typed confirmation missing — type RECONCILE to apply.");
    }
    await assertPlatformReauth(ctx, body.password);
  }

  const requestId = requestIdOf(req);
  const report = await reconcileAiCosts({
    dryRun: body.mode === "dry-run",
    actorId: ctx.userId,
  });

  if (body.mode === "apply") {
    await platformAudit({
      operatorId: ctx.operatorId,
      operatorRole: ctx.role,
      action: "ai_cost.reconciliation_applied",
      entityType: "AiCostRecord",
      entityId: null,
      reason: body.reason,
      after: {
        candidateRecordCount: report.candidateRecordCount,
        eligibleRecords: report.eligibleRecords,
        updatedCount: report.updatedCount,
        window: report.boundedWindow,
      },
      requestId,
      ip: getClientIp(req),
      userAgent: req.headers.get("user-agent"),
    });
  }

  return platformOk({ report, requestId });
});
