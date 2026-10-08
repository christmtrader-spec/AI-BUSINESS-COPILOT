import "server-only";

/**
 * Prompt 42 — Goods Receipt CSV export (§125-§134).
 *
 * LAWS:
 *  - ONE source of truth: rows are mapped through the SAME
 *    goodsReceiptLineDto mapper the detail API uses — historical
 *    snapshots, never live names (§127).
 *  - §128 — the export covers ALL lines of the receipt, never one page.
 *    Bounded BY DESIGN: a receipt can never exceed
 *    GOODS_RECEIPT_MAX_LINES, so a single cap+1 fetch is provably complete.
 *  - §126 — NO money columns exist (a receipt records quantity only).
 *  - §239-analog — every cell passes the shared csvCell() OWASP formula
 *    guard (inside toCsv).
 *  - §130 — EN CSV gets English headers, FA CSV Persian headers (no
 *    English fallback in FA).
 *  - §127 — supplier/PO/product identity from snapshot columns ONLY.
 *  - §96 — a corrupted persisted status is a controlled 500 (the CSV
 *    never labels unknown DB state as Draft).
 */
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-helpers";
import { toCsv } from "@/lib/csv";
import { messagesFor } from "@/i18n/messages";
import {
  GOODS_RECEIPT_ERROR_CODES,
  parseGoodsReceiptStatus,
  goodsReceiptLineCap,
} from "./types";
import { goodsReceiptLineDto } from "./dto";

export type GoodsReceiptCsvResult = {
  csv: string;
  filename: string;
  reference: string;
  lineCount: number;
  truncated: boolean;
};

/** Business-facing, filesystem-safe reference slug (never raw user input). */
export function goodsReceiptReferenceSlug(reference: string): string {
  const slug = reference
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "goods-receipt";
}

export async function buildGoodsReceiptCsv(input: {
  businessId: string;
  id: string;
  locale: "en" | "fa";
}): Promise<GoodsReceiptCsvResult> {
  const header = await db.goodsReceipt.findFirst({
    where: { id: input.id, businessId: input.businessId }, // tenant scope
    select: {
      id: true,
      reference: true,
      status: true,
      supplierNameAtReceipt: true,
      purchaseOrderReferenceAtReceipt: true,
      postedAt: true,
    },
  });
  if (!header) throw new ApiError(404, "NOT_FOUND", "Goods receipt not found.");

  // §96 — the export uses the ONE centralized status parser: a corrupted
  // persisted status is a controlled 500 integrity error — the CSV NEVER
  // labels unknown DB state as "Draft".
  let status;
  try {
    status = parseGoodsReceiptStatus(header.status);
  } catch (error) {
    if (error instanceof Error && error.name === "GoodsReceiptStatusIntegrityError") {
      throw new ApiError(
        500,
        GOODS_RECEIPT_ERROR_CODES.INVALID_PERSISTED_STATUS,
        "Goods receipt data is in an invalid state. Please contact support.",
      );
    }
    throw error;
  }

  const cap = goodsReceiptLineCap(process.env.GOODS_RECEIPT_MAX_LINES);
  // take: cap + 1 proves completeness — cap+1 rows would mean the receipt
  // exceeded its own line cap (impossible by §20), and the export would
  // report truncated instead of lying.
  const lineRows = await db.goodsReceiptLine.findMany({
    where: { goodsReceiptId: header.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], // same deterministic order as detail
    take: cap + 1,
    select: {
      id: true,
      purchaseOrderLineId: true,
      productId: true,
      productNameAtReceipt: true,
      skuAtReceipt: true,
      unitAtReceipt: true,
      receivedQty: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const truncated = lineRows.length > cap;
  const lines = lineRows.slice(0, cap).map(goodsReceiptLineDto);

  const m = messagesFor(input.locale).goodsReceipts;
  const statusLabel = m[`status_${status}`];

  // §126 — flat extract: one row per line; document-level fields
  // denormalized on each row. NO money columns (§37/§38).
  const rows = lines.map((l) => [
    header.reference,
    statusLabel,
    header.purchaseOrderReferenceAtReceipt,
    header.supplierNameAtReceipt,
    l.productNameAtReceipt,
    l.skuAtReceipt ?? "",
    l.unitAtReceipt ?? "",
    l.receivedQty,
    header.postedAt ? header.postedAt.toISOString().slice(0, 10) : "",
  ]);

  const csv = toCsv(
    [
      m.csvReference,
      m.csvStatus,
      m.csvPurchaseOrderReference,
      m.csvSupplier,
      m.csvProduct,
      m.csvSku,
      m.csvUnit,
      m.csvReceivedQty,
      m.csvPostedAt,
    ],
    rows,
  );

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const filename = `goods-receipt-${goodsReceiptReferenceSlug(header.reference)}-${stamp}.csv`;

  return { csv, filename, reference: header.reference, lineCount: lines.length, truncated };
}
