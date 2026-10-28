/**
 * GET /api/v1/billing/usage/series — R135.
 *
 * The daily AI-usage time series behind the ⌘K quick dialog's sparkline.
 * Read-only, business-scoped EXACTLY like /api/v1/billing/usage: the
 * business is resolved server-side from the session — the client can
 * never pass a businessId and read another tenant's usage (§55/§99).
 *
 * Population law (ONE truth with the meter):
 * - UsageEvent rows of THIS business, metric = AI_REQUESTS,
 *   status = COMMITTED — RELEASED rows were reconciled back by the meter
 *   (§20/§49/§50) and never count; the series and the period counter can
 *   therefore never disagree about a day;
 * - `quantity` is SUMMED per UTC day (the meter's own unit — §48);
 * - bucketing happens in UTC (the ledger's clock), then
 *   src/lib/billing/usage-series.ts zero-fills the clamped window (the
 *   ONE shaping authority — pure, battery-pinned).
 *
 * Query: `?days=N` — clamped to [1, 30] server-side (default 14); a
 * hostile value falls back to the default, never echoes back.
 *
 * Response:
 * {
 *   window: { from, to },   // inclusive UTC day keys
 *   days: 14,               // clamped day count == series.length
 *   series: [{ date, requests }, ...]  // oldest → newest, zero-filled
 * }
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { db } from "@/lib/db";
import {
  buildUsageSeries,
  clampSeriesDays,
  seriesWindowKeys,
  utcDayKey,
} from "@/lib/billing/usage-series";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:read");

  const days = clampSeriesDays(new URL(req.url).searchParams.get("days"));
  const now = new Date();
  const window = seriesWindowKeys(now, days);
  // Window starts at 00:00 UTC of the OLDEST day — the index
  // @@index([businessId, createdAt]) serves this range scan directly.
  const sinceUtc = new Date(`${window[0]}T00:00:00.000Z`);

  const events = await db.usageEvent.findMany({
    where: {
      businessId: ctx.businessId,
      metric: "AI_REQUESTS",
      status: "COMMITTED",
      createdAt: { gte: sinceUtc },
    },
    select: { createdAt: true, quantity: true },
  });

  const counts = new Map<string, number>();
  for (const e of events) {
    const day = utcDayKey(e.createdAt);
    counts.set(day, (counts.get(day) ?? 0) + e.quantity);
  }
  const countsArray = [...counts.entries()].map(([day, requests]) => ({ day, requests }));

  const built = buildUsageSeries(countsArray, now, days);

  return ok({
    window: { from: built.from, to: built.to },
    days: built.days,
    series: built.series,
  });
});
