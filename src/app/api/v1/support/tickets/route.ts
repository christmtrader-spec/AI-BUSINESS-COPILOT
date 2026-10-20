/**
 * GET/POST /api/v1/support/tickets — Prompt 62 (§10, tenant surface).
 *
 * The requester identity is ALWAYS the authenticated session user (§79 —
 * never a body/query field). businessId comes ONLY from the server context
 * (x-business-id + membership — the tenant law A01/A02). INTERNAL operator
 * notes can never appear here: the DTO filter lives in the service layer.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import {
  createSupportTicket,
  SUPPORT_DESCRIPTION_MAX,
  SUPPORT_SUBJECT_MAX,
  SUPPORT_TICKET_CATEGORIES,
  ticketListItemDto,
} from "@/lib/platform/support";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);

  const url = new URL(req.url);
  const pageRaw = Number(url.searchParams.get("page") ?? "1");
  const sizeRaw = Number(url.searchParams.get("pageSize") ?? "20");
  const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? Math.min(pageRaw, 10_000) : 1;
  const pageSize = Number.isInteger(sizeRaw) && sizeRaw >= 1 ? Math.min(sizeRaw, 50) : 20;

  const [rows, total] = await Promise.all([
    db.supportTicket.findMany({
      where: { requesterId: ctx.userId },
      orderBy: { createdAt: "desc" },
      take: pageSize,
      skip: (page - 1) * pageSize,
    }),
    db.supportTicket.count({ where: { requesterId: ctx.userId } }),
  ]);

  return ok({
    tickets: rows.map(ticketListItemDto),
    page: { page, pageSize, total, hasNext: (page - 1) * pageSize + pageSize < total, hasPrev: page > 1 },
  });
});

const createSchema = z.object({
  subject: z.string().trim().min(5, "The subject must be at least 5 characters.").max(SUPPORT_SUBJECT_MAX),
  description: z
    .string()
    .trim()
    .min(10, "Please describe the problem in at least 10 characters.")
    .max(SUPPORT_DESCRIPTION_MAX),
  category: z.enum(SUPPORT_TICKET_CATEGORIES),
});

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);

  // Spam guard per user (§21) — 5 new tickets / hour.
  const rl = rateLimit(`support:create:${ctx.userId}`, 5, 60 * 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many tickets. Please wait before opening another one.");
  }

  const body = await parseBody(req, createSchema);

  const ticket = await createSupportTicket({
    requesterId: ctx.userId,
    businessId: ctx.businessId,
    subject: body.subject,
    description: body.description,
    category: body.category,
    actor: { kind: "REQUESTER", userId: ctx.userId, name: null }, // name resolved server-side by the service
  });

  if (!ticket || "code" in ticket) {
    throw new ApiError(503, "SUPPORT_NUMBER_COLLISION", "Ticket reference contention — please retry.");
  }

  return ok({ ticket: ticketListItemDto(ticket) }, 201);
});
