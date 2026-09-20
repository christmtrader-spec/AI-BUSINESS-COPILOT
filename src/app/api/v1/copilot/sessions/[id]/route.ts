/**
 * PATCH  /api/v1/copilot/sessions/[id] — rename and/or pin one transcript.
 * DELETE /api/v1/copilot/sessions/[id] — delete one transcript (audited).
 *
 * Phase 07 (r10 rec #1) + r12 (rename & pin). Scoped triple lookup: a user
 * can only touch their OWN transcript, and only within the active business
 * (A01/A02) — an id collision with another user's session can never match.
 *
 * Rename semantics: setting `title` flips `titleEdited`, after which the
 * append-time auto-title on the client never overwrites the user's name.
 * Pin semantics: pinned conversations sort first in the history list; the
 * flag is metadata only — it never affects message contents or caps.
 *
 * Permission: copilot:use (same gate as asking — VIEWER excluded).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { chatSessionIdSchema, chatSessionUpdateSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const sessionKey = chatSessionIdSchema.safeParse(id);
  if (!sessionKey.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Malformed session id.");
  }

  const ctx = await getAuthContext(req);
  requirePermission(ctx, "copilot:use");

  const input = await parseBody(req, chatSessionUpdateSchema);

  const updated = await db.chatSession.updateMany({
    where: { id: sessionKey.data, businessId: ctx.businessId, userId: ctx.userId },
    data: {
      ...(input.title !== undefined
        ? { title: input.title, titleEdited: true }
        : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
    },
  });
  if (updated.count === 0) {
    throw new ApiError(404, "NOT_FOUND", "Conversation not found.");
  }

  const row = await db.chatSession.findFirst({
    where: { id: sessionKey.data, businessId: ctx.businessId, userId: ctx.userId },
    select: { id: true, title: true, titleEdited: true, pinned: true, updatedAt: true },
  });

  await audit({
    businessId: ctx.businessId,
    actorId: ctx.userId,
    action: "copilot.session_update",
    entityType: "ChatSession",
    entityId: sessionKey.data,
    after: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
    },
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });

  return ok({
    session: {
      id: row?.id ?? sessionKey.data,
      title: row?.title ?? "",
      titleEdited: row?.titleEdited ?? false,
      pinned: row?.pinned ?? false,
      updatedAt: row?.updatedAt.toISOString() ?? new Date().toISOString(),
    },
  });
});

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const sessionKey = chatSessionIdSchema.safeParse(id);
  if (!sessionKey.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Malformed session id.");
  }

  const ctx = await getAuthContext(req);
  requirePermission(ctx, "copilot:use");

  const deleted = await db.chatSession.deleteMany({
    where: { id: sessionKey.data, businessId: ctx.businessId, userId: ctx.userId },
  });
  if (deleted.count === 0) {
    throw new ApiError(404, "NOT_FOUND", "Conversation not found.");
  }

  await audit({
    businessId: ctx.businessId,
    actorId: ctx.userId,
    action: "copilot.session_delete",
    entityType: "ChatSession",
    entityId: sessionKey.data,
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });

  return ok({ deleted: deleted.count });
});
