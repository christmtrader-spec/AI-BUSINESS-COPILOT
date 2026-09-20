/**
 * POST /api/v1/copilot/sessions/[id]/messages — append one message to the
 * user's transcript (auto-creates the session on first append).
 *
 * Phase 07 (r10 rec #1). Design notes:
 * - Session ids are CLIENT-generated (format-validated `chatSessionIdSchema`)
 *   so local↔server reconciliation is identity-based and idempotent.
 * - POST upserts the session scoped to (businessId, userId) — the lookup
 *   NEVER matches another user's session even on id collision.
 * - Append-only writes: no message edit/delete endpoints (transcript
 *   integrity); deletes act at session granularity only.
 * - Caps (20 sessions / 200 messages) are enforced best-effort: appends
 *   beyond the cap return { skipped: true } with 200 so the client never
 *   treats storage overflow as an error (transcripts are best-effort UX,
 *   never financial authority — A11-A13).
 *
 * Permission: copilot:use (same gate as asking — VIEWER excluded).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { chatMessageAppendSchema, chatSessionIdSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

const SESSION_CAP = 20;
const MESSAGES_CAP = 200;
const META_MAX_CHARS = 4000;

type RouteParams = { params: Promise<{ id: string }> };

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const sessionKey = chatSessionIdSchema.safeParse(id);
  if (!sessionKey.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Malformed session id.");
  }

  const ctx = await getAuthContext(req);
  requirePermission(ctx, "copilot:use");

  // Appends ride along with questions (2 per Q&A) — generous limit; the
  // AI ask endpoint itself is the tighter gate (10/min).
  const rl = rateLimit(`copilot-sync:${ctx.userId}:${ctx.businessId}`, 60, 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many sync requests. Please wait a moment.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const input = await parseBody(req, chatMessageAppendSchema);

  // Citation meta is provenance-only: store as compact JSON, drop if oversized.
  let metaJson: string | null = null;
  if (input.meta !== undefined && input.meta !== null) {
    try {
      const compact = JSON.stringify(input.meta);
      if (compact.length <= META_MAX_CHARS) metaJson = compact;
    } catch {
      // non-serializable meta — provenance is decorative, skip it
    }
  }

  // Explicit union type so the skipped/message branches narrow cleanly
  // (transaction callback inference alone was too loose for the `in` check).
  const result = await db.$transaction(
    async (
      tx,
    ): Promise<{ skipped: true } | { id: string; createdAt: Date }> => {
    // Upsert the session (scoped by owner triple — never another user's row).
    const existing = await tx.chatSession.findFirst({
      where: { id: sessionKey.data, businessId: ctx.businessId, userId: ctx.userId },
      select: { id: true, _count: { select: { messages: true } } },
    });

    if (!existing) {
      const sessionCount = await tx.chatSession.count({
        where: { businessId: ctx.businessId, userId: ctx.userId },
      });
      if (sessionCount >= SESSION_CAP) {
        return { skipped: true };
      }
      await tx.chatSession.create({
        data: {
          id: sessionKey.data,
          businessId: ctx.businessId,
          userId: ctx.userId,
          title: input.title?.slice(0, 80) ?? "",
        },
      });
    } else if (existing._count.messages >= MESSAGES_CAP) {
      return { skipped: true };
    }

    return tx.chatMessage.create({
      data: {
        sessionId: sessionKey.data,
        userId: ctx.userId,
        role: input.role,
        content: input.content,
        metaJson,
      },
      select: { id: true, createdAt: true },
    });
    },
  );

  if ("skipped" in result) {
    return ok({ skipped: true });
  }

  return ok(
    {
      message: {
        id: result.id,
        createdAt: result.createdAt.toISOString(),
      },
    },
    201,
  );
});
