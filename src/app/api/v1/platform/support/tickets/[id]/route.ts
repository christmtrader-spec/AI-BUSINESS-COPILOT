/**
 * GET/PATCH /api/v1/platform/support/tickets/[id] — Prompt 62 (§10.2/§10.4).
 *
 * GET    — operator detail: full thread (INTERNAL notes included — the
 *          operator surface is the ONLY place they are visible) +
 *          permission-conditional diagnostics (§10.3).
 * PATCH  — exactly ONE field per request (no mass assignment, §21):
 *            { status }  → platform:support:update  (validated transition)
 *            { priority } → platform:support:update
 *            { assigneeOperatorId } → platform:support:assign
 *          assignee accepts an operator id, "me", or null (unassign).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { route } from "@/lib/api-helpers";
import { getPlatformContext, platformError, requirePlatformPermission } from "@/lib/platform/auth";
import { parsePlatformBody, platformOk } from "@/lib/platform/http";
import {
  assignTicket,
  getSupportTicket,
  getTicketDiagnostics,
  setTicketPriority,
  SUPPORT_TICKET_PRIORITIES,
  SUPPORT_TICKET_STATUSES,
  ticketOperatorDetailDto,
  transitionSupportTicket,
} from "@/lib/platform/support";

export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    status: z.enum(SUPPORT_TICKET_STATUSES).optional(),
    priority: z.enum(SUPPORT_TICKET_PRIORITIES).optional(),
    // "me" resolves to the CALLING operator server-side (never a body-supplied id for self — §79 spirit).
    assigneeOperatorId: z.union([z.literal("me"), z.string().min(6).max(64)]).nullish(),
  })
  .refine((v) => {
    const keys = [v.status !== undefined, v.priority !== undefined, v.assigneeOperatorId !== undefined].filter(Boolean).length;
    return keys === 1;
  }, { message: "Exactly one of status | priority | assigneeOperatorId per request." });

export const GET = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:support:read");
  const { id } = await params;

  const ticket = await getSupportTicket(id);
  if (!ticket) {
    throw platformError(404, "SUPPORT_TICKET_NOT_FOUND", "Ticket not found.");
  }

  const diagnostics = await getTicketDiagnostics(ticket, {
    canReadSecurity: ctx.permissions.includes("platform:security:read"),
    canReadAudit: ctx.permissions.includes("platform:audit:read"),
  });

  return platformOk({
    ticket: ticketOperatorDetailDto(ticket),
    diagnostics,
    viewer: {
      operatorId: ctx.operatorId,
      canAssign: ctx.permissions.includes("platform:support:assign"),
      canUpdate: ctx.permissions.includes("platform:support:update"),
      canResolve: ctx.permissions.includes("platform:support:resolve"),
    },
  });
});

export const PATCH = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getPlatformContext(req);
  const { id } = await params;
  const body = await parsePlatformBody(req, patchSchema);

  const actor = {
    kind: "OPERATOR" as const,
    operatorId: ctx.operatorId,
    operatorRole: ctx.role,
    userId: ctx.userId,
    name: ctx.email,
  };

  if (body.status !== undefined) {
    requirePlatformPermission(ctx, "platform:support:update");
    const updated = await transitionSupportTicket({ ticketId: id, to: body.status, actor });
    return platformOk({ ticket: { id: updated.id, status: updated.status } });
  }
  if (body.priority !== undefined) {
    requirePlatformPermission(ctx, "platform:support:update");
    const updated = await setTicketPriority({ ticketId: id, priority: body.priority, actor });
    return platformOk({ ticket: { id: updated.id, priority: updated.priority } });
  }
  // assigneeOperatorId (string | "me" | null)
  requirePlatformPermission(ctx, "platform:support:assign");
  const raw = body.assigneeOperatorId ?? null;
  const target = raw === "me" ? ctx.operatorId : raw;
  const updated = await assignTicket({ ticketId: id, assigneeOperatorId: target, actor });
  return platformOk({
    ticket: { id: updated.id, assigneeOperatorId: updated.assigneeOperatorId },
  });
});
