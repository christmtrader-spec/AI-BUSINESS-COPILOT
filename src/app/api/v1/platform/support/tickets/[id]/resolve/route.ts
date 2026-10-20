/**
 * POST /api/v1/platform/support/tickets/[id]/resolve — Prompt 62 (§10.4).
 *
 * A ticket is NEVER resolved by a bare click: a resolution summary is
 * REQUIRED (min 10 chars), the transition matrix is enforced, the actor and
 * timestamp are recorded, the requester is notified (fire-safe) and the
 * mutation is audited (before/after with the summary).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { route, getClientIp } from "@/lib/api-helpers";
import { getPlatformContext, platformError, requirePlatformPermission } from "@/lib/platform/auth";
import { parsePlatformBody, platformOk } from "@/lib/platform/http";
import { requestIdOf } from "@/lib/platform/audit";
import {
  SUPPORT_RESOLUTION_MAX,
  SUPPORT_RESOLUTION_MIN,
  transitionSupportTicket,
} from "@/lib/platform/support";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const resolveSchema = z.object({
  resolutionSummary: z
    .string()
    .trim()
    .min(SUPPORT_RESOLUTION_MIN, `The resolution summary must be at least ${SUPPORT_RESOLUTION_MIN} characters.`)
    .max(SUPPORT_RESOLUTION_MAX),
});

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:support:resolve");

  const rl = rateLimit(`platform:${ctx.operatorId}:support-resolve`, 30, 60_000);
  if (!rl.allowed) {
    throw platformError(429, "PLATFORM_INVALID_OPERATION", "Too many operations. Try again shortly.");
  }

  const { id } = await params;
  const body = await parsePlatformBody(req, resolveSchema);
  const requestId = requestIdOf(req);

  const updated = await transitionSupportTicket({
    ticketId: id,
    to: "RESOLVED",
    resolutionSummary: body.resolutionSummary,
    actor: {
      kind: "OPERATOR",
      operatorId: ctx.operatorId,
      operatorRole: ctx.role,
      userId: ctx.userId,
      name: ctx.email,
      requestId,
      ip: getClientIp(req),
      userAgent: req.headers.get("user-agent"),
    },
  });

  return platformOk({
    ticket: {
      id: updated.id,
      status: updated.status,
      resolvedAt: updated.resolvedAt ? updated.resolvedAt.toISOString() : null,
      resolutionSummary: updated.resolutionSummary,
    },
  });
});
