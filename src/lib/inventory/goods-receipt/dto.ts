/**
 * Prompt 42 — client-safe goods-receipt DTOs + pure mappers (§85/§86).
 *
 * DTO LAWS:
 *  - explicit allowlist — a raw Prisma object is NEVER serialized (§298);
 *  - every date is an ISO-8601 UTC string;
 *  - product/supplier/PO identity comes from the SNAPSHOT columns
 *    (§24/§25/§28) — historical values are never replaced with live names;
 *  - quantities are exact integers (§87 — no floats anywhere);
 *  - NO MONEY FIELDS EXIST (§37/§38 — a receipt records physical quantity
 *    only; there is no totalMinor/unitPriceMinor in this domain).
 */
import {
  computeReceivedQty,
  parseGoodsReceiptStatus,
  type GoodsReceiptStatus,
} from "./types";

/** §85 — bounded, lighter-than-detail list row. */
export type GoodsReceiptListItemDto = {
  id: string;
  reference: string;
  status: GoodsReceiptStatus;
  purchaseOrderId: string;
  purchaseOrderReferenceAtReceipt: string;
  supplierNameAtReceipt: string;
  lineCount: number;
  totalReceivedQty: number;
  createdAt: string;
  postedAt: string | null;
  cancelledAt: string | null;
};

/** §86 — detail line. Snapshot fields are the historical identity. */
export type GoodsReceiptLineDto = {
  id: string;
  purchaseOrderLineId: string;
  productId: string;
  productNameAtReceipt: string;
  skuAtReceipt: string | null;
  unitAtReceipt: string | null;
  receivedQty: number;
  createdAt: string;
  updatedAt: string;
};

/** §86 — detail document (receipt + summary + lines). */
export type GoodsReceiptDetailDto = {
  id: string;
  reference: string;
  status: GoodsReceiptStatus;
  notes: string | null;
  purchaseOrder: { id: string; referenceAtReceipt: string };
  supplierNameAtReceipt: string;
  createdBy: { id: string; name: string | null } | null; // §88 — id/name only
  createdAt: string;
  postedAt: string | null;
  cancelledAt: string | null;
  summary: {
    lineCount: number;
    totalReceivedQty: number;
  };
  lines: GoodsReceiptLineDto[];
};

/**
 * §98 — the ADDITIVE receiving summary merged into the EXISTING P41
 * purchase-order detail DTO (never a rebuild of P41, §98). All derived
 * from POSTED receipt lines (§99/§100).
 */
export type PurchaseOrderReceivingSummaryDto = {
  orderedQty: number;
  receivedQty: number;
  remainingQty: number;
  receiptCount: number;
  fullyReceived: boolean;
};

/** §98 — per-PO-line received/remaining (additive to the P41 line DTO). */
export type PurchaseOrderLineReceivingDto = {
  receivedQty: number;
  remainingQty: number;
};

/** §104 — bounded recent-receipt row on the PO detail. */
export type PurchaseOrderRecentReceiptDto = {
  id: string;
  reference: string;
  status: GoodsReceiptStatus;
  postedAt: string | null;
  totalReceivedQty: number;
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
 * §96 — DTO mappers REQUIRE an already-valid status: an unknown persisted
 * value throws the controlled integrity error instead of silently becoming
 * DRAFT. INVALID PERSISTED STATUS ≠ DRAFT.
 */
function statusOf(value: string): GoodsReceiptStatus {
  return parseGoodsReceiptStatus(value);
}

export type GoodsReceiptHeaderRow = {
  id: string;
  reference: string;
  status: string;
  notes: string | null;
  purchaseOrderId: string;
  purchaseOrderReferenceAtReceipt: string;
  supplierNameAtReceipt: string;
  createdByUserId: string;
  createdByName: string | null;
  postedAt: DateLike | null;
  cancelledAt: DateLike | null;
  createdAt: DateLike;
};

export type GoodsReceiptLineRow = {
  id: string;
  purchaseOrderLineId: string;
  productId: string;
  productNameAtReceipt: string;
  skuAtReceipt: string | null;
  unitAtReceipt: string | null;
  receivedQty: number;
  createdAt: DateLike;
  updatedAt: DateLike;
};

/* -------------------------------- mappers --------------------------------- */

/** §85 — list row mapper (lineCount/totalReceivedQty arrive aggregated). */
export function goodsReceiptListItemDto(
  row: GoodsReceiptHeaderRow & { lineCount: number; totalReceivedQty: number },
): GoodsReceiptListItemDto {
  return {
    id: row.id,
    reference: row.reference,
    status: statusOf(row.status),
    purchaseOrderId: row.purchaseOrderId,
    purchaseOrderReferenceAtReceipt: row.purchaseOrderReferenceAtReceipt,
    supplierNameAtReceipt: row.supplierNameAtReceipt,
    lineCount: row.lineCount,
    totalReceivedQty: row.totalReceivedQty,
    createdAt: iso(row.createdAt),
    postedAt: isoOrNull(row.postedAt),
    cancelledAt: isoOrNull(row.cancelledAt),
  };
}

/** §86 — line mapper (pure projection; quantities stay exact integers). */
export function goodsReceiptLineDto(row: GoodsReceiptLineRow): GoodsReceiptLineDto {
  return {
    id: row.id,
    purchaseOrderLineId: row.purchaseOrderLineId,
    productId: row.productId,
    productNameAtReceipt: row.productNameAtReceipt,
    skuAtReceipt: row.skuAtReceipt,
    unitAtReceipt: row.unitAtReceipt,
    receivedQty: row.receivedQty,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** §86/§87 — detail mapper; totalReceivedQty via the ONE canonical sum. */
export function goodsReceiptDetailDto(
  row: GoodsReceiptHeaderRow,
  lines: ReadonlyArray<GoodsReceiptLineRow>,
): GoodsReceiptDetailDto {
  return {
    id: row.id,
    reference: row.reference,
    status: statusOf(row.status),
    notes: row.notes,
    purchaseOrder: {
      id: row.purchaseOrderId,
      referenceAtReceipt: row.purchaseOrderReferenceAtReceipt,
    },
    supplierNameAtReceipt: row.supplierNameAtReceipt,
    createdBy: row.createdByUserId
      ? { id: row.createdByUserId, name: row.createdByName }
      : null,
    createdAt: iso(row.createdAt),
    postedAt: isoOrNull(row.postedAt),
    cancelledAt: isoOrNull(row.cancelledAt),
    summary: {
      lineCount: lines.length,
      totalReceivedQty: computeReceivedQty(lines.map((l) => l.receivedQty)),
    },
    lines: lines.map(goodsReceiptLineDto),
  };
}
