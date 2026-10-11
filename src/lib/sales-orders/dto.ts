/**
 * Prompt 45 — client-safe Sales Order DTOs + pure mappers.
 *
 * DTO LAWS (inherited from the audited P41–P44 pattern):
 *  - explicit allowlist — a raw Prisma object is NEVER serialized (§113);
 *  - every date is an ISO-8601 UTC string;
 *  - product/customer identity comes from the SNAPSHOT columns —
 *    historical values are never replaced with live names (§109);
 *  - money is integer minor units; quantities are exact integers;
 *  - the linked-invoice DTO appears ONLY when the relation is actually
 *    present (§65/§91 — never inferred from order status);
 *  - DTO mappers REQUIRE an already-valid status: an unknown persisted
 *    value throws the controlled integrity error (never silently DRAFT);
 *  - fulfillment numbers arrive pre-aggregated and are re-validated via
 *    the ONE canonical remaining-quantity law.
 */
import {
  computeOrderLineTotalMinor,
  computeOrderTotalMinor,
  computeRemainingToDispatchQty,
  parseSalesOrderStatus,
  SalesOrderIntegrityError,
  SALES_ORDER_CORRUPT_HISTORY,
  type SalesOrderStatus,
} from "./types";

/* -------------------------------- types ---------------------------------- */

/** Bounded, lighter-than-detail list row (§66). */
export type SalesOrderListItemDto = {
  id: string;
  reference: string;
  status: SalesOrderStatus;
  customerId: string | null;
  customerNameAtOrder: string;
  orderDate: string;
  expectedDate: string | null;
  lineCount: number;
  totalQty: number;
  totalMinor: number;
  dispatchedQty: number;
  remainingToDispatchQty: number;
  invoiceNumber: number | null;
  invoiceStatus: string | null;
  createdAt: string;
};

/** Detail line — snapshot identity + per-line fulfillment (§65). */
export type SalesOrderLineDto = {
  id: string;
  productId: string;
  productNameAtOrder: string;
  skuAtOrder: string | null;
  unitAtOrder: string | null;
  orderedQty: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  dispatchedQty: number;
  remainingToDispatchQty: number;
  createdAt: string;
  updatedAt: string;
};

/** Linked invoice projection — appears ONLY when present (§65). */
export type SalesOrderInvoiceDto = {
  id: string;
  number: number;
  status: string;
  totalMinor: number;
  paidMinor: number;
};

/** Detail document (order + summary + lines + linked invoice) (§65). */
export type SalesOrderDetailDto = {
  order: {
    id: string;
    reference: string;
    status: SalesOrderStatus;
    customerId: string | null;
    customerNameAtOrder: string;
    currencyCodeAtOrder: string;
    currencySymbolAtOrder: string;
    decimalPrecisionAtOrder: number;
    orderDate: string;
    expectedDate: string | null;
    discountMinor: number;
    notes: string | null;
    createdBy: { id: string; name: string | null } | null;
    confirmedAt: string | null;
    completedAt: string | null;
    cancelledAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  summary: {
    lineCount: number;
    totalQty: number;
    subtotalMinor: number;
    discountMinor: number;
    totalMinor: number;
    dispatchedQty: number;
    remainingToDispatchQty: number;
    fullyDispatched: boolean;
  };
  lines: SalesOrderLineDto[];
  invoice: SalesOrderInvoiceDto | null;
};

/** §90 — recent linked dispatch row for the order detail (≤10). */
export type SalesOrderRecentDispatchDto = {
  id: string;
  reference: string;
  status: string;
  postedAt: string | null;
  totalDispatchedQty: number;
};

/** §71 — bounded order row for the Customer 360 (≤10). */
export type CustomerRecentSalesOrderDto = {
  id: string;
  reference: string;
  status: SalesOrderStatus;
  orderDate: string;
  currencyCodeAtOrder: string;
  currencySymbolAtOrder: string;
  decimalPrecisionAtOrder: number;
  totalMinor: number;
  orderedQty: number;
  dispatchedQty: number;
  invoiceNumber: number | null;
  invoiceStatus: string | null;
};

/** §72 — bounded order row for the Product detail (≤10). */
export type ProductRecentSalesOrderDto = {
  id: string;
  reference: string;
  customerNameAtOrder: string;
  status: SalesOrderStatus;
  orderDate: string;
  orderedQty: number;
  dispatchedQty: number;
  remainingToDispatchQty: number;
};

/* ------------------------------- row shapes ------------------------------- */

type DateLike = Date | string;

function iso(value: DateLike): string {
  return typeof value === "string" ? value : value.toISOString();
}

function isoOrNull(value: DateLike | null): string | null {
  if (value == null) return null;
  return iso(value);
}

/** DTO mappers REQUIRE an already-valid status (INVALID ≠ DRAFT, §108). */
function statusOf(value: string): SalesOrderStatus {
  return parseSalesOrderStatus(value);
}

/** Persisted-money sanity: every money field must be a safe integer. */
function assertSafeMoney(value: number, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new SalesOrderIntegrityError(
      `${SALES_ORDER_CORRUPT_HISTORY}: ${field} ${String(value)}`,
    );
  }
  return value;
}

export type SalesOrderHeaderRow = {
  id: string;
  reference: string;
  status: string;
  customerId: string | null;
  customerNameAtOrder: string;
  currencyCodeAtOrder: string;
  currencySymbolAtOrder: string;
  decimalPrecisionAtOrder: number;
  orderDate: DateLike;
  expectedDate: DateLike | null;
  discountMinor: number;
  notes: string | null;
  createdByUserId: string;
  createdByName: string | null;
  confirmedAt: DateLike | null;
  completedAt: DateLike | null;
  cancelledAt: DateLike | null;
  createdAt: DateLike;
  updatedAt: DateLike;
};

export type SalesOrderLineRow = {
  id: string;
  productId: string;
  productNameAtOrder: string;
  skuAtOrder: string | null;
  unitAtOrder: string | null;
  orderedQty: number;
  unitPriceMinor: number;
  createdAt: DateLike;
  updatedAt: DateLike;
};

/** A persisted line must carry a valid quantity, price and snapshot. */
function validatePersistedLine(line: SalesOrderLineRow): void {
  if (
    typeof line.orderedQty !== "number" ||
    !Number.isSafeInteger(line.orderedQty) ||
    line.orderedQty < 1
  ) {
    throw new SalesOrderIntegrityError(
      `${SALES_ORDER_CORRUPT_HISTORY}: persisted orderedQty ${String(line.orderedQty)}`,
    );
  }
  if (
    typeof line.unitPriceMinor !== "number" ||
    !Number.isSafeInteger(line.unitPriceMinor) ||
    line.unitPriceMinor < 0
  ) {
    throw new SalesOrderIntegrityError(
      `${SALES_ORDER_CORRUPT_HISTORY}: persisted unitPriceMinor ${String(line.unitPriceMinor)}`,
    );
  }
  // §109 — a MISSING product snapshot would make the document misleading;
  // surface corruption instead of substituting unrelated live values.
  if (typeof line.productNameAtOrder !== "string" || line.productNameAtOrder.length === 0) {
    throw new SalesOrderIntegrityError(
      `${SALES_ORDER_CORRUPT_HISTORY}: missing productNameAtOrder snapshot`,
    );
  }
}

/* -------------------------------- mappers --------------------------------- */

/** Line mapper — per-line fulfillment arrives pre-aggregated (§36). */
export function salesOrderLineDto(
  line: SalesOrderLineRow,
  dispatchedQty: number,
): SalesOrderLineDto {
  validatePersistedLine(line);
  const fulfillment = computeRemainingToDispatchQty(line.orderedQty, dispatchedQty);
  return {
    id: line.id,
    productId: line.productId,
    productNameAtOrder: line.productNameAtOrder,
    skuAtOrder: line.skuAtOrder,
    unitAtOrder: line.unitAtOrder,
    orderedQty: line.orderedQty,
    unitPriceMinor: line.unitPriceMinor,
    lineTotalMinor: computeOrderLineTotalMinor(line.orderedQty, line.unitPriceMinor),
    dispatchedQty: fulfillment.dispatchedQty,
    remainingToDispatchQty: fulfillment.remainingToDispatchQty,
    createdAt: iso(line.createdAt),
    updatedAt: iso(line.updatedAt),
  };
}

/** Detail mapper; totals via the ONE canonical math (§24). */
export function salesOrderDetailDto(
  row: SalesOrderHeaderRow,
  lines: ReadonlyArray<{ row: SalesOrderLineRow; dispatchedQty: number }>,
  invoice: SalesOrderInvoiceDto | null,
): SalesOrderDetailDto {
  const mapped = lines.map((l) => salesOrderLineDto(l.row, l.dispatchedQty));
  const subtotalMinor = mapped.reduce((acc, l) => acc + l.lineTotalMinor, 0);
  const totalMinor = computeOrderTotalMinor(subtotalMinor, row.discountMinor);
  const totalQty = mapped.reduce((acc, l) => acc + l.orderedQty, 0);
  const dispatchedQty = mapped.reduce((acc, l) => acc + l.dispatchedQty, 0);
  const remainingToDispatchQty = mapped.reduce(
    (acc, l) => acc + l.remainingToDispatchQty,
    0,
  );
  return {
    order: {
      id: row.id,
      reference: row.reference,
      status: statusOf(row.status),
      customerId: row.customerId,
      customerNameAtOrder: row.customerNameAtOrder,
      currencyCodeAtOrder: row.currencyCodeAtOrder,
      currencySymbolAtOrder: row.currencySymbolAtOrder,
      decimalPrecisionAtOrder: row.decimalPrecisionAtOrder,
      orderDate: iso(row.orderDate),
      expectedDate: isoOrNull(row.expectedDate),
      discountMinor: assertSafeMoney(row.discountMinor, "discountMinor"),
      notes: row.notes,
      createdBy: row.createdByUserId
        ? { id: row.createdByUserId, name: row.createdByName }
        : null,
      confirmedAt: isoOrNull(row.confirmedAt),
      completedAt: isoOrNull(row.completedAt),
      cancelledAt: isoOrNull(row.cancelledAt),
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    },
    summary: {
      lineCount: mapped.length,
      totalQty,
      subtotalMinor,
      discountMinor: row.discountMinor,
      totalMinor,
      dispatchedQty,
      remainingToDispatchQty,
      fullyDispatched: mapped.length > 0 && remainingToDispatchQty === 0,
    },
    lines: mapped,
    invoice,
  };
}

/** Linked-invoice projection (§65) — every field validated. */
export function salesOrderInvoiceDto(row: {
  id: string;
  number: number;
  status: string;
  totalMinor: number;
  paidMinor: number;
}): SalesOrderInvoiceDto {
  return {
    id: row.id,
    number: assertSafeMoney(row.number, "invoice number"),
    status: row.status,
    totalMinor: assertSafeMoney(row.totalMinor, "invoice totalMinor"),
    paidMinor: assertSafeMoney(row.paidMinor, "invoice paidMinor"),
  };
}

/** §90 — recent linked dispatch row (totalDispatchedQty arrives validated). */
export function salesOrderRecentDispatchDto(row: {
  id: string;
  reference: string;
  status: string;
  postedAt: DateLike | null;
  totalDispatchedQty: number;
}): SalesOrderRecentDispatchDto {
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    postedAt: isoOrNull(row.postedAt),
    totalDispatchedQty: assertSafeMoney(row.totalDispatchedQty, "dispatch qty"),
  };
}

/** §71 — Customer-360 bounded order row. */
export function customerRecentSalesOrderDto(row: {
  id: string;
  reference: string;
  status: string;
  orderDate: DateLike;
  currencyCodeAtOrder: string;
  currencySymbolAtOrder: string;
  decimalPrecisionAtOrder: number;
  totalMinor: number;
  orderedQty: number;
  dispatchedQty: number;
  invoiceNumber: number | null;
  invoiceStatus: string | null;
}): CustomerRecentSalesOrderDto {
  return {
    id: row.id,
    reference: row.reference,
    status: statusOf(row.status),
    orderDate: iso(row.orderDate),
    currencyCodeAtOrder: row.currencyCodeAtOrder,
    currencySymbolAtOrder: row.currencySymbolAtOrder,
    decimalPrecisionAtOrder: row.decimalPrecisionAtOrder,
    totalMinor: assertSafeMoney(row.totalMinor, "totalMinor"),
    orderedQty: assertSafeMoney(row.orderedQty, "orderedQty"),
    dispatchedQty: assertSafeMoney(row.dispatchedQty, "dispatchedQty"),
    invoiceNumber: row.invoiceNumber,
    invoiceStatus: row.invoiceStatus,
  };
}

/** §72 — Product-detail bounded order row. */
export function productRecentSalesOrderDto(row: {
  id: string;
  reference: string;
  customerNameAtOrder: string;
  status: string;
  orderDate: DateLike;
  orderedQty: number;
  dispatchedQty: number;
}): ProductRecentSalesOrderDto {
  const fulfillment = computeRemainingToDispatchQty(
    row.orderedQty,
    row.dispatchedQty,
  );
  return {
    id: row.id,
    reference: row.reference,
    customerNameAtOrder: row.customerNameAtOrder,
    status: statusOf(row.status),
    orderDate: iso(row.orderDate),
    orderedQty: row.orderedQty,
    dispatchedQty: fulfillment.dispatchedQty,
    remainingToDispatchQty: fulfillment.remainingToDispatchQty,
  };
}
