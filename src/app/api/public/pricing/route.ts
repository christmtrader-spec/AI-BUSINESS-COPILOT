/**
 * GET /api/public/pricing — Prompt 25.
 *
 * PUBLIC (no authentication): the authoritative, currency-aware plan catalog
 * for the public pricing page. Shape = PublicPlanDTO[] built from the
 * PricingService (PriceBook → PlanPrice) + the entitlement catalog — the
 * browser never resolves or hard-codes prices.
 *
 * Guarantees:
 * - No plan DB ids, no PriceBook ids, no operator metadata.
 * - Honest availability (AVAILABLE / NOT_PRICED / NOT_SELF_SERVICE /
 *   NOT_PURCHASABLE) and a server-computed CTA matrix.
 * - The funnel cookie (anonymous visitor key) is issued here.
 * - PRICING_VIEWED is NOT recorded here — this is an API read, not a page
 *   view; the page posts the event explicitly via /api/public/events.
 */
import { NextRequest, NextResponse } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { buildPublicPricing } from "@/lib/billing/public-pricing";
import { funnelIdentity } from "@/lib/funnel-cookie";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const currency = new URL(req.url).searchParams.get("currency");
  const data = await buildPublicPricing(currency);

  const res = NextResponse.json({ ok: true, data });
  const { setCookie } = funnelIdentity(req);
  if (setCookie) res.headers.append("set-cookie", setCookie);
  return res;
});
