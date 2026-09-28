/**
 * GET /api/v1/platform/ai-cost/anomalies — anomaly view (§50).
 * Displays the existing detection types (usage/token/cost spike, unknown
 * ratio, missing rate, business concentration). NO automatic business
 * suspension exists (§50) — display + acknowledgment only.
 */
import { NextRequest } from "next/server";
import { route } from "@/lib/api-helpers";
import { getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { pageMeta, parsePagination, platformOk, queryFilter } from "@/lib/platform/http";
import { db } from "@/lib/db";
import { platformAiCostAnomalyDto } from "@/lib/platform/serializers";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:ai-cost:read");

  const sp = req.nextUrl.searchParams;
  const p = parsePagination(sp);
  const status = queryFilter(sp, "status", 14);
  const businessId = queryFilter(sp, "businessId", 64);

  const where = {
    ...(status && ["OPEN", "ACKNOWLEDGED", "RESOLVED"].includes(status) ? { status } : {}),
    ...(businessId ? { businessId } : {}),
  };

  const [rows, total] = await Promise.all([
    db.aiCostAnomaly.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: p.pageSize,
      skip: p.skip,
    }),
    db.aiCostAnomaly.count({ where }),
  ]);

  return platformOk({
    anomalies: rows.map(platformAiCostAnomalyDto),
    page: pageMeta(p, total),
  });
});
