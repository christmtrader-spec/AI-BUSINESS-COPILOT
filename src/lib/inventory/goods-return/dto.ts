/**
 * Prompt 43 — client-safe goods-return DTOs + pure mappers (§70/§71).
 *
 * DTO LAWS:
 *  - explicit allowlist — a raw Prisma object is NEVER serialized (§70);
 *  - every date is an ISO-8601 UTC string;
 *  - product/supplier/receipt/PO identity comes from the SNAPSHOT columns
 *    (§16/§17/§18/§30) — historical values are never replaced with live names;
 *  - quantities are exact integers (§70 — no floats anywhere);
 *  - NO MONEY FIELDS EXIST (§4/§7 — a return records physical quantity
 *    only; there is no totalMinor/unitPriceMinor in this domain).
 */
import {
  computeReturnedQty,
  computeReturnableQty,
  isGoodsReturnReasonCode,
  parseGoodsReturnStatus,
  GoodsReturnIntegrityError,
  GOODS_RETURN_CORRUPT_HISTORY,
  type GoodsReturnStatus,
} from "./types";

/** §71 — bounded, lighter-than-detail list row. */
export type GoodsReturnListItemDto = {
  id: string;
  reference: string;
  status: GoodsReturnStatus;
  goodsReceiptId: string;
  goodsReceiptReferenceAtReturn: string;
  purchaseOrderReferenceAtReturn: string;
  supplierNameAtReturn: string;
  lineCount: number;
  totalReturnedQty: number;
  createdAt: string;
  postedAt: string | null;
  cancelledAt: string | null;
};

/** §70 — detail line. Snapshot fields are the historical identity. */
export type GoodsReturnLineDto = {
  id: string;
  goodsReceiptLineId: string;
  productId: string;
  productNameAtReturn: string;
  skuAtReturn: string | null;
  unitAtReturn: string | null;
  returnedQty: number;
  reasonCode: string;
  createdAt: string;
  updatedAt: string;
};

/** §70 — detail document (return + summary + lines). */
export type GoodsReturnDetailDto = {
  id: string;
  reference: string;
  status: GoodsReturnStatus;
  notes: string | null;
  goodsReceipt: { id: string; referenceAtReturn: string };
  purchaseOrderReferenceAtReturn: string;
  supplierNameAtReturn: string;
  createdBy: { id: string; name: string | null } | null; // §70 — id/name only
  createdAt: string;
  postedAt: string | null;
  cancelledAt: string | null;
  summary: {
    lineCount: number;
    totalReturnedQty: number;
  };
  lines: GoodsReturnLineDto[];
};

/* ------------------------- receipt-side return facts ------------------------ */

/**
 * §86 — ADDITIVE per-receipt-line return facts merged into the EXISTING
 * P42 goods-receipt detail DTO. receivedQty keeps its immutable gross
 * meaning (§78/§126); returned/returnable are DERIVED (§36) — never stored.
 */
export type ReceiptLineReturnFactsDto = {
  goodsReceiptLineId: string;
  receivedQty: number;
  returnedQty: number;
  returnableQty: number;
};

/** §88 — bounded recent-return row on the goods-receipt detail (≤10). */
export type ReceiptRecentReturnDto = {
  id: string;
  reference: string;
  status: GoodsReturnStatus;
  postedAt: string | null;
  totalReturnedQty: number;
};

/* --------------------- entity-360 bounded return rows ---------------------- */

/** §100 — bounded recent-return row on the Supplier 360 (≤10). */
export type SupplierRecentReturnDto = {
  id: string;
  reference: string;
  status: GoodsReturnStatus;
  supplierNameAtReturn: string;
  goodsReceiptReferenceAtReturn: string;
  postedAt: string | null;
  totalReturnedQty: number;
};

/** §99 — bounded recent-return row on the Product detail (≤10). */
export type ProductRecentReturnDto = {
  id: string;
  reference: string;
  status: GoodsReturnStatus;
  goodsReceiptReferenceAtReturn: string;
  returnedQty: number;
  reasonCode: string;
  postedAt: string | null;
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
 * §65 — DTO mappers REQUIRE an already-valid status: an unknown persisted
 * value throws the controlled integrity error instead of silently becoming
 * DRAFT. INVALID PERSISTED STATUS ≠ DRAFT.
 */
function statusOf(value: string): GoodsReturnStatus {
  return parseGoodsReturnStatus(value);
}

export type GoodsReturnHeaderRow = {
  id: string;
  reference: string;
  status: string;
  notes: string | null;
  goodsReceiptId: string;
  goodsReceiptReferenceAtReturn: string;
  purchaseOrderReferenceAtReturn: string;
  supplierNameAtReturn: string;
  createdByUserId: string;
  createdByName: string | null;
  postedAt: DateLike | null;
  cancelledAt: DateLike | null;
  createdAt: DateLike;
};

export type GoodsReturnLineRow = {
  id: string;
  goodsReceiptLineId: string;
  productId: string;
  productNameAtReturn: string;
  skuAtReturn: string | null;
  unitAtReturn: string | null;
  returnedQty: number;
  reasonCode: string;
  createdAt: DateLike;
  updatedAt: DateLike;
};

/* -------------------------------- mappers --------------------------------- */

/** §71 — list row mapper (lineCount/totalReturnedQty arrive aggregated). */
export function goodsReturnListItemDto(
  row: GoodsReturnHeaderRow & { lineCount: number; totalReturnedQty: number },
): GoodsReturnListItemDto {
  return {
    id: row.id,
    reference: row.reference,
    status: statusOf(row.status),
    goodsReceiptId: row.goodsReceiptId,
    goodsReceiptReferenceAtReturn: row.goodsReceiptReferenceAtReturn,
    purchaseOrderReferenceAtReturn: row.purchaseOrderReferenceAtReturn,
    supplierNameAtReturn: row.supplierNameAtReturn,
    lineCount: row.lineCount,
    totalReturnedQty: row.totalReturnedQty,
    createdAt: iso(row.createdAt),
    postedAt: isoOrNull(row.postedAt),
    cancelledAt: isoOrNull(row.cancelledAt),
  };
}

/** §70 — line mapper (pure projection; quantities stay exact integers). */
export function goodsReturnLineDto(row: GoodsReturnLineRow): GoodsReturnLineDto {
  // §51 — the DTO boundary promises the CLOSED reason vocabulary: a
  // corrupted persisted reason code is rejected here (never silently
  // translated to OTHER, never rendered as an unknown label).
  if (!isGoodsReturnReasonCode(row.reasonCode)) {
    throw new GoodsReturnIntegrityError(
      `${GOODS_RETURN_CORRUPT_HISTORY}: invalid persisted reason code ${String(row.reasonCode)}`,
    );
  }
  return {
    id: row.id,
    goodsReceiptLineId: row.goodsReceiptLineId,
    productId: row.productId,
    productNameAtReturn: row.productNameAtReturn,
    skuAtReturn: row.skuAtReturn,
    unitAtReturn: row.unitAtReturn,
    returnedQty: row.returnedQty,
    reasonCode: row.reasonCode,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** §70 — detail mapper; totalReturnedQty via the ONE canonical sum. */
export function goodsReturnDetailDto(
  row: GoodsReturnHeaderRow,
  lines: ReadonlyArray<GoodsReturnLineRow>,
): GoodsReturnDetailDto {
  return {
    id: row.id,
    reference: row.reference,
    status: statusOf(row.status),
    notes: row.notes,
    goodsReceipt: {
      id: row.goodsReceiptId,
      referenceAtReturn: row.goodsReceiptReferenceAtReturn,
    },
    purchaseOrderReferenceAtReturn: row.purchaseOrderReferenceAtReturn,
    supplierNameAtReturn: row.supplierNameAtReturn,
    createdBy: row.createdByUserId
      ? { id: row.createdByUserId, name: row.createdByName }
      : null,
    createdAt: iso(row.createdAt),
    postedAt: isoOrNull(row.postedAt),
    cancelledAt: isoOrNull(row.cancelledAt),
    summary: {
      lineCount: lines.length,
      totalReturnedQty: computeReturnedQty(lines.map((l) => l.returnedQty)),
    },
    lines: lines.map(goodsReturnLineDto),
  };
}

/**
 * §86 — pure projection of one receipt line's return facts. receivedQty is
 * the immutable gross source; returnable = received − returned via the ONE
 * canonical checked helper (§36/§12 — throws on any corruption; callers
 * map it to the stable integrity 500).
 */
export function receiptLineReturnFactsDto(row: {
  goodsReceiptLineId: string;
  receivedQty: number;
  returnedQty: number;
}): ReceiptLineReturnFactsDto {
  const returnableQty = computeReturnableQty(row.receivedQty, row.returnedQty);
  return {
    goodsReceiptLineId: row.goodsReceiptLineId,
    receivedQty: row.receivedQty,
    returnedQty: row.returnedQty,
    returnableQty,
  };
}
