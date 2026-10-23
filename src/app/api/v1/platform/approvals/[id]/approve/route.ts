/**
 * POST /api/v1/platform/approvals/[id]/approve — second-person approval
 * (Prompt 65 §10.1).
 *
 * Requires platform:approvals:manage AND the operation's own permission.
 * The approver must be a DIFFERENT OPERATOR than the requester — enforced
 * SERVER-SIDE from the operator row, never from any client input. The
 * transition is a guarded single-step state change; only a PENDING request
 * can be approved. Audited.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { route } from "@/lib/api-helpers";
import { getPlatformContext, platformError } from "@/lib/platform/auth";
import { parsePlatformBody, platformOk } from "@/lib/platform/http";
import { platformAudit, requestIdOf } from "@/lib/platform/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-helpers";
import { approveApprovalRequest, approvalDto } from "@/lib/platform/approvals";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  note: z.string().trim().max(300).optional(),
});

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getPlatformContext(req);
  const { id } = await params;
  const body = await parsePlatformBody(req, bodySchema);

  const rl = rateLimit(`platform:${ctx.operatorId}:approvals-act`, 20, 15 * 60_000);
  if (!rl.allowed) {
    throw platformError(429, "PLATFORM_RATE_LIMITED", "Too many attempts. Try again later.");
  }

  const approved = await approveApprovalRequest({ ctx, id, note: body.note });
  const dto = approvalDto(approved);

  await platformAudit({
    operatorId: ctx.operatorId,
    operatorRole: ctx.role,
    action: "platform.approval.approved",
    entityType: "PlatformApprovalRequest",
    entityId: id,
    reason: body.note ?? dto.reason,
    after: { kind: dto.kind, status: dto.status, requesterId: dto.requester?.id ?? null },
    requestId: requestIdOf(req),
    ip: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });

  return platformOk({ approval: dto, requestId: requestIdOf(req) });
});
