/**
 * GET /api/v1/inventory/adjustments — stock adjustment history feed.
 *
 * Round 2 upgrade (was: unbounded take-only feed returning raw Prisma rows):
 *  - DTO allowlist (§116/§117) — never a raw Prisma object;
 *  - filters: direction (INCREASE|DECREASE), productId, q (product name/sku),
 *    from/to (strict business-calendar dates, A07 — §93-style window);
 *  - pagination: page/pageSize (listParams law, cap 100) + `total`;
 *    legacy `take` (1–200) stays supported as a page-1 alias for the
 *    existing smoke contract;
 *  - `?format=csv` — accountant-friendly CSV of ALL matching rows up to
 *    INVENTORY_ADJUSTMENT_EXPORT_CAP (1,000 — mirrors AGING_SCAN_CAP /
 *    the stocktake line cap), gated by CSV_EXPORT (§34/§80) + the export
 *    rate limit + "data.export" audit, with an honest truncated flag in
 *    the audit record.
 *
 * Written by products/[id]/stock (P31) and stocktake finalize (P40 §689+);
 * this endpoint is strictly read-only.
 */
import { NextRequest, NextResponse } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { assertFeatureAccess } from "@/lib/billing";
import { listParams } from "@/lib/schemas";
import { isValidEntityId } from "@/lib/entity-routes";
import { toCsv } from "@/lib/csv";
import { messagesFor } from "@/i18n/messages";
import { resolveStatementWindow, StatementValidationError } from "@/lib/statements/schema";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

/** Export honesty cap — mirrors AGING_SCAN_CAP (aging) and the stocktake
 * line cap: 1,000 rows maximum per export, truncation surfaced upstream. */
export const INVENTORY_ADJUSTMENT_EXPORT_CAP = 1000;
const EXPORT_CHUNK = 200;

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Strict calendar validation (P40 law): 2026-02-31 must NEVER silently
 * roll over to March. Returns an normalized "YYYY-MM-DD" or null. */
function calendarDate(raw: string | null): string | null {
  if (!raw || !CALENDAR_DATE.test(raw)) return null;
  const [y, mo, d] = raw.split("-").map(Number);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d
    ? raw
    : null;
}

type AdjustmentDto = {
  id: string;
  createdAt: string;
  delta: number;
  reason: string;
  productId: string;
  product: { name: string; sku: string | null; unit: string | null };
  actor: { name: string | null; email: string } | null;
};

type AdjustmentRow = {
  id: string;
  delta: number;
  reason: string;
  createdAt: Date;
  productId: string;
  product: { name: string; sku: string | null; unit: string | null } | null;
  actor: { name: string | null; email: string } | null;
};

function toDto(row: AdjustmentRow): AdjustmentDto {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    delta: row.delta,
    reason: row.reason,
    productId: row.productId,
    product: {
      name: row.product?.name ?? "",
      sku: row.product?.sku ?? null,
      unit: row.product?.unit ?? null,
    },
    actor: row.actor ? { name: row.actor.name, email: row.actor.email } : null,
  };
}

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  const url = req.nextUrl;
  const { q, page, pageSize } = listParams(url);

  // Legacy `take` alias (smoke contract): page-1 pageSize, clamp 1–200.
  let size = pageSize;
  const takeRaw = Number(url.searchParams.get("take") ?? NaN);
  if (!Number.isNaN(takeRaw) && url.searchParams.get("pageSize") == null) {
    size = Number.isInteger(takeRaw) && takeRaw > 0 && takeRaw <= 200 ? takeRaw : 50;
  }

  // ---- filters ------------------------------------------------------------
  const directionRaw = (url.searchParams.get("direction") ?? "").trim().toUpperCase();
  if (directionRaw && directionRaw !== "INCREASE" && directionRaw !== "DECREASE") {
    throw new ApiError(422, "VALIDATION_ERROR", "'direction' must be 'INCREASE' or 'DECREASE'.", {
      field: "direction",
    });
  }

  const productIdRaw = (url.searchParams.get("productId") ?? "").trim();
  if (productIdRaw && !isValidEntityId(productIdRaw)) {
    throw new ApiError(422, "VALIDATION_ERROR", "Invalid productId.", { field: "productId" });
  }

  const fromRaw = (url.searchParams.get("from") ?? "").trim();
  const toRaw = (url.searchParams.get("to") ?? "").trim();
  const hasFrom = fromRaw !== "";
  const hasTo = toRaw !== "";
  if (hasFrom !== hasTo) {
    throw new ApiError(422, "VALIDATION_ERROR", "'from' and 'to' must be provided together.", {
      field: hasFrom ? "to" : "from",
    });
  }
  let window: { from: Date; until: Date } | null = null;
  if (hasFrom && hasTo) {
    const from = calendarDate(fromRaw);
    const to = calendarDate(toRaw);
    if (!from || !to) {
      throw new ApiError(422, "VALIDATION_ERROR", "Dates must be real calendar days (YYYY-MM-DD).", {
        field: !from ? "from" : "to",
      });
    }
    if (from > to) {
      throw new ApiError(422, "VALIDATION_ERROR", "'from' must be on or before 'to'.", { field: "from" });
    }
    try {
      window = resolveStatementWindow(from, to, ctx.business.timezone || "UTC");
    } catch (error) {
      if (error instanceof StatementValidationError) {
        throw new ApiError(422, "VALIDATION_ERROR", error.message, { field: error.field });
      }
      throw error;
    }
  }

  const where: Prisma.InventoryAdjustmentWhereInput = {
    businessId: ctx.businessId,
    ...(directionRaw === "INCREASE" ? { delta: { gt: 0 } } : {}),
    ...(directionRaw === "DECREASE" ? { delta: { lt: 0 } } : {}),
    ...(productIdRaw ? { productId: productIdRaw } : {}),
    ...(q
      ? { product: { is: { OR: [{ name: { contains: q } }, { sku: { contains: q } }] } } }
      : {}),
    ...(window ? { createdAt: { gte: window.from, lt: window.until } } : {}),
  };

  // ---- CSV branch (§34/§80 conventions, same as audit/reports) -------------
  if (url.searchParams.get("format") === "csv") {
    await assertFeatureAccess(ctx.businessId, "CSV_EXPORT");

    const rl = rateLimit(`adjustment-export:${ctx.userId}`, 10, 5 * 60_000);
    if (!rl.allowed) {
      throw new ApiError(429, "RATE_LIMITED", "Too many exports in a short time. Please wait a moment.", {
        retryAfterMs: rl.retryAfterMs,
      });
    }

    const locale: "en" | "fa" = url.searchParams.get("locale") === "fa" ? "fa" : "en";
    const m = messagesFor(locale).inventory;
    const st = messagesFor(locale).inventory.stocktakes;
    const directionLabel = (delta: number) => (delta > 0 ? st.increase : st.decrease);

    const total = await db.inventoryAdjustment.count({ where });
    const capped = Math.min(total, INVENTORY_ADJUSTMENT_EXPORT_CAP);
    const truncated = total > capped;

    const headers = [m.csvCreatedAt, m.csvProduct, m.csvSku, m.csvUnit, m.csvDirection, m.csvQuantity, m.csvReason, m.csvBy];
    const lines: Array<Array<string | number>> = [];
    for (let skip = 0; skip < capped; skip += EXPORT_CHUNK) {
      const chunk = await db.inventoryAdjustment.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take: Math.min(EXPORT_CHUNK, capped - skip),
        select: {
          id: true,
          delta: true,
          reason: true,
          createdAt: true,
          productId: true,
          product: { select: { name: true, sku: true, unit: true } },
          actor: { select: { name: true, email: true } },
        },
      });
      for (const r of chunk) {
        lines.push([
          r.createdAt.toISOString(),
          r.product?.name ?? "",
          r.product?.sku ?? "",
          r.product?.unit ?? "",
          directionLabel(r.delta),
          r.delta,
          r.reason,
          r.actor ? (r.actor.name ?? r.actor.email) : "",
        ]);
      }
      if (chunk.length < EXPORT_CHUNK) break;
    }

    const csv = toCsv(headers, lines);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const filename = `inventory-adjustments-${stamp}.csv`;

    void audit({
      businessId: ctx.businessId,
      actorId: ctx.userId,
      action: "data.export",
      entityType: "AdjustmentCSV",
      entityId: null,
      after: {
        format: "csv",
        rows: lines.length,
        truncated,
        filters: { direction: directionRaw || null, q: q || null, from: hasFrom ? fromRaw : null, to: hasTo ? toRaw : null },
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

  // ---- JSON branch ---------------------------------------------------------
  const [total, rows] = await Promise.all([
    db.inventoryAdjustment.count({ where }),
    db.inventoryAdjustment.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * size,
      take: size,
      select: {
        id: true,
        delta: true,
        reason: true,
        createdAt: true,
        productId: true,
        product: { select: { name: true, sku: true, unit: true } },
        actor: { select: { name: true, email: true } },
      },
    }),
  ]);

  return ok({
    items: rows.map(toDto),
    total,
    page,
    pageSize: size,
  });
});
