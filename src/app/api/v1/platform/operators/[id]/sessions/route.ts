/**
 * GET /api/v1/platform/operators/[id]/sessions — live session registry for
 * ONE platform operator (R64: "operator session listing under Operators").
 *
 * The Operators view can already create/deactivate operators; this adds the
 * missing VISIBILITY: which devices hold live sessions for the operator
 * account, since when, and from which hashed-IP prefix — the same minimized
 * projection the tenant devices view uses (no raw IP exists anywhere; no
 * token hashes ever leave the registry; userAgent renders only as the
 * coarse deviceLabel §232).
 *
 * Guards: platform:operators:read (READONLY included — it is a read).
 * The [id] is the PlatformOperator id (same identifier the operators
 * list/detail already use) — a user id or foreign id yields 404.
 */
import { NextRequest } from "next/server";
import { route } from "@/lib/api-helpers";
import { getPlatformContext, platformError, requirePlatformPermission } from "@/lib/platform/auth";
import { platformOk } from "@/lib/platform/http";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const MAX_SESSIONS = 50;

export const GET = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:operators:read");

  const rl = rateLimit(`platform:${ctx.operatorId}:operator-sessions-read`, 60, 60_000);
  if (!rl.allowed) {
    throw platformError(429, "PLATFORM_INVALID_OPERATION", "Too many requests. Try again later.");
  }

  const { id } = await params;
  const operator = await db.platformOperator.findUnique({
    where: { id },
    select: {
      id: true,
      role: true,
      active: true,
      userId: true,
      user: { select: { email: true, name: true } },
    },
  });
  if (!operator) {
    throw platformError(404, "PLATFORM_INVALID_OPERATION", "Operator not found.");
  }

  const now = new Date();
  const rows = await db.userSession.findMany({
    where: { userId: operator.userId },
    orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }], // live sessions first
    take: MAX_SESSIONS,
    select: {
      id: true,
      deviceLabel: true,
      createdAt: true,
      lastSeenAt: true,
      expiresAt: true,
      revokedAt: true,
      ipHash: true,
    },
  });

  const sessions = rows.map((row) => ({
    id: row.id,
    deviceLabel: row.deviceLabel,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revoked: row.revokedAt !== null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    live: row.revokedAt === null && row.expiresAt.getTime() > now.getTime(),
    ipHashPrefix: row.ipHash ? row.ipHash.slice(0, 12) : null,
  }));

  return platformOk({
    operator: {
      id: operator.id,
      email: operator.user?.email ?? null,
      name: operator.user?.name ?? null,
      role: operator.role,
      active: operator.active,
    },
    activeCount: sessions.filter((s) => s.live).length,
    sessions,
    truncated: sessions.length === MAX_SESSIONS,
  });
});
