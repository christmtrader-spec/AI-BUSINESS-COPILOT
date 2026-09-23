/**
 * GET /api/v1/audit — recent audit log entries (audit:read).
 * GET /api/v1/audit?format=csv&take=N — same entries as an accountant-friendly
 * CSV download (r22). Server-generated from the SAME rows the Audit view
 * shows (single source of truth). Gated by the plan's CSV_EXPORT
 * entitlement (§34 — server-side reject; UI hiding alone is never the
 * enforcement) and rate limited like the reports export.
 */
import { NextRequest, NextResponse } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { assertFeatureAccess } from "@/lib/billing";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { csvCell } from "@/lib/csv";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "audit:read");

  const takeRaw = Number(new URL(req.url).searchParams.get("take") ?? 50);
  if (!Number.isInteger(takeRaw) || takeRaw < 1 || takeRaw > 200) {
    throw new ApiError(422, "INVALID_TAKE", "'take' must be an integer between 1 and 200.");
  }
  const take = takeRaw;

  const logs = await db.auditLog.findMany({
    where: { businessId: ctx.businessId },
    include: { actor: { select: { name: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take,
  });

  // CSV variant (r22) — same rows, accountant-friendly serialization.
  if (new URL(req.url).searchParams.get("format") === "csv") {
    // Billing gate (§34): server-side CSV export rejects when the plan's
    // CSV_EXPORT entitlement is false — fresh read (§111).
    await assertFeatureAccess(ctx.businessId, "CSV_EXPORT");

    const limit = rateLimit(`audit-export:${ctx.userId}`, 10, 5 * 60_000);
    if (!limit.allowed) {
      throw new ApiError(
        429,
        "RATE_LIMITED",
        "Too many exports in a short time. Please wait a moment.",
        { retryAfterMs: limit.retryAfterMs },
      );
    }

    const lines: string[] = [];
    lines.push(csvRow(["timestamp", "actor_name", "actor_email", "action", "entity_type", "entity_id"]));
    for (const l of logs) {
      lines.push(
        csvRow([
          l.createdAt.toISOString(),
          l.actor?.name ?? "",
          l.actor?.email ?? "",
          l.action,
          l.entityType,
          l.entityId,
        ]),
      );
    }

    const csv = `\uFEFF${lines.join("\r\n")}\r\n`; // BOM so Excel opens UTF-8 cleanly
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const filename = `audit-${ctx.business.slug || "business"}-${stamp}.csv`;

    void audit({
      businessId: ctx.businessId,
      actorId: ctx.userId,
      action: "data.export",
      entityType: "AuditCSV",
      entityId: null,
      after: { format: "csv", take },
      ip: req.headers.get("x-forwarded-for"),
      userAgent: req.headers.get("user-agent"),
    });

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  }

  return ok(
    logs.map((l) => ({
      id: l.id,
      action: l.action,
      entityType: l.entityType,
      entityId: l.entityId,
      actor: l.actor,
      before: l.beforeJson ? JSON.parse(l.beforeJson) : null,
      after: l.afterJson ? JSON.parse(l.afterJson) : null,
      createdAt: l.createdAt,
    })),
  );
});
