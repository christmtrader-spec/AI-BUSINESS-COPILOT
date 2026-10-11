import "server-only";

/**
 * Prompt 44 — Goods Dispatch CSV export.
 *
 * LAWS (inherited verbatim from the audited P43 export):
 *  - ONE source of truth: rows are mapped through the SAME
 *    goodsDispatchLineDto mapper the detail API uses — historical
 *    snapshots, never live names.
 *  - The export covers ALL lines of the dispatch, never one page.
 *    Bounded BY DESIGN: a dispatch can never exceed
 *    GOODS_DISPATCH_MAX_LINES, so a single cap+1 fetch is provably
 *    complete; over-cap persisted data returns the controlled integrity
 *    error rather than a partial CSV.
 *  - NO money columns exist (a dispatch records quantity only).
 *  - Every cell passes the shared csvCell() OWASP formula guard (inside
 *    toCsv) — injection-safe (=1+1, +cmd, @cmd, -tab).
 *  - EN CSV gets English headers, FA CSV Persian headers (no English
 *    fallback in FA).
 *  - Product/customer identity from snapshot columns ONLY.
 *  - A corrupted persisted status is a controlled 500 (the CSV never
 *    labels unknown DB state as Draft).
 */
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-helpers";
import { toCsv } from "@/lib/csv";
import { messagesFor } from "@/i18n/messages";
import {
  GOODS_DISPATCH_CORRUPT_HISTORY,
  GOODS_DISPATCH_ERROR_CODES,
  GOODS_DISPATCH_LINE_CAP_INVARIANT,
  GoodsDispatchIntegrityError,
  computeDispatchedQty,
  goodsDispatchLineCap,
  parseGoodsDispatchStatus,
} from "./types";
import { goodsDispatchLineDto } from "./dto";

export type GoodsDispatchCsvResult = {
  csv: string;
  filename: string;
  reference: string;
  lineCount: number;
  truncated: boolean;
};

/** Business-facing, filesystem-safe reference slug (never raw user input). */
export function goodsDispatchReferenceSlug(reference: string): string {
  const slug = reference
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "goods-dispatch";
}

export async function buildGoodsDispatchCsv(input: {
  businessId: string;
  id: string;
  locale: "en" | "fa";
}): Promise<GoodsDispatchCsvResult> {
  const header = await db.goodsDispatch.findFirst({
    where: { id: input.id, businessId: input.businessId }, // tenant scope
    select: {
      id: true,
      reference: true,
      status: true,
      customerNameAtDispatch: true,
      postedAt: true,
    },
  });
  if (!header) throw new ApiError(404, "NOT_FOUND", "Goods dispatch not found.");

  // The export uses the ONE centralized status parser: a corrupted
  // persisted status is a controlled 500 integrity error — the CSV NEVER
  // labels unknown DB state as "Draft".
  let status;
  try {
    status = parseGoodsDispatchStatus(header.status);
  } catch (error) {
    if (error instanceof Error && error.name === "GoodsDispatchStatusIntegrityError") {
      throw new ApiError(
        500,
        GOODS_DISPATCH_ERROR_CODES.INVALID_PERSISTED_STATUS,
        "Goods dispatch data is in an invalid state. Please contact support.",
      );
    }
    throw error;
  }

  const cap = goodsDispatchLineCap(process.env.GOODS_DISPATCH_MAX_LINES);
  // take: cap + 1 proves completeness — cap+1 rows would mean the dispatch
  // exceeded its own line cap (impossible by the cap law), and the export
  // would report truncated instead of lying.
  const lineRows = await db.goodsDispatchLine.findMany({
    where: { goodsDispatchId: header.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], // same deterministic order as detail
    take: cap + 1,
    select: {
      id: true,
      productId: true,
      productNameAtDispatch: true,
      skuAtDispatch: true,
      unitAtDispatch: true,
      qty: true,
      reasonCode: true,
      salesOrderLineId: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const truncated = lineRows.length > cap;
  // The export covers ALL lines with cap+1 completeness proof; every
  // persisted line quantity (safe integer ≥ 1) and reason code (closed
  // vocabulary) is validated through the canonical helpers. A corrupted
  // row is a controlled integrity 500 — never a partial export and never
  // a printed zero/fabricated row.
  let lines;
  try {
    if (truncated) {
      // Persisted data exceeding the cap is corruption: the export
      // returns the controlled integrity error rather than a partial CSV.
      throw new GoodsDispatchIntegrityError(
        `${GOODS_DISPATCH_LINE_CAP_INVARIANT}: export rows exceed the document cap`,
      );
    }
    computeDispatchedQty(lineRows.map((l) => l.qty)); // validates EVERY row
    lines = lineRows.map(goodsDispatchLineDto); // reason validation
  } catch (error) {
    if (error instanceof Error && error.name === "GoodsDispatchIntegrityError") {
      const capInvariant = error.message.includes(GOODS_DISPATCH_LINE_CAP_INVARIANT);
      throw new ApiError(
        500,
        capInvariant ? GOODS_DISPATCH_LINE_CAP_INVARIANT : GOODS_DISPATCH_CORRUPT_HISTORY,
        capInvariant
          ? "Stored document data exceeds its configured line cap. Please contact support."
          : "Goods dispatch data is inconsistent. Please contact support.",
      );
    }
    throw error;
  }

  const m = messagesFor(input.locale).goodsDispatches;
  const statusLabel = m[`status_${status}`];

  // Flat extract: one row per line; document-level fields denormalized on
  // each row. NO money columns.
  const rows = lines.map((l) => [
    header.reference,
    statusLabel,
    header.customerNameAtDispatch,
    l.productNameAtDispatch,
    l.skuAtDispatch ?? "",
    l.unitAtDispatch ?? "",
    l.qty,
    l.reasonCode,
    header.postedAt ? header.postedAt.toISOString().slice(0, 10) : "",
  ]);

  const csv = toCsv(
    [
      m.csvReference,
      m.csvStatus,
      m.csvCustomer,
      m.csvProduct,
      m.csvSku,
      m.csvUnit,
      m.csvQty,
      m.csvReason,
      m.csvPostedAt,
    ],
    rows,
  );

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const filename = `goods-dispatch-${goodsDispatchReferenceSlug(header.reference)}-${stamp}.csv`;

  return { csv, filename, reference: header.reference, lineCount: lines.length, truncated };
}
