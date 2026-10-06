/**
 * Prompt 41 — client-safe purchase-order DTOs + pure mappers (§49/§50/§51).
 *
 * DTO LAWS:
 *  - explicit allowlist — a raw Prisma object is NEVER serialized (§49/§144);
 *  - every date is an ISO-8601 UTC string;
 *  - supplier/product identity comes from the SNAPSHOT columns (§11/§27) —
 *    historical values are never replaced with live names;
 *  - totals are server-derived here from stored integer lines (§30);
 *  - NO money beyond the procurement document total — never a payable,
 *    paid, or balance field (§31/§151/§204).
 */
import {
  computeLineTotalMinor,
  computePurchaseOrderTotal,
  parsePurchaseOrderStatus,
  type PurchaseOrderStatus,
  type PurchaseOrderTotal,
} from "./types";

/** §51 — bounded, lighter-than-detail list row. */
export type PurchaseOrderListItemDto = {
  id: string;
  reference: string;
  status: PurchaseOrderStatus;
  supplierId: string;
  supplierNameAtOrder: string;
  currencyCodeAtOrder: string;
  currencySymbolAtOrder: string;
  decimalPrecisionAtOrder: number;
  orderedAt: string;
  expectedDate: string | null;
  lineCount: number;
  totalQty: number;
  totalMinor: number;
  createdAt: string;
};

/** §50 — detail line. Snapshot fields are the historical identity. */
export type PurchaseOrderLineDto = {
  id: string;
  productId: string;
  productNameAtOrder: string;
  skuAtOrder: string | null;
  unitAtOrder: string | null;
  orderedQty: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  createdAt: string;
  updatedAt: string;
};

/** §50 — detail document. */
export type PurchaseOrderDetailDto = {
  id: string;
  reference: string;
  status: PurchaseOrderStatus;
  orderedAt: string;
  expectedDate: string | null;
  notes: string | null;
  supplier: {
    id: string;
    /** Historical snapshot — display identity of the document (§11). */
    nameAtOrder: string;
    /** Live name — only when the supplier still exists (navigation aid). */
    name: string | null;
    stillExists: boolean;
  };
  currency: {
    codeAtOrder: string;
    symbolAtOrder: string;
    decimalPrecisionAtOrder: number;
  };
  lifecycle: {
    sentAt: string | null;
    confirmedAt: string | null;
    closedAt: string | null;
    cancelledAt: string | null;
  };
  createdBy: { id: string; name: string | null } | null;
  createdAt: string;
  updatedAt: string;
  summary: PurchaseOrderTotal;
  lines: PurchaseOrderLineDto[];
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

/**
 * §13 — DTO mappers REQUIRE an already-valid status: an unknown persisted
 * value throws the controlled integrity error instead of silently becoming
 * DRAFT. INVALID PERSISTED STATUS ≠ DRAFT.
 */
function statusOf(value: string): PurchaseOrderStatus {
  return parsePurchaseOrderStatus(value);
}

export type PurchaseOrderLineRow = {
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

export type PurchaseOrderHeaderRow = {
  id: string;
  reference: string;
  status: string;
  currencyCodeAtOrder: string;
  currencySymbolAtOrder: string;
  decimalPrecisionAtOrder: number;
  orderedAt: DateLike;
  expectedDate: DateLike | null;
  notes: string | null;
  supplierId: string;
  supplierNameAtOrder: string;
  supplierName: string | null;
  createdByUserId: string;
  createdByName: string | null;
  sentAt: DateLike | null;
  confirmedAt: DateLike | null;
  closedAt: DateLike | null;
  cancelledAt: DateLike | null;
  createdAt: DateLike;
  updatedAt: DateLike;
};

/* -------------------------------- mappers --------------------------------- */

/**
 * §51 — list row mapper. Lines arrive as a bounded scalar slice.
 * §17/§18 — the total comes from the ONE canonical BigInt function; an
 * unsafe total throws PURCHASE_ORDER_TOTAL_OVERFLOW (never a rounded number).
 */
export function purchaseOrderListItemDto(
  row: PurchaseOrderHeaderRow & {
    lineCount: number;
    lines: ReadonlyArray<{ orderedQty: number; unitPriceMinor: number }>;
  },
): PurchaseOrderListItemDto {
  const totals: PurchaseOrderTotal = computePurchaseOrderTotal(row.lines);
  return {
    id: row.id,
    reference: row.reference,
    status: statusOf(row.status),
    supplierId: row.supplierId,
    supplierNameAtOrder: row.supplierNameAtOrder,
    currencyCodeAtOrder: row.currencyCodeAtOrder,
    currencySymbolAtOrder: row.currencySymbolAtOrder,
    decimalPrecisionAtOrder: row.decimalPrecisionAtOrder,
    orderedAt: iso(row.orderedAt),
    expectedDate: isoOrNull(row.expectedDate),
    lineCount: row.lineCount,
    totalQty: totals.totalQty,
    totalMinor: totals.totalMinor,
    createdAt: iso(row.createdAt),
  };
}

/** §50 — line mapper. lineTotalMinor is derived, never stored (§30). */
export function purchaseOrderLineDto(row: PurchaseOrderLineRow): PurchaseOrderLineDto {
  return {
    id: row.id,
    productId: row.productId,
    productNameAtOrder: row.productNameAtOrder,
    skuAtOrder: row.skuAtOrder,
    unitAtOrder: row.unitAtOrder,
    orderedQty: row.orderedQty,
    unitPriceMinor: row.unitPriceMinor,
    lineTotalMinor: computeLineTotalMinor(row.orderedQty, row.unitPriceMinor),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/**
 * §50 — detail mapper (header + summary + all lines, cap-bounded).
 * §18 — SAME canonical total law as list/create/export — no second math.
 */
export function purchaseOrderDetailDto(
  row: PurchaseOrderHeaderRow,
  lines: ReadonlyArray<PurchaseOrderLineRow>,
): PurchaseOrderDetailDto {
  const totals: PurchaseOrderTotal = computePurchaseOrderTotal(lines);
  return {
    id: row.id,
    reference: row.reference,
    status: statusOf(row.status),
    orderedAt: iso(row.orderedAt),
    expectedDate: isoOrNull(row.expectedDate),
    notes: row.notes,
    supplier: {
      id: row.supplierId,
      nameAtOrder: row.supplierNameAtOrder,
      name: row.supplierName,
      stillExists: row.supplierName !== null,
    },
    currency: {
      codeAtOrder: row.currencyCodeAtOrder,
      symbolAtOrder: row.currencySymbolAtOrder,
      decimalPrecisionAtOrder: row.decimalPrecisionAtOrder,
    },
    lifecycle: {
      sentAt: isoOrNull(row.sentAt),
      confirmedAt: isoOrNull(row.confirmedAt),
      closedAt: isoOrNull(row.closedAt),
      cancelledAt: isoOrNull(row.cancelledAt),
    },
    createdBy: row.createdByUserId
      ? { id: row.createdByUserId, name: row.createdByName }
      : null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    summary: totals,
    lines: lines.map(purchaseOrderLineDto),
  };
}
