/**
 * POST /api/v1/copilot/stream/stop — R126 stop beacon.
 *
 * The user's Stop button must stop the MODEL, not just the socket. Before
 * R126 the client aborted the fetch and the server saw the abort —
 * indistinguishable from a network cut. With the R126 break law an abort
 * AFTER deltas keeps generating (so a network cut can resume), which means
 * a genuine Stop MUST announce itself: this endpoint marks the answer's
 * buffer entry as user-stopped and the stream loop breaks at the next
 * delta boundary.
 *
 * The client fires this beacon (keepalive, best-effort) and then aborts —
 * exactly like before, one fetch earlier.
 *
 * Laws:
 * - AUTH + ownership: same pipeline as the stream; a foreign/unknown
 *   requestId answers { ok: false } with 200 — the endpoint exists for the
 *   honest case and must not leak which ids exist.
 * - NO METERING CHANGE: stopping after deltas keeps the charge (§45), the
 *   same law as before R126.
 * - RATE LIMIT: 60/min per user+business — far above human Stop use.
 */
import { NextRequest, NextResponse } from "next/server";
import { route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { copilotStopSchema } from "@/lib/schemas";
import { rateLimit } from "@/lib/rate-limit";
import { streamResumeStore } from "@/lib/ai/stream-resume-store";

export const dynamic = "force-dynamic";

/**
 * R126② — MULTI-TAB SEMANTICS (documented decision, not an oversight):
 * a stop is scoped to the ANSWER (requestId), not to the TAB that started
 * it. Any tab of the SAME user (ownership re-checked below) may stop the
 * answer by id. Rationale: the requestId is a client-generated UUID that
 * never leaves the user's own session storage — there is no cross-tab
 * broadcast today, so the only realistic second-tab stop is a deliberate
 * replay by the same user (or a page that re-fired the same logical
 * question's id, which Prompt 21 treats as the SAME operation anyway). A
 * tab nonce would add state without closing any real hole: two tabs
 * sharing one login can always observe and abort each other's fetches
 * client-side. If multi-tab broadcast ever ships, revisit with a nonce.
 */
export const POST = route(async (req: NextRequest) => {
  const authCtx = await getAuthContext(req);
  requirePermission(authCtx, "copilot:use");

  const rl = rateLimit(`copilot-stop:${authCtx.userId}:${authCtx.businessId}`, 60, 60_000);
  if (!rl.allowed) {
    // A rate-limited stop must still try — fall through to a {ok:false}
    // answer instead of an error envelope: the client ignores this body.
    return NextResponse.json({ ok: false });
  }

  const input = copilotStopSchema.parse(await req.json());
  const stopped = streamResumeStore.markUserStopped(input.requestId, {
    businessId: authCtx.businessId,
    userId: authCtx.userId,
  });

  return NextResponse.json({ ok: stopped });
});
