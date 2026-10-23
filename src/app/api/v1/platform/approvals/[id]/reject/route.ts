/**
 * POST /api/v1/platform/approvals/[id]/reject — reject a pending approval
 * request (reason mandatory, Prompt 65 §10.1). Requires
 * platform:approvals:manage AND the operation's own permission. Audited.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { route } from "@/lib/api-helpers";
import { getPlatformContext, platformError } from "@/lib/platform/auth";
import { parsePlatformBody, platformOk } from "@/lib/platform/http";
import { platformAudit, requestIdOf } from "@/lib/platform/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-helpers";
import { approvalDto, rejectApprovalRequest } from "@/lib/platform/approvals";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  reason: z.string().trim().min(3).max(300),
});

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getPlatformContext(req);
  const { id } = await params;
  const body = await parsePlatformBody(req, bodySchema);

  const rl = rateLimit(`platform:${ctx.operatorId}:approvals-act`, 20, 15 * 60_000);
  if (!rl.allowed) {
    throw platformError(429, "PLATFORM_RATE_LIMITED", "Too many attempts. Try again later.");
  }

  const rejected = await rejectApprovalRequest({ ctx, id, reason: body.reason });
  const dto = approvalDto(rejected);

  await platformAudit({
    operatorId: ctx.operatorId,
    operatorRole: ctx.role,
    action: "platform.approval.rejected",
    entityType: "PlatformApprovalRequest",
    entityId: id,
    reason: body.reason,
    after: { kind: dto.kind, status: dto.status, requesterId: dto.requester?.id ?? null },
    requestId: requestIdOf(req),
    ip: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });

  return platformOk({ approval: dto, requestId: requestIdOf(req) });
});
