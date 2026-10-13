/**
 * GET /api/v1/public/pricing — Prompt 25 §5/§6/§116/§125.
 *
 * The PUBLIC pricing source (no session required). One endpoint, a handful
 * of queries (§125) — the plan comparison, FAQ and CTAs all render from
 * THIS payload, which is built by the same PricingService that checkout
 * uses (§136: pricing page, pricing API and checkout can never diverge).
 *
 * Exposed: plan codes/order, safe pricing snapshots (amountMinor + currency
 * + readable version), entitlements, honest per-currency availability,
 * payments/trials flags.
 * NEVER exposed (§6/§116): DB ids, priceBookId, audit metadata, provider
 * credentials, subscription records, admin fields.
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { publicPricingForCurrency } from "@/lib/payments/public-pricing";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const currency = new URL(req.url).searchParams.get("currency");
  const payload = await publicPricingForCurrency(currency);

  // §60 — the payload may be cached briefly by browsers/CDNs; the short
  // TTL guarantees a price change is picked up quickly, and checkout NEVER
  // trusts this payload anyway (§118/§119 — it re-resolves server-side).
  const res = ok(payload);
  res.headers.set("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
  return res;
});
