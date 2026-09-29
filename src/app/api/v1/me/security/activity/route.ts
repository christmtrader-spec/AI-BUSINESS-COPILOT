/**
 * GET /api/v1/me/security/activity — the caller's security activity
 * (Prompt 30 §88/§97/§123, §125/§236/§237, §326).
 *
 * Only the SESSION OWNER's events (§166). DTOs (§123) carry event type,
 * timestamp, outcome, reason class and device label — NEVER secrets, raw
 * IPs, or payloads (§90). Bounded pagination, newest first (§236/§326:
 * default 20, max 100).
 */
import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { ok, route } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { assertFreshSession } from "@/lib/auth-security";

export const dynamic = "force-dynamic";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export type SecurityEventDTO = {
  eventType: string;
  success: boolean;
  reasonCode: string | null;
  createdAt: string;
  deviceLabel: string | null;
};

export const GET = route(async (req: NextRequest) => {
  const session = await getServerSession(authOptions);
  const userId = await assertFreshSession(session);

  const url = new URL(req.url);
  const page = Math.max(1, Math.min(Number(url.searchParams.get("page") ?? "1") || 1, 10_000));
  const pageSizeRaw = Number(url.searchParams.get("pageSize") ?? String(DEFAULT_PAGE_SIZE)) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.max(1, Math.min(pageSizeRaw, MAX_PAGE_SIZE));

  const [rows, total] = await Promise.all([
    db.securityEvent.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" }, // §236 — newest first
      select: {
        id: true,
        eventType: true,
        success: true,
        reasonCode: true,
        createdAt: true,
        userAgent: true,
      },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.securityEvent.count({ where: { userId } }),
  ]);

  // §97/§123/§426 — device label derived from the bounded UA snapshot;
  // raw IPs are never shown (§98/§426 — device + time only).
  const { deviceLabelFromUserAgent } = await import("@/lib/auth/sessions/service");

  const events: SecurityEventDTO[] = rows.map((row) => ({
    eventType: row.eventType,
    success: row.success,
    reasonCode: row.reasonCode,
    createdAt: row.createdAt.toISOString(),
    deviceLabel: deviceLabelFromUserAgent(row.userAgent),
  }));

  return ok({ events, page, pageSize, total });
});
