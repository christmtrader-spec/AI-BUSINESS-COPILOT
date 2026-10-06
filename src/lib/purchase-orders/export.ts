import "server-only";

/**
 * Prompt 41 — Purchase Order CSV export (§97-§102, statement-CSV conventions).
 *
 * LAWS:
 *  - ONE source of truth: rows are mapped through the SAME purchaseOrderLineDto
 *    mapper the detail API uses — historical snapshots, never live names (§236).
 *  - §99/§158 — the export covers ALL lines of the order, never one page.
 *    Bounded BY DESIGN: an order can never exceed PURCHASE_ORDER_MAX_LINES,
 *    so a single cap+1 fetch is provably complete.
 *  - §151/§202-§204 — the CSV may show procurement document totals ONLY.
 *    Labels never say expense/payable/amount-owed/paid.
 *  - §23 — money stays exact integer minor units (raw minor columns;
 *    never floats, never locale-formatted decimals).
 *  - §239 — every cell passes the shared csvCell() OWASP formula guard.
 *  - §240 — EN CSV gets English headers, FA CSV Persian headers.
 *  - §241 — filename: purchase-order-<reference-slug>-<stamp>.csv (slugified,
 *    no path separators, no control characters).
 */
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-helpers";
import { toCsv } from "@/lib/csv";
import { messagesFor } from "@/i18n/messages";
import {
  PURCHASE_ORDER_ERROR_CODES,
  PURCHASE_ORDER_INVALID_PERSISTED_STATUS,
  computePurchaseOrderTotal,
  parsePurchaseOrderStatus,
  purchaseOrderLineCap,
} from "./types";
import { purchaseOrderLineDto } from "./dto";

export type PurchaseOrderCsvResult = {
  csv: string;
  filename: string;
  reference: string;
  lineCount: number;
  truncated: boolean;
  totalMinor: number;
};

/** Business-facing, filesystem-safe reference slug (never raw user input). */
export function purchaseOrderReferenceSlug(reference: string): string {
  const slug = reference
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "purchase-order";
}

export async function buildPurchaseOrderCsv(input: {
  businessId: string;
  id: string;
  locale: "en" | "fa";
}): Promise<PurchaseOrderCsvResult> {
  const header = await db.purchaseOrder.findFirst({
    where: { id: input.id, businessId: input.businessId }, // §101 — tenant scope
    select: {
      id: true,
      reference: true,
      status: true,
      supplierNameAtOrder: true,
      currencyCodeAtOrder: true,
      orderedAt: true,
      expectedDate: true,
    },
  });
  if (!header) throw new ApiError(404, "NOT_FOUND", "Purchase order not found.");

  // §15 — the export uses the ONE centralized status parser: a corrupted
  // persisted status is a controlled 500 integrity error — the CSV NEVER
  // labels unknown DB state as "Draft".
  let status;
  try {
    status = parsePurchaseOrderStatus(header.status);
  } catch {
    throw new ApiError(
      500,
      PURCHASE_ORDER_INVALID_PERSISTED_STATUS,
      "Purchase order data is in an invalid state. Please contact support.",
    );
  }

  const cap = purchaseOrderLineCap(process.env.PURCHASE_ORDER_MAX_LINES);
  // take: cap + 1 proves completeness — cap+1 rows would mean the order
  // exceeded its own line cap (impossible by §33), and the export would
  // report truncated instead of lying.
  const lineRows = await db.purchaseOrderLine.findMany({
    where: { purchaseOrderId: header.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], // same deterministic order as detail
    take: cap + 1,
    select: {
      id: true,
      productId: true,
      productNameAtOrder: true,
      skuAtOrder: true,
      unitAtOrder: true,
      orderedQty: true,
      unitPriceMinor: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const truncated = lineRows.length > cap;
  const lines = lineRows.slice(0, cap).map(purchaseOrderLineDto);

  // §19 — the SAME canonical BigInt total function as create/list/detail —
  // no second overflow policy. An unsafe total fails honestly (422) instead
  // of emitting a silently rounded number.
  let totalMinor: number;
  try {
    totalMinor = computePurchaseOrderTotal(lines).totalMinor;
  } catch (error) {
    if (error instanceof Error && error.message === "PURCHASE_ORDER_TOTAL_OVERFLOW") {
      throw new ApiError(
        422,
        PURCHASE_ORDER_ERROR_CODES.TOTAL_OVERFLOW,
        "This purchase order total exceeds the safe numeric range.",
      );
    }
    throw error;
  }

  const m = messagesFor(input.locale).purchaseOrders;
  const statusLabel = m[`status_${status}`];

  // Flat extract: one row per line; order-level fields denormalized on each
  // row (machine-readable; the document total is a constant column — it is
  // a procurement document total ONLY, §151).
  const rows = lines.map((l) => [
    header.reference,
    statusLabel,
    header.supplierNameAtOrder,
    l.productNameAtOrder,
    l.skuAtOrder ?? "",
    l.unitAtOrder ?? "",
    l.orderedQty,
    l.unitPriceMinor,
    l.lineTotalMinor,
    totalMinor,
    header.currencyCodeAtOrder,
    header.orderedAt.toISOString().slice(0, 10),
    header.expectedDate ? header.expectedDate.toISOString().slice(0, 10) : "",
  ]);

  const csv = toCsv(
    [
      m.csvReference,
      m.csvStatus,
      m.csvSupplier,
      m.csvProduct,
      m.csvSku,
      m.csvUnit,
      m.csvOrderedQty,
      m.csvUnitPriceMinor,
      m.csvLineTotalMinor,
      m.csvOrderTotalMinor,
      m.csvCurrency,
      m.csvOrderedAt,
      m.csvExpectedDate,
    ],
    rows,
  );

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const filename = `purchase-order-${purchaseOrderReferenceSlug(header.reference)}-${stamp}.csv`;

  return { csv, filename, reference: header.reference, lineCount: lines.length, truncated, totalMinor };
}
