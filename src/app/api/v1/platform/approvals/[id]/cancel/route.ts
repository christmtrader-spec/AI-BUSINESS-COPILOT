/**
 * POST /api/v1/platform/approvals/[id]/cancel — the REQUESTER withdraws a
 * still-pending request (Prompt 65 §10.1). Deliberately NOT an approval
 * action: only the requester's own operator row may cancel, and the
 * operation permission is not required (withdrawing one's own proposal).
 * Audited.
 */
import { NextRequest } from "next/server";
import { route } from "@/lib/api-helpers";
import { getPlatformContext, platformError } from "@/lib/platform/auth";
import { platformOk } from "@/lib/platform/http";
import { platformAudit, requestIdOf } from "@/lib/platform/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-helpers";
import { approvalDto, cancelApprovalRequest } from "@/lib/platform/approvals";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getPlatformContext(req);
  const { id } = await params;

  const rl = rateLimit(`platform:${ctx.operatorId}:approvals-act`, 20, 15 * 60_000);
  if (!rl.allowed) {
    throw platformError(429, "PLATFORM_RATE_LIMITED", "Too many attempts. Try again later.");
  }

  const cancelled = await cancelApprovalRequest({ ctx, id });
  const dto = approvalDto(cancelled);

  await platformAudit({
    operatorId: ctx.operatorId,
    operatorRole: ctx.role,
    action: "platform.approval.cancelled",
    entityType: "PlatformApprovalRequest",
    entityId: id,
    reason: dto.reason,
    after: { kind: dto.kind, status: dto.status },
    requestId: requestIdOf(req),
    ip: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });

  return platformOk({ approval: dto, requestId: requestIdOf(req) });
});
