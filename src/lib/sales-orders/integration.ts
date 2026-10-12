import "server-only";

/**
 * Prompt 45 — server-side integration helpers shared by the sales-order
 * service and the goods-dispatch service (single direction: both import
 * THIS module; neither imports the other — no import cycles).
 *
 * LAWS:
 *  - the ONE canonical POSTED dispatched-quantity aggregate per order line
 *    (§36): DRAFT/CANCELLED dispatches never count; the aggregate result
 *    is re-validated (safe integer, ≥ 0) — corruption surfaces, never
 *    clamps;
 *  - the ONE pure-domain-error → HTTP mapping for every sales-order
 *    integrity failure (mirrors mapPureGoodsDispatchDomainError).
 */
import { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api-helpers";
import {
  SalesOrderIntegrityError,
  SalesOrderStatusIntegrityError,
  SalesOrderTotalOverflowError,
  SALES_ORDER_CORRUPT_HISTORY,
  SALES_ORDER_ERROR_CODES,
  SALES_ORDER_LINE_CAP_INVARIANT,
  SALES_ORDER_TOTAL_OVERFLOW,
} from "./types";

type Tx = Prisma.TransactionClient;
/** Aggregate-capable read client (raw client or transaction client). */
type DbLike = Pick<Tx, "goodsDispatchLine">;

/**
 * Map pure sales-order canonical-math integrity failures to their
 * controlled HTTP result. Exported for cross-service mapping (the
 * goods-dispatch fulfillment path surfaces order corruption through the
 * SAME stable codes as the sales-order module — never a generic 500).
 */
export function mapPureSalesOrderDomainError(error: unknown): never {
  if (error instanceof Error && error.name === "SalesOrderStatusIntegrityError") {
    throw new ApiError(
      500,
      SALES_ORDER_ERROR_CODES.INVALID_PERSISTED_STATUS,
      "Sales order data is in an invalid state. Please contact support.",
    );
  }
  if (error instanceof Error && error.name === "SalesOrderTotalOverflowError") {
    // Persisted-data overflow is corruption (input-time overflow is mapped
    // to the 422 by the write paths BEFORE anything persists).
    throw new ApiError(
      500,
      SALES_ORDER_TOTAL_OVERFLOW,
      "Sales order data is inconsistent. Please contact support.",
    );
  }
  if (error instanceof Error && error.name === "SalesOrderIntegrityError") {
    if (error.message.includes(SALES_ORDER_LINE_CAP_INVARIANT)) {
      throw new ApiError(
        500,
        SALES_ORDER_LINE_CAP_INVARIANT,
        "Stored document data exceeds its configured line cap. Please contact support.",
      );
    }
    if (error.message.includes(SALES_ORDER_ERROR_CODES.OVER_DISPATCH)) {
      // Over-dispatched persisted history is an integrity failure (§37) —
      // never clamped, never reported as an ordinary conflict.
      throw new ApiError(
        500,
        SALES_ORDER_ERROR_CODES.OVER_DISPATCH,
        "Order fulfillment data is inconsistent. Please contact support.",
      );
    }
    throw new ApiError(
      500,
      SALES_ORDER_CORRUPT_HISTORY,
      "Sales order data is inconsistent. Please contact support.",
    );
  }
  throw error;
}

/**
 * The ONE canonical POSTED dispatched-quantity aggregate for a set of
 * order lines (§36): Σ GoodsDispatchLine.qty where the parent dispatch is
 * POSTED. DRAFT and CANCELLED dispatches NEVER count (§36 — a draft
 * dispatch is not fulfilled stock). Database groupBy(_sum), never a
 * findMany of history into memory; every aggregate result is re-validated
 * (safe integer ≥ 0 — a negative or unsafe sum is corruption).
 */
export async function sumPostedDispatchedQtyBySalesOrderLines(
  tx: DbLike,
  salesOrderLineIds: readonly string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (salesOrderLineIds.length === 0) return map;
  const rows = await tx.goodsDispatchLine.groupBy({
    by: ["salesOrderLineId"],
    where: {
      salesOrderLineId: { in: [...salesOrderLineIds] },
      goodsDispatch: { status: "POSTED" }, // POSTED only (§36)
    },
    _sum: { qty: true },
  });
  for (const row of rows) {
    const sum = row._sum.qty ?? 0;
    if (!Number.isSafeInteger(sum) || sum < 0) {
      mapPureSalesOrderDomainError(
        new SalesOrderIntegrityError(
          `${SALES_ORDER_CORRUPT_HISTORY}: negative or unsafe dispatched aggregate`,
        ),
      );
    }
    if (row.salesOrderLineId) {
      map.set(row.salesOrderLineId, sum);
    }
  }
  return map;
}

/**
 * Re-throw a pure sales-order integrity error through the ONE mapping;
 * non-integrity errors pass through unchanged. Convenience for call
 * sites that catch broadly.
 */
export function rethrowPureSalesOrderDomainError(error: unknown): void {
  if (
    error instanceof SalesOrderIntegrityError ||
    error instanceof SalesOrderStatusIntegrityError ||
    error instanceof SalesOrderTotalOverflowError
  ) {
    mapPureSalesOrderDomainError(error);
  }
}
