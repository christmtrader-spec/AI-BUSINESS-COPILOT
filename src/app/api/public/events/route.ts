/**
 * POST /api/public/events — Prompt 25 anonymous funnel events.
 *
 * The ONLY endpoint where an unauthenticated visitor may contribute to the
 * commercial event ledger — restricted to the PRICING_* subset and stripped
 * to allowlisted dimensions. Identity comes exclusively from the
 * server-issued funnel cookie (never from the body). Everything else
 * (emails, IPs, fingerprints) is rejected by construction.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ok, parseBody, route } from "@/lib/api-helpers";
import { cleanDimension, isPublicEventType, recordCommercialEvent } from "@/lib/billing/events";
import { funnelIdentity } from "@/lib/funnel-cookie";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  eventType: z.string().min(1).max(64),
  planCode: z.string().trim().max(32).optional(),
  billingPeriod: z.enum(["MONTHLY", "YEARLY"]).optional(),
  currency: z.string().trim().max(8).optional(),
  source: z.string().trim().max(64).optional(),
  route: z.string().trim().max(64).optional(),
});

export const POST = route(async (req: NextRequest) => {
  const rl = rateLimit(`public-events:${getClientIpSafe(req)}`, 60, 60_000);
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "Too many requests." } },
      { status: 429 },
    );
  }

  const input = await parseBody(req, bodySchema);
  if (!isPublicEventType(input.eventType)) {
    // 404-safe equivalent: anonymous callers learn nothing about the
    // internal event directory beyond the public subset.
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: "Not found." } },
      { status: 404 },
    );
  }

  const { key, setCookie } = funnelIdentity(req);
  await recordCommercialEvent({
    eventType: input.eventType,
    anonymousSessionKey: key,
    planCode: cleanDimension(input.planCode, 32),
    billingPeriod: input.billingPeriod ?? null,
    currency: cleanDimension(input.currency, 8),
    source: cleanDimension(input.source),
    route: cleanDimension(input.route),
  });

  const res = NextResponse.json({ ok: true, data: { recorded: true } });
  if (setCookie) res.headers.append("set-cookie", setCookie);
  return res;
});

function getClientIpSafe(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
