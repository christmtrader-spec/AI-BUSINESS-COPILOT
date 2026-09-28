/**
 * GET /api/v1/platform/ai-cost/ledger — paginated AiCostRecord view (§45).
 * INTERNAL ONLY (§52). Cost values shown only in the authorized platform
 * context; UNKNOWN cost stays NULL + UNKNOWN — never zero (§47).
 */
import { NextRequest } from "next/server";
import { route } from "@/lib/api-helpers";
import { getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { pageMeta, parsePagination, platformOk, queryFilter } from "@/lib/platform/http";
import { db } from "@/lib/db";
import { platformAiCostRecordDto } from "@/lib/platform/serializers";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:ai-cost:read");

  const sp = req.nextUrl.searchParams;
  const p = parsePagination(sp);

  const costStatus = queryFilter(sp, "costStatus", 10);
  const businessId = queryFilter(sp, "businessId", 64);
  const provider = queryFilter(sp, "provider", 32);
  const environment = queryFilter(sp, "environment", 12);

  const where = {
    ...(costStatus === "KNOWN" || costStatus === "UNKNOWN" ? { costStatus } : {}),
    ...(businessId ? { businessId } : {}),
    ...(provider ? { provider } : {}),
    ...(environment === "TEST" || environment === "PRODUCTION" ? { environment } : {}),
  };

  const [rows, total] = await Promise.all([
    db.aiCostRecord.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: p.pageSize,
      skip: p.skip,
    }),
    db.aiCostRecord.count({ where }),
  ]);

  return platformOk({
    records: rows.map(platformAiCostRecordDto),
    page: pageMeta(p, total),
  });
});
