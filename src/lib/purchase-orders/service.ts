import "server-only";

/**
 * Prompt 41 — purchase-order service (server-only, §118/§212).
 *
 * LAWS:
 *  - PROCUREMENT COMMITMENT ONLY (§4/§255): no operation here ever writes
 *    Expense, Payment, Sale, InventoryAdjustment, Product.stockQty,
 *    statements, payables or aging balances — create/send/confirm/close/
 *    cancel included. The static scan enforces this (§147-§150).
 *  - Every query is tenant-scoped by ctx.businessId (§47) — never a client
 *    businessId. Foreign supplier/product/order → 404, no existence leak
 *    (§48/§10/§26).
 *  - Status transitions are server-authoritative through dedicated
 *    operations (§15/§42); the current status is RE-CHECKED INSIDE the
 *    transaction (§61) so concurrent transitions cannot double-apply.
 *  - Money is integer minor units; totals are server-derived with BigInt
 *    and must stay safe integers (§23/§30/§32).
 *  - Snapshots (supplier name, product name/sku/unit, currency) are frozen
 *    at write time and NEVER overwritten from live data (§11/§22/§27).
 *  - Audit through the single sanctioned helper inside the same transaction
 *    (§62-§64); safe metadata only — never notes content, never tokens.
 */
import { randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { withWriteTransaction } from "@/lib/db/write-transaction";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api-helpers";
import {
  computeRemainingQty,
  GoodsReceiptIntegrityError,
  GOODS_RECEIPT_ERROR_CODES,
  GOODS_RECEIPT_LINE_CAP_INVARIANT,
} from "@/lib/inventory/goods-receipt/types";
import { listRecentReceiptsForPurchaseOrder } from "@/lib/inventory/goods-receipt/service";
import {
  PURCHASE_ORDER_ERROR_CODES,
  PURCHASE_ORDER_INVALID_PERSISTED_STATUS,
  PURCHASE_ORDER_TRANSITION_TARGET,
  PurchaseOrderStatusIntegrityError,
  canTransitionPurchaseOrder,
  computePurchaseOrderTotal,
  generatePurchaseOrderReference,
  isPurchaseOrderStatus,
  parsePurchaseOrderStatus,
  purchaseOrderLineCap,
  type PurchaseOrderStatus,
} from "./types";
import {
  purchaseOrderDetailDto,
  purchaseOrderLineDto,
  purchaseOrderListItemDto,
} from "./dto";

type Tx = Prisma.TransactionClient;

/**
 * Prompt 42 §146 — stable error code: a purchase order with POSTED goods
 * receipts can never be cancelled (no receipt-reversal workflow exists).
 */
export const PURCHASE_ORDER_HAS_POSTED_RECEIPTS = "PURCHASE_ORDER_HAS_POSTED_RECEIPTS";

/**
 * §25/§28 — SQLite single-writer hardening (P42 §52/§53): the FIFO
 * serialized-write + bounded-transient-retry mechanism now lives in the
 * ONE shared server utility (`@/lib/db/write-transaction`) so the P41
 * procurement path and the P42 receiving path cannot interleave on the
 * SQLite write lock. Behavior is unchanged: same serialization, same
 * P2034/P2024/SQLITE_BUSY retry class, same deterministic backoff, and
 * domain (ApiError) failures are still never retried.
 */
const withWriteTx = withWriteTransaction;

/** RFC-4180-unsafe day-window helpers on orderedAt (day-precision filters). */
function dayWindow(from?: string, to?: string): { gte?: Date; lte?: Date } {
  const window: { gte?: Date; lte?: Date } = {};
  if (from) window.gte = new Date(`${from}T00:00:00.000Z`);
  if (to) window.lte = new Date(`${to}T23:59:59.999Z`);
  return window;
}

/** §20 — calendar date → the project's UTC-midnoon convention. */
function midnoon(dateIso: string): Date {
  return new Date(`${dateIso}T12:00:00.000Z`);
}

/* ---------------------------- shared internals ----------------------------- */

function assertTransition(from: PurchaseOrderStatus, to: PurchaseOrderStatus): void {
  if (!canTransitionPurchaseOrder(from, to)) {
    throw new ApiError(
      422,
      PURCHASE_ORDER_ERROR_CODES.INVALID_TRANSITION,
      `Cannot move a purchase order from ${from} to ${to}.`,
    );
  }
}

function requireDraft(status: PurchaseOrderStatus): void {
  if (status !== "DRAFT") {
    throw new ApiError(
      409,
      PURCHASE_ORDER_ERROR_CODES.IMMUTABLE,
      "Only DRAFT purchase orders can be edited.",
    );
  }
}

/**
 * §12 — server-side mapping of the pure integrity error to a controlled
 * HTTP result: 500 with the stable PURCHASE_ORDER_INVALID_PERSISTED_STATUS
 * code and a fixed, value-free message. Internal DB details never leak.
 */
function parseDbStatus(value: string): PurchaseOrderStatus {
  try {
    return parsePurchaseOrderStatus(value);
  } catch (error) {
    if (error instanceof PurchaseOrderStatusIntegrityError) {
      throw new ApiError(
        500,
        PURCHASE_ORDER_INVALID_PERSISTED_STATUS,
        "Purchase order data is in an invalid state. Please contact support.",
      );
    }
    throw error;
  }
}

/**
 * §17/§18 — map pure canonical-total failures to their controlled HTTP
 * result: an unsafe total is a 422 (client-relevant bound), never a silent
 * rounding. Integrity errors keep their 500 mapping. Also used by the
 * Supplier 360 / Product history routes so corrupted PO rows surface the
 * SAME stable codes (§12) instead of generic 500s.
 */
export function mapPurePurchaseOrderDomainError(error: unknown): never {
  if (error instanceof PurchaseOrderStatusIntegrityError) {
    throw new ApiError(
      500,
      PURCHASE_ORDER_INVALID_PERSISTED_STATUS,
      "Purchase order data is in an invalid state. Please contact support.",
    );
  }
  if (error instanceof Error && error.message === "PURCHASE_ORDER_TOTAL_OVERFLOW") {
    throw new ApiError(
      422,
      PURCHASE_ORDER_ERROR_CODES.TOTAL_OVERFLOW,
      "This purchase order total exceeds the safe numeric range.",
    );
  }
  throw error;
}

/** Server-side alias used inside this module. */
function mapPureDomainError(error: unknown): never {
  return mapPurePurchaseOrderDomainError(error);
}

async function loadSupplier(tx: Tx, businessId: string, supplierId: string) {
  const supplier = await tx.supplier.findFirst({
    where: { id: supplierId, businessId, deletedAt: null }, // §10 — tenant + not deleted
    select: { id: true, name: true },
  });
  if (!supplier) {
    // §48 — foreign/deleted supplier is indistinguishable from unknown.
    throw new ApiError(404, PURCHASE_ORDER_ERROR_CODES.INVALID_SUPPLIER, "Supplier not found.");
  }
  return supplier;
}

async function loadOrderHeader(
  tx: Tx,
  businessId: string,
  id: string,
): Promise<{
  id: string;
  reference: string;
  status: PurchaseOrderStatus;
  supplierId: string;
  supplierNameAtOrder: string;
  orderedAt: Date;
  expectedDate: Date | null;
  notes: string | null;
  currencyCodeAtOrder: string;
  currencySymbolAtOrder: string;
  decimalPrecisionAtOrder: number;
  createdByUserId: string;
  sentAt: Date | null;
  confirmedAt: Date | null;
  closedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}> {
  const row = await tx.purchaseOrder.findFirst({
    where: { id, businessId }, // §47 — tenant scope from auth context only
    select: {
      id: true,
      reference: true,
      status: true,
      supplierId: true,
      supplierNameAtOrder: true,
      orderedAt: true,
      expectedDate: true,
      notes: true,
      currencyCodeAtOrder: true,
      currencySymbolAtOrder: true,
      decimalPrecisionAtOrder: true,
      createdByUserId: true,
      sentAt: true,
      confirmedAt: true,
      closedAt: true,
      cancelledAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!row) throw new ApiError(404, "NOT_FOUND", "Purchase order not found.");
  // §11/§12 — a corrupted persisted status NEVER silently becomes DRAFT:
  // it is a controlled 500 integrity error (invalid state ≠ draft).
  return { ...row, status: parseDbStatus(row.status) };
}

function auditInput(
  businessId: string,
  actorId: string,
  action: string,
  purchaseOrderId: string,
  reference: string,
  after: Record<string, unknown>,
  before?: Record<string, unknown>,
) {
  return {
    businessId,
    actorId,
    action,
    entityType: "PurchaseOrder",
    entityId: purchaseOrderId,
    ...(before ? { before } : {}),
    after: { reference, ...after }, // §63 — safe metadata; never notes content
  };
}

/** §32 — guard the post-mutation total; 422 instead of silent precision loss. */
function assertSafeTotal(lines: ReadonlyArray<{ orderedQty: number; unitPriceMinor: number }>): void {
  try {
    computePurchaseOrderTotal(lines);
  } catch {
    throw new ApiError(
      422,
      PURCHASE_ORDER_ERROR_CODES.TOTAL_OVERFLOW,
      "This combination of quantities and prices exceeds the safe total range.",
    );
  }
}

/* -------------------------------- create ---------------------------------- */

export async function createPurchaseOrder(input: {
  businessId: string;
  userId: string;
  supplierId: string;
  reference?: string; // undefined/blank → server-generated (§13)
  orderedAt?: string; // calendar date; default now
  expectedDate?: string | null;
  notes?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}) {
  const cap = purchaseOrderLineCap(process.env.PURCHASE_ORDER_MAX_LINES);
  void cap; // creation starts with zero lines; cap bounds LINES (§33)
  const orderedAt = input.orderedAt ? midnoon(input.orderedAt) : new Date();
  const expectedDate = input.expectedDate ? midnoon(input.expectedDate) : null;

  return withWriteTx(async (tx) => {
    const supplier = await loadSupplier(tx, input.businessId, input.supplierId);
    const business = await tx.business.findUnique({
      where: { id: input.businessId },
      select: { currencyCode: true, currencySymbol: true, decimalPrecision: true },
    });
    if (!business) throw new ApiError(404, "NOT_FOUND", "Business not found.");

    const generated = !input.reference;
    const baseReference = generated
      ? generatePurchaseOrderReference(new Date(), (max) => randomInt(max))
      : (input.reference as string);

    // §13 — bounded retry ONLY for generated references; a user-chosen
    // duplicate fails immediately with the stable 409 (§12/§60).
    let lastCollision = false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const reference = generated && attempt > 0
        ? generatePurchaseOrderReference(new Date(), (max) => randomInt(max))
        : baseReference;
      try {
        const row = await tx.purchaseOrder.create({
          data: {
            businessId: input.businessId,
            supplierId: supplier.id,
            reference,
            status: "DRAFT",
            // §22 — currency snapshot from the business, never the client.
            currencyCodeAtOrder: business.currencyCode,
            currencySymbolAtOrder: business.currencySymbol,
            decimalPrecisionAtOrder: business.decimalPrecision,
            orderedAt,
            expectedDate,
            notes: input.notes ?? null,
            supplierNameAtOrder: supplier.name, // §11 — historical identity
            createdByUserId: input.userId, // §209 — always ctx.userId
          },
          select: { id: true, reference: true, status: true },
        });
        await audit(
          auditInput(input.businessId, input.userId, "purchase_order.create", row.id, row.reference, {
            status: row.status,
            supplierId: supplier.id,
            supplierNameAtOrder: supplier.name,
            currencyCodeAtOrder: business.currencyCode,
            lineCount: 0,
          }),
          tx,
        );
        return row;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          lastCollision = true;
          if (!generated) break; // §60 — user-chosen reference collision → 409
          continue; // §13 — regenerate and retry (bounded)
        }
        throw error;
      }
    }
    if (lastCollision) {
      throw new ApiError(
        409,
        PURCHASE_ORDER_ERROR_CODES.DUPLICATE_REFERENCE,
        "A purchase order with this reference already exists.",
      );
    }
    throw new ApiError(500, "INTERNAL_ERROR", "Purchase order could not be created.");
  });
}

/* --------------------------------- list ----------------------------------- */

export async function listPurchaseOrders(input: {
  businessId: string;
  q?: string;
  status?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}) {
  const cap = purchaseOrderLineCap(process.env.PURCHASE_ORDER_MAX_LINES);
  const where: Prisma.PurchaseOrderWhereInput = { businessId: input.businessId };
  if (input.q) {
    // §53 — reference + supplier snapshot + product snapshot names/SKUs.
    where.OR = [
      { reference: { contains: input.q } },
      { supplierNameAtOrder: { contains: input.q } },
      { supplier: { is: { name: { contains: input.q } } } },
      { lines: { some: { OR: [
        { productNameAtOrder: { contains: input.q } },
        { skuAtOrder: { contains: input.q } },
      ] } } },
    ];
  }
  if (input.status && isPurchaseOrderStatus(input.status)) where.status = input.status;
  if (input.from || input.to) where.orderedAt = dayWindow(input.from, input.to);

  const [rows, total] = await Promise.all([
    db.purchaseOrder.findMany({
      where,
      // §55 — deterministic: orderedAt DESC, then createdAt DESC, then id DESC.
      orderBy: [{ orderedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      select: {
        id: true,
        reference: true,
        status: true,
        supplierId: true,
        supplierNameAtOrder: true,
        currencyCodeAtOrder: true,
        currencySymbolAtOrder: true,
        decimalPrecisionAtOrder: true,
        orderedAt: true,
        expectedDate: true,
        createdAt: true,
        updatedAt: true,
        // §16 — the line slice is EXPLICITLY bounded by the same cap law as
        // the write path (defense against invariant drift/corrupt rows).
        lines: { select: { orderedQty: true, unitPriceMinor: true }, take: cap },
        _count: { select: { lines: true } },
      },
    }),
    db.purchaseOrder.count({ where }),
  ]);

  let items;
  try {
    items = rows.map((row) => {
      if (row._count.lines > row.lines.length) {
        // §16 — a truncated slice would make every total a LIE. The write
        // path forbids this; treat it as the invariant violation it is.
        throw new Error("PURCHASE_ORDER_LINE_CAP_INVARIANT");
      }
      return purchaseOrderListItemDto({
        ...row,
        supplierName: null,
        createdByName: null,
        createdByUserId: "",
        sentAt: null,
        confirmedAt: null,
        closedAt: null,
        cancelledAt: null,
        notes: null,
        lineCount: row._count.lines,
      });
    });
  } catch (error) {
    if (error instanceof Error && error.message === "PURCHASE_ORDER_LINE_CAP_INVARIANT") {
      throw new ApiError(
        500,
        "PURCHASE_ORDER_LINE_CAP_INVARIANT",
        "Purchase order line cap invariant violated.",
      );
    }
    mapPureDomainError(error); // §17 — overflow/integrity → controlled errors
  }

  return {
    items,
    total,
    page: input.page,
    pageSize: input.pageSize,
  };
}

/* -------------------------------- detail ---------------------------------- */

export async function getPurchaseOrder(input: { businessId: string; id: string }) {
  const cap = purchaseOrderLineCap(process.env.PURCHASE_ORDER_MAX_LINES);
  // §22 — header, supplier state, creator and lines are read in ONE
  // consistent transaction so the response can never combine a stale header
  // with mismatched line state (production-quality document read).
  // Prompt 42 §98/§181/§296 — the receiving aggregates are computed in the
  // SAME transaction via a grouped query (never one query per line).
  const { header, supplier, creator, lineRows } = await db.$transaction(async (tx) => {
    const hdr = await loadOrderHeader(tx, input.businessId, input.id);
    const [sup, usr, lineRws] = await Promise.all([
      // §23 — EXPLICIT tenant scope on the live-supplier read: a foreign
      // tenant's supplier row is unreachable even by internal id.
      tx.supplier.findFirst({
        where: { id: hdr.supplierId, businessId: input.businessId },
        select: { name: true, deletedAt: true },
      }),
      // §24 — creator read exposes ONLY id + name (no hashes/secrets).
      tx.user.findUnique({
        where: { id: hdr.createdByUserId },
        select: { id: true, name: true },
      }),
      // §158 — ALL lines (the order is hard-capped); cap+1 proves completeness.
      tx.purchaseOrderLine.findMany({
        where: { purchaseOrderId: hdr.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
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
      }),
    ]);
    return { header: hdr, supplier: sup, creator: usr, lineRows: lineRws };
  });

  // Prompt 42 §98 — bounded grouped receiving aggregates AFTER the
  // transactional document read (two reads, each internally consistent;
  // the aggregates only ever grow so a marginally newer posted receipt is
  // a safe display race — never a stock or quantity authority).
  // P42-F §14/§16 — take cap+1 proves the PO-line read is complete: more
  // lines than the PO's own cap is corruption → stable invariant 500,
  // never a partial receiving summary computed from a truncated slice.
  let receivingAgg: Parameters<typeof purchaseOrderDetailDto>[2] | undefined;
  try {
    const poLines = await db.purchaseOrderLine.findMany({
      where: { purchaseOrderId: header.id },
      select: { id: true, orderedQty: true },
      take: cap + 1, // P42-F §14 — completeness proof
    });
    if (poLines.length > cap) {
      throw new ApiError(
        500,
        GOODS_RECEIPT_LINE_CAP_INVARIANT,
        "Stored purchase order data exceeds its configured line cap. Please contact support.",
      );
    }
    const grouped = await db.goodsReceiptLine.groupBy({
      by: ["purchaseOrderLineId"],
      where: {
        purchaseOrderLineId: { in: poLines.map((l) => l.id) },
        goodsReceipt: { status: "POSTED" }, // §99 — POSTED receipts only
      },
      _sum: { receivedQty: true },
    });
    const receivedByLine = new Map(
      grouped.map((g) => [g.purchaseOrderLineId, g._sum.receivedQty ?? 0]),
    );
    const receiptCount = await db.goodsReceipt.count({
      where: { purchaseOrderId: header.id, status: "POSTED" },
    });
    let orderedQty = 0;
    let receivedQty = 0;
    const recvLines = poLines.map((l) => {
      const lineReceived = receivedByLine.get(l.id) ?? 0;
      const lineRemaining = computeRemainingQty(l.orderedQty, lineReceived); // §100
      orderedQty += l.orderedQty;
      receivedQty += lineReceived;
      return { lineId: l.id, receivedQty: lineReceived, remainingQty: lineRemaining };
    });
    const remainingQty = computeRemainingQty(orderedQty, receivedQty);
    receivingAgg = {
      orderedQty,
      receivedQty,
      remainingQty,
      receiptCount,
      fullyReceived: remainingQty === 0, // §101 — derived
      lines: recvLines,
    };
  } catch (error) {
    // §283 — corrupted received history surfaces as the stable P42 code
    // (never a silent clamp, never a generic 500).
    if (
      error instanceof GoodsReceiptIntegrityError ||
      (error instanceof Error && error.message === "GOODS_RECEIPT_CORRUPT_RECEIVED_HISTORY")
    ) {
      throw new ApiError(
        500,
        GOODS_RECEIPT_ERROR_CODES.CORRUPT_RECEIVED,
        "Receiving data is inconsistent. Please contact support.",
      );
    }
    mapPureDomainError(error); // §17 — overflow/integrity → controlled errors
  }

  if (lineRows.length > cap) {
    // Defensive: the write path prevents this; never render a partial document.
    throw new ApiError(500, "INTERNAL_ERROR", "Purchase order line cap invariant violated.");
  }

  // §104 — bounded recent receipts (take 10, §105). Read AFTER the main
  // document read; a marginally newer receipt is a safe display race.
  let recentReceipts;
  try {
    recentReceipts = await listRecentReceiptsForPurchaseOrder({
      businessId: input.businessId,
      purchaseOrderId: header.id,
      take: 10,
    });
  } catch {
    recentReceipts = undefined; // §104-analog — history is display-only
  }

  try {
    return purchaseOrderDetailDto(
      {
        ...header,
        // §11 — live name ONLY as a navigation aid; display identity is the
        // snapshot. A soft-deleted supplier renders as "no longer listed".
        supplierName: supplier && supplier.deletedAt === null ? supplier.name : null,
        createdByName: creator?.name ?? null,
      },
      lineRows,
      receivingAgg,
      recentReceipts,
    );
  } catch (error) {
    mapPureDomainError(error); // §13/§17 — controlled integrity/overflow
  }
}

/* ---------------------------- draft header patch --------------------------- */

export async function updatePurchaseOrder(input: {
  businessId: string;
  userId: string;
  id: string;
  reference?: string;
  orderedAt?: string;
  expectedDate?: string | null;
  notes?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const header = await loadOrderHeader(tx, input.businessId, input.id);
    requireDraft(header.status); // §43 — DRAFT-only header patch

    const data: Prisma.PurchaseOrderUpdateInput = {};
    if (input.reference !== undefined) data.reference = input.reference;
    if (input.orderedAt !== undefined) data.orderedAt = midnoon(input.orderedAt);
    if (input.expectedDate !== undefined) {
      data.expectedDate = input.expectedDate ? midnoon(input.expectedDate) : null;
    }
    if (input.notes !== undefined) data.notes = input.notes;

    const updated = await tx.purchaseOrder.update({
      where: { id: header.id },
      data,
      select: { id: true, reference: true, status: true, updatedAt: true },
    });
    await audit(
      auditInput(
        input.businessId,
        input.userId,
        "purchase_order.update",
        header.id,
        updated.reference,
        {
          status: updated.status,
          changed: {
            ...(input.reference !== undefined ? { reference: true } : {}),
            ...(input.orderedAt !== undefined ? { orderedAt: input.orderedAt } : {}),
            ...(input.expectedDate !== undefined ? { expectedDate: input.expectedDate } : {}),
            ...(input.notes !== undefined ? { notes: true } : {}),
          },
          // §63 — before/after of the changed header fields (no notes content).
          ...(input.reference !== undefined ? { referenceBefore: header.reference } : {}),
          ...(input.expectedDate !== undefined
            ? { expectedDateBefore: header.expectedDate?.toISOString() ?? null }
            : {}),
        },
      ),
      tx,
    );
    return updated;
  });
}

/* -------------------------------- lines ----------------------------------- */

export async function addPurchaseOrderLine(input: {
  businessId: string;
  userId: string;
  id: string;
  productId: string;
  orderedQty: number;
  unitPriceMinor: number;
  ip?: string | null;
  userAgent?: string | null;
}) {
  const cap = purchaseOrderLineCap(process.env.PURCHASE_ORDER_MAX_LINES);
  return withWriteTx(async (tx) => {
    // §58 steps 1-2 — order exists in tenant + DRAFT.
    const header = await loadOrderHeader(tx, input.businessId, input.id);
    requireDraft(header.status);

    // §58 step 3-5 — product exists in the same business, not deleted, and
    // ACTIVE for NEW selections (existing draft lines stay historical §26).
    const product = await tx.product.findFirst({
      where: { id: input.productId, businessId: input.businessId, deletedAt: null },
      select: { id: true, name: true, sku: true, unit: true, isActive: true },
    });
    if (!product) {
      throw new ApiError(404, PURCHASE_ORDER_ERROR_CODES.INVALID_PRODUCT, "Product not found.");
    }
    if (!product.isActive) {
      throw new ApiError(
        422,
        PURCHASE_ORDER_ERROR_CODES.PRODUCT_INACTIVE,
        "Inactive products cannot be added to a purchase order.",
      );
    }

    // §58 step 6 — line cap.
    const lineCount = await tx.purchaseOrderLine.count({ where: { purchaseOrderId: header.id } });
    if (lineCount >= cap) {
      throw new ApiError(
        422,
        PURCHASE_ORDER_ERROR_CODES.LINE_LIMIT,
        `Purchase order line limit reached (${cap}).`,
      );
    }

    // §58 step 9 — snapshot product metadata at write time (§27).
    try {
      const line = await tx.purchaseOrderLine.create({
        data: {
          purchaseOrderId: header.id,
          productId: product.id,
          orderedQty: input.orderedQty,
          unitPriceMinor: input.unitPriceMinor,
          productNameAtOrder: product.name,
          skuAtOrder: product.sku,
          unitAtOrder: product.unit,
        },
        // §67 — the FULL persisted row feeds the DTO (real timestamps).
        select: {
          id: true,
          orderedQty: true,
          unitPriceMinor: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      // §25 — belt-and-braces cap re-check INSIDE the transaction: two
      // racing adds cannot both survive SQLite serialization — if the
      // create pushed the count past the cap, this throw ROLLS BACK the
      // whole transaction so >cap lines can never persist.
      const lineCountAfter = await tx.purchaseOrderLine.count({
        where: { purchaseOrderId: header.id },
      });
      if (lineCountAfter > cap) {
        throw new ApiError(
          422,
          PURCHASE_ORDER_ERROR_CODES.LINE_LIMIT,
          `Purchase order line limit reached (${cap}).`,
        );
      }

      // §58 step 10 — audit inside the same transaction.
      await audit(
        auditInput(input.businessId, input.userId, "purchase_order.line_add", header.id, header.reference, {
          lineId: line.id,
          productId: product.id,
          productNameAtOrder: product.name,
          orderedQty: line.orderedQty,
          unitPriceMinor: line.unitPriceMinor,
          lineCount: lineCountAfter,
        }),
        tx,
      );

      // §32 — the resulting document total must remain a safe integer.
      const lines = await tx.purchaseOrderLine.findMany({
        where: { purchaseOrderId: header.id },
        select: { orderedQty: true, unitPriceMinor: true },
      });
      assertSafeTotal(lines);

      // §67 — DTO built from the PERSISTED row: real snapshots + real
      // timestamps, nothing fabricated.
      return purchaseOrderLineDto({
        ...line,
        productId: product.id,
        productNameAtOrder: product.name,
        skuAtOrder: product.sku,
        unitAtOrder: product.unit,
      });
    } catch (error) {
      // §59 — DB uniqueness is authoritative for duplicate products.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ApiError(
          409,
          PURCHASE_ORDER_ERROR_CODES.DUPLICATE_PRODUCT,
          "This product is already on the purchase order.",
        );
      }
      throw error;
    }
  });
}

export async function updatePurchaseOrderLine(input: {
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
    const header = await loadOrderHeader(tx, input.businessId, input.id);
    requireDraft(header.status); // §35 — DRAFT-only

    const line = await tx.purchaseOrderLine.findFirst({
      where: { id: input.lineId, purchaseOrderId: header.id }, // §47 — scoped via parent
      select: { id: true, orderedQty: true, unitPriceMinor: true, productId: true },
    });
    if (!line) throw new ApiError(404, "NOT_FOUND", "Purchase order line not found.");

    const data: Prisma.PurchaseOrderLineUpdateInput = {};
    if (input.orderedQty !== undefined) data.orderedQty = input.orderedQty;
    if (input.unitPriceMinor !== undefined) data.unitPriceMinor = input.unitPriceMinor;

    // §9 — re-read the COMPLETE persisted row after the mutation: the API
    // response must carry the real stored snapshots (productNameAtOrder /
    // skuAtOrder / unitAtOrder) and the real stored timestamps — never
    // placeholders and never fabricated `new Date()` approximations.
    const updated = await tx.purchaseOrderLine.update({
      where: { id: line.id },
      data,
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

    await audit(
      auditInput(input.businessId, input.userId, "purchase_order.line_update", header.id, header.reference, {
        lineId: line.id,
        changed: {
          ...(input.orderedQty !== undefined
            ? { orderedQty: { from: line.orderedQty, to: updated.orderedQty } }
            : {}),
          ...(input.unitPriceMinor !== undefined
            ? { unitPriceMinor: { from: line.unitPriceMinor, to: updated.unitPriceMinor } }
            : {}),
        },
      }),
      tx,
    );

    // §32 — total stays safe after the edit.
    const lines = await tx.purchaseOrderLine.findMany({
      where: { purchaseOrderId: header.id },
      select: { orderedQty: true, unitPriceMinor: true },
    });
    assertSafeTotal(lines);

    // §9 — DTO straight from the persisted row (real values, zero fabrication).
    return purchaseOrderLineDto(updated);
  });
}

export async function removePurchaseOrderLine(input: {
  businessId: string;
  userId: string;
  id: string;
  lineId: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const header = await loadOrderHeader(tx, input.businessId, input.id);
    requireDraft(header.status); // §36 — DRAFT-only

    const line = await tx.purchaseOrderLine.findFirst({
      where: { id: input.lineId, purchaseOrderId: header.id },
      select: { id: true, productId: true, orderedQty: true, unitPriceMinor: true },
    });
    if (!line) throw new ApiError(404, "NOT_FOUND", "Purchase order line not found.");

    await tx.purchaseOrderLine.delete({ where: { id: line.id } });
    const lineCount = await tx.purchaseOrderLine.count({ where: { purchaseOrderId: header.id } });

    await audit(
      auditInput(input.businessId, input.userId, "purchase_order.line_remove", header.id, header.reference, {
        lineId: line.id,
        productId: line.productId,
        lineCount,
      }),
      tx,
    );

    return { removed: true, lineCount };
  });
}

/* ------------------------------- lifecycle --------------------------------- */

async function assertSupplierStillValid(tx: Tx, businessId: string, supplierId: string) {
  const supplier = await tx.supplier.findFirst({
    where: { id: supplierId, businessId, deletedAt: null },
    select: { id: true },
  });
  if (!supplier) {
    throw new ApiError(
      422,
      PURCHASE_ORDER_ERROR_CODES.INVALID_SUPPLIER,
      "The supplier of this purchase order is no longer available.",
    );
  }
}

export async function transitionPurchaseOrder(input: {
  businessId: string;
  userId: string;
  id: string;
  op: "send" | "confirm" | "close" | "cancel";
  ip?: string | null;
  userAgent?: string | null;
}) {
  const target = PURCHASE_ORDER_TRANSITION_TARGET[input.op];

  return withWriteTx(async (tx) => {
    // §61 — current status re-checked INSIDE the transaction; two concurrent
    // confirms cannot both succeed (the second sees the new status).
    const header = await loadOrderHeader(tx, input.businessId, input.id);
    assertTransition(header.status, target);

    if (input.op === "send") {
      // §37/§38 — a document needs at least one line to be sent.
      const lineCount = await tx.purchaseOrderLine.count({ where: { purchaseOrderId: header.id } });
      if (lineCount < 1) {
        throw new ApiError(
          422,
          PURCHASE_ORDER_ERROR_CODES.EMPTY_ORDER,
          "Add at least one line before sending.",
        );
      }
      // §38 — supplier must still exist and not be soft-deleted.
      await assertSupplierStillValid(tx, input.businessId, header.supplierId);
    }

    if (input.op === "cancel") {
      // Prompt 42 §146 — PO CANCELLATION HARDENING: an order with POSTED
      // goods receipts cannot be cancelled. Physical inventory already
      // exists behind it; there is no receipt-reversal workflow (and none
      // may be silently invented here). Checked INSIDE the write
      // transaction so a receipt posting concurrently cannot slip through.
      const postedReceipts = await tx.goodsReceipt.count({
        where: { businessId: input.businessId, purchaseOrderId: header.id, status: "POSTED" },
      });
      if (postedReceipts > 0) {
        throw new ApiError(
          409,
          PURCHASE_ORDER_HAS_POSTED_RECEIPTS,
          "This purchase order has posted goods receipts and can no longer be cancelled.",
        );
      }
    }

    const now = new Date();
    const data: Prisma.PurchaseOrderUpdateInput = { status: target };
    if (target === "SENT") data.sentAt = now;
    if (target === "CONFIRMED") data.confirmedAt = now;
    if (target === "CLOSED") data.closedAt = now;
    if (target === "CANCELLED") data.cancelledAt = now;

    const updated = await tx.purchaseOrder.update({
      where: { id: header.id },
      data,
      select: { id: true, reference: true, status: true, sentAt: true, confirmedAt: true, closedAt: true, cancelledAt: true },
    });

    // §17/§18 — CONFIRMED/CLOSED are pure document-state transitions: NO
    // inventory, expense, payment or statement write happens here (pinned
    // by the §110-§113 negative tests and the §147-§150 static scan).
    await audit(
      auditInput(input.businessId, input.userId, `purchase_order.${input.op}`, header.id, header.reference, {
        previousStatus: header.status,
        newStatus: target,
      }),
      tx,
    );

    return updated;
  });
}
