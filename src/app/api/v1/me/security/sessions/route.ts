/**
 * GET /api/v1/me/security/sessions — the caller's registered sessions
 * (Prompt 30 §76/§122, §124, §203, §230/§231).
 *
 * Only the SESSION OWNER's sessions are ever listed (§203/§357). Bounded
 * pagination (§124/§327: default 10, max 50). DTOs carry NO token material
 * (§122). The current session is marked server-side from the JWT sid (§77).
 */
import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { ok, route } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertFreshSession, assertSessionRegistry } from "@/lib/auth-security";
import { toSessionDTO } from "@/lib/auth/sessions/service";

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;

export const GET = route(async (req: NextRequest) => {
  const session = await getServerSession(authOptions);
  const userId = await assertFreshSession(session);
  const currentRegistryId = await assertSessionRegistry(session, userId);

  const url = new URL(req.url);
  const page = Math.max(1, Math.min(Number(url.searchParams.get("page") ?? "1") || 1, 10_000));
  const pageSizeRaw = Number(url.searchParams.get("pageSize") ?? String(DEFAULT_PAGE_SIZE)) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.max(1, Math.min(pageSizeRaw, MAX_PAGE_SIZE));

  const [rows, total] = await Promise.all([
    db.userSession.findMany({
      where: { userId },
      orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }],
      select: {
        id: true,
        deviceLabel: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
        revokedAt: true,
      },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.userSession.count({ where: { userId } }),
  ]);

  return ok({
    sessions: rows.map((row) => toSessionDTO(row, currentRegistryId)),
    page,
    pageSize,
    total,
    // §230/§231 — honest legacy note when the CURRENT session is not
    // registered (pre-Prompt-30 JWT during the compatibility window).
    currentSessionRegistered: currentRegistryId !== null,
  });
});
