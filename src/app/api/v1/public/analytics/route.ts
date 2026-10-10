/**
 * POST /api/v1/public/analytics — Prompt 25 §54/§104/§171.
 *
 * The ONLY public analytics door, and it is deliberately narrow:
 * - Names: STRICT allowlist (PRICING_VIEWED / PLAN_SELECTED /
 *   SIGNUP_STARTED / ONBOARDING_STARTED). A client that tries to forge a
 *   lifecycle event (CHECKOUT_COMPLETED, TRIAL_STARTED, PAYMENT_FAILED,
 *   SIGNUP_COMPLETED, …) gets 422 EVENT_NOT_ALLOWED — critical events are
 *   generated server-side only (§55).
 * - Properties: sanitized in src/lib/analytics.ts — unknown/oversized/
 *   malformed values are dropped, never stored.
 * - Dedupe (§54): one event per (name, session, UTC day) — React
 *   re-renders and page refreshes cannot inflate the funnel. The session
 *   id is a client-generated UUID with NO personal content; when absent,
 *   the caller IP is used only as a dedupe dimension (never stored).
 * - Rate limited per IP (§171 — tests use synthetic sessions; real users
 *   never notice the ceiling).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, getClientIp, ok, parseBody, route } from "@/lib/api-helpers";
import { rateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { isClientEventName, sanitizeClientProps } from "@/lib/analytics";

export const dynamic = "force-dynamic";

const ingestSchema = z.object({
  name: z.string().trim().max(64),
  props: z.record(z.string(), z.string().max(64)).optional(),
  /** Client-side dedupe session — a random UUID, not an identifier of a person. */
  sessionId: z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
});

/** UTC day bucket for the per-day dedupe semantics (§54). */
function utcDayBucket(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export const POST = route(async (req: NextRequest) => {
  const ip = getClientIp(req);
  const rl = rateLimit(`public-analytics:${ip}`, 60, 5 * 60 * 1000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const input = await parseBody(req, ingestSchema);

  // §104 — allowlist check BEFORE anything else.
  if (!isClientEventName(input.name)) {
    throw new ApiError(422, "EVENT_NOT_ALLOWED", "This event cannot be tracked from the client.");
  }

  const props = sanitizeClientProps(input.props);
  const sessionPart = input.sessionId ?? `ip:${ip}`;
  const dedupeKey = `${input.name}:${sessionPart}:${utcDayBucket()}`;

  try {
    await db.analyticsEvent.create({
      data: { name: input.name, ...props, dedupeKey },
    });
  } catch (error) {
    // Unique-violation = already recorded today for this session: success
    // semantics for an idempotent funnel event (§54).
    const code = (error as { code?: string }).code;
    if (code !== "P2002") throw error;
  }

  // Respond WITHOUT echoing internal ids or stored rows (§6/§116).
  return ok({ received: true }, 202);
});
