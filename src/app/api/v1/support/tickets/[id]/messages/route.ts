/**
 * POST /api/v1/support/tickets/[id]/messages — Prompt 62 (§10.2, tenant).
 *
 * Requester reply. visibility is FIXED to CUSTOMER server-side (no body
 * field can widen it). CLOSED tickets reject replies (409); RESOLVED
 * tickets auto-reopen (→ OPEN) so the conversation continues in one place.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { addRequesterMessage, SUPPORT_MESSAGE_MAX, ticketMessageDto } from "@/lib/platform/support";

export const dynamic = "force-dynamic";

const replySchema = z.object({
  body: z.string().trim().min(1).max(SUPPORT_MESSAGE_MAX),
});

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getAuthContext(req);
  const { id } = await params;

  const rl = rateLimit(`support:reply:${ctx.userId}`, 20, 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many replies. Please wait a moment.");
  }

  const body = await parseBody(req, replySchema);

  const message = await addRequesterMessage({
    ticketId: id,
    requesterId: ctx.userId,
    body: body.body,
  });

  return ok({ message: ticketMessageDto(message, { includeInternal: false }) }, 201);
});
