/**
 * Prompt 44 — client-safe Goods Dispatch DTOs + pure mappers.
 *
 * DTO LAWS (inherited from the audited P43 pattern):
 *  - explicit allowlist — a raw Prisma object is NEVER serialized;
 *  - every date is an ISO-8601 UTC string;
 *  - product/customer identity comes from the SNAPSHOT columns —
 *    historical values are never replaced with live names;
 *  - quantities are exact integers (no floats anywhere);
 *  - NO MONEY FIELDS EXIST (a dispatch records physical quantity only —
 *    there is no totalMinor/unitPriceMinor in this domain);
 *  - the DTO boundary promises the CLOSED reason vocabulary: a corrupted
 *    persisted reason code is rejected (never silently translated);
 *  - DTO mappers REQUIRE an already-valid status: an unknown persisted
 *    value throws the controlled integrity error (never silently DRAFT).
 */
import {
  computeDispatchedQty,
  isGoodsDispatchReasonCode,
  parseGoodsDispatchStatus,
  GoodsDispatchIntegrityError,
  GOODS_DISPATCH_CORRUPT_HISTORY,
  type GoodsDispatchStatus,
} from "./types";

/* -------------------------------- types ---------------------------------- */

/** Bounded, lighter-than-detail list row. */
export type GoodsDispatchListItemDto = {
  id: string;
  reference: string;
  status: GoodsDispatchStatus;
  customerId: string | null;
  customerNameAtDispatch: string;
  lineCount: number;
  totalDispatchedQty: number;
  createdAt: string;
  postedAt: string | null;
  cancelledAt: string | null;
};

/** Detail line. Snapshot fields are the historical identity. */
export type GoodsDispatchLineDto = {
  id: string;
  productId: string;
  productNameAtDispatch: string;
  skuAtDispatch: string | null;
  unitAtDispatch: string | null;
  qty: number;
  reasonCode: string;
  /** Prompt 45 — source-order line for ORDER-BASED fulfillment (null on
   *  standalone dispatches). The authoritative linkage for §41/§44. */
  salesOrderLineId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Detail document (dispatch + summary + lines). */
export type GoodsDispatchDetailDto = {
  id: string;
  reference: string;
  status: GoodsDispatchStatus;
  notes: string | null;
  customer: { id: string | null; nameAtDispatch: string };
  createdBy: { id: string; name: string | null } | null;
  /** Prompt 45 (§89) — the order context for LINKED fulfillment dispatches
   *  (null on standalone P44 dispatches). Deriving identity from the
   *  ORDER-CONTEXT relation, never from notes/reference text (§58). */
  salesOrder: { id: string; reference: string } | null;
  createdAt: string;
  postedAt: string | null;
  cancelledAt: string | null;
  summary: {
    lineCount: number;
    totalDispatchedQty: number;
  };
  lines: GoodsDispatchLineDto[];
};

/* --------------------- entity-360 bounded dispatch rows ------------------- */

/** Bounded recent-dispatch row on the Product detail (≤10). */
export type ProductRecentDispatchDto = {
  id: string;
  reference: string;
  status: GoodsDispatchStatus;
  customerNameAtDispatch: string;
  qty: number;
  reasonCode: string;
  postedAt: string | null;
};

/** Bounded recent-dispatch row on the Customer 360 (≤10). */
export type CustomerRecentDispatchDto = {
  id: string;
  reference: string;
  status: GoodsDispatchStatus;
  customerNameAtDispatch: string;
  postedAt: string | null;
  totalDispatchedQty: number;
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

/** DTO mappers REQUIRE an already-valid status (INVALID ≠ DRAFT). */
function statusOf(value: string): GoodsDispatchStatus {
  return parseGoodsDispatchStatus(value);
}

export type GoodsDispatchHeaderRow = {
  id: string;
  reference: string;
  status: string;
  notes: string | null;
  customerId: string | null;
  customerNameAtDispatch: string;
  salesOrderId: string | null;
  salesOrderReferenceAtDispatch: string | null;
  createdByUserId: string;
  createdByName: string | null;
  postedAt: DateLike | null;
  cancelledAt: DateLike | null;
  createdAt: DateLike;
};

export type GoodsDispatchLineRow = {
  id: string;
  productId: string;
  productNameAtDispatch: string;
  skuAtDispatch: string | null;
  unitAtDispatch: string | null;
  qty: number;
  reasonCode: string;
  salesOrderLineId: string | null;
  createdAt: DateLike;
  updatedAt: DateLike;
};

/* -------------------------------- mappers --------------------------------- */

/** List row mapper (lineCount/totalDispatchedQty arrive aggregated). */
export function goodsDispatchListItemDto(
  row: GoodsDispatchHeaderRow & { lineCount: number; totalDispatchedQty: number },
): GoodsDispatchListItemDto {
  return {
    id: row.id,
    reference: row.reference,
    status: statusOf(row.status),
    customerId: row.customerId,
    customerNameAtDispatch: row.customerNameAtDispatch,
    lineCount: row.lineCount,
    totalDispatchedQty: row.totalDispatchedQty,
    createdAt: iso(row.createdAt),
    postedAt: isoOrNull(row.postedAt),
    cancelledAt: isoOrNull(row.cancelledAt),
  };
}

/** Line mapper (pure projection; quantities stay exact integers). */
export function goodsDispatchLineDto(row: GoodsDispatchLineRow): GoodsDispatchLineDto {
  // The DTO boundary promises the CLOSED reason vocabulary: a corrupted
  // persisted reason code is rejected here (never silently translated to
  // OTHER, never rendered as an unknown label).
  if (!isGoodsDispatchReasonCode(row.reasonCode)) {
    throw new GoodsDispatchIntegrityError(
      `${GOODS_DISPATCH_CORRUPT_HISTORY}: invalid persisted reason code ${String(row.reasonCode)}`,
    );
  }
  return {
    id: row.id,
    productId: row.productId,
    productNameAtDispatch: row.productNameAtDispatch,
    skuAtDispatch: row.skuAtDispatch,
    unitAtDispatch: row.unitAtDispatch,
    qty: row.qty,
    reasonCode: row.reasonCode,
    salesOrderLineId: row.salesOrderLineId ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** Detail mapper; totalDispatchedQty via the ONE canonical sum. */
export function goodsDispatchDetailDto(
  row: GoodsDispatchHeaderRow,
  lines: ReadonlyArray<GoodsDispatchLineRow>,
): GoodsDispatchDetailDto {
  return {
    id: row.id,
    reference: row.reference,
    status: statusOf(row.status),
    notes: row.notes,
    customer: {
      id: row.customerId,
      nameAtDispatch: row.customerNameAtDispatch,
    },
    salesOrder: row.salesOrderId
      ? {
          id: row.salesOrderId,
          reference: row.salesOrderReferenceAtDispatch ?? "",
        }
      : null,
    createdBy: row.createdByUserId
      ? { id: row.createdByUserId, name: row.createdByName }
      : null,
    createdAt: iso(row.createdAt),
    postedAt: isoOrNull(row.postedAt),
    cancelledAt: isoOrNull(row.cancelledAt),
    summary: {
      lineCount: lines.length,
      totalDispatchedQty: computeDispatchedQty(lines.map((l) => l.qty)),
    },
    lines: lines.map(goodsDispatchLineDto),
  };
}

/** Pure projection of one Product-detail recent-dispatch row (≤10). */
export function productRecentDispatchDto(row: {
  id: string;
  reference: string;
  status: string;
  customerNameAtDispatch: string;
  qty: number;
  reasonCode: string;
  postedAt: DateLike | null;
}): ProductRecentDispatchDto {
  // The closed reason vocabulary is enforced at EVERY mapper that carries
  // it (same law as the line DTO) — an unknown persisted reason is
  // corruption, never silently rendered.
  if (!isGoodsDispatchReasonCode(row.reasonCode)) {
    throw new GoodsDispatchIntegrityError(
      `${GOODS_DISPATCH_CORRUPT_HISTORY}: invalid persisted reason code ${String(row.reasonCode)}`,
    );
  }
  return {
    id: row.id,
    reference: row.reference,
    status: statusOf(row.status),
    customerNameAtDispatch: row.customerNameAtDispatch,
    qty: row.qty,
    reasonCode: row.reasonCode,
    postedAt: isoOrNull(row.postedAt),
  };
}

/** Pure projection of one Customer-360 recent-dispatch row (≤10). */
export function customerRecentDispatchDto(row: {
  id: string;
  reference: string;
  status: string;
  customerNameAtDispatch: string;
  postedAt: DateLike | null;
  totalDispatchedQty: number;
}): CustomerRecentDispatchDto {
  return {
    id: row.id,
    reference: row.reference,
    status: statusOf(row.status),
    customerNameAtDispatch: row.customerNameAtDispatch,
    postedAt: isoOrNull(row.postedAt),
    totalDispatchedQty: row.totalDispatchedQty,
  };
}
