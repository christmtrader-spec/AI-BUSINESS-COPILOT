/**
 * GET /api/v1/audit — recent audit log entries (audit:read).
 *
 * Prompt 52 §F10 — advanced filters for admins:
 *   action=<substring>        — case-sensitive "contains" match (e.g. "sale")
 *   entityType=<exact>        — e.g. Sale, Payment, BusinessMember
 *   actorId=<exact>           — user id of the acting member
 *   from=YYYY-MM-DD&to=YYYY-MM-DD — UTC calendar-day window (inclusive)
 *   facets=1                  — response becomes {items, facets} where
 *                               facets lists distinct actions / entityTypes
 *                               / actors (bounded) for the filter UI.
 *   take=N (1..200, default 50)
 *
 * GET /api/v1/audit?format=csv&take=N — same entries (WITH the same filter
 * params) as an accountant-friendly CSV download (r22). Gated by the plan's
 * CSV_EXPORT entitlement (§34 — server-side reject; UI hiding alone is never
 * the enforcement) and rate limited like the reports export.
 *
 * Every filter is applied SERVER-SIDE over the tenant-scoped rows — the
 * business scoping stays unconditional (A01/A02), filters only narrow.
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

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_STRING = 120;

function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}

type AuditFilter = {
  action: string | null;
  entityType: string | null;
  actorId: string | null;
  from: string | null;
  to: string | null;
};

function parseFilter(req: NextRequest): AuditFilter {
  const url = new URL(req.url);
  const sp = url.searchParams;
  const str = (name: string): string | null => {
    const raw = sp.get(name);
    if (raw === null) return null;
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    if (trimmed.length > MAX_STRING) {
      throw new ApiError(422, "VALIDATION_ERROR", `'${name}' is too long.`, { field: name });
    }
    return trimmed;
  };
  const from = str("from");
  const to = str("to");
  if (from !== null && !DATE_KEY.test(from)) {
    throw new ApiError(422, "VALIDATION_ERROR", "'from' must be YYYY-MM-DD.", { field: "from" });
  }
  if (to !== null && !DATE_KEY.test(to)) {
    throw new ApiError(422, "VALIDATION_ERROR", "'to' must be YYYY-MM-DD.", { field: "to" });
  }
  if (from !== null && to !== null && from > to) {
    throw new ApiError(422, "VALIDATION_ERROR", "'from' must not be after 'to'.", { field: "from" });
  }
  return {
    action: str("action"),
    entityType: str("entityType"),
    actorId: str("actorId"),
    from,
    to,
  };
}

function buildWhere(businessId: string, f: AuditFilter) {
  const createdAt: { gte?: Date; lt?: Date } = {};
  if (f.from) createdAt.gte = new Date(`${f.from}T00:00:00.000Z`);
  if (f.to) createdAt.lt = new Date(new Date(`${f.to}T00:00:00.000Z`).getTime() + 86_400_000);
  return {
    businessId,
    ...(f.action ? { action: { contains: f.action } } : {}),
    ...(f.entityType ? { entityType: f.entityType } : {}),
    ...(f.actorId ? { actorId: f.actorId } : {}),
    ...(f.from || f.to ? { createdAt } : {}),
  };
}

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "audit:read");

  const url = new URL(req.url);
  const filter = parseFilter(req);
  const where = buildWhere(ctx.businessId, filter);

  const takeRaw = Number(url.searchParams.get("take") ?? 50);
  if (!Number.isInteger(takeRaw) || takeRaw < 1 || takeRaw > 200) {
    throw new ApiError(422, "INVALID_TAKE", "'take' must be an integer between 1 and 200.");
  }
  const take = takeRaw;

  const wantFacets = url.searchParams.get("facets") === "1";

  const logs = await db.auditLog.findMany({
    where,
    include: { actor: { select: { name: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take,
  });

  // CSV variant (r22) — same FILTERED rows, accountant-friendly serialization.
  if (url.searchParams.get("format") === "csv") {
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
      after: {
        format: "csv",
        take,
        filters: {
          action: filter.action,
          entityType: filter.entityType,
          actorId: filter.actorId,
          from: filter.from,
          to: filter.to,
        },
      },
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

  const items = logs.map((l) => ({
    id: l.id,
    action: l.action,
    entityType: l.entityType,
    entityId: l.entityId,
    actor: l.actor,
    before: l.beforeJson ? JSON.parse(l.beforeJson) : null,
    after: l.afterJson ? JSON.parse(l.afterJson) : null,
    createdAt: l.createdAt,
  }));

  if (wantFacets) {
    // Facets over the WHOLE (tenant-scoped) log, not just the current take —
    // bounded scans: distinct via groupBy, capped server-side.
    const [actionGroups, typeGroups, actorGroups] = await Promise.all([
      db.auditLog.groupBy({
        by: ["action"],
        where: { businessId: ctx.businessId },
        _count: { _all: true },
        orderBy: { _count: { action: "desc" } },
        take: 60,
      }),
      db.auditLog.groupBy({
        by: ["entityType"],
        where: { businessId: ctx.businessId },
        _count: { _all: true },
        orderBy: { _count: { entityType: "desc" } },
        take: 40,
      }),
      db.auditLog.findMany({
        where: { businessId: ctx.businessId, actorId: { not: null } },
        distinct: ["actorId"],
        select: {
          actorId: true,
          actor: { select: { id: true, name: true, email: true } },
        },
        take: 50,
      }),
    ]);
    const facets = {
      actions: actionGroups.map((g) => ({ value: g.action, count: g._count._all })),
      entityTypes: typeGroups.map((g) => ({ value: g.entityType, count: g._count._all })),
      actors: actorGroups
        .filter((g) => g.actor !== null)
        .map((g) => ({
          id: g.actor!.id,
          name: g.actor!.name,
          email: g.actor!.email,
        })),
    };
    return ok({ items, facets });
  }

  return ok(items);
});
