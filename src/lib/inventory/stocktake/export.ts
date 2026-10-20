/**
 * Prompt 40 round 2 — Stocktake CSV export (statement-CSV conventions §76–§83).
 *
 * LAWS:
 *  - §132/§133 spirit — ONE source of truth: rows are mapped through the
 *    SAME stocktakeLineDto mapper the detail API uses (historical snapshots
 *    for counted lines; current-product fallback ONLY for uncounted DRAFT
 *    preparation lines, §19).
 *  - §184 (full coverage) — the export covers ALL lines of the stocktake,
 *    never one page. This is bounded BY DESIGN: a stocktake can never hold
 *    more lines than INVENTORY_STOCKTAKE_MAX_LINES (default 1000, §61), so
 *    a single capped fetch is provably complete.
 *  - §82 — NO monetary values: quantities and dates only.
 *  - §176 — every cell passes the shared csvCell() OWASP formula guard.
 *  - §81 — UTF-8 with BOM so Persian product names survive Excel.
 *  - §121 — no internal database ids in the CSV body; business-facing
 *    reference only. Filename: stocktake-<reference-slug>-<stamp>.csv.
 */
import "server-only";

import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-helpers";
import { toCsv } from "@/lib/csv";
import { messagesFor } from "@/i18n/messages";
import { isStocktakeStatus, stocktakeLineCap } from "./types";
import { stocktakeLineDto } from "./dto";
import { referenceSlug } from "@/lib/filename-slug";

export type StocktakeCsvResult = {
  csv: string;
  filename: string;
  reference: string;
  lineCount: number;
  truncated: boolean;
};

/**
 * Business-facing, filesystem-safe reference slug (never raw user input).
 * Pure law lives in @/lib/filename-slug (server-only here is for the db path
 * below, not for the slug); re-exported for server callers.
 */
export function stocktakeReferenceSlug(reference: string): string {
  return referenceSlug(reference, "stocktake");
}

export async function buildStocktakeCsv(input: {
  businessId: string;
  id: string;
  locale: "en" | "fa";
}): Promise<StocktakeCsvResult> {
  const header = await db.inventoryStocktake.findFirst({
    where: { id: input.id, businessId: input.businessId }, // §54 — tenant scope
    select: { id: true, reference: true, status: true },
  });
  if (!header) throw new ApiError(404, "NOT_FOUND", "Stocktake not found.");

  const cap = stocktakeLineCap(process.env.INVENTORY_STOCKTAKE_MAX_LINES);
  // take: cap + 1 proves completeness — if this ever returned cap + 1 rows
  // the stocktake exceeded its own line cap (impossible by §61), and the
  // export would report truncated instead of lying.
  const lineRows = await db.inventoryStocktakeLine.findMany({
    where: { stocktakeId: header.id },
    orderBy: [{ countedAt: "asc" }, { id: "asc" }], // same deterministic order as detail
    take: cap + 1,
    select: {
      id: true,
      productId: true,
      productNameAtCount: true,
      skuAtCount: true,
      unitAtCount: true,
      systemQtyAtCount: true,
      countedQty: true,
      varianceQty: true,
      countedAt: true,
      countedByUser: { select: { id: true, name: true, email: true } },
      product: { select: { name: true, sku: true, unit: true, stockQty: true } },
    },
  });

  const truncated = lineRows.length > cap;
  const lines = lineRows.slice(0, cap).map(stocktakeLineDto);

  const m = messagesFor(input.locale).inventory.stocktakes;
  const statusKey = `status_${isStocktakeStatus(header.status) ? header.status : "DRAFT"}` as keyof typeof m;
  const statusLabel = () => m[statusKey] ?? header.status;

  const rows = lines.map((l) => [
    header.reference,
    statusLabel(),
    l.productNameAtCount,
    l.skuAtCount ?? "",
    l.unitAtCount ?? "",
    l.systemQtyAtCount,
    // Uncounted (DRAFT preparation) lines export BLANK counted/variance —
    // honest absence, never a fake zero (§29 epoch-0 sentinel law).
    l.countedQty == null ? "" : l.countedQty,
    l.varianceQty == null ? "" : l.varianceQty,
    l.countedAt ?? "",
    l.countedBy ? (l.countedBy.name ?? l.countedBy.email) : "",
  ]);

  const csv = toCsv(
    [
      m.csvReference,
      m.csvStatus,
      m.csvProduct,
      m.csvSku,
      m.csvUnit,
      m.csvSystemQty,
      m.csvCountedQty,
      m.csvVariance,
      m.csvCountedAt,
      m.csvCountedBy,
    ],
    rows,
  );

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const filename = `stocktake-${stocktakeReferenceSlug(header.reference)}-${stamp}.csv`;

  return { csv, filename, reference: header.reference, lineCount: lines.length, truncated };
}
