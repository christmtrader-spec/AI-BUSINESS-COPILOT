/**
 * GET/POST /api/v1/platform/support/tickets — Prompt 62 (§10).
 *
 * GET  — paginated ticket search (platform:support:read). Filters come from
 *        explicit allowlists; pagination is bounded by MAX_PAGE_SIZE.
 * POST — open a ticket ON BEHALF of a caller (phone/e-mail intake). The
 *        requester id is explicitly validated server-side; the actor is the
 *        authenticated operator (never a body field — §79/§132).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { route, getClientIp } from "@/lib/api-helpers";
import { getPlatformContext, platformError, requirePlatformPermission } from "@/lib/platform/auth";
import { parsePlatformBody, parsePagination, platformOk, queryDate, queryFilter } from "@/lib/platform/http";
import { requestIdOf } from "@/lib/platform/audit";
import {
  createSupportTicket,
  isSupportCategory,
  isSupportPriority,
  isSupportStatus,
  listSupportTickets,
  SUPPORT_TICKET_CATEGORIES,
  SUPPORT_TICKET_PRIORITIES,
  SUPPORT_TICKET_STATUSES,
  SUPPORT_SUBJECT_MAX,
  SUPPORT_DESCRIPTION_MAX,
  ticketListItemDto,
} from "@/lib/platform/support";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:support:read");

  const sp = req.nextUrl.searchParams;
  const p = parsePagination(sp);

  const status = queryFilter(sp, "status", 40);
  const priority = queryFilter(sp, "priority", 20);
  const category = queryFilter(sp, "category", 40);

  const result = await listSupportTickets({
    ...(status && isSupportStatus(status) ? { status } : {}),
    ...(priority && isSupportPriority(priority) ? { priority } : {}),
    ...(category && isSupportCategory(category) ? { category } : {}),
    assignee: queryFilter(sp, "assignee", 64),
    callerOperatorId: ctx.operatorId,
    businessId: queryFilter(sp, "businessId", 64),
    requesterId: queryFilter(sp, "requesterId", 64),
    q: queryFilter(sp, "q", 120),
    createdFrom: queryDate(sp, "createdFrom"),
    createdTo: queryDate(sp, "createdTo", true),
    page: p.page,
    pageSize: p.pageSize,
  });

  return platformOk({
    tickets: result.tickets,
    page: result.page,
    facets: {
      statuses: SUPPORT_TICKET_STATUSES,
      priorities: SUPPORT_TICKET_PRIORITIES,
      categories: SUPPORT_TICKET_CATEGORIES,
    },
  });
});

const createSchema = z.object({
  requesterId: z.string().min(6).max(64),
  businessId: z.string().min(6).max(64).nullish(),
  subject: z.string().trim().min(5).max(SUPPORT_SUBJECT_MAX),
  description: z.string().trim().min(10).max(SUPPORT_DESCRIPTION_MAX),
  category: z.enum(SUPPORT_TICKET_CATEGORIES),
  priority: z.enum(SUPPORT_TICKET_PRIORITIES).default("NORMAL"),
});

export const POST = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:support:read");

  // Intake is rate-limited per operator (§21 — support desk hygiene).
  const rl = rateLimit(`platform:${ctx.operatorId}:support-create`, 20, 60_000);
  if (!rl.allowed) {
    throw platformError(429, "PLATFORM_INVALID_OPERATION", "Too many ticket creations. Try again shortly.");
  }

  const body = await parsePlatformBody(req, createSchema);
  const requestId = requestIdOf(req);

  const ticket = await createSupportTicket({
    requesterId: body.requesterId,
    ...(body.businessId ? { businessId: body.businessId } : {}),
    subject: body.subject,
    description: body.description,
    category: body.category,
    priority: body.priority,
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

  if (!ticket || "code" in ticket) {
    throw platformError(503, "SUPPORT_NUMBER_COLLISION", "Ticket reference contention — please retry.");
  }

  return platformOk({ ticket: ticketListItemDto(ticket) }, 201);
});
