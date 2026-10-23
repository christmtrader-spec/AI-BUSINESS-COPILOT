/**
 * GET  /api/v1/platform/approvals — list two-person approval requests
 *      (platform:approvals:read; status/kind filters from allowlists).
 * POST /api/v1/platform/approvals — create an approval request for a
 *      registered high-risk operation (platform:approvals:manage + the
 *      operation's own permission + reason). Prompt 65 §10.
 *
 * Creating a request NEVER executes anything (§10.1) — it only records a
 * structured, validated proposal that a DIFFERENT operator must approve.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { route } from "@/lib/api-helpers";
import { getPlatformContext, platformError } from "@/lib/platform/auth";
import { pageMeta, parsePagination, parsePlatformBody, platformOk } from "@/lib/platform/http";
import { platformAudit, requestIdOf } from "@/lib/platform/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-helpers";
import {
  APPROVAL_KINDS,
  APPROVAL_STATUSES,
  approvalDto,
  createApprovalRequest,
  listApprovalRequests,
} from "@/lib/platform/approvals";

export const dynamic = "force-dynamic";

const listSchema = z.object({
  status: z.string().trim().optional(),
  kind: z.string().trim().optional(),
});

const createSchema = z.object({
  kind: z.string().trim().min(1).max(64),
  payload: z.record(z.string(), z.unknown()),
  reason: z.string().trim().min(3).max(300),
});

export const GET = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  if (!ctx.permissions.includes("platform:approvals:read")) {
    throw platformError(403, "PLATFORM_PERMISSION_DENIED", "Your operator role does not allow this action.", {
      permission: "platform:approvals:read",
    });
  }
  const url = new URL(req.url);
  const filters = listSchema.parse({
    status: url.searchParams.get("status") ?? undefined,
    kind: url.searchParams.get("kind") ?? undefined,
  });
  // Allowlisted filters only (§71) — never an arbitrary client string.
  const status = filters.status && (APPROVAL_STATUSES as readonly string[]).includes(filters.status) ? filters.status : undefined;
  const kind = filters.kind && (APPROVAL_KINDS as readonly string[]).includes(filters.kind) ? filters.kind : undefined;

  const pagination = parsePagination(url.searchParams);
  const { rows, total } = await listApprovalRequests({ status, kind, ...pagination });

  return platformOk({
    approvals: rows.map(approvalDto),
    meta: pageMeta(pagination, total),
    // R69 — the LIVE operation registry (single source of truth §81): the
    // filter UI derives its kind options from this, never a hardcoded copy.
    kinds: APPROVAL_KINDS,
  });
});

export const POST = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  const body = await parsePlatformBody(req, createSchema);

  const rl = rateLimit(`platform:${ctx.operatorId}:approvals-create`, 10, 15 * 60_000);
  if (!rl.allowed) {
    throw platformError(429, "PLATFORM_RATE_LIMITED", "Too many attempts. Try again later.");
  }

  const created = await createApprovalRequest({
    ctx,
    kind: body.kind,
    payload: body.payload,
    reason: body.reason,
  });
  const dto = approvalDto(created);

  await platformAudit({
    operatorId: ctx.operatorId,
    operatorRole: ctx.role,
    action: "platform.approval.created",
    entityType: "PlatformApprovalRequest",
    entityId: created.id,
    reason: body.reason,
    after: { kind: created.kind, payloadHashPrefix: dto.payloadHashPrefix, status: created.status },
    requestId: requestIdOf(req),
    ip: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });

  return platformOk({ approval: dto, requestId: requestIdOf(req) });
});
