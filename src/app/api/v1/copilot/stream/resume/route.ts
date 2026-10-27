/**
 * POST /api/v1/copilot/stream/resume — R126 post-delta resume.
 *
 * The client polls this endpoint after a MID-ANSWER connection cut (the
 * original SSE fetch died with deltas already delivered). The stream route
 * kept generating into the bounded resume buffer (see
 * src/lib/ai/stream-resume.ts), so the client re-attaches with the answer's
 * Prompt 21 requestId and the index of the first delta it has NOT seen:
 *
 *   { requestId, fromIndex } →
 *   200 { deltas: string[], nextIndex, done, stopped, overflow, error? }
 *   404 { error: { code: "RESUME_NOT_FOUND" } }   — unknown/expired/foreign
 *
 * Laws:
 * - AUTH: same pipeline as the stream (permission "copilot:use"); ownership
 *   (businessId + userId) is re-checked against the buffer's owner — a
 *   resume is an extension of the ORIGINAL request, not a new one.
 * - NO METERING: the answer was metered once by the original POST; resume
 *   only replays what that operation already produced.
 * - RATE LIMIT: generous (300/min per user+business) — the poll cadence is
 *   ~2.5/s for the life of one answer; every other cadence is abuse.
 * - IDEMPOTENT: polling twice with the same fromIndex returns the same
 *   deltas — the client can re-poll after its own network blips.
 */
import { NextRequest, NextResponse } from "next/server";
import { ApiError, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { copilotResumeSchema } from "@/lib/schemas";
import { rateLimit } from "@/lib/rate-limit";
import { streamResumeStore } from "@/lib/ai/stream-resume-store";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest) => {
  const authCtx = await getAuthContext(req);
  requirePermission(authCtx, "copilot:use");

  const rl = rateLimit(`copilot-resume:${authCtx.userId}:${authCtx.businessId}`, 300, 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many resume attempts. Please wait a moment.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const input = copilotResumeSchema.parse(await req.json());
  const snap = streamResumeStore.snapshot(input.requestId, input.fromIndex, {
    businessId: authCtx.businessId,
    userId: authCtx.userId,
  });

  if (!snap) {
    // Unknown, expired, or foreign — one honest code for all three (no
    // information leak about other users' streams).
    throw new ApiError(404, "RESUME_NOT_FOUND", "This answer can no longer be resumed.");
  }

  return NextResponse.json({
    deltas: snap.deltas,
    nextIndex: snap.nextIndex,
    done: snap.done,
    stopped: snap.stopped,
    overflow: snap.overflow,
    ...(snap.error ? { error: snap.error } : {}),
  });
});
