import "server-only";

/**
 * Prompt 43 — Goods Return CSV export (§103-§111).
 *
 * LAWS:
 *  - ONE source of truth: rows are mapped through the SAME
 *    goodsReturnLineDto mapper the detail API uses — historical
 *    snapshots, never live names (§104).
 *  - §105 — the export covers ALL lines of the return, never one page.
 *    Bounded BY DESIGN: a return can never exceed
 *    GOODS_RETURN_MAX_LINES, so a single cap+1 fetch is provably complete.
 *  - §104/§106 — NO money columns exist (a return records quantity only).
 *  - §239-analog — every cell passes the shared csvCell() OWASP formula
 *    guard (inside toCsv) — injection-safe (=1+1, +cmd, @cmd, -tab).
 *  - §104 — EN CSV gets English headers, FA CSV Persian headers (no
 *    English fallback in FA).
 *  - §104 — supplier/receipt/PO/product identity from snapshot columns ONLY.
 *  - §65 — a corrupted persisted status is a controlled 500 (the CSV
 *    never labels unknown DB state as Draft).
 */
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-helpers";
import { toCsv } from "@/lib/csv";
import { messagesFor } from "@/i18n/messages";
import {
  GOODS_RETURN_ERROR_CODES,
  parseGoodsReturnStatus,
  goodsReturnLineCap,
  computeReturnedQty,
  GoodsReturnIntegrityError,
  GOODS_RETURN_CORRUPT_HISTORY,
  GOODS_RETURN_LINE_CAP_INVARIANT,
} from "./types";
import { goodsReturnLineDto } from "./dto";

export type GoodsReturnCsvResult = {
  csv: string;
  filename: string;
  reference: string;
  lineCount: number;
  truncated: boolean;
};

/** Business-facing, filesystem-safe reference slug (never raw user input). */
export function goodsReturnReferenceSlug(reference: string): string {
  const slug = reference
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "goods-return";
}

export async function buildGoodsReturnCsv(input: {
  businessId: string;
  id: string;
  locale: "en" | "fa";
}): Promise<GoodsReturnCsvResult> {
  const header = await db.goodsReturn.findFirst({
    where: { id: input.id, businessId: input.businessId }, // tenant scope
    select: {
      id: true,
      reference: true,
      status: true,
      supplierNameAtReturn: true,
      goodsReceiptReferenceAtReturn: true,
      purchaseOrderReferenceAtReturn: true,
      postedAt: true,
    },
  });
  if (!header) throw new ApiError(404, "NOT_FOUND", "Goods return not found.");

  // §65 — the export uses the ONE centralized status parser: a corrupted
  // persisted status is a controlled 500 integrity error — the CSV NEVER
  // labels unknown DB state as "Draft".
  let status;
  try {
    status = parseGoodsReturnStatus(header.status);
  } catch (error) {
    if (error instanceof Error && error.name === "GoodsReturnStatusIntegrityError") {
      throw new ApiError(
        500,
        GOODS_RETURN_ERROR_CODES.INVALID_PERSISTED_STATUS,
        "Goods return data is in an invalid state. Please contact support.",
      );
    }
    throw error;
  }

  const cap = goodsReturnLineCap(process.env.GOODS_RETURN_MAX_LINES);
  // take: cap + 1 proves completeness — cap+1 rows would mean the return
  // exceeded its own line cap (impossible by §33), and the export would
  // report truncated instead of lying (§105).
  const lineRows = await db.goodsReturnLine.findMany({
    where: { goodsReturnId: header.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], // same deterministic order as detail
    take: cap + 1,
    select: {
      id: true,
      goodsReceiptLineId: true,
      productId: true,
      productNameAtReturn: true,
      skuAtReturn: true,
      unitAtReturn: true,
      returnedQty: true,
      reasonCode: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const truncated = lineRows.length > cap;
  // §67/§7/§51 — the export covers ALL lines with cap+1 completeness proof;
  // every persisted line quantity (safe integer ≥ 1) and reason code
  // (closed vocabulary) is validated through the canonical helpers. A
  // corrupted row is a controlled integrity 500 — never a partial export
  // and never a printed zero/fabricated row; over-cap persisted data
  // returns the controlled integrity error rather than a partial CSV (§67).
  let lines;
  try {
    if (truncated) {
      // §67 — persisted data exceeding the cap is corruption: the export
      // returns the controlled integrity error rather than a partial CSV.
      throw new GoodsReturnIntegrityError(
        `${GOODS_RETURN_LINE_CAP_INVARIANT}: export rows exceed the document cap`,
      );
    }
    computeReturnedQty(lineRows.map((l) => l.returnedQty)); // validates EVERY row (§7)
    lines = lineRows.slice(0, cap).map(goodsReturnLineDto); // §51 reason validation
  } catch (error) {
    if (error instanceof Error && error.name === "GoodsReturnIntegrityError") {
      const capInvariant = error.message.includes(GOODS_RETURN_LINE_CAP_INVARIANT);
      throw new ApiError(
        500,
        capInvariant ? GOODS_RETURN_LINE_CAP_INVARIANT : GOODS_RETURN_CORRUPT_HISTORY,
        capInvariant
          ? "Stored document data exceeds its configured line cap. Please contact support."
          : "Goods return data is inconsistent. Please contact support.",
      );
    }
    throw error;
  }

  const m = messagesFor(input.locale).goodsReturns;
  const statusLabel = m[`status_${status}`];

  // §104 — flat extract: one row per line; document-level fields
  // denormalized on each row. NO money columns (§104/§106).
  const rows = lines.map((l) => [
    header.reference,
    statusLabel,
    header.goodsReceiptReferenceAtReturn,
    header.purchaseOrderReferenceAtReturn,
    header.supplierNameAtReturn,
    l.productNameAtReturn,
    l.skuAtReturn ?? "",
    l.unitAtReturn ?? "",
    l.returnedQty,
    l.reasonCode,
    header.postedAt ? header.postedAt.toISOString().slice(0, 10) : "",
  ]);

  const csv = toCsv(
    [
      m.csvReference,
      m.csvStatus,
      m.csvReceiptReference,
      m.csvPurchaseOrderReference,
      m.csvSupplier,
      m.csvProduct,
      m.csvSku,
      m.csvUnit,
      m.csvReturnedQty,
      m.csvReason,
      m.csvPostedAt,
    ],
    rows,
  );

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const filename = `goods-return-${goodsReturnReferenceSlug(header.reference)}-${stamp}.csv`;

  return { csv, filename, reference: header.reference, lineCount: lines.length, truncated };
}
