import { NextResponse, type NextRequest } from "next/server";
import { getClientIp } from "@/lib/api-helpers";
import { rateLimit } from "@/lib/rate-limit";
import { computeReadiness, publicReadinessDTO } from "@/lib/observability/readiness";
import { getOrCreateRequestId, requestIdHeaderName } from "@/lib/observability/request-id";

export const dynamic = "force-dynamic";

/**
 * GET /api/ready — production readiness probe (Prompt 29 §39-42, §92).
 *
 * Liveness (/api/health) answers "is the process alive"; THIS endpoint
 * answers "can the process safely serve production traffic".
 *
 * Public-safe contract (§42/§93/§172): overall status (ready|degraded|
 * blocked) + per-component status words ONLY. No migration names, no counts
 * of users/businesses, no file paths, no provider model names, no SMTP
 * details, no AI cost figures. Detailed readiness lives in Platform System.
 *
 * A short internal cache (3s, §91) absorbs monitoring bursts while keeping
 * configuration/state changes visible predictably.
 */
export async function GET(req: NextRequest) {
  const rl = rateLimit(`ready:${getClientIp(req)}`, 30, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { status: 429, retryAfterMs: rl.retryAfterMs },
      { status: 429, headers: { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  const r = await computeReadiness();
  const dto = publicReadinessDTO(r);
  // The endpoint itself answers 200 whenever it can report; the BODY carries
  // the operational state (ready | degraded | blocked) per §41.
  return NextResponse.json(dto, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      // §25 — probes carry the correlation header too (uptime monitors log it).
      [requestIdHeaderName()]: getOrCreateRequestId(req),
    },
  });
}
