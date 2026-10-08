import "server-only";

/**
 * Prompt 42 — goods-receipt service (server-only, §169).
 *
 * LAWS:
 *  - PHYSICAL INVENTORY EVENT ONLY (§3/§4/§5): posting mutates
 *    Product.stockQty and creates one positive InventoryAdjustment per
 *    non-zero received line. It NEVER creates Expense, Payment, Sale,
 *    supplier-statement movement, payable/aging row or any accounting
 *    entry (§5/§160-§164). Draft/cancel mutate NOTHING but the receipt.
 *  - OVER-RECEIPT LAW (§15): SUM(posted received) + new quantity ≤
 *    orderedQty, enforced by the ONE pure helper at line-add (advisory,
 *    §66) AND authoritatively inside the post transaction (§39 step 8).
 *    No tolerance, no bypass, no silent overage (§15).
 *  - Every query is tenant-scoped by ctx.businessId (§89) — never a
 *    client businessId. Foreign PO/PO-line/receipt → 404, no existence
 *    leak (§90/§91).
 *  - Status transitions are server-authoritative through dedicated
 *    operations (§7); the current status is RE-CHECKED INSIDE the write
 *    transaction (§73) so concurrent posts/cancels cannot double-apply.
 *  - Snapshots (supplier name, PO reference, product name/sku/unit) are
 *    frozen at write time from ALREADY-FROZEN PO data (§24/§25/§28/§29)
 *    and NEVER overwritten from live data.
 *  - Quantities are exact integers (§18/§48); stock math is Int32-bounded
 *    (§49); corrupt persisted state is surfaced, never repaired (§46/§47).
 *  - Audit through the single sanctioned helper INSIDE the same
 *    transaction as every mutation (§154) — safe metadata only, never
 *    notes content (§155).
 */
import { randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { withWriteTransaction } from "@/lib/db/write-transaction";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api-helpers";
import {
  GOODS_RECEIPT_ERROR_CODES,
  GoodsReceiptIntegrityError,
  GOODS_RECEIPT_INVALID_PERSISTED_STATUS,
  PRODUCT_STOCK_INT32_MAX,
  canTransitionGoodsReceipt,
  computeReceivedQty,
  computeRemainingQty,
  exceedsRemaining,
  generateGoodsReceiptReference,
  goodsReceiptLineCap,
  parseGoodsReceiptStatus,
  purchaseOrderIsReceivable,
  stockOverflowsInt32,
  type GoodsReceiptStatus,
} from "./types";
import {
  goodsReceiptDetailDto,
  goodsReceiptLineDto,
  goodsReceiptListItemDto,
  type GoodsReceiptDetailDto,
  type GoodsReceiptListItemDto,
  type PurchaseOrderRecentReceiptDto,
} from "./dto";

type Tx = Prisma.TransactionClient;

/**
 * §52/§54 — the ONE shared SQLite write-transaction law (FIFO serialized
 * writes + bounded transient retry). Both the P41 procurement path and
 * this P42 receiving path run through the same helper so neither can
 * interleave with the other on the single write lock.
 */
const withWriteTx = withWriteTransaction;

/** §41 — the adjustment reason ties every posted line to its receipt. */
const RECEIPT_ADJUSTMENT_REASON = (reference: string) =>
  `Goods receipt ${reference}: inventory receiving`;

/** §98-analog day-window helpers on createdAt (day-precision filters). */
function dayWindow(from?: string, to?: string): { gte?: Date; lte?: Date } {
  const window: { gte?: Date; lte?: Date } = {};
  if (from) window.gte = new Date(`${from}T00:00:00.000Z`);
  if (to) window.lte = new Date(`${to}T23:59:59.999Z`);
  return window;
}

/* ---------------------------- shared internals ----------------------------- */

/** §96 — corrupted persisted status → controlled 500 (never Draft). */
function parseDbStatus(value: string): GoodsReceiptStatus {
  try {
    return parseGoodsReceiptStatus(value);
  } catch (error) {
    if (error instanceof Error && error.name === "GoodsReceiptStatusIntegrityError") {
      throw new ApiError(
        500,
        GOODS_RECEIPT_INVALID_PERSISTED_STATUS,
        "Goods receipt data is in an invalid state. Please contact support.",
      );
    }
    throw error;
  }
}

/**
 * §100/§283 — map pure canonical-math integrity failures to their
 * controlled HTTP result: corrupted received history is a 500, never a
 * silent clamp to 0. Exported for the PO detail route so corrupted rows
 * surface the SAME stable code there (§283 — receiving summary included).
 */
export function mapPureGoodsReceiptDomainError(error: unknown): never {
  if (error instanceof Error && error.name === "GoodsReceiptStatusIntegrityError") {
    throw new ApiError(
      500,
      GOODS_RECEIPT_INVALID_PERSISTED_STATUS,
      "Goods receipt data is in an invalid state. Please contact support.",
    );
  }
  if (error instanceof GoodsReceiptIntegrityError) {
    throw new ApiError(
      500,
      GOODS_RECEIPT_ERROR_CODES.CORRUPT_RECEIVED,
      "Receiving data is inconsistent. Please contact support.",
    );
  }
  if (error instanceof Error && error.message === "GOODS_RECEIPT_CORRUPT_RECEIVED_HISTORY") {
    throw new ApiError(
      500,
      GOODS_RECEIPT_ERROR_CODES.CORRUPT_RECEIVED,
      "Receiving data is inconsistent. Please contact support.",
    );
  }
  throw error;
}

function requireDraft(status: GoodsReceiptStatus): void {
  if (status !== "DRAFT") {
    // §64/§68/§69 — POSTED is immutable (§8); CANCELLED is terminal (§10).
    throw new ApiError(
      409,
      GOODS_RECEIPT_ERROR_CODES.IMMUTABLE,
      "Only DRAFT goods receipts can be changed.",
    );
  }
}

function assertTransition(from: GoodsReceiptStatus, to: GoodsReceiptStatus): void {
  if (!canTransitionGoodsReceipt(from, to)) {
    throw new ApiError(
      409,
      GOODS_RECEIPT_ERROR_CODES.INVALID_TRANSITION,
      `Cannot move a goods receipt from ${from} to ${to}.`,
    );
  }
}

async function loadReceiptHeader(
  tx: Tx,
  businessId: string,
  id: string,
): Promise<{
  id: string;
  reference: string;
  status: GoodsReceiptStatus;
  purchaseOrderId: string;
  purchaseOrderReferenceAtReceipt: string;
  supplierNameAtReceipt: string;
  notes: string | null;
  createdByUserId: string;
  postedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
}> {
  const row = await tx.goodsReceipt.findFirst({
    where: { id, businessId }, // §89 — tenant scope from auth context only
    select: {
      id: true,
      reference: true,
      status: true,
      purchaseOrderId: true,
      purchaseOrderReferenceAtReceipt: true,
      supplierNameAtReceipt: true,
      notes: true,
      createdByUserId: true,
      postedAt: true,
      cancelledAt: true,
      createdAt: true,
    },
  });
  if (!row) throw new ApiError(404, "NOT_FOUND", "Goods receipt not found.");
  // §96 — a corrupted persisted status NEVER silently becomes DRAFT.
  return { ...row, status: parseDbStatus(row.status) };
}

/** §65 — only CONFIRMED orders may receive; any other status → 422. */
function assertPurchaseOrderReceivable(status: GoodsReceiptStatus | string): void {
  if (!purchaseOrderIsReceivable(status)) {
    throw new ApiError(
      422,
      GOODS_RECEIPT_ERROR_CODES.PO_NOT_RECEIVABLE,
      "Goods can be received only against a confirmed purchase order.",
    );
  }
}

function auditInput(
  businessId: string,
  actorId: string,
  action: string,
  goodsReceiptId: string,
  reference: string,
  after: Record<string, unknown>,
  before?: Record<string, unknown>,
) {
  return {
    businessId,
    actorId,
    action,
    entityType: "GoodsReceipt",
    entityId: goodsReceiptId,
    ...(before ? { before } : {}),
    after: { reference, ...after }, // §155 — safe metadata; never notes content
  };
}

/**
 * §39 steps 6-7 (shared by line-add advisory check and post-time
 * authoritative check): POSTED-only quantity sum for ONE PO line.
 * DRAFT/CANCELLED receipts never count (§99). Tenant scope is inherited
 * from the receipt→PO chain which the caller has already verified.
 */
async function sumPostedQtyForPoLine(tx: Tx, purchaseOrderLineId: string): Promise<number> {
  const rows = await tx.goodsReceiptLine.findMany({
    where: {
      purchaseOrderLineId,
      goodsReceipt: { status: "POSTED" }, // §99 — POSTED only
    },
    select: { receivedQty: true },
  });
  try {
    return computeReceivedQty(rows.map((r) => r.receivedQty));
  } catch (error) {
    return mapPureGoodsReceiptDomainError(error);
  }
}

/** §71 — defensive line-count validation (add line + post). */
async function assertLineCap(tx: Tx, goodsReceiptId: string, cap: number): Promise<number> {
  const lineCount = await tx.goodsReceiptLine.count({ where: { goodsReceiptId } });
  if (lineCount >= cap) {
    throw new ApiError(
      422,
      GOODS_RECEIPT_ERROR_CODES.LINE_LIMIT,
      `A goods receipt can contain at most ${cap} lines.`,
    );
  }
  return lineCount;
}

/**
 * §45/§46/§47 — post-time stock sanity: current stock must be a valid
 * non-negative integer. Corrupt stored stock (negative) is surfaced as a
 * controlled 500 — NEVER silently repaired (§47).
 */
function assertPersistedStockValid(stockQty: number): void {
  if (!Number.isInteger(stockQty) || stockQty < 0) {
    throw new ApiError(
      500,
      GOODS_RECEIPT_ERROR_CODES.INVALID_PERSISTED_STOCK,
      "Product stock data is in an invalid state. Please contact support.",
    );
  }
}

/* -------------------------------- create ----------------------------------- */

export async function createGoodsReceipt(input: {
  businessId: string;
  userId: string;
  purchaseOrderId: string;
  reference?: string;
  notes?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    // §11/§23 — the PO must be tenant-scoped and CONFIRMED.
    const po = await tx.purchaseOrder.findFirst({
      where: { id: input.purchaseOrderId, businessId: input.businessId }, // §90 — foreign PO → 404
      select: {
        id: true,
        reference: true,
        status: true,
        supplierNameAtOrder: true, // §25 — copy the ALREADY-FROZEN snapshot
      },
    });
    if (!po) throw new ApiError(404, "NOT_FOUND", "Purchase order not found.");
    assertPurchaseOrderReceivable(po.status); // §11 — DRAFT/SENT/CLOSED/CANCELLED → 422

    // §59 — reference: user-supplied (normalized) or server-generated.
    let reference = input.reference;
    if (reference === undefined) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const candidate = generateGoodsReceiptReference(new Date(), (max) => randomInt(max));
        const clash = await tx.goodsReceipt.findFirst({
          where: { businessId: input.businessId, reference: candidate },
          select: { id: true },
        });
        if (!clash) {
          reference = candidate;
          break;
        }
      }
      if (reference === undefined) {
        // Astronomically unlikely (31^6); fail honestly rather than loop.
        throw new ApiError(
          409,
          GOODS_RECEIPT_ERROR_CODES.DUPLICATE_REFERENCE,
          "Could not generate a unique reference. Please try again.",
        );
      }
    }

    try {
      const row = await tx.goodsReceipt.create({
        data: {
          businessId: input.businessId, // §22 — server-derived, never client
          purchaseOrderId: po.id,
          reference,
          status: "DRAFT", // §58 — every receipt starts as preparation only
          supplierNameAtReceipt: po.supplierNameAtOrder, // §25 — frozen identity
          purchaseOrderReferenceAtReceipt: po.reference, // §24 — frozen identity
          notes: input.notes ?? null, // §62 — document data only
          createdByUserId: input.userId, // §58 — server-derived
        },
        select: { id: true, reference: true, status: true },
      });

      await audit(
        auditInput(input.businessId, input.userId, "goods_receipt.create", row.id, row.reference, {
          purchaseOrderId: po.id,
          purchaseOrderReferenceAtReceipt: po.reference,
          supplierNameAtReceipt: po.supplierNameAtOrder,
          status: row.status,
        }),
        tx,
      );

      return row;
    } catch (error) {
      // §61 — database uniqueness stays authoritative for duplicates.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ApiError(
          409,
          GOODS_RECEIPT_ERROR_CODES.DUPLICATE_REFERENCE,
          "A goods receipt with this reference already exists.",
        );
      }
      throw error;
    }
  });
}

/* --------------------------------- list ------------------------------------ */

export async function listGoodsReceipts(input: {
  businessId: string;
  q?: string;
  status?: string; // ALL → undefined
  purchaseOrderId?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}): Promise<{
  items: GoodsReceiptListItemDto[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const cap = goodsReceiptLineCap(process.env.GOODS_RECEIPT_MAX_LINES);
  const where: Prisma.GoodsReceiptWhereInput = {
    businessId: input.businessId, // §89 — tenant scope
    ...(input.status && input.status !== "ALL" ? { status: input.status } : {}),
    ...(input.purchaseOrderId ? { purchaseOrderId: input.purchaseOrderId } : {}),
    ...(input.from || input.to ? { createdAt: dayWindow(input.from, input.to) } : {}),
    ...(input.q
      ? {
          OR: [
            { reference: { contains: input.q } }, // receipt reference (§81)
            { purchaseOrderReferenceAtReceipt: { contains: input.q } }, // PO reference
            { supplierNameAtReceipt: { contains: input.q } }, // supplier snapshot
            {
              lines: {
                some: {
                  OR: [
                    { productNameAtReceipt: { contains: input.q } }, // product snapshot
                    { skuAtReceipt: { contains: input.q } }, // SKU snapshot
                  ],
                },
              },
            },
          ],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    db.goodsReceipt.count({ where }),
    // §175 — DB-level pagination; never findMany + slice.
    db.goodsReceipt.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      select: {
        id: true,
        reference: true,
        status: true,
        purchaseOrderId: true,
        purchaseOrderReferenceAtReceipt: true,
        supplierNameAtReceipt: true,
        postedAt: true,
        cancelledAt: true,
        createdAt: true,
        lines: {
          // §180 — bounded aggregate relation, not one query per row.
          select: { receivedQty: true },
          take: cap,
        },
        _count: { select: { lines: true } },
      },
    }),
  ]);

  const items = rows.map((row) => {
    // §180 — the capped relation slice IS the full line set (a receipt can
    // never exceed its own cap), so the sum below is provably complete.
    const totalReceivedQty = computeReceivedQty(row.lines.map((l) => l.receivedQty));
    return goodsReceiptListItemDto({
      id: row.id,
      reference: row.reference,
      status: row.status,
      purchaseOrderId: row.purchaseOrderId,
      purchaseOrderReferenceAtReceipt: row.purchaseOrderReferenceAtReceipt,
      supplierNameAtReceipt: row.supplierNameAtReceipt,
      lineCount: row._count.lines,
      totalReceivedQty,
      postedAt: row.postedAt,
      cancelledAt: row.cancelledAt,
      createdAt: row.createdAt,
      createdByUserId: "",
      createdByName: null,
      notes: null,
    });
  });
  return { items, total, page: input.page, pageSize: input.pageSize };
}

/* -------------------------------- detail ----------------------------------- */

export async function getGoodsReceipt(input: {
  businessId: string;
  id: string;
}): Promise<GoodsReceiptDetailDto> {
  const cap = goodsReceiptLineCap(process.env.GOODS_RECEIPT_MAX_LINES);
  // §176 — lines are bounded by the document's own cap; one bounded read.
  const row = await db.goodsReceipt.findFirst({
    where: { id: input.id, businessId: input.businessId }, // §89
    select: {
      id: true,
      reference: true,
      status: true,
      notes: true,
      purchaseOrderId: true,
      purchaseOrderReferenceAtReceipt: true,
      supplierNameAtReceipt: true,
      createdByUserId: true,
      postedAt: true,
      cancelledAt: true,
      createdAt: true,
      createdByUser: { select: { name: true } }, // §88 — name only
      lines: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: cap,
        select: {
          id: true,
          purchaseOrderLineId: true,
          productId: true,
          productNameAtReceipt: true,
          skuAtReceipt: true,
          unitAtReceipt: true,
          receivedQty: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });
  if (!row) throw new ApiError(404, "NOT_FOUND", "Goods receipt not found.");

  try {
    return goodsReceiptDetailDto(
      {
        id: row.id,
        reference: row.reference,
        status: row.status,
        notes: row.notes,
        purchaseOrderId: row.purchaseOrderId,
        purchaseOrderReferenceAtReceipt: row.purchaseOrderReferenceAtReceipt,
        supplierNameAtReceipt: row.supplierNameAtReceipt,
        createdByUserId: row.createdByUserId,
        createdByName: row.createdByUser?.name ?? null,
        postedAt: row.postedAt,
        cancelledAt: row.cancelledAt,
        createdAt: row.createdAt,
      },
      row.lines,
    );
  } catch (error) {
    return mapPureGoodsReceiptDomainError(error);
  }
}

/* ------------------------------ header patch ------------------------------- */

export async function updateGoodsReceipt(input: {
  businessId: string;
  userId: string;
  id: string;
  reference?: string;
  notes?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const header = await loadReceiptHeader(tx, input.businessId, input.id);
    requireDraft(header.status); // §107 — DRAFT-only edits

    const data: Prisma.GoodsReceiptUpdateInput = {};
    if (input.reference !== undefined) data.reference = input.reference;
    if (input.notes !== undefined) data.notes = input.notes;

    try {
      const updated = await tx.goodsReceipt.update({
        where: { id: header.id },
        data,
        select: { id: true, reference: true, status: true },
      });

      await audit(
        auditInput(
          input.businessId,
          input.userId,
          "goods_receipt.update",
          header.id,
          updated.reference,
          {
            changed: {
              ...(input.reference !== undefined
                ? { reference: { from: header.reference, to: updated.reference } }
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
          GOODS_RECEIPT_ERROR_CODES.DUPLICATE_REFERENCE,
          "A goods receipt with this reference already exists.",
        );
      }
      throw error;
    }
  });
}

/* -------------------------------- line add --------------------------------- */

export async function addGoodsReceiptLine(input: {
  businessId: string;
  userId: string;
  id: string;
  purchaseOrderLineId: string;
  receivedQty: number;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const header = await loadReceiptHeader(tx, input.businessId, input.id);
    requireDraft(header.status); // §64 — DRAFT-only

    // §35 — the PO line must belong to THIS receipt's tenant-scoped PO.
    // One tenant-scoped join validates receipt→PO→line ownership; a
    // foreign PO line is indistinguishable from an unknown one (§91 → 404).
    const poLine = await tx.purchaseOrderLine.findFirst({
      where: { id: input.purchaseOrderLineId, purchaseOrderId: header.purchaseOrderId },
      select: {
        id: true,
        productId: true,
        orderedQty: true,
        productNameAtOrder: true, // §29 — snapshots copied from the PO line
        skuAtOrder: true,
        unitAtOrder: true,
        product: { select: { id: true, businessId: true } },
      },
    });
    if (!poLine) throw new ApiError(404, "NOT_FOUND", "Purchase order line not found.");

    // §35 — product must exist inside the SAME tenant (belt-and-braces:
    // the FK is Restrict so a hard-deleted product is nearly impossible,
    // but §33/§152 demands a safe controlled failure, never fabrication).
    if (poLine.product.businessId !== input.businessId) {
      throw new ApiError(404, "NOT_FOUND", "Product not found.");
    }

    // §65 — the PO must STILL be CONFIRMED at line-add time (a PO that was
    // cancelled/closed after the draft was created stops accepting lines).
    const po = await tx.purchaseOrder.findFirst({
      where: { id: header.purchaseOrderId, businessId: input.businessId },
      select: { status: true },
    });
    if (!po) throw new ApiError(404, "NOT_FOUND", "Purchase order not found.");
    assertPurchaseOrderReceivable(po.status);

    const cap = goodsReceiptLineCap(process.env.GOODS_RECEIPT_MAX_LINES);
    await assertLineCap(tx, header.id, cap); // §71 — defensive count

    // §66 — ADVISORY remaining check at line-add time: receivedQty ≤
    // (ordered − POSTED received). Draft lines of OTHER receipts are
    // deliberately NOT subtracted — over-allocation across drafts is the
    // documented §67 stale-draft scenario and only POST is authoritative.
    const alreadyPosted = await sumPostedQtyForPoLine(tx, poLine.id);
    const remaining = computeRemainingQty(poLine.orderedQty, alreadyPosted); // §172
    if (exceedsRemaining(poLine.orderedQty, alreadyPosted, input.receivedQty)) {
      throw new ApiError(
        409,
        GOODS_RECEIPT_ERROR_CODES.EXCEEDS_REMAINING,
        `Only ${remaining} unit(s) remain to receive on this line.`,
      );
    }

    try {
      const line = await tx.goodsReceiptLine.create({
        data: {
          goodsReceiptId: header.id,
          purchaseOrderLineId: poLine.id,
          productId: poLine.productId, // §36 — derived, never client authority
          receivedQty: input.receivedQty,
          // §28/§29 — snapshots copied from the PO LINE, not live Product.
          productNameAtReceipt: poLine.productNameAtOrder,
          skuAtReceipt: poLine.skuAtOrder,
          unitAtReceipt: poLine.unitAtOrder,
        },
        select: { id: true },
      });

      await audit(
        auditInput(input.businessId, input.userId, "goods_receipt.line_add", header.id, header.reference, {
          lineId: line.id, // §156 — safe per-line metadata
          purchaseOrderLineId: poLine.id,
          productId: poLine.productId,
          productNameAtReceipt: poLine.productNameAtOrder,
          receivedQty: input.receivedQty,
        }),
        tx,
      );

      return { id: line.id };
    } catch (error) {
      // §27/§209 — DB uniqueness is authoritative for duplicate lines.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ApiError(
          409,
          GOODS_RECEIPT_ERROR_CODES.IMMUTABLE,
          "This purchase order line is already on the receipt.",
        );
      }
      throw error;
    }
  });
}

/* ------------------------------- line update ------------------------------- */

export async function updateGoodsReceiptLine(input: {
  businessId: string;
  userId: string;
  id: string;
  lineId: string;
  receivedQty: number;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const header = await loadReceiptHeader(tx, input.businessId, input.id);
    requireDraft(header.status); // §68 — DRAFT-only

    const line = await tx.goodsReceiptLine.findFirst({
      where: { id: input.lineId, goodsReceiptId: header.id }, // §89 — scoped via parent
      select: {
        id: true,
        purchaseOrderLineId: true,
        productId: true,
        productNameAtReceipt: true,
        receivedQty: true,
      },
    });
    if (!line) throw new ApiError(404, "NOT_FOUND", "Receipt line not found.");

    // §68 — the receivedQty still respects the advisory remaining check
    // (POSTED sums only — see the §66 note in addGoodsReceiptLine).
    const poLine = await tx.purchaseOrderLine.findFirst({
      where: { id: line.purchaseOrderLineId },
      select: { orderedQty: true },
    });
    if (!poLine) throw new ApiError(404, "NOT_FOUND", "Purchase order line not found.");
    const alreadyPosted = await sumPostedQtyForPoLine(tx, line.purchaseOrderLineId);
    const remaining = computeRemainingQty(poLine.orderedQty, alreadyPosted);
    if (exceedsRemaining(poLine.orderedQty, alreadyPosted, input.receivedQty)) {
      throw new ApiError(
        409,
        GOODS_RECEIPT_ERROR_CODES.EXCEEDS_REMAINING,
        `Only ${remaining} unit(s) remain to receive on this line.`,
      );
    }

    // §68-analog — re-read the persisted row after mutation: the response
    // carries the REAL stored snapshot fields and timestamps.
    const updated = await tx.goodsReceiptLine.update({
      where: { id: line.id },
      data: { receivedQty: input.receivedQty },
      select: {
        id: true,
        purchaseOrderLineId: true,
        productId: true,
        productNameAtReceipt: true,
        skuAtReceipt: true,
        unitAtReceipt: true,
        receivedQty: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    await audit(
      auditInput(input.businessId, input.userId, "goods_receipt.line_update", header.id, header.reference, {
        lineId: line.id, // §156 — before/after quantities only
        receivedQty: { from: line.receivedQty, to: updated.receivedQty },
      }),
      tx,
    );

    return goodsReceiptLineDto(updated);
  });
}

/* ------------------------------- line remove ------------------------------- */

export async function removeGoodsReceiptLine(input: {
  businessId: string;
  userId: string;
  id: string;
  lineId: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const header = await loadReceiptHeader(tx, input.businessId, input.id);
    requireDraft(header.status); // §69 — DRAFT-only

    const line = await tx.goodsReceiptLine.findFirst({
      where: { id: input.lineId, goodsReceiptId: header.id },
      select: { id: true, purchaseOrderLineId: true, productId: true, receivedQty: true },
    });
    if (!line) throw new ApiError(404, "NOT_FOUND", "Receipt line not found.");

    await tx.goodsReceiptLine.delete({ where: { id: line.id } });
    const lineCount = await tx.goodsReceiptLine.count({ where: { goodsReceiptId: header.id } });

    await audit(
      auditInput(input.businessId, input.userId, "goods_receipt.line_remove", header.id, header.reference, {
        lineId: line.id,
        purchaseOrderLineId: line.purchaseOrderLineId,
        productId: line.productId,
        receivedQty: line.receivedQty,
        lineCount,
      }),
      tx,
    );

    return { removed: true, lineCount };
  });
}

/* ---------------------------------- post ----------------------------------- */

/**
 * §39 — THE atomic stock posting transaction. Steps 1-17 in ONE
 * database transaction (§72); a failure at ANY step rolls back EVERYTHING
 * (§40/§214) — no stock change, no adjustment, no status, no audit.
 */
export async function postGoodsReceipt(input: {
  businessId: string;
  userId: string;
  id: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    // §39 steps 1-2 / §73 — reload receipt INSIDE the transaction; never
    // trust an earlier GET. Corrupted status is surfaced, never Draft.
    const header = await loadReceiptHeader(tx, input.businessId, input.id);
    assertTransition(header.status, "POSTED"); // §7 — only DRAFT → POSTED

    // §39 step 3 — PO must STILL be CONFIRMED (§149/§150: a PO cancelled
    // or closed after the draft was created can never be posted).
    const po = await tx.purchaseOrder.findFirst({
      where: { id: header.purchaseOrderId, businessId: input.businessId },
      select: { id: true, reference: true, status: true, supplierNameAtOrder: true },
    });
    if (!po) throw new ApiError(404, "NOT_FOUND", "Purchase order not found.");
    assertPurchaseOrderReceivable(po.status);

    // §39 step 4 — load the receipt's own lines (bounded by the document
    // cap, §177 — a receipt can never exceed GOODS_RECEIPT_MAX_LINES).
    const cap = goodsReceiptLineCap(process.env.GOODS_RECEIPT_MAX_LINES);
    const lines = await tx.goodsReceiptLine.findMany({
      where: { goodsReceiptId: header.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: cap + 1, // cap+1 proves completeness (same law as P41 export)
      select: {
        id: true,
        purchaseOrderLineId: true,
        productId: true,
        receivedQty: true,
        purchaseOrderLine: {
          select: {
            id: true,
            orderedQty: true,
            purchaseOrderId: true,
          },
        },
      },
    });
    if (lines.length > cap) {
      // Impossible by §20/§71 — if it ever happens, fail honestly.
      throw new ApiError(
        422,
        GOODS_RECEIPT_ERROR_CODES.LINE_LIMIT,
        "Goods receipt line limit exceeded.",
      );
    }

    // §70 — a receipt with zero lines can never post.
    if (lines.length === 0) {
      throw new ApiError(
        422,
        GOODS_RECEIPT_ERROR_CODES.EMPTY,
        "Add at least one line before posting this receipt.",
      );
    }

    const adjustmentIds: string[] = [];
    const stockChanges: { productId: string; from: number; to: number }[] = [];

    for (const line of lines) {
      // §39 step 4 — the PO line must belong to THIS purchase order
      // (defensive re-verification of the document chain).
      if (line.purchaseOrderLine.purchaseOrderId !== po.id) {
        throw new ApiError(404, "NOT_FOUND", "Purchase order line not found.");
      }

      // §39 steps 5-8 — product existence + authoritative remaining check.
      const product = await tx.product.findFirst({
        where: { id: line.productId, businessId: input.businessId }, // §30/§35
        select: { id: true, stockQty: true },
      });
      if (!product) {
        // §33/§152 — a hard-deleted product fails the post safely.
        throw new ApiError(
          422,
          GOODS_RECEIPT_ERROR_CODES.PRODUCT_NOT_FOUND,
          "A product on this receipt no longer exists.",
        );
      }

      const alreadyPosted = await sumPostedQtyForPoLine(tx, line.purchaseOrderLineId);
      const remaining = computeRemainingQty(
        line.purchaseOrderLine.orderedQty,
        alreadyPosted,
      ); // §100 — throws on corrupted over-received history (§283)
      if (exceedsRemaining(line.purchaseOrderLine.orderedQty, alreadyPosted, line.receivedQty)) {
        // §15/§16/§67 — the HARD over-receipt law, final authority.
        throw new ApiError(
          409,
          GOODS_RECEIPT_ERROR_CODES.EXCEEDS_REMAINING,
          `Only ${remaining} unit(s) remain to receive on this line.`,
        );
      }

      // §46/§47 — corrupt persisted stock is surfaced, never repaired.
      assertPersistedStockValid(product.stockQty);

      // §49 — Int32 storage bound; overflow → 422, no partial writes.
      if (stockOverflowsInt32(product.stockQty, line.receivedQty)) {
        throw new ApiError(
          422,
          GOODS_RECEIPT_ERROR_CODES.STOCK_OVERFLOW,
          "Receiving this quantity would exceed the stock storage limit.",
        );
      }

      // §39 steps 9-11 — exact integer arithmetic, positive delta only.
      const newStock = product.stockQty + line.receivedQty;
      await tx.product.update({
        where: { id: product.id },
        data: { stockQty: newStock },
        select: { id: true },
      });
      stockChanges.push({ productId: product.id, from: product.stockQty, to: newStock });

      // §39 step 12 / §41-§45 — one positive InventoryAdjustment per line.
      const adjustment = await tx.inventoryAdjustment.create({
        data: {
          businessId: input.businessId, // §43 — server-derived
          productId: product.id, // §44 — derived from the PO line chain
          delta: line.receivedQty, // §45 — always positive
          reason: RECEIPT_ADJUSTMENT_REASON(header.reference), // §41 — stable identifier
          actorId: input.userId, // §42 — server-derived
        },
        select: { id: true },
      });
      adjustmentIds.push(adjustment.id);
    }

    // §39 steps 14-15 — complete the posting (server timestamps only §74).
    const postedAt = new Date();
    const updated = await tx.goodsReceipt.update({
      where: { id: header.id },
      data: { status: "POSTED", postedAt },
      select: { id: true, reference: true, status: true, postedAt: true },
    });

    // §39 step 16 / §153/§154 — ONE audit record for the posting, written
    // in the SAME transaction; if it fails, everything above rolls back.
    const totalReceivedQty = computeReceivedQty(lines.map((l) => l.receivedQty));
    await audit(
      auditInput(input.businessId, input.userId, "goods_receipt.post", header.id, header.reference, {
        purchaseOrderId: po.id,
        purchaseOrderReferenceAtReceipt: header.purchaseOrderReferenceAtReceipt,
        lineCount: lines.length,
        totalReceivedQty, // §155 — quantity facts only; never notes
        adjustmentIds,
        previousStatus: header.status,
        newStatus: updated.status,
        postedAt: updated.postedAt?.toISOString() ?? null,
      }),
      tx,
    );

    return {
      id: updated.id,
      reference: updated.reference,
      status: updated.status,
      postedAt: updated.postedAt,
      lineCount: lines.length,
      totalReceivedQty,
      stockChanges,
    };
  });
}

/* --------------------------------- cancel ---------------------------------- */

export async function cancelGoodsReceipt(input: {
  businessId: string;
  userId: string;
  id: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    // §75 — reload inside the transaction; only DRAFT may cancel.
    const header = await loadReceiptHeader(tx, input.businessId, input.id);
    assertTransition(header.status, "CANCELLED"); // §7

    // §10 — cancelling a draft is a pure document transition: NO stock
    // mutation, NO adjustment, NO financial anything.
    const updated = await tx.goodsReceipt.update({
      where: { id: header.id },
      data: { status: "CANCELLED", cancelledAt: new Date() },
      select: { id: true, reference: true, status: true, cancelledAt: true },
    });

    await audit(
      auditInput(input.businessId, input.userId, "goods_receipt.cancel", header.id, header.reference, {
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

/* ------------------- P41 integration: receiving summary --------------------- */

/**
 * §98/§181 — the PO receiving summary in ONE consistent read (§296): a
 * transactional read of the PO lines + the POSTED receipt-line aggregates
 * (grouped, never one query per line). Corrupted over-received history
 * surfaces as the stable integrity code (§283 — never clamped).
 */
export async function getPurchaseOrderReceivingSummary(input: {
  businessId: string;
  purchaseOrderId: string;
}): Promise<{
  orderedQty: number;
  receivedQty: number;
  remainingQty: number;
  receiptCount: number;
  fullyReceived: boolean;
  lines: { lineId: string; orderedQty: number; receivedQty: number; remainingQty: number }[];
}> {
  const po = await db.purchaseOrder.findFirst({
    where: { id: input.purchaseOrderId, businessId: input.businessId }, // §89
    select: { id: true },
  });
  if (!po) throw new ApiError(404, "NOT_FOUND", "Purchase order not found.");

  // §296 — one transactional read of lines + posted aggregates.
  const cap = goodsReceiptLineCap(process.env.GOODS_RECEIPT_MAX_LINES);
  return db.$transaction(async (tx) => {
    const poLines = await tx.purchaseOrderLine.findMany({
      where: { purchaseOrderId: po.id },
      select: { id: true, orderedQty: true },
      take: cap, // bounded by the PO's own line cap (P41 law)
    });

    // §178 — sum POSTED receipt lines per PO line, grouped in one query.
    const grouped = await tx.goodsReceiptLine.groupBy({
      by: ["purchaseOrderLineId"],
      where: {
        purchaseOrderLineId: { in: poLines.map((l) => l.id) },
        goodsReceipt: { status: "POSTED" }, // §99 — POSTED only
      },
      _sum: { receivedQty: true },
    });
    const receivedByLine = new Map(
      grouped.map((g) => [g.purchaseOrderLineId, g._sum.receivedQty ?? 0]),
    );

    // §104-analog — receipt COUNT (POSTED receipts touching this PO).
    const receiptCount = await tx.goodsReceipt.count({
      where: { purchaseOrderId: po.id, status: "POSTED" },
    });

    let orderedQty = 0;
    let receivedQty = 0;
    const lines = poLines.map((l) => {
      const lineReceived = receivedByLine.get(l.id) ?? 0;
      const lineRemaining = computeRemainingQty(l.orderedQty, lineReceived); // §100
      orderedQty += l.orderedQty;
      receivedQty += lineReceived;
      return {
        lineId: l.id,
        orderedQty: l.orderedQty,
        receivedQty: lineReceived,
        remainingQty: lineRemaining,
      };
    });
    const remainingQty = computeRemainingQty(orderedQty, receivedQty); // §100

    return {
      orderedQty,
      receivedQty,
      remainingQty,
      receiptCount,
      fullyReceived: remainingQty === 0, // §101 — derived, never stored
      lines,
    };
  }).catch((error) => mapPureGoodsReceiptDomainError(error));
}

/** §104 — bounded recent receipts for the PO detail (take 10, §105). */
export async function listRecentReceiptsForPurchaseOrder(input: {
  businessId: string;
  purchaseOrderId: string;
  take?: number;
}): Promise<PurchaseOrderRecentReceiptDto[]> {
  const take = Math.min(Math.max(input.take ?? 10, 1), 10); // §105 — bounded
  const cap = goodsReceiptLineCap(process.env.GOODS_RECEIPT_MAX_LINES);
  const rows = await db.goodsReceipt.findMany({
    where: { businessId: input.businessId, purchaseOrderId: input.purchaseOrderId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: {
      id: true,
      reference: true,
      status: true,
      postedAt: true,
      createdAt: true,
      lines: { select: { receivedQty: true }, take: cap },
    },
  });
  return rows.map((r) => {
    try {
      return {
        id: r.id,
        reference: r.reference,
        status: parseGoodsReceiptStatus(r.status),
        postedAt: r.postedAt ? r.postedAt.toISOString() : null,
        totalReceivedQty: computeReceivedQty(r.lines.map((l) => l.receivedQty)),
      };
    } catch (error) {
      return mapPureGoodsReceiptDomainError(error);
    }
  });
}

/**
 * §146 — PO cancel hardening helper: the number of POSTED receipts
 * against this PO. A PO with posted receipts can never be cancelled
 * (physical goods already exist; reversal is out of scope).
 */
export async function countPostedReceiptsForPurchaseOrder(
  tx: Tx,
  businessId: string,
  purchaseOrderId: string,
): Promise<number> {
  return tx.goodsReceipt.count({
    where: { businessId, purchaseOrderId, status: "POSTED" },
  });
}

/** §120 — bounded recent receipts for the Product detail (take 10). */
export async function listRecentReceiptsForProduct(input: {
  businessId: string;
  productId: string;
  take?: number;
}): Promise<
  { id: string; reference: string; status: GoodsReceiptStatus; postedAt: string | null; receivedQty: number }[]
> {
  const take = Math.min(Math.max(input.take ?? 10, 1), 10); // §182 — bounded
  const rows = await db.goodsReceiptLine.findMany({
    where: {
      productId: input.productId,
      goodsReceipt: { businessId: input.businessId, status: "POSTED" },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: {
      receivedQty: true,
      createdAt: true,
      goodsReceipt: {
        select: { id: true, reference: true, status: true, postedAt: true },
      },
    },
  });
  return rows.map((r) => {
    try {
      return {
        id: r.goodsReceipt.id,
        reference: r.goodsReceipt.reference,
        status: parseGoodsReceiptStatus(r.goodsReceipt.status),
        postedAt: r.goodsReceipt.postedAt ? r.goodsReceipt.postedAt.toISOString() : null,
        receivedQty: r.receivedQty,
      };
    } catch (error) {
      return mapPureGoodsReceiptDomainError(error);
    }
  });
}

/** §121 — bounded recent receipts for the Supplier 360 (take 10). */
export async function listRecentReceiptsForSupplier(input: {
  businessId: string;
  supplierId: string;
  take?: number;
}): Promise<PurchaseOrderRecentReceiptDto[]> {
  const take = Math.min(Math.max(input.take ?? 10, 1), 10); // §183 — bounded
  const cap = goodsReceiptLineCap(process.env.GOODS_RECEIPT_MAX_LINES);
  const rows = await db.goodsReceipt.findMany({
    where: {
      businessId: input.businessId,
      purchaseOrder: { supplierId: input.supplierId },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: {
      id: true,
      reference: true,
      status: true,
      postedAt: true,
      lines: { select: { receivedQty: true }, take: cap },
    },
  });
  return rows.map((r) => {
    try {
      return {
        id: r.id,
        reference: r.reference,
        status: parseGoodsReceiptStatus(r.status),
        postedAt: r.postedAt ? r.postedAt.toISOString() : null,
        totalReceivedQty: computeReceivedQty(r.lines.map((l) => l.receivedQty)),
      };
    } catch (error) {
      return mapPureGoodsReceiptDomainError(error);
    }
  });
}

/** Total received quantity across a PO's POSTED receipts (§282 check). */
export const PRODUCT_STOCK_LIMIT = PRODUCT_STOCK_INT32_MAX;
