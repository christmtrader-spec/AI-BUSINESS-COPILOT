/**
 * GET    /api/v1/copilot/sessions — list THIS user's copilot transcripts
 *                                   for the active business (with messages).
 * DELETE /api/v1/copilot/sessions — clear ALL of the user's transcripts
 *                                   for the business ("clear history").
 *
 * Phase 07 (r10 rec #1): transcripts follow the user across devices.
 * Scoped per (businessId, userId) — a user's questions are their own;
 * other members can never read them (defense in depth beyond the
 * tenant header: the WHERE clause always includes userId).
 *
 * Server copy is NOT financial authority: answers are historical
 * narration; figures are recomputed on every ask (A11-A13).
 *
 * Permission: copilot:use (same gate as asking — VIEWER excluded).
 * Caps: 20 sessions × 200 messages, content ≤ 8000 chars (mirrors the
 * localStorage store so neither side can balloon unbounded).
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export const SESSION_CAP = 20;
export const MESSAGES_CAP = 200;

/** Serialized message row → client shape (metaJson parsed back to meta). */
function toClientMessage(m: {
  id: string;
  role: string;
  content: string;
  failed: boolean;
  metaJson: string | null;
  createdAt: Date;
}) {
  let meta: unknown;
  if (m.metaJson) {
    try {
      meta = JSON.parse(m.metaJson);
    } catch {
      meta = undefined;
    }
  }
  return {
    id: m.id,
    role: m.role === "user" ? "user" : "assistant",
    content: m.content,
    failed: m.failed || undefined,
    ...(meta !== undefined ? { meta } : {}),
    createdAt: m.createdAt.toISOString(),
  };
}

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "copilot:use");

  const sessions = await db.chatSession.findMany({
    where: { businessId: ctx.businessId, userId: ctx.userId },
    orderBy: { updatedAt: "desc" },
    take: SESSION_CAP,
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        take: MESSAGES_CAP,
      },
    },
  });

  return ok({
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      titleEdited: s.titleEdited || undefined,
      pinned: s.pinned || undefined,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      messages: s.messages.map(toClientMessage),
    })),
  });
});

export const DELETE = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "copilot:use");

  const deleted = await db.chatSession.deleteMany({
    where: { businessId: ctx.businessId, userId: ctx.userId },
  });

  await audit({
    businessId: ctx.businessId,
    actorId: ctx.userId,
    action: "copilot.session_clear",
    entityType: "ChatSession",
    entityId: null,
    after: { deletedSessions: deleted.count },
    ip: req.headers.get("x-forwarded-for"),
    userAgent: req.headers.get("user-agent"),
  });

  return ok({ deleted: deleted.count });
});
