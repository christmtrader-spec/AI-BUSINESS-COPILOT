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
import { pageMeta, parsePagination, platformOk, queryDate, queryFilter } from "@/lib/platform/http";
import { db } from "@/lib/db";
import { SECURITY_EVENTS } from "@/lib/auth/security-events/service";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Fixed vocabulary — the ONLY filterable event types (§71/§423). */
const EVENT_TYPES: string[] = Object.values(SECURITY_EVENTS);
const eventTypeSet = new Set(EVENT_TYPES);

export const GET = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:security:read");

  const rl = rateLimit(`platform:${ctx.operatorId}:security-read`, 60, 60_000);
  if (!rl.allowed) {
    throw platformError(429, "PLATFORM_INVALID_OPERATION", "Too many requests. Try again later.");
  }

  const sp = req.nextUrl.searchParams;
  const p = parsePagination(sp);

  const rawEventType = queryFilter(sp, "eventType", 64);
  let eventType: string | undefined;
  if (rawEventType) {
    if (!eventTypeSet.has(rawEventType)) {
      throw platformError(422, "PLATFORM_INVALID_OPERATION", "Unknown event type filter.", {
        eventType: rawEventType,
      });
    }
    eventType = rawEventType;
  }

  const successRaw = queryFilter(sp, "success", 8);
  let success: boolean | undefined;
  if (successRaw === "true") success = true;
  else if (successRaw === "false") success = false;
  else if (successRaw !== undefined) {
    throw platformError(422, "PLATFORM_INVALID_OPERATION", "The success filter must be true or false.");
  }

  const userId = queryFilter(sp, "userId", 64);
  const email = queryFilter(sp, "email", 200);
  const createdFrom = queryDate(sp, "createdFrom");
  const createdTo = queryDate(sp, "createdTo", true);

  const where = {
    ...(eventType ? { eventType } : {}),
    ...(success !== undefined ? { success } : {}),
    ...(userId ? { userId } : {}),
    ...(email ? { user: { is: { email: { contains: email.toLowerCase() } } } } : {}),
    ...(createdFrom || createdTo
      ? {
          createdAt: {
            ...(createdFrom ? { gte: createdFrom } : {}),
            ...(createdTo ? { lte: createdTo } : {}),
          },
        }
      : {}),
  };

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
    facets: { eventTypes: EVENT_TYPES },
  });
});
