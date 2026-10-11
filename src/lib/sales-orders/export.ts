import "server-only";

/**
 * Prompt 45 — Sales Order CSV export (§114/§115).
 *
 * LAWS (inherited verbatim from the audited P42–P44 exports):
 *  - ONE source of truth: lines are validated through the SAME canonical
 *    helpers the detail API uses — historical snapshots, never live names.
 *  - The export covers ALL lines of the order, never one page. Bounded BY
 *    DESIGN: an order can never exceed SALES_ORDER_MAX_LINES, so a single
 *    cap+1 fetch is provably complete; over-cap persisted data returns
 *    the controlled integrity error rather than a partial CSV.
 *  - Every cell passes the shared csvCell() OWASP formula guard (inside
 *    toCsv) — injection-safe (=1+1, +cmd, @cmd, -tab).
 *  - EN CSV gets English headers, FA CSV Persian headers (no English
 *    fallback in FA).
 *  - Product/customer identity from snapshot columns ONLY.
 *  - A corrupted persisted status is a controlled 500 (the CSV never
 *    labels unknown DB state as Draft).
 *  - Fulfillment numbers come from the ONE canonical POSTED-only
 *    aggregate (§36); the invoice columns appear ONLY when the linked
 *    invoice exists (§114).
 */
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-helpers";
import { toCsv } from "@/lib/csv";
import { messagesFor } from "@/i18n/messages";
import {
  computeOrderLineTotalMinor,
  computeOrderSubtotalMinor,
  computeOrderTotalMinor,
  computeRemainingToDispatchQty,
  isValidOrderPrice,
  isValidPersistedOrderQty,
  parseSalesOrderStatus,
  salesOrderLineCap,
  SalesOrderIntegrityError,
  SALES_ORDER_ERROR_CODES,
  SALES_ORDER_LINE_CAP_INVARIANT,
} from "./types";
import { mapPureSalesOrderDomainError, sumPostedDispatchedQtyBySalesOrderLines } from "./integration";

export type SalesOrderCsvResult = {
  csv: string;
  filename: string;
  reference: string;
  lineCount: number;
  truncated: boolean;
};

/** Business-facing, filesystem-safe reference slug (never raw user input). */
export function salesOrderReferenceSlug(reference: string): string {
  const slug = reference
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "sales-order";
}

export async function buildSalesOrderCsv(input: {
  businessId: string;
  id: string;
  locale: "en" | "fa";
}): Promise<SalesOrderCsvResult> {
  const header = await db.salesOrder.findFirst({
    where: { id: input.id, businessId: input.businessId }, // tenant scope
    select: {
      id: true,
      reference: true,
      status: true,
      customerNameAtOrder: true,
      orderDate: true,
      expectedDate: true,
      discountMinor: true,
      sale: { select: { number: true, status: true } },
    },
  });
  if (!header) throw new ApiError(404, "NOT_FOUND", "Sales order not found.");

  // The export uses the ONE centralized status parser: a corrupted
  // persisted status is a controlled 500 integrity error — the CSV NEVER
  // labels unknown DB state as "Draft" (§108 applies to export too).
  let status;
  try {
    status = parseSalesOrderStatus(header.status);
  } catch (error) {
    mapPureSalesOrderDomainError(error);
  }

  const cap = salesOrderLineCap(process.env.SALES_ORDER_MAX_LINES);
  // take: cap + 1 proves completeness — cap+1 rows would mean the order
  // exceeded its own line cap (impossible by the cap law), and the export
  // would fail with the integrity error instead of lying (§106).
  const lineRows = await db.salesOrderLine.findMany({
    where: { salesOrderId: header.id },
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
    },
  });

  const truncated = lineRows.length > cap;
  let lines;
  try {
    if (truncated) {
      // Persisted data exceeding the cap is corruption: the export
      // returns the controlled integrity error rather than a partial CSV.
      throw new SalesOrderIntegrityError(
        `${SALES_ORDER_LINE_CAP_INVARIANT}: export rows exceed the document cap`,
      );
    }
    // Every persisted line is validated through the canonical laws (§18/
    // §21/§106) and the fulfillment numbers come from the ONE aggregate.
    for (const line of lineRows) {
      if (!isValidPersistedOrderQty(line.orderedQty) || !isValidOrderPrice(line.unitPriceMinor)) {
        throw new SalesOrderIntegrityError(
          `${SALES_ORDER_ERROR_CODES.CORRUPT_HISTORY}: invalid persisted line`,
        );
      }
    }
    const dispatchedMap = await sumPostedDispatchedQtyBySalesOrderLines(
      db,
      lineRows.map((l) => l.id),
    );
    lines = lineRows.map((l) => {
      const fulfillment = computeRemainingToDispatchQty(
        l.orderedQty,
        dispatchedMap.get(l.id) ?? 0,
      );
      return {
        productNameAtOrder: l.productNameAtOrder,
        skuAtOrder: l.skuAtOrder,
        unitAtOrder: l.unitAtOrder,
        orderedQty: l.orderedQty,
        unitPriceMinor: l.unitPriceMinor,
        lineTotalMinor: computeOrderLineTotalMinor(l.orderedQty, l.unitPriceMinor),
        dispatchedQty: fulfillment.dispatchedQty,
        remainingToDispatchQty: fulfillment.remainingToDispatchQty,
      };
    });
  } catch (error) {
    if (error instanceof SalesOrderIntegrityError) {
      mapPureSalesOrderDomainError(error);
    }
    throw error;
  }

  const totals = computeOrderSubtotalMinor(lines);
  const totalMinor = computeOrderTotalMinor(totals.subtotalMinor, header.discountMinor);

  const m = messagesFor(input.locale).salesOrders;
  const statusLabel = m[`status_${status}`];

  // Flat extract: one row per line; document-level fields denormalized on
  // each row (§114 — includes fulfillment + invoice reference/status).
  const rows = lines.map((l) => [
    header.reference,
    statusLabel,
    header.customerNameAtOrder,
    header.orderDate.toISOString().slice(0, 10),
    header.expectedDate ? header.expectedDate.toISOString().slice(0, 10) : "",
    l.productNameAtOrder,
    l.skuAtOrder ?? "",
    l.unitAtOrder ?? "",
    l.orderedQty,
    l.unitPriceMinor,
    l.lineTotalMinor,
    header.discountMinor,
    totalMinor,
    l.dispatchedQty,
    l.remainingToDispatchQty,
    header.sale ? String(header.sale.number) : "",
    header.sale ? header.sale.status : "",
  ]);

  const csv = toCsv(
    [
      m.csvReference,
      m.csvStatus,
      m.csvCustomer,
      m.csvOrderDate,
      m.csvExpectedDate,
      m.csvProduct,
      m.csvSku,
      m.csvUnit,
      m.csvOrderedQty,
      m.csvUnitPrice,
      m.csvLineTotal,
      m.csvDiscount,
      m.csvTotal,
      m.csvDispatchedQty,
      m.csvRemainingQty,
      m.csvInvoiceNumber,
      m.csvInvoiceStatus,
    ],
    rows,
  );

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const filename = `sales-order-${salesOrderReferenceSlug(header.reference)}-${stamp}.csv`;

  return { csv, filename, reference: header.reference, lineCount: lines.length, truncated };
}
