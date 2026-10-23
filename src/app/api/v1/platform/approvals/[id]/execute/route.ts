/**
 * POST /api/v1/platform/approvals/[id]/execute — execute an APPROVED
 * two-person request exactly once (Prompt 65 §10.1).
 *
 * Gates (all server-side):
 *  1. platform:approvals:manage AND the operation's own permission;
 *  2. REAUTHENTICATION with the current password (§56 — high-risk mutation);
 *  3. the request must be APPROVED (or a retryable FAILED) and unexpired;
 *  4. an atomic status-conditional claim guarantees ONE execution under
 *     concurrency (§10.1 — duplicate execution is impossible by state).
 *
 * The payloadHash re-check binds execution to the EXACT approved payload.
 * Execution failures store a VALUE-FREE error code and are retryable while
 * unexpired. Every attempt outcome is audited.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { route } from "@/lib/api-helpers";
import { assertPlatformReauth, getPlatformContext, platformError } from "@/lib/platform/auth";
import { parsePlatformBody, platformOk } from "@/lib/platform/http";
import { platformAudit, requestIdOf } from "@/lib/platform/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-helpers";
import { approvalDto, executeApprovalRequest } from "@/lib/platform/approvals";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  password: z.string().min(1).max(200).optional(),
});

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getPlatformContext(req);
  const { id } = await params;
  const body = await parsePlatformBody(req, bodySchema);

  const rl = rateLimit(`platform:${ctx.operatorId}:approvals-execute`, 10, 15 * 60_000);
  if (!rl.allowed) {
    throw platformError(429, "PLATFORM_RATE_LIMITED", "Too many attempts. Try again later.");
  }

  await assertPlatformReauth(ctx, body.password);

  const result = await executeApprovalRequest({ ctx, id });
  const dto = approvalDto(result.row);

  // R65 (§10.1 honesty): a FAILED execution is surfaced as a FAILURE — never
  // as a 200. The errorCode is VALUE-FREE (sanitized in the service).
  if (!result.ok) {
    await platformAudit({
      operatorId: ctx.operatorId,
      operatorRole: ctx.role,
      action: "platform.approval.execution_failed",
      entityType: "PlatformApprovalRequest",
      entityId: id,
      reason: dto.reason,
      after: { kind: dto.kind, status: dto.status, errorCode: result.errorCode },
      requestId: requestIdOf(req),
      ip: getClientIp(req),
      userAgent: req.headers.get("user-agent"),
    });
    throw platformError(
      409,
      "PLATFORM_EXECUTION_FAILED",
      "The approved operation could not be executed. The request stays retryable until it expires.",
      { approval: dto, errorCode: result.errorCode },
    );
  }

  await platformAudit({
    operatorId: ctx.operatorId,
    operatorRole: ctx.role,
    action: "platform.approval.executed",
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
