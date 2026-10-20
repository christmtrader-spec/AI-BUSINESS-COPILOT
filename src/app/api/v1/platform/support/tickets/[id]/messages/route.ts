/**
 * POST /api/v1/platform/support/tickets/[id]/messages — Prompt 62 (§10.2).
 *
 * Operator thread message. visibility:
 *   CUSTOMER — visible to the requester through the tenant API + notified.
 *   INTERNAL — internal note; NEVER leaves the platform surface (§10.2).
 * Rate-limited per operator; audited; first CUSTOMER message starts the
 * response clock (firstResponseAt).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { route, getClientIp } from "@/lib/api-helpers";
import { getPlatformContext, platformError, requirePlatformPermission } from "@/lib/platform/auth";
import { parsePlatformBody, platformOk } from "@/lib/platform/http";
import { requestIdOf } from "@/lib/platform/audit";
import { addOperatorMessage, SUPPORT_MESSAGE_MAX, SUPPORT_MESSAGE_VISIBILITIES, ticketMessageDto } from "@/lib/platform/support";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const messageSchema = z.object({
  body: z.string().trim().min(1).max(SUPPORT_MESSAGE_MAX),
  visibility: z.enum(SUPPORT_MESSAGE_VISIBILITIES),
});

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:support:update");

  const rl = rateLimit(`platform:${ctx.operatorId}:support-message`, 60, 60_000);
  if (!rl.allowed) {
    throw platformError(429, "PLATFORM_INVALID_OPERATION", "Too many messages. Try again shortly.");
  }

  const { id } = await params;
  const body = await parsePlatformBody(req, messageSchema);
  const requestId = requestIdOf(req);

  const message = await addOperatorMessage({
    ticketId: id,
    body: body.body,
    visibility: body.visibility,
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

  return platformOk({ message: ticketMessageDto(message, { includeInternal: true }) }, 201);
});
