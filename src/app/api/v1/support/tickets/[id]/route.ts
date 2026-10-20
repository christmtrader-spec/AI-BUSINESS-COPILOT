/**
 * GET /api/v1/support/tickets/[id] — Prompt 62 (§10.2, tenant surface).
 *
 * Requester-only (IDOR guard: a non-requester gets the SAME 404 as a
 * missing ticket — no existence oracle). INTERNAL messages are filtered at
 * the SERVICE layer; this route can never leak them.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext } from "@/lib/tenant";
import { getSupportTicket, ticketRequesterDetailDto } from "@/lib/platform/support";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getAuthContext(req);
  const { id } = await params;

  const ticket = await getSupportTicket(id);
  if (!ticket || ticket.requesterId !== ctx.userId) {
    throw new ApiError(404, "SUPPORT_TICKET_NOT_FOUND", "Ticket not found.");
  }

  return ok({ ticket: ticketRequesterDetailDto(ticket) });
});
