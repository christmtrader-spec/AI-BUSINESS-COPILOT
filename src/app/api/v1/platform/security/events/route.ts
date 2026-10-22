/**
 * GET /api/v1/platform/security/events — cross-user auth-lifecycle feed
 * (R63-P — the ورود و خروج / login-logout monitor of the Security Center).
 *
 * Reads the durable SecurityEvent ledger (FIXED server vocabulary — §423;
 * never client-supplied). Rows are already minimized at write time: no
 * passwords/OTPs/tokens/bodies, IPs stored HASHED, userAgent bounded to
 * 255 chars. This endpoint exposes a HASH PREFIX only (12 hex chars) —
 * never a raw IP (which does not exist in the row) and never the full
 * hash (data minimization §90).
 *
 * Guards: platform:security:read + per-operator rate limit. Every filter
 * is an explicit allowlist/bounded value — a request string can never
 * become a Prisma field name (§71). Unknown eventType / success values
 * are 422'd, not silently dropped.
 */
import { NextRequest } from "next/server";
import { route } from "@/lib/api-helpers";
import { getPlatformContext, platformError, requirePlatformPermission } from "@/lib/platform/auth";
import { pageMeta, parsePagination, platformOk } from "@/lib/platform/http";
import { db } from "@/lib/db";
import {
  parseSecurityEventFilters,
  securityEventWhere,
  SECURITY_EVENT_TYPES,
} from "@/lib/platform/security-filters";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:security:read");

  const rl = rateLimit(`platform:${ctx.operatorId}:security-read`, 60, 60_000);
  if (!rl.allowed) {
    throw platformError(429, "PLATFORM_INVALID_OPERATION", "Too many requests. Try again later.");
  }

  const p = parsePagination(req.nextUrl.searchParams);
  const where = securityEventWhere(parseSecurityEventFilters(req.nextUrl.searchParams));

  const [rows, total] = await Promise.all([
    db.securityEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: p.pageSize,
      skip: p.skip,
      include: { user: { select: { email: true } } },
    }),
    db.securityEvent.count({ where }),
  ]);

  return platformOk({
    events: rows.map((row) => ({
      id: row.id,
      eventType: row.eventType,
      success: row.success,
      reasonCode: row.reasonCode,
      email: row.user?.email ?? null,
      userAgent: row.userAgent,
      ipHashPrefix: row.ipHash ? row.ipHash.slice(0, 12) : null,
      createdAt: row.createdAt.toISOString(),
    })),
    page: pageMeta(p, total),
    facets: { eventTypes: SECURITY_EVENT_TYPES },
  });
});
