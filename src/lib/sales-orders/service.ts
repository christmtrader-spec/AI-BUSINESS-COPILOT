import "server-only";

/**
 * Prompt 45 — sales-order service (server-only).
 *
 * LAWS:
 *  - COMMERCIAL DOCUMENT ONLY (§4): creating/confirming an order mutates
 *    NOTHING but the order (no stock, no reservation, no Sale, no
 *    Payment, no Expense, no receivable, no statement, no aging, no
 *    InventoryAdjustment — §30/§92/§93/§94/§95).
 *  - INVENTORY DECREMENT AUTHORITY (§5/§45/§58): the order code NEVER
 *    touches Product.stockQty. The linked GoodsDispatch POST decrements
 *    stock exactly once (existing P44 algorithm — never duplicated
 *    here); the linked Sale invoice must NOT decrement stock again.
 *  - ONE INVOICE PER ORDER (§52/§105): enforced by the unique
 *    Sale.salesOrderId constraint plus an in-transaction existence check;
 *    concurrent issuance → exactly one winner, stable 409 for the loser.
 *  - FULFILLMENT LAW (§36–§38): dispatched = Σ POSTED linked dispatch
 *    lines (aggregate, never memory-loaded history); dispatched ≤ ordered
 *    is a hard invariant; remaining is never clamped.
 *  - STATUS LAW (§15/§16/§108): closed vocabulary, server-authoritative
 *    transitions, status RE-CHECKED INSIDE the write transaction;
 *    corrupted persisted status is a controlled 500 — never DRAFT.
 *  - TENANT LAW (§10/§68/§69): every query is scoped by ctx.businessId;
 *    foreign ids are indistinguishable from unknown ones (404).
 *  - Snapshot law (§12/§21/§109): customer/product identity is frozen at
 *    write time from verified rows; corrupted/missing persisted snapshots
 *    surface, never silently substituted with live values.
 *  - Every mutation writes its audit INSIDE the same transaction.
 *  - READ-CAP LAW (§106): every bounded read fetches cap+1 rows to prove
 *    completeness; over-cap documents fail with the stable invariant code.
 */
import { randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { withWriteTransaction } from "@/lib/db/write-transaction";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api-helpers";
import { formatInvoiceNumber } from "@/lib/finance";
import {
  parseGoodsDispatchStatus,
  computeDispatchedQty,
  goodsDispatchLineCap,
  generateGoodsDispatchReference,
} from "@/lib/inventory/goods-dispatch/types";
import {
  assertSalesOrderLineSetComplete,
  canTransitionSalesOrder,
  computeOrderLineTotalMinor,
  computeOrderSubtotalMinor,
  computeOrderTotalMinor,
  computeRemainingToDispatchQty,
  exceedsRemainingToDispatch,
  generateSalesOrderReference,
  isValidOrderPrice,
  isValidPersistedOrderQty,
  normalizeSalesOrderReference,
  parseSalesOrderStatus,
  salesOrderDayWindow,
  salesOrderLineCap,
  validateOrderDiscount,
  SalesOrderIntegrityError,
  SALES_ORDER_ERROR_CODES,
  type SalesOrderStatus,
} from "./types";
import {
  mapPureSalesOrderDomainError,
  sumPostedDispatchedQtyBySalesOrderLines,
} from "./integration";
import {
  customerRecentSalesOrderDto,
  productRecentSalesOrderDto,
  salesOrderDetailDto,
  salesOrderInvoiceDto,
  salesOrderRecentDispatchDto,
  type CustomerRecentSalesOrderDto,
  type ProductRecentSalesOrderDto,
  type SalesOrderDetailDto,
} from "./dto";

type Tx = Prisma.TransactionClient;

/**
 * The ONE shared SQLite write-transaction law (FIFO serialized writes +
 * bounded transient retry) — the same helper every P41–P45 write path
 * uses, so concurrent fulfillment, legacy sales, manual adjustments and
 * stocktake finalization can never interleave on the single write lock.
 */
const withWriteTx = withWriteTransaction;

/* ------------------------- shared order internals ------------------------ */

/** Corrupted persisted status → controlled 500 (never Draft, §108). */
function parseDbStatus(value: string): SalesOrderStatus {
  try {
    return parseSalesOrderStatus(value);
  } catch (error) {
    mapPureSalesOrderDomainError(error);
  }
}

function auditInput(
  businessId: string,
  actorId: string,
  action: string,
  salesOrderId: string,
  reference: string,
  after: Record<string, unknown>,
  before?: Record<string, unknown>,
) {
  return {
    businessId,
    actorId,
    action,
    entityType: "SalesOrder",
    entityId: salesOrderId,
    ...(before ? { before } : {}),
    after: { reference, ...after }, // safe metadata; never notes content
  };
}

async function loadOrderHeader(
  tx: Tx,
  businessId: string,
  id: string,
): Promise<{
  id: string;
  reference: string;
  status: SalesOrderStatus;
  customerId: string | null;
  customerNameAtOrder: string;
  currencyCodeAtOrder: string;
  currencySymbolAtOrder: string;
  decimalPrecisionAtOrder: number;
  orderDate: Date;
  expectedDate: Date | null;
  discountMinor: number;
  notes: string | null;
  createdByUserId: string;
  createdByName: string | null;
  confirmedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}> {
  const row = await tx.salesOrder.findFirst({
    where: { id, businessId }, // tenant scope from auth context only
    select: {
      id: true,
      reference: true,
      status: true,
      customerId: true,
      customerNameAtOrder: true,
      currencyCodeAtOrder: true,
      currencySymbolAtOrder: true,
      decimalPrecisionAtOrder: true,
      orderDate: true,
      expectedDate: true,
      discountMinor: true,
      notes: true,
      createdByUserId: true,
      createdByUser: { select: { name: true } },
      confirmedAt: true,
      completedAt: true,
      cancelledAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!row) throw new ApiError(404, "NOT_FOUND", "Sales order not found.");
  return {
    ...row,
    status: parseDbStatus(row.status), // INVALID PERSISTED STATUS ≠ DRAFT
    createdByName: row.createdByUser?.name ?? null,
  };
}

/** Tenant-scoped, active (not soft-deleted) customer snapshot source. */
async function loadActiveCustomer(
  tx: Tx,
  businessId: string,
  customerId: string,
): Promise<{ id: string; name: string }> {
  const customer = await tx.customer.findFirst({
    where: { id: customerId, businessId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!customer) {
    throw new ApiError(
      404,
      SALES_ORDER_ERROR_CODES.CUSTOMER_NOT_FOUND,
      "Customer not found.",
    );
  }
  return customer;
}

/** Load a PROVEN-COMPLETE, validated line set for one order (§106). */
async function loadCompleteLines(
  tx: Tx,
  salesOrderId: string,
  cap: number,
): Promise<
  Array<{
    id: string;
    productId: string;
    productNameAtOrder: string;
    skuAtOrder: string | null;
    unitAtOrder: string | null;
    orderedQty: number;
    unitPriceMinor: number;
  }>
> {
  const lines = await tx.salesOrderLine.findMany({
    where: { salesOrderId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: cap + 1, // cap+1 proves completeness
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
  const counted = await tx.salesOrderLine.count({ where: { salesOrderId } });
  // THREE explicit invariants (§106): fetched ≤ cap, counted ≤ cap,
  // counted === fetched — a mismatch below the cap NEVER passes.
  assertSalesOrderLineSetComplete(lines.length, counted, cap);
  // Every persisted line must be materially valid BEFORE use (§18/§21/§109).
  for (const line of lines) {
    if (!isValidPersistedOrderQty(line.orderedQty) || !isValidOrderPrice(line.unitPriceMinor)) {
      mapPureSalesOrderDomainError(
        new SalesOrderIntegrityError(
          `${SALES_ORDER_ERROR_CODES.CORRUPT_HISTORY}: invalid persisted line quantities`,
        ),
      );
    }
    if (typeof line.productNameAtOrder !== "string" || line.productNameAtOrder.length === 0) {
      mapPureSalesOrderDomainError(
        new SalesOrderIntegrityError(
          `${SALES_ORDER_ERROR_CODES.CORRUPT_HISTORY}: missing product snapshot`,
        ),
      );
    }
  }
  return lines;
}

/** Per-order-line POSTED fulfillment map (§36) — validated aggregate. */
async function fulfillmentMapForLines(
  tx: Tx,
  lineIds: readonly string[],
): Promise<Map<string, number>> {
  return sumPostedDispatchedQtyBySalesOrderLines(tx, lineIds);
}

/** Defensive line-count validation for line writes (§31/§106). */
async function assertLineCap(tx: Tx, salesOrderId: string, cap: number): Promise<number> {
  const lineCount = await tx.salesOrderLine.count({ where: { salesOrderId } });
  if (lineCount > cap) {
    // An ALREADY-corrupted over-cap order is database corruption: 500
    // integrity, never disguised as the ordinary 422 user failure.
    throw new ApiError(
      500,
      SALES_ORDER_ERROR_CODES.LINE_CAP_INVARIANT,
      "Stored document data exceeds its configured line cap. Please contact support.",
    );
  }
  if (lineCount === cap) {
    // The NORMAL write-time rejection for a legitimately full draft.
    throw new ApiError(
      422,
      SALES_ORDER_ERROR_CODES.LINE_LIMIT,
      `A sales order can contain at most ${cap} lines.`,
    );
  }
  return lineCount;
}

/** Current canonical subtotal of an order (validated complete lines). */
async function currentSubtotalMinor(tx: Tx, salesOrderId: string, cap: number): Promise<number> {
  const lines = await loadCompleteLines(tx, salesOrderId, cap);
  try {
    return computeOrderSubtotalMinor(lines).subtotalMinor;
  } catch (error) {
    mapPureSalesOrderDomainError(error);
  }
}

/** Business-local unique reference generation (§14 — never MAX+1). */
async function generateUniqueOrderReference(
  tx: Tx,
  businessId: string,
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generateSalesOrderReference(new Date(), (max) => randomInt(max));
    const clash = await tx.salesOrder.findFirst({
      where: { businessId, reference: candidate },
      select: { id: true },
    });
    if (!clash) return candidate;
  }
  // Astronomically unlikely (31^6); fail honestly rather than loop.
  throw new ApiError(
    409,
    SALES_ORDER_ERROR_CODES.DUPLICATE_REFERENCE,
    "Could not generate a unique reference. Please try again.",
  );
}

/* -------------------------------- create ---------------------------------- */

export async function createSalesOrder(input: {
  businessId: string;
  userId: string;
  customerId?: string;
  reference?: string;
  orderDate?: string; // calendar date (strict, zod) — default now
  expectedDate?: string;
  discountMinor?: number;
  notes?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    // §25 — currency snapshot comes from the BUSINESS configuration
    // (server-derived); the client can never select a different currency.
    const business = await tx.business.findUnique({
      where: { id: input.businessId },
      select: { currencyCode: true, currencySymbol: true, decimalPrecision: true },
    });
    if (!business) throw new ApiError(404, "NOT_FOUND", "Business not found.");

    // §11 — optional customer: tenant-scoped, not soft-deleted; the name
    // snapshot is frozen at creation (§12).
    let customerNameAtOrder = "";
    if (input.customerId) {
      const customer = await loadActiveCustomer(tx, input.businessId, input.customerId);
      customerNameAtOrder = customer.name;
    }

    // §23 — an order with no lines has subtotal 0: a non-zero creation
    // discount would violate the discount law on day one.
    if ((input.discountMinor ?? 0) > 0) {
      throw new ApiError(
        422,
        SALES_ORDER_ERROR_CODES.INVALID_DISCOUNT,
        "Add lines first — an empty order cannot carry a discount.",
      );
    }

    // Reference: user-supplied (normalized) or server-generated (§14).
    let reference = input.reference;
    if (reference === undefined) {
      reference = await generateUniqueOrderReference(tx, input.businessId);
    }

    try {
      const row = await tx.salesOrder.create({
        data: {
          businessId: input.businessId, // server-derived, never client (§10)
          customerId: input.customerId ?? null,
          customerNameAtOrder, // frozen snapshot ("" when no customer)
          reference,
          status: "DRAFT", // commercial preparation only (§4/§15)
          currencyCodeAtOrder: business.currencyCode,
          currencySymbolAtOrder: business.currencySymbol,
          decimalPrecisionAtOrder: business.decimalPrecision,
          orderDate: input.orderDate ? new Date(`${input.orderDate}T12:00:00.000Z`) : new Date(),
          expectedDate: input.expectedDate
            ? new Date(`${input.expectedDate}T12:00:00.000Z`)
            : null,
          discountMinor: 0,
          notes: input.notes ?? null, // document data only
          createdByUserId: input.userId, // server-derived
        },
        select: { id: true, reference: true, status: true },
      });

      await audit(
        auditInput(input.businessId, input.userId, "sales_order.create", row.id, row.reference, {
          customerId: input.customerId ?? null,
          customerNameAtOrder,
          status: row.status,
        }),
        tx,
      );

      return row;
    } catch (error) {
      // Database uniqueness stays authoritative for duplicates (§13).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ApiError(
          409,
          SALES_ORDER_ERROR_CODES.DUPLICATE_REFERENCE,
          "A sales order with this reference already exists.",
        );
      }
      throw error;
    }
  });
}

/* --------------------------------- list ----------------------------------- */

export async function listSalesOrders(input: {
  businessId: string;
  q?: string;
  status?: string; // ALL → undefined
  customerId?: string;
  from?: string;
  to?: string;
  timezone?: string; // AUTHENTICATED business timezone (never client authority)
  page: number;
  pageSize: number;
}): Promise<{
  items: Array<{
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
  }>;
  total: number;
  page: number;
  pageSize: number;
}> {
  const cap = salesOrderLineCap(process.env.SALES_ORDER_MAX_LINES);
  const where: Prisma.SalesOrderWhereInput = {
    businessId: input.businessId, // tenant scope
    ...(input.status && input.status !== "ALL" ? { status: input.status } : {}),
    ...(input.customerId ? { customerId: input.customerId } : {}),
    ...(input.from || input.to
      ? (() => {
          // from/to are interpreted in the AUTHENTICATED business timezone
          // (inclusive local start of `from`, EXCLUSIVE local start of the
          // day after `to`) — the ONE canonical window law (§types).
          const window = salesOrderDayWindow(input.from, input.to, input.timezone);
          if (!window) {
            throw new ApiError(422, "VALIDATION_ERROR", "Invalid date filter.");
          }
          return { createdAt: window };
        })()
      : {}),
    ...(input.q
      ? {
          OR: [
            { reference: { contains: input.q } }, // order reference
            { customerNameAtOrder: { contains: input.q } }, // customer snapshot
            {
              lines: {
                some: {
                  OR: [
                    { productNameAtOrder: { contains: input.q } }, // product snapshot
                    { skuAtOrder: { contains: input.q } }, // SKU snapshot
                  ],
                },
              },
            },
          ],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    db.salesOrder.count({ where }),
    // DB-level pagination; never findMany + slice.
    db.salesOrder.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      select: {
        id: true,
        reference: true,
        status: true,
        customerId: true,
        customerNameAtOrder: true,
        orderDate: true,
        expectedDate: true,
        discountMinor: true,
        createdAt: true,
        sale: { select: { number: true, status: true } }, // §66 — invoice presence
        lines: {
          // Bounded per-order aggregate relation, not one query per row.
          // take cap+1 PROVES the slice is the whole line set (§106).
          select: { id: true, orderedQty: true, unitPriceMinor: true },
          take: cap + 1,
        },
        _count: { select: { lines: true } },
      },
    }),
  ]);

  // ONE aggregate for the whole page: POSTED dispatched quantities per
  // order line (§36) — never N queries per row, never in-memory history.
  const lineIds = rows.flatMap((r) => r.lines.map((l) => l.id));
  const dispatchedMap = await sumPostedDispatchedQtyBySalesOrderLines(db, lineIds);

  const items = rows.map((row) => {
    try {
      assertSalesOrderLineSetComplete(row.lines.length, row._count.lines, cap);
      let totalQty = 0;
      let subtotalMinor = 0;
      let dispatchedQty = 0;
      for (const line of row.lines) {
        if (!isValidPersistedOrderQty(line.orderedQty) || !isValidOrderPrice(line.unitPriceMinor)) {
          mapPureSalesOrderDomainError(
            new SalesOrderIntegrityError(
              `${SALES_ORDER_ERROR_CODES.CORRUPT_HISTORY}: invalid persisted line`,
            ),
          );
        }
        totalQty += line.orderedQty;
        subtotalMinor += computeOrderLineTotalMinor(line.orderedQty, line.unitPriceMinor);
        dispatchedQty += computeRemainingToDispatchQty(
          line.orderedQty,
          dispatchedMap.get(line.id) ?? 0,
        ).dispatchedQty;
      }
      if (!Number.isSafeInteger(subtotalMinor)) {
        mapPureSalesOrderDomainError(
          new SalesOrderIntegrityError(
            `${SALES_ORDER_ERROR_CODES.TOTAL_OVERFLOW}: list subtotal overflow`,
          ),
        );
      }
      const totalMinor = computeOrderTotalMinor(subtotalMinor, row.discountMinor);
      const status = parseDbStatus(row.status);
      return {
        id: row.id,
        reference: row.reference,
        status,
        customerId: row.customerId,
        customerNameAtOrder: row.customerNameAtOrder,
        orderDate: row.orderDate.toISOString(),
        expectedDate: row.expectedDate?.toISOString() ?? null,
        lineCount: row._count.lines,
        totalQty,
        totalMinor,
        dispatchedQty,
        remainingToDispatchQty: totalQty - dispatchedQty,
        invoiceNumber: row.sale?.number ?? null, // ONLY when the relation exists (§91)
        invoiceStatus: row.sale?.status ?? null,
        createdAt: row.createdAt.toISOString(),
      };
    } catch (error) {
      return mapPureSalesOrderDomainError(error);
    }
  });
  return { items, total, page: input.page, pageSize: input.pageSize };
}

/* -------------------------------- detail ---------------------------------- */

export async function getSalesOrder(input: {
  businessId: string;
  id: string;
}): Promise<SalesOrderDetailDto & { recentDispatches: ReturnType<typeof salesOrderRecentDispatchDto>[] }> {
  const cap = salesOrderLineCap(process.env.SALES_ORDER_MAX_LINES);
  const row = await db.salesOrder.findFirst({
    where: { id: input.id, businessId: input.businessId }, // tenant scope
    select: {
      id: true,
      reference: true,
      status: true,
      customerId: true,
      customerNameAtOrder: true,
      currencyCodeAtOrder: true,
      currencySymbolAtOrder: true,
      decimalPrecisionAtOrder: true,
      orderDate: true,
      expectedDate: true,
      discountMinor: true,
      notes: true,
      createdByUserId: true,
      createdByUser: { select: { name: true } },
      confirmedAt: true,
      completedAt: true,
      cancelledAt: true,
      createdAt: true,
      updatedAt: true,
      sale: {
        select: { id: true, number: true, status: true, totalMinor: true, paidMinor: true },
      },
      lines: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: cap + 1, // cap+1 proves completeness (§106)
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
      },
      _count: { select: { lines: true } },
    },
  });
  if (!row) throw new ApiError(404, "NOT_FOUND", "Sales order not found.");

  try {
    assertSalesOrderLineSetComplete(row.lines.length, row._count.lines, cap);
    const dispatchedMap = await sumPostedDispatchedQtyBySalesOrderLines(
      db,
      row.lines.map((l) => l.id),
    );
    const detail = salesOrderDetailDto(
      {
        id: row.id,
        reference: row.reference,
        status: row.status,
        customerId: row.customerId,
        customerNameAtOrder: row.customerNameAtOrder,
        currencyCodeAtOrder: row.currencyCodeAtOrder,
        currencySymbolAtOrder: row.currencySymbolAtOrder,
        decimalPrecisionAtOrder: row.decimalPrecisionAtOrder,
        orderDate: row.orderDate,
        expectedDate: row.expectedDate,
        discountMinor: row.discountMinor,
        notes: row.notes,
        createdByUserId: row.createdByUserId,
        createdByName: row.createdByUser?.name ?? null,
        confirmedAt: row.confirmedAt,
        completedAt: row.completedAt,
        cancelledAt: row.cancelledAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      row.lines.map((l) => ({ row: l, dispatchedQty: dispatchedMap.get(l.id) ?? 0 })),
      // §65/§91 — the invoice DTO appears ONLY when the relation exists.
      row.sale ? salesOrderInvoiceDto(row.sale) : null,
    );
    const recentDispatches = await listRecentDispatchesForOrderInternal(
      input.businessId,
      row.id,
      10,
    );
    return { ...detail, recentDispatches };
  } catch (error) {
    return mapPureSalesOrderDomainError(error);
  }
}

/** §90 — recent linked dispatch documents (≤10; posted quantities only). */
async function listRecentDispatchesForOrderInternal(
  businessId: string,
  salesOrderId: string,
  take: number,
): Promise<ReturnType<typeof salesOrderRecentDispatchDto>[]> {
  const rows = await db.goodsDispatch.findMany({
    where: { businessId, salesOrderId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: {
      id: true,
      reference: true,
      status: true,
      postedAt: true,
      lines: {
        select: { qty: true },
        take: goodsDispatchLineCap(process.env.GOODS_DISPATCH_MAX_LINES) + 1,
      },
    },
  });
  return rows.map((r) => {
    // P44 status law applies to the linked documents too — an unknown
    // persisted dispatch status is corruption, never silently rendered.
    parseGoodsDispatchStatus(r.status);
    return salesOrderRecentDispatchDto({
      id: r.id,
      reference: r.reference,
      status: r.status,
      postedAt: r.postedAt,
      totalDispatchedQty: computeDispatchedQty(r.lines.map((l) => l.qty)),
    });
  });
}

/* ------------------------------ header patch ------------------------------ */

export async function updateSalesOrder(input: {
  businessId: string;
  userId: string;
  id: string;
  customerId?: string | null;
  reference?: string;
  orderDate?: string;
  expectedDate?: string | null;
  discountMinor?: number;
  notes?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const cap = salesOrderLineCap(process.env.SALES_ORDER_MAX_LINES);
    const header = await loadOrderHeader(tx, input.businessId, input.id);
    if (header.status !== "DRAFT") {
      // §27 — CONFIRMED orders are immutable (no silent correction).
      throw new ApiError(
        409,
        SALES_ORDER_ERROR_CODES.IMMUTABLE,
        "Only DRAFT sales orders can be changed.",
      );
    }

    const data: Prisma.SalesOrderUpdateInput = {};
    if (input.customerId !== undefined) {
      if (input.customerId === null) {
        data.customer = { disconnect: true };
        data.customerNameAtOrder = "";
      } else {
        const customer = await loadActiveCustomer(tx, input.businessId, input.customerId);
        data.customer = { connect: { id: customer.id } };
        data.customerNameAtOrder = customer.name; // snapshot refrozen (§12)
      }
    }
    if (input.reference !== undefined) data.reference = input.reference;
    if (input.orderDate !== undefined) {
      data.orderDate = new Date(`${input.orderDate}T12:00:00.000Z`);
    }
    if (input.expectedDate !== undefined) {
      data.expectedDate =
        input.expectedDate === null ? null : new Date(`${input.expectedDate}T12:00:00.000Z`);
    }
    if (input.notes !== undefined) data.notes = input.notes;

    if (input.discountMinor !== undefined) {
      // §23 — discount law against the CURRENT canonical subtotal.
      const subtotalMinor = await currentSubtotalMinor(tx, header.id, cap);
      try {
        validateOrderDiscount(input.discountMinor, subtotalMinor);
      } catch {
        throw new ApiError(
          422,
          SALES_ORDER_ERROR_CODES.INVALID_DISCOUNT,
          "Discount cannot exceed the order subtotal.",
        );
      }
      data.discountMinor = input.discountMinor;
    }

    try {
      const updated = await tx.salesOrder.update({
        where: { id: header.id },
        data,
        select: { id: true, reference: true, status: true },
      });

      await audit(
        auditInput(
          input.businessId,
          input.userId,
          "sales_order.update",
          header.id,
          updated.reference,
          {
            changed: {
              ...(input.customerId !== undefined ? { customerId: { changed: true } } : {}),
              ...(input.reference !== undefined
                ? { reference: { from: header.reference, to: updated.reference } }
                : {}),
              ...(input.orderDate !== undefined ? { orderDate: { changed: true } } : {}),
              ...(input.expectedDate !== undefined ? { expectedDate: { changed: true } } : {}),
              ...(input.discountMinor !== undefined
                ? { discountMinor: { from: header.discountMinor, to: input.discountMinor } }
                : {}),
              ...(input.notes !== undefined ? { notes: { changed: true } } : {}),
            },
          },
          { reference: header.reference },
        ),
        tx,
      );

      return updated;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ApiError(
          409,
          SALES_ORDER_ERROR_CODES.DUPLICATE_REFERENCE,
          "A sales order with this reference already exists.",
        );
      }
      throw error;
    }
  });
}

/* ------------------------------- line writes ------------------------------ */

export async function addSalesOrderLine(input: {
  businessId: string;
  userId: string;
  id: string;
  productId: string;
  orderedQty: number;
  unitPriceMinor?: number;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const cap = salesOrderLineCap(process.env.SALES_ORDER_MAX_LINES);
    const header = await loadOrderHeader(tx, input.businessId, input.id);
    if (header.status !== "DRAFT") {
      throw new ApiError(
        409,
        SALES_ORDER_ERROR_CODES.IMMUTABLE,
        "Only DRAFT sales orders can be changed.",
      );
    }

    // §20 — eligible products only: same tenant, exists, not soft-deleted,
    // active. A foreign product is indistinguishable from unknown (404).
    const product = await tx.product.findFirst({
      where: { id: input.productId, businessId: input.businessId, deletedAt: null },
      select: { id: true, name: true, sku: true, unit: true, salePriceMinor: true, isActive: true },
    });
    if (!product || !product.isActive) {
      throw new ApiError(
        404,
        SALES_ORDER_ERROR_CODES.PRODUCT_NOT_FOUND,
        "Product not found.",
      );
    }

    await assertLineCap(tx, header.id, cap); // defensive count

    // §21 — the agreed price: client-supplied or the CURRENT product sale
    // price as the default; persisted ONCE and never re-derived later.
    const unitPriceMinor = input.unitPriceMinor ?? product.salePriceMinor;
    if (!isValidOrderPrice(unitPriceMinor)) {
      throw new ApiError(
        422,
        SALES_ORDER_ERROR_CODES.TOTAL_OVERFLOW,
        "Unit price is outside the allowed range.",
      );
    }
    // §24 — the line total must be exact BEFORE anything persists.
    try {
      computeOrderLineTotalMinor(input.orderedQty, unitPriceMinor);
    } catch (error) {
      if (error instanceof Error && error.name === "SalesOrderTotalOverflowError") {
        throw new ApiError(
          422,
          SALES_ORDER_ERROR_CODES.TOTAL_OVERFLOW,
          "The requested quantity × price exceeds the supported total range.",
        );
      }
      throw error;
    }

    try {
      const line = await tx.salesOrderLine.create({
        data: {
          salesOrderId: header.id,
          productId: product.id,
          orderedQty: input.orderedQty,
          unitPriceMinor,
          // §9/§20 — snapshots copied from the tenant-scoped Product at
          // add time, then frozen; the client never authors them.
          productNameAtOrder: product.name,
          skuAtOrder: product.sku,
          unitAtOrder: product.unit,
        },
        select: { id: true },
      });

      // §23 — the stored discount must still satisfy the law against the
      // NEW subtotal (a line change can shrink the subtotal below it).
      const lines = await loadCompleteLines(tx, header.id, cap);
      const subtotalMinor = computeOrderSubtotalMinor(lines).subtotalMinor;
      if (header.discountMinor > subtotalMinor) {
        throw new ApiError(
          422,
          SALES_ORDER_ERROR_CODES.INVALID_DISCOUNT,
          "Discount cannot exceed the order subtotal.",
        );
      }

      await audit(
        auditInput(
          input.businessId,
          input.userId,
          "sales_order.line_add",
          header.id,
          header.reference,
          {
            lineId: line.id,
            productId: product.id,
            productNameAtOrder: product.name,
            orderedQty: input.orderedQty,
            unitPriceMinor,
          },
        ),
        tx,
      );

      return { id: line.id };
    } catch (error) {
      // DB uniqueness is authoritative for duplicate lines (§19).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ApiError(
          409,
          SALES_ORDER_ERROR_CODES.DUPLICATE_PRODUCT,
          "This product is already on the order.",
        );
      }
      throw error;
    }
  });
}

export async function updateSalesOrderLine(input: {
  businessId: string;
  userId: string;
  id: string;
  lineId: string;
  orderedQty?: number;
  unitPriceMinor?: number;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const cap = salesOrderLineCap(process.env.SALES_ORDER_MAX_LINES);
    const header = await loadOrderHeader(tx, input.businessId, input.id);
    if (header.status !== "DRAFT") {
      throw new ApiError(
        409,
        SALES_ORDER_ERROR_CODES.IMMUTABLE,
        "Only DRAFT sales orders can be changed.",
      );
    }

    const line = await tx.salesOrderLine.findFirst({
      where: { id: input.lineId, salesOrderId: header.id }, // scoped via parent
      select: { id: true, orderedQty: true, unitPriceMinor: true },
    });
    if (!line) throw new ApiError(404, SALES_ORDER_ERROR_CODES.LINE_NOT_FOUND, "Order line not found.");

    const orderedQty = input.orderedQty ?? line.orderedQty;
    const unitPriceMinor = input.unitPriceMinor ?? line.unitPriceMinor;

    // §24 — the new line total must be exact.
    try {
      computeOrderLineTotalMinor(orderedQty, unitPriceMinor);
    } catch (error) {
      if (error instanceof Error && error.name === "SalesOrderTotalOverflowError") {
        throw new ApiError(
          422,
          SALES_ORDER_ERROR_CODES.TOTAL_OVERFLOW,
          "The requested quantity × price exceeds the supported total range.",
        );
      }
      throw error;
    }

    const updated = await tx.salesOrderLine.update({
      where: { id: line.id },
      data: { orderedQty, unitPriceMinor },
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

    // §23 — discount law re-check against the new subtotal.
    const lines = await loadCompleteLines(tx, header.id, cap);
    const subtotalMinor = computeOrderSubtotalMinor(lines).subtotalMinor;
    if (header.discountMinor > subtotalMinor) {
      throw new ApiError(
        422,
        SALES_ORDER_ERROR_CODES.INVALID_DISCOUNT,
        "Discount cannot exceed the order subtotal.",
      );
    }

    await audit(
      auditInput(
        input.businessId,
        input.userId,
        "sales_order.line_update",
        header.id,
        header.reference,
        {
          lineId: line.id,
          orderedQty: { from: line.orderedQty, to: updated.orderedQty },
          unitPriceMinor: { from: line.unitPriceMinor, to: updated.unitPriceMinor },
        },
      ),
      tx,
    );

    return { id: updated.id };
  });
}

export async function removeSalesOrderLine(input: {
  businessId: string;
  userId: string;
  id: string;
  lineId: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const cap = salesOrderLineCap(process.env.SALES_ORDER_MAX_LINES);
    const header = await loadOrderHeader(tx, input.businessId, input.id);
    if (header.status !== "DRAFT") {
      throw new ApiError(
        409,
        SALES_ORDER_ERROR_CODES.IMMUTABLE,
        "Only DRAFT sales orders can be changed.",
      );
    }

    const line = await tx.salesOrderLine.findFirst({
      where: { id: input.lineId, salesOrderId: header.id },
      select: { id: true, productId: true, orderedQty: true },
    });
    if (!line) throw new ApiError(404, SALES_ORDER_ERROR_CODES.LINE_NOT_FOUND, "Order line not found.");

    await tx.salesOrderLine.delete({ where: { id: line.id } });
    const lineCount = await tx.salesOrderLine.count({ where: { salesOrderId: header.id } });

    // §23 — discount law re-check (the subtotal may now be below it).
    if (lineCount > 0) {
      const lines = await loadCompleteLines(tx, header.id, cap);
      const subtotalMinor = computeOrderSubtotalMinor(lines).subtotalMinor;
      if (header.discountMinor > subtotalMinor) {
        throw new ApiError(
          422,
          SALES_ORDER_ERROR_CODES.INVALID_DISCOUNT,
          "Discount cannot exceed the order subtotal.",
        );
      }
    }

    await audit(
      auditInput(
        input.businessId,
        input.userId,
        "sales_order.line_remove",
        header.id,
        header.reference,
        { lineId: line.id, productId: line.productId, orderedQty: line.orderedQty, lineCount },
      ),
      tx,
    );

    return { removed: true, lineCount };
  });
}

/* ------------------------------ confirm/cancel ---------------------------- */

export async function confirmSalesOrder(input: {
  businessId: string;
  userId: string;
  id: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const cap = salesOrderLineCap(process.env.SALES_ORDER_MAX_LINES);
    // Reload INSIDE the transaction; never trust an earlier GET.
    const header = await loadOrderHeader(tx, input.businessId, input.id);
    if (!canTransitionSalesOrder(header.status, "CONFIRMED")) {
      throw new ApiError(
        409,
        SALES_ORDER_ERROR_CODES.INVALID_TRANSITION,
        `Cannot move a sales order from ${header.status} to CONFIRMED.`,
      );
    }

    // §28 — a complete, materially valid line set is REQUIRED.
    const lines = await loadCompleteLines(tx, header.id, cap);
    if (lines.length === 0) {
      throw new ApiError(
        422,
        SALES_ORDER_ERROR_CODES.EMPTY,
        "Add at least one line before confirming this order.",
      );
    }

    // §24/§28 — the canonical total must be exact and the discount lawful.
    const totals = computeOrderSubtotalMinor(lines);
    try {
      validateOrderDiscount(header.discountMinor, totals.subtotalMinor);
    } catch {
      // Persisted discount exceeding its own subtotal is corruption.
      mapPureSalesOrderDomainError(
        new SalesOrderIntegrityError(
          `${SALES_ORDER_ERROR_CODES.CORRUPT_HISTORY}: discount exceeds subtotal`,
        ),
      );
    }
    computeOrderTotalMinor(totals.subtotalMinor, header.discountMinor);

    // §4/§30 — NO stock mutation, NO reservation, NO Sale, NO Payment, NO
    // receivable, NO adjustment. Only the lifecycle + audit change.
    const confirmedAt = new Date();
    const updated = await tx.salesOrder.update({
      where: { id: header.id },
      data: { status: "CONFIRMED", confirmedAt },
      select: { id: true, reference: true, status: true, confirmedAt: true },
    });

    await audit(
      auditInput(input.businessId, input.userId, "sales_order.confirm", header.id, header.reference, {
        lineCount: lines.length,
        subtotalMinor: totals.subtotalMinor,
        discountMinor: header.discountMinor,
        previousStatus: header.status,
        newStatus: updated.status,
        confirmedAt: updated.confirmedAt?.toISOString() ?? null,
      }),
      tx,
    );

    return {
      id: updated.id,
      reference: updated.reference,
      status: updated.status,
      confirmedAt: updated.confirmedAt,
    };
  });
}

export async function cancelSalesOrder(input: {
  businessId: string;
  userId: string;
  id: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const cap = salesOrderLineCap(process.env.SALES_ORDER_MAX_LINES);
    const header = await loadOrderHeader(tx, input.businessId, input.id);
    if (!canTransitionSalesOrder(header.status, "CANCELLED")) {
      throw new ApiError(
        409,
        SALES_ORDER_ERROR_CODES.INVALID_TRANSITION,
        `Cannot move a sales order from ${header.status} to CANCELLED.`,
      );
    }

    if (header.status === "CONFIRMED") {
      // §49/§99 — inside the SAME transaction: no POSTED dispatch
      // quantity may exist and no linked invoice may exist. Stock that
      // has left the business is never "uncancelled" here.
      const lines = await loadCompleteLines(tx, header.id, cap);
      const posted = await fulfillmentMapForLines(
        tx,
        lines.map((l) => l.id),
      );
      let totalPosted = 0;
      for (const line of lines) {
        totalPosted += computeRemainingToDispatchQty(
          line.orderedQty,
          posted.get(line.id) ?? 0,
        ).dispatchedQty;
      }
      if (totalPosted > 0) {
        throw new ApiError(
          409,
          SALES_ORDER_ERROR_CODES.HAS_FULFILLMENT,
          "This order already has posted dispatches and can no longer be cancelled.",
        );
      }
      const invoice = await tx.sale.findFirst({
        where: { salesOrderId: header.id },
        select: { id: true },
      });
      if (invoice) {
        throw new ApiError(
          409,
          SALES_ORDER_ERROR_CODES.HAS_FULFILLMENT,
          "This order already has a linked invoice and can no longer be cancelled.",
        );
      }
    }

    const cancelledAt = new Date();
    const updated = await tx.salesOrder.update({
      where: { id: header.id },
      data: { status: "CANCELLED", cancelledAt },
      select: { id: true, reference: true, status: true, cancelledAt: true },
    });

    await audit(
      auditInput(input.businessId, input.userId, "sales_order.cancel", header.id, header.reference, {
        previousStatus: header.status,
        newStatus: updated.status,
        cancelledAt: updated.cancelledAt?.toISOString() ?? null,
      }),
      tx,
    );

    return {
      id: updated.id,
      reference: updated.reference,
      status: updated.status,
      cancelledAt: updated.cancelledAt,
    };
  });
}

/* --------------------------- linked dispatch create ----------------------- */

/**
 * §40 — order-context linked dispatch creation. ONE atomic transaction:
 * order re-validation (CONFIRMED + dispatchable remaining), the DRAFT
 * GoodsDispatch row (customer context derived from the ORDER, §34; its
 * own business-unique reference, §35), and the audit. NO stock mutation,
 * NO financial record (§40/§96).
 */
export async function createLinkedDispatch(input: {
  businessId: string;
  userId: string;
  id: string; // sales order id
  notes?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const cap = salesOrderLineCap(process.env.SALES_ORDER_MAX_LINES);
    const header = await loadOrderHeader(tx, input.businessId, input.id);
    if (header.status !== "CONFIRMED") {
      // §40 — only CONFIRMED orders accept fulfillment dispatches.
      throw new ApiError(
        409,
        SALES_ORDER_ERROR_CODES.INVALID_STATUS,
        "Only CONFIRMED sales orders can be dispatched.",
      );
    }

    const lines = await loadCompleteLines(tx, header.id, cap);
    const posted = await fulfillmentMapForLines(
      tx,
      lines.map((l) => l.id),
    );
    let dispatchable = false;
    for (const line of lines) {
      const remaining = computeRemainingToDispatchQty(
        line.orderedQty,
        posted.get(line.id) ?? 0,
      ).remainingToDispatchQty;
      if (remaining > 0) {
        dispatchable = true;
        break;
      }
    }
    if (!dispatchable) {
      throw new ApiError(
        409,
        SALES_ORDER_ERROR_CODES.DISPATCH_EXCEEDS_REMAINING,
        "Nothing remains to dispatch on this order.",
      );
    }

    // §35 — the linked dispatch keeps its OWN business-unique reference
    // (never reuses the order reference); the order reference is stored
    // as an additive snapshot.
    let reference: string | undefined;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generateGoodsDispatchReference(new Date(), (max) => randomInt(max));
      const clash = await tx.goodsDispatch.findFirst({
        where: { businessId: input.businessId, reference: candidate },
        select: { id: true },
      });
      if (!clash) {
        reference = candidate;
        break;
      }
    }
    if (reference === undefined) {
      throw new ApiError(
        409,
        "GOODS_DISPATCH_DUPLICATE_REFERENCE",
        "Could not generate a unique dispatch reference. Please try again.",
      );
    }

    // §34 — the customer context derives from the ORDER (the frozen
    // customerNameAtOrder snapshot + the live customer link); the client
    // can never attach an unrelated customer to an order dispatch.
    const row = await tx.goodsDispatch.create({
      data: {
        businessId: input.businessId, // server-derived
        customerId: header.customerId,
        customerNameAtDispatch: header.customerNameAtOrder,
        reference,
        status: "DRAFT", // preparation only — no stock mutation (§40)
        notes: input.notes ?? null,
        createdByUserId: input.userId,
        salesOrderId: header.id,
        salesOrderReferenceAtDispatch: header.reference,
      },
      select: { id: true, reference: true, status: true },
    });

    await audit(
      {
        businessId: input.businessId,
        actorId: input.userId,
        action: "goods_dispatch.create",
        entityType: "GoodsDispatch",
        entityId: row.id,
        after: {
          reference: row.reference,
          salesOrderId: header.id,
          salesOrderReferenceAtDispatch: header.reference,
          customerNameAtDispatch: header.customerNameAtOrder,
          status: row.status,
        },
      },
      tx,
    );
    await audit(
      auditInput(
        input.businessId,
        input.userId,
        "sales_order.dispatch_create",
        header.id,
        header.reference,
        { dispatchId: row.id, dispatchReference: row.reference },
      ),
      tx,
    );

    return row;
  });
}

/* ------------------------------ invoice issuance -------------------------- */

/**
 * §53–§61 — THE order-linked invoice issuance. ONE atomic transaction:
 *  1. order reload + status law (CONFIRMED, §54);
 *  2. one-invoice guard (in-tx existence + unique constraint, §52/§105);
 *  3. full-dispatch proof (every line remaining === 0, §54) — partial
 *     orders can NEVER be invoiced (§100);
 *  4. totals recomputed from the proven-complete line set (§56);
 *  5. Sale + SaleItems creation with the EXISTING invoice numbering
 *     convention (§61) — and NO stock decrement, NO InventoryAdjustment
 *     (§58 — the GoodsDispatch documents already own the movement);
 *  6. SalesOrder → COMPLETED + completedAt (§59);
 *  7. the two audit events, same transaction (§59).
 */
export async function issueOrderInvoice(input: {
  businessId: string;
  userId: string;
  id: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const cap = salesOrderLineCap(process.env.SALES_ORDER_MAX_LINES);
    const header = await loadOrderHeader(tx, input.businessId, input.id);

    // §52/§105 — ONE invoice per order: the relation check runs BEFORE the
    // status gate so that EVERY loser of the issuance path — including the
    // concurrent race where the winner already moved the order to
    // COMPLETED — receives the ONE documented stable conflict code
    // (SALES_ORDER_ALREADY_INVOICED), never a state-dependent code. The
    // database unique constraint remains the final concurrency authority.
    const existing = await tx.sale.findFirst({
      where: { salesOrderId: header.id },
      select: { id: true, number: true },
    });
    if (existing) {
      throw new ApiError(
        409,
        SALES_ORDER_ERROR_CODES.ALREADY_INVOICED,
        "This sales order already has an invoice.",
      );
    }

    if (header.status !== "CONFIRMED") {
      // §54 — only CONFIRMED orders can be invoiced (COMPLETED/CANCELLED
      // orders are terminal; DRAFT orders are not yet commitments).
      throw new ApiError(
        409,
        SALES_ORDER_ERROR_CODES.INVALID_STATUS,
        "Only CONFIRMED sales orders can be invoiced.",
      );
    }

    // §54 — full dispatch proof per line (§36 aggregates; over-dispatch
    // history is integrity corruption, never clamped, §37/§38).
    const lines = await loadCompleteLines(tx, header.id, cap);
    const posted = await fulfillmentMapForLines(
      tx,
      lines.map((l) => l.id),
    );
    for (const line of lines) {
      const remaining = computeRemainingToDispatchQty(
        line.orderedQty,
        posted.get(line.id) ?? 0,
      ).remainingToDispatchQty;
      if (remaining > 0) {
        throw new ApiError(
          409,
          SALES_ORDER_ERROR_CODES.NOT_FULLY_DISPATCHED,
          "Dispatch every ordered quantity before issuing the invoice.",
        );
      }
    }

    // §54 — customer ownership must remain valid when supplied (§11).
    if (header.customerId) {
      const customer = await tx.customer.findFirst({
        where: { id: header.customerId, businessId: input.businessId, deletedAt: null },
        select: { id: true },
      });
      if (!customer) {
        throw new ApiError(
          404,
          SALES_ORDER_ERROR_CODES.CUSTOMER_NOT_FOUND,
          "The order's customer no longer exists in this business.",
        );
      }
    }

    // §56 — recompute and verify totals INSIDE the transaction from the
    // authoritative line contract; the stored discount stays part of the
    // commercial agreement (never silently re-derived).
    const totals = computeOrderSubtotalMinor(lines);
    try {
      validateOrderDiscount(header.discountMinor, totals.subtotalMinor);
    } catch {
      mapPureSalesOrderDomainError(
        new SalesOrderIntegrityError(
          `${SALES_ORDER_ERROR_CODES.CORRUPT_HISTORY}: discount exceeds subtotal`,
        ),
      );
    }
    const totalMinor = computeOrderTotalMinor(totals.subtotalMinor, header.discountMinor);

    // §61 — the EXISTING invoice numbering convention (same as the legacy
    // sale route); the shared write transaction + the per-business unique
    // constraint keep concurrent issuance safe.
    const last = await tx.sale.findFirst({
      where: { businessId: input.businessId },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const number = (last?.number ?? 0) + 1;
    const display = formatInvoiceNumber(number);

    let sale;
    try {
      sale = await tx.sale.create({
        data: {
          businessId: input.businessId,
          number,
          customerId: header.customerId,
          subtotalMinor: totals.subtotalMinor,
          discountMinor: header.discountMinor,
          totalMinor,
          status: "UNPAID", // §57 — payment is a separate authority
          paidMinor: 0,
          issueDate: new Date(),
          note: `Sales order ${header.reference}`,
          // §52 — the relation IS the authority (never a notes heuristic).
          salesOrderId: header.id,
          items: {
            create: lines.map((l) => ({
              productId: l.productId,
              name: l.productNameAtOrder, // §55 — order-line snapshots
              unit: l.unitAtOrder,
              qty: l.orderedQty,
              unitPriceMinor: l.unitPriceMinor,
              lineTotalMinor: computeOrderLineTotalMinor(l.orderedQty, l.unitPriceMinor),
            })),
          },
        },
        select: { id: true, number: true, totalMinor: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const target = JSON.stringify(error.meta?.target ?? []);
        if (target.includes("salesOrderId")) {
          // §105 — lost the one-invoice race: stable conflict, no duplicates.
          throw new ApiError(
            409,
            SALES_ORDER_ERROR_CODES.ALREADY_INVOICED,
            "This sales order already has an invoice.",
          );
        }
        throw new ApiError(
          409,
          SALES_ORDER_ERROR_CODES.INVALID_TRANSITION,
          "Invoice numbering conflict. Please retry.",
        );
      }
      throw error;
    }

    // §59 — the COMPLETED transition commits together with the invoice.
    const completedAt = new Date();
    await tx.salesOrder.update({
      where: { id: header.id },
      data: { status: "COMPLETED", completedAt },
      select: { id: true },
    });

    // §59 — BOTH audit events, same transaction.
    await audit(
      {
        businessId: input.businessId,
        actorId: input.userId,
        action: "sale.create",
        entityType: "Sale",
        entityId: sale.id,
        after: {
          number: sale.number,
          totalMinor: sale.totalMinor,
          items: lines.length,
          customerId: header.customerId,
          salesOrderId: header.id,
        },
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
      tx,
    );
    await audit(
      auditInput(input.businessId, input.userId, "sales_order.invoice", header.id, header.reference, {
        saleId: sale.id,
        invoiceNumber: sale.number,
        totalMinor: sale.totalMinor,
        previousStatus: header.status,
        newStatus: "COMPLETED",
      }),
      tx,
    );

    return {
      saleId: sale.id,
      invoiceNumber: sale.number,
      invoiceDisplay: display,
      totalMinor: sale.totalMinor,
      orderStatus: "COMPLETED" as const,
    };
  });
}

/* --------------------- entity-360 bounded order history ------------------- */

/** §71 — bounded recent orders for the Customer 360 (take ≤ 10). */
export async function listRecentOrdersForCustomer(input: {
  businessId: string;
  customerId: string;
  take?: number;
}): Promise<CustomerRecentSalesOrderDto[]> {
  const take = Math.min(Math.max(input.take ?? 10, 1), 10); // bounded
  const cap = salesOrderLineCap(process.env.SALES_ORDER_MAX_LINES);
  const rows = await db.salesOrder.findMany({
    where: { businessId: input.businessId, customerId: input.customerId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: {
      id: true,
      reference: true,
      status: true,
      orderDate: true,
      currencyCodeAtOrder: true,
      currencySymbolAtOrder: true,
      decimalPrecisionAtOrder: true,
      discountMinor: true,
      sale: { select: { number: true, status: true } },
      lines: { select: { id: true, orderedQty: true, unitPriceMinor: true }, take: cap + 1 },
      _count: { select: { lines: true } },
    },
  });
  const lineIds = rows.flatMap((r) => r.lines.map((l) => l.id));
  const dispatchedMap = await sumPostedDispatchedQtyBySalesOrderLines(db, lineIds);
  return rows.map((r) => {
    try {
      assertSalesOrderLineSetComplete(r.lines.length, r._count.lines, cap);
      let orderedQty = 0;
      let subtotalMinor = 0;
      let dispatchedQty = 0;
      for (const line of r.lines) {
        if (!isValidPersistedOrderQty(line.orderedQty) || !isValidOrderPrice(line.unitPriceMinor)) {
          mapPureSalesOrderDomainError(
            new SalesOrderIntegrityError(
              `${SALES_ORDER_ERROR_CODES.CORRUPT_HISTORY}: invalid persisted line`,
            ),
          );
        }
        orderedQty += line.orderedQty;
        subtotalMinor += computeOrderLineTotalMinor(line.orderedQty, line.unitPriceMinor);
        dispatchedQty += computeRemainingToDispatchQty(
          line.orderedQty,
          dispatchedMap.get(line.id) ?? 0,
        ).dispatchedQty;
      }
      const totalMinor = computeOrderTotalMinor(subtotalMinor, r.discountMinor);
      return customerRecentSalesOrderDto({
        id: r.id,
        reference: r.reference,
        status: r.status,
        orderDate: r.orderDate,
        currencyCodeAtOrder: r.currencyCodeAtOrder,
        currencySymbolAtOrder: r.currencySymbolAtOrder,
        decimalPrecisionAtOrder: r.decimalPrecisionAtOrder,
        totalMinor,
        orderedQty,
        dispatchedQty,
        invoiceNumber: r.sale?.number ?? null,
        invoiceStatus: r.sale?.status ?? null,
      });
    } catch (error) {
      return mapPureSalesOrderDomainError(error);
    }
  });
}

/** §72 — bounded recent orders for the Product detail (take ≤ 10). */
export async function listRecentOrdersForProduct(input: {
  businessId: string;
  productId: string;
  take?: number;
}): Promise<ProductRecentSalesOrderDto[]> {
  const take = Math.min(Math.max(input.take ?? 10, 1), 10); // bounded
  const rows = await db.salesOrderLine.findMany({
    where: {
      productId: input.productId,
      salesOrder: { businessId: input.businessId },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: {
      id: true,
      orderedQty: true,
      salesOrder: {
        select: {
          id: true,
          reference: true,
          status: true,
          customerNameAtOrder: true,
          orderDate: true,
        },
      },
    },
  });
  // ONE aggregate for every fetched order line: POSTED-only dispatched
  // quantities (§36 — the same canonical law as everywhere else).
  const dispatchedMap = await sumPostedDispatchedQtyBySalesOrderLines(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => {
    try {
      if (!isValidPersistedOrderQty(r.orderedQty)) {
        mapPureSalesOrderDomainError(
          new SalesOrderIntegrityError(
            `${SALES_ORDER_ERROR_CODES.CORRUPT_HISTORY}: invalid persisted orderedQty`,
          ),
        );
      }
      return productRecentSalesOrderDto({
        id: r.salesOrder.id,
        reference: r.salesOrder.reference,
        customerNameAtOrder: r.salesOrder.customerNameAtOrder,
        status: r.salesOrder.status,
        orderDate: r.salesOrder.orderDate,
        orderedQty: r.orderedQty,
        dispatchedQty: dispatchedMap.get(r.id) ?? 0,
      });
    } catch (error) {
      return mapPureSalesOrderDomainError(error);
    }
  });
}
