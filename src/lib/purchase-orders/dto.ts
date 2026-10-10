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
import type { PurchaseOrderRecentReceiptDto } from "@/lib/inventory/goods-receipt/dto";
export type { PurchaseOrderRecentReceiptDto };

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
  /**
   * Prompt 42 §98 — ADDITIVE receiving facts (derived from POSTED goods
   * receipt lines, §99/§100). Present only when receiving data was
   * computed by the service; never client-trusted.
   */
  receivedQty?: number;
  remainingQty?: number;
  /**
   * Prompt 43 §83 — ADDITIVE net-receiving facts (quantity labels, never
   * money; §96 — returned units are NOT expenses or credit notes).
   */
  returnedQty?: number;
  netReceivedQty?: number;
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
  /**
   * Prompt 42 §98 — ADDITIVE receiving summary on the EXISTING detail DTO
   * (never a rebuild of P41). Ordered/Received/Remaining are derived
   * operational quantities — NO accounting wording is attached (§102).
   */
  receiving?: {
    orderedQty: number;
    receivedQty: number;
    remainingQty: number;
    receiptCount: number;
    fullyReceived: boolean;
    /**
     * Prompt 43 §78/§83 — ADDITIVE net-receiving summary: returnedQty =
     * SUM(POSTED GoodsReturnLine.returnedQty); netReceivedQty = gross −
     * returned. receivedQty KEEPS its gross meaning (§78 compatibility);
     * remainingQty is NET-derived (ordered − netReceivedQty, §79).
     */
    returnedQty: number;
    netReceivedQty: number;
  };
  /**
   * Prompt 42 §104 — ADDITIVE bounded recent-receipts list (take 10,
   * §105). Click-through to the receipt detail deep link.
   */
  recentReceipts?: PurchaseOrderRecentReceiptDto[];
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
 * Prompt 42 §98 — receiving data arrives precomputed from the service's
 * transactional read; the mapper performs NO second aggregation.
 */
export function purchaseOrderDetailDto(
  row: PurchaseOrderHeaderRow,
  lines: ReadonlyArray<PurchaseOrderLineRow>,
  receiving?: {
    orderedQty: number;
    receivedQty: number;
    remainingQty: number;
    receiptCount: number;
    fullyReceived: boolean;
    returnedQty?: number;
    netReceivedQty?: number;
    lines: ReadonlyArray<{
      lineId: string;
      receivedQty: number;
      remainingQty: number;
      returnedQty?: number;
      netReceivedQty?: number;
    }>;
  },
  recentReceipts?: ReadonlyArray<PurchaseOrderRecentReceiptDto>,
): PurchaseOrderDetailDto {
  const totals: PurchaseOrderTotal = computePurchaseOrderTotal(lines);
  const receivingByLine = new Map(
    receiving ? receiving.lines.map((r) => [r.lineId, r]) : [],
  );
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
    lines: lines.map((l) => {
      const dto = purchaseOrderLineDto(l);
      const recv = receivingByLine.get(l.id);
      if (recv) {
        dto.receivedQty = recv.receivedQty;
        dto.remainingQty = recv.remainingQty;
        // P43 §83 — ADDITIVE return facts (quantity labels, never money).
        dto.returnedQty = recv.returnedQty ?? 0;
        dto.netReceivedQty = recv.netReceivedQty ?? recv.receivedQty;
      }
      return dto;
    }),
    ...(receiving
      ? {
          receiving: {
            orderedQty: receiving.orderedQty,
            receivedQty: receiving.receivedQty,
            remainingQty: receiving.remainingQty,
            receiptCount: receiving.receiptCount,
            fullyReceived: receiving.fullyReceived,
            // P43 §78/§83 — ADDITIVE net-receiving facts: returnedQty =
            // SUM(POSTED returns), netReceivedQty = gross − returned.
            // receivedQty KEEPS its gross meaning (§78 — compatibility).
            returnedQty: receiving.returnedQty ?? 0,
            netReceivedQty: receiving.netReceivedQty ?? receiving.receivedQty,
          },
        }
      : {}),
    ...(recentReceipts && recentReceipts.length > 0
      ? { recentReceipts: [...recentReceipts] }
      : {}),
  };
}
