/**
 * GET /api/v1/platform/security/events/export — audited CSV export of the
 * auth-lifecycle feed (R64).
 *
 * A bulk read is still a sensitive read: this endpoint is rate-limited FAR
 * tighter than the JSON feed (5/min vs 60/min), hard-capped at
 * SECURITY_EXPORT_MAX_ROWS (honest truncation, announced via header AND
 * audit), filtered through the SAME allowlist parser as the feed (one
 * parser, two consumers §81) and AUDITED per invocation
 * (platform.security.events_exported) with the filter set + row count.
 *
 * Data minimization travels with the rows: ipHashPrefix is the SAME 12-hex
 * prefix the feed shows — a raw IP does not exist anywhere in this path.
 */
import { NextRequest, NextResponse } from "next/server";
import { route, getClientIp } from "@/lib/api-helpers";
import { getPlatformContext, platformError, requirePlatformPermission } from "@/lib/platform/auth";
import { platformAudit, requestIdOf } from "@/lib/platform/audit";
import { toCsv } from "@/lib/csv";
import { parseSecurityEventFilters, securityEventWhere, describeEventFilters } from "@/lib/platform/security-filters";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Hard cap — an export is a bounded snapshot, not an unbounded dump. */
export const SECURITY_EXPORT_MAX_ROWS = 5_000;

export const GET = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:security:read");

  const rl = rateLimit(`platform:${ctx.operatorId}:security-export`, 5, 60_000);
  if (!rl.allowed) {
    throw platformError(429, "PLATFORM_INVALID_OPERATION", "Too many exports. Try again in a minute.");
  }

  const filters = parseSecurityEventFilters(req.nextUrl.searchParams);
  const where = securityEventWhere(filters);

  const rows = await db.securityEvent.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: SECURITY_EXPORT_MAX_ROWS + 1, // +1 detects truncation without a count query
    include: { user: { select: { email: true } } },
  });
  const truncated = rows.length > SECURITY_EXPORT_MAX_ROWS;
  const exported = truncated ? rows.slice(0, SECURITY_EXPORT_MAX_ROWS) : rows;

  const csv = toCsv(
    ["id", "createdAt", "eventType", "success", "reasonCode", "email", "ipHashPrefix", "userAgent"],
    exported.map((row) => [
      row.id,
      row.createdAt.toISOString(),
      row.eventType,
      row.success ? "true" : "false",
      row.reasonCode ?? "",
      row.user?.email ?? "",
      row.ipHash ? row.ipHash.slice(0, 12) : "",
      row.userAgent ?? "",
    ]),
  );

  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const requestId = requestIdOf(req);
  await platformAudit({
    operatorId: ctx.operatorId,
    operatorRole: ctx.role,
    action: "platform.security.events_exported",
    entityType: "SecurityEvent",
    entityId: `export:${stamp}`,
    reason: "Security Center CSV export",
    after: {
      rows: exported.length,
      truncated,
      filters: describeEventFilters(filters),
    },
    requestId,
    ip: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="security-events-${stamp}.csv"`,
      "cache-control": "no-store",
      "x-export-truncated": truncated ? "true" : "false",
      "x-export-rows": String(exported.length),
    },
  });
});
