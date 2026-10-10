import "server-only";

/**
 * Prompt 43 — goods-return service (server-only, §136).
 *
 * LAWS:
 *  - PHYSICAL INVENTORY OUTFLOW ONLY (§4/§6/§7): posting DECREASES
 *    Product.stockQty and creates ONE negative InventoryAdjustment per
 *    line (delta = -returnedQty). It NEVER creates Expense, Payment, Sale,
 *    Credit Note, supplier-statement movement, payable/aging row or any
 *    accounting entry (§7). Draft/cancel mutate NOTHING but the return.
 *  - RECEIPT IMMUTABILITY (§8): a return NEVER mutates its source receipt
 *    — status, receivedQty, snapshots and lines stay frozen forever.
 *  - CUMULATIVE RETURN CAP (§35): SUM(POSTED returned) + new ≤ receivedQty,
 *    enforced by the ONE pure helper at line-add (advisory, §62) AND
 *    authoritatively inside the post transaction (§43 step 11). No
 *    tolerance, no bypass, no rounding.
 *  - CURRENT STOCK CHECK (§39/§41): each posted line requires
 *    Product.stockQty ≥ returnedQty; the aggregate stock can NEVER go
 *    negative — no override, no silent zero-clamp (§42 exact integer math).
 *  - Every query is tenant-scoped by ctx.businessId (§67) — never a client
 *    businessId. Foreign receipt/receipt-line/return/return-line → 404, no
 *    existence leak (§68).
 *  - Status transitions are server-authoritative through dedicated
 *    operations (§9); the current status is RE-CHECKED INSIDE the write
 *    transaction (§43 step 3) so concurrent posts/cancels cannot double-apply.
 *  - Snapshots (supplier name, receipt reference, PO reference, product
 *    name/sku/unit) are frozen at write time from ALREADY-FROZEN receipt
 *    data (§16/§17/§18/§30) and NEVER overwritten from live data.
 *  - Quantities are exact integers (§32/§42); corrupt persisted state is
 *    surfaced, never repaired (§38/§41/§65).
 *  - READ-CAP LAW (§76/§140): every bounded read fetches cap+1 rows to
 *    PROVE completeness — a document holding more rows than its own cap
 *    (or a `_count` mismatch) fails the read with the stable
 *    GOODS_RETURN_LINE_CAP_INVARIANT code. Read paths NEVER render a
 *    silently truncated slice or a partial total.
 *  - AGGREGATE LAW (§37/§140): POSTED returned quantities are summed by
 *    the DATABASE (aggregate/groupBy _sum), never by loading return
 *    history into application memory. The aggregate result is re-validated
 *    (integer, ≥ 0); corruption still surfaces, never clamps.
 *  - Audit through the single sanctioned helper INSIDE the same
 *    transaction as every mutation (§48/§133) — safe metadata only, never
 *    notes content (§22/§132).
 */
import { randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { withWriteTransaction } from "@/lib/db/write-transaction";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api-helpers";
import {
  GOODS_RETURN_CORRUPT_HISTORY,
  GOODS_RETURN_ERROR_CODES,
  GoodsReturnIntegrityError,
  GOODS_RETURN_LINE_CAP_INVARIANT,
  GOODS_RETURN_INVALID_PERSISTED_STATUS,
  GOODS_RETURN_QTY_MAX,
  RETURNED_QTY_MIN,
  assertGoodsReturnLineSetComplete,
  canTransitionGoodsReturn,
  computeReturnableQty,
  computeReturnedQty,
  exceedsReturnable,
  generateGoodsReturnReference,
  goodsReturnDayWindow,
  goodsReturnLineCap,
  isGoodsReturnReasonCode,
  isValidPersistedReturnedQty,
  parseGoodsReturnStatus,
  stockAfterReturn,
  type GoodsReturnStatus,
} from "./types";
import {
  parseGoodsReceiptStatus,
  GOODS_RECEIPT_INVALID_PERSISTED_STATUS,
} from "@/lib/inventory/goods-receipt/types";
import {
  goodsReturnDetailDto,
  goodsReturnLineDto,
  goodsReturnListItemDto,
  receiptLineReturnFactsDto,
  type GoodsReturnDetailDto,
  type GoodsReturnListItemDto,
  type ProductRecentReturnDto,
  type ReceiptLineReturnFactsDto,
  type ReceiptRecentReturnDto,
  type SupplierRecentReturnDto,
} from "./dto";

type Tx = Prisma.TransactionClient;
/** Read-side helpers accept either the raw client or a transaction client. */
type DbLike = Pick<Tx, "goodsReturnLine" | "goodsReceiptLine">;

/**
 * §50 — the ONE shared SQLite write-transaction law (FIFO serialized
 * writes + bounded transient retry). The P41 procurement, P42 receiving
 * and P43 return paths all run through the same helper so none can
 * interleave with another on the single write lock (§51 — no lost update
 * against receipts, manual adjustments or stocktake finalization).
 */
const withWriteTx = withWriteTransaction;

/** §44 — the adjustment reason ties every posted line to its return. */
const RETURN_ADJUSTMENT_REASON = (reference: string) =>
  `Goods return ${reference}: inventory returned to supplier`;

/* ---------------------------- shared internals ----------------------------- */

/** §65 — corrupted persisted status → controlled 500 (never Draft). */
function parseDbStatus(value: string): GoodsReturnStatus {
  try {
    return parseGoodsReturnStatus(value);
  } catch (error) {
    if (error instanceof Error && error.name === "GoodsReturnStatusIntegrityError") {
      throw new ApiError(
        500,
        GOODS_RETURN_INVALID_PERSISTED_STATUS,
        "Goods return data is in an invalid state. Please contact support.",
      );
    }
    throw error;
  }
}

/**
 * §38/§41 — map pure canonical-math integrity failures to their controlled
 * HTTP result: corrupted return history / corrupt stock is a 500, never a
 * silent clamp. Exported for cross-service mapping (the P42 receiving
 * path surfaces return-history corruption under the SAME stable code).
 */
export function mapPureGoodsReturnDomainError(error: unknown): never {
  if (error instanceof Error && error.name === "GoodsReturnStatusIntegrityError") {
    throw new ApiError(
      500,
      GOODS_RETURN_INVALID_PERSISTED_STATUS,
      "Goods return data is in an invalid state. Please contact support.",
    );
  }
  if (error instanceof Error && error.name === "GoodsReceiptStatusIntegrityError") {
    // §66 — corrupted SOURCE receipt status uses P42's own stable code.
    throw new ApiError(
      500,
      GOODS_RECEIPT_INVALID_PERSISTED_STATUS,
      "Goods receipt data is in an invalid state. Please contact support.",
    );
  }
  if (error instanceof Error && error.name === "GoodsReturnIntegrityError") {
    // §15/§16 — the line-set completeness invariant (over-cap document or a
    // counted/fetched mismatch) is ITS OWN stable integrity code — never
    // misreported as generic history corruption.
    if (error.message.includes(GOODS_RETURN_LINE_CAP_INVARIANT)) {
      throw new ApiError(
        500,
        GOODS_RETURN_LINE_CAP_INVARIANT,
        "Stored document data exceeds its configured line cap. Please contact support.",
      );
    }
    const corruptStock = error.message.includes("GOODS_RETURN_INVALID_PERSISTED_STOCK");
    throw new ApiError(
      500,
      corruptStock
        ? GOODS_RETURN_ERROR_CODES.INVALID_PERSISTED_STOCK
        : GOODS_RETURN_ERROR_CODES.CORRUPT_HISTORY,
      corruptStock
        ? "Product stock data is in an invalid state. Please contact support."
        : "Goods return data is inconsistent. Please contact support.",
    );
  }
  throw error;
}

/**
 * §76/§140 — read-cap invariant mapping lives in mapPureGoodsReturnDomainError
 * (the ONE canonical failure mapper). All read paths validate with the pure
 * assertGoodsReturnLineSetComplete helper and map through it.
 */

function requireDraft(status: GoodsReturnStatus): void {
  if (status !== "DRAFT") {
    // §11 — POSTED is immutable; §12 — CANCELLED is terminal.
    throw new ApiError(
      409,
      GOODS_RETURN_ERROR_CODES.IMMUTABLE,
      "Only DRAFT goods returns can be changed.",
    );
  }
}

function assertTransition(from: GoodsReturnStatus, to: GoodsReturnStatus): void {
  if (!canTransitionGoodsReturn(from, to)) {
    throw new ApiError(
      409,
      GOODS_RETURN_ERROR_CODES.INVALID_TRANSITION,
      `Cannot move a goods return from ${from} to ${to}.`,
    );
  }
}

async function loadReturnHeader(
  tx: Tx,
  businessId: string,
  id: string,
): Promise<{
  id: string;
  reference: string;
  status: GoodsReturnStatus;
  goodsReceiptId: string;
  goodsReceiptReferenceAtReturn: string;
  purchaseOrderReferenceAtReturn: string;
  supplierNameAtReturn: string;
  notes: string | null;
  createdByUserId: string;
  postedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
}> {
  const row = await tx.goodsReturn.findFirst({
    where: { id, businessId }, // §67 — tenant scope from auth context only
    select: {
      id: true,
      reference: true,
      status: true,
      goodsReceiptId: true,
      goodsReceiptReferenceAtReturn: true,
      purchaseOrderReferenceAtReturn: true,
      supplierNameAtReturn: true,
      notes: true,
      createdByUserId: true,
      postedAt: true,
      cancelledAt: true,
      createdAt: true,
    },
  });
  if (!row) throw new ApiError(404, "NOT_FOUND", "Goods return not found.");
  // §65 — a corrupted persisted status NEVER silently becomes DRAFT.
  return { ...row, status: parseDbStatus(row.status) };
}

/**
 * §13/§43 step 5/§66 — load the tenant-scoped source receipt and require
 * persisted status POSTED. A corrupted receipt status NEVER becomes
 * POSTED — P42's own parser + stable code are reused (§66).
 */
async function loadPostedSourceReceipt(tx: Tx, businessId: string, goodsReceiptId: string) {
  const receipt = await tx.goodsReceipt.findFirst({
    where: { id: goodsReceiptId, businessId }, // §67/§68 — foreign → 404
    select: {
      id: true,
      reference: true,
      status: true,
      supplierNameAtReceipt: true,
      purchaseOrderReferenceAtReceipt: true,
    },
  });
  if (!receipt) throw new ApiError(404, "NOT_FOUND", "Goods receipt not found.");
  let status: string;
  try {
    status = parseGoodsReceiptStatus(receipt.status);
  } catch (error) {
    throw mapPureGoodsReturnDomainError(error); // §66 — stable P42 code
  }
  if (status !== "POSTED") {
    // §13 — returns may only be created from POSTED receipts.
    throw new ApiError(
      422,
      GOODS_RETURN_ERROR_CODES.SOURCE_NOT_POSTED,
      "Goods can be returned only from a posted goods receipt.",
    );
  }
  return { ...receipt, status };
}

function auditInput(
  businessId: string,
  actorId: string,
  action: string,
  goodsReturnId: string,
  reference: string,
  after: Record<string, unknown>,
  before?: Record<string, unknown>,
) {
  return {
    businessId,
    actorId,
    action,
    entityType: "GoodsReturn",
    entityId: goodsReturnId,
    ...(before ? { before } : {}),
    after: { reference, ...after }, // §132 — safe metadata; never notes content
  };
}

/**
 * §37/§140 — the ONE canonical POSTED-returned-quantity sum for ONE
 * receipt line. DRAFT/CANCELLED returns never count (§9/§10). Database
 * aggregate (_sum), never a findMany of history into memory; the result
 * is re-validated (exact integer, ≥ 0) and corruption surfaces through
 * the ONE mapping, never clamped.
 */
export async function sumPostedReturnedQtyForReceiptLine(
  tx: Tx,
  goodsReceiptLineId: string,
): Promise<number> {
  const agg = await tx.goodsReturnLine.aggregate({
    where: {
      goodsReceiptLineId,
      goodsReturn: { status: "POSTED" }, // §9 — POSTED only
    },
    _sum: { returnedQty: true },
  });
  return validateReturnedSum(agg._sum.returnedQty ?? 0);
}

/**
 * §37/§77/§80 — the ONE canonical POSTED-returned-quantity sum for ONE
 * PO line (all return lines whose SOURCE receipt line belongs to that PO
 * line). Database aggregate with a join filter — no receipt-line
 * materialization. Used by the P42 net-receiving guard (line add / line
 * update / receipt POST) and by the PO net receiving summary.
 */
export async function sumPostedReturnedQtyForPoLine(
  tx: Tx,
  purchaseOrderLineId: string,
): Promise<number> {
  const agg = await tx.goodsReturnLine.aggregate({
    where: {
      goodsReturn: { status: "POSTED" }, // §9 — POSTED only
      goodsReceiptLine: { purchaseOrderLineId },
    },
    _sum: { returnedQty: true },
  });
  return validateReturnedSum(agg._sum.returnedQty ?? 0);
}

/** §38 — aggregate result re-validation (SAFE integer, ≥ 0, no clamp, §8). */
function validateReturnedSum(sum: number): number {
  if (!Number.isSafeInteger(sum) || sum < 0) {
    throw mapPureGoodsReturnDomainError(
      new Error("GOODS_RETURN_CORRUPT_HISTORY: negative or unsafe aggregate"),
    );
  }
  return sum;
}

/**
 * §141 — grouped returned-quantity sums for MANY receipt lines (bounded
 * batch, no N+1): one groupBy + (only when needed) one bounded id-in
 * mapping fetch. Used by the receipt-detail return facts.
 */
export async function sumPostedReturnedQtyForReceiptLines(
  db: DbLike,
  goodsReceiptLineIds: string[],
): Promise<Map<string, number>> {
  const result = new Map(goodsReceiptLineIds.map((id) => [id, 0]));
  if (goodsReceiptLineIds.length === 0) return result;
  const grouped = await db.goodsReturnLine.groupBy({
    by: ["goodsReceiptLineId"],
    where: {
      goodsReceiptLineId: { in: goodsReceiptLineIds },
      goodsReturn: { status: "POSTED" }, // §9 — POSTED only
    },
    _sum: { returnedQty: true },
  });
  for (const g of grouped) {
    result.set(g.goodsReceiptLineId, validateReturnedSum(g._sum.returnedQty ?? 0));
  }
  return result;
}

/**
 * §77/§141 — grouped returned-quantity sums for MANY PO lines (bounded
 * batch, no N+1): one groupBy (by source receipt line) + one bounded
 * id-in mapping fetch (only receipt lines that actually HAVE returns —
 * never the PO's whole receipt history). Used by the PO net receiving
 * summary and the PO detail aggregate.
 */
export async function sumPostedReturnedQtyForPoLines(
  db: DbLike,
  purchaseOrderLineIds: string[],
): Promise<Map<string, number>> {
  const result = new Map(purchaseOrderLineIds.map((id) => [id, 0]));
  if (purchaseOrderLineIds.length === 0) return result;
  const grouped = await db.goodsReturnLine.groupBy({
    by: ["goodsReceiptLineId"],
    where: {
      goodsReturn: { status: "POSTED" }, // §9 — POSTED only
      goodsReceiptLine: { purchaseOrderLineId: { in: purchaseOrderLineIds } },
    },
    _sum: { returnedQty: true },
  });
  if (grouped.length === 0) return result;
  // §141 — bounded batch: only the receipt lines that appear in return
  // history, fetched by indexed id (NOT the PO's whole receipt set).
  const receiptLineIds = grouped.map((g) => g.goodsReceiptLineId);
  const mapping = await db.goodsReceiptLine.findMany({
    where: { id: { in: receiptLineIds } },
    select: { id: true, purchaseOrderLineId: true },
  });
  const poLineByReceiptLine = new Map(mapping.map((m) => [m.id, m.purchaseOrderLineId]));
  for (const g of grouped) {
    const poLineId = poLineByReceiptLine.get(g.goodsReceiptLineId);
    if (!poLineId) continue; // defensive — FK guarantees existence
    // §6 — every accumulation step stays a safe non-negative integer; the
    // addition is re-validated, never trusted.
    result.set(
      poLineId,
      validateReturnedSum((result.get(poLineId) ?? 0) + validateReturnedSum(g._sum.returnedQty ?? 0)),
    );
  }
  return result;
}

/** §71/§20 — defensive line-count validation (add line). */
async function assertLineCap(tx: Tx, goodsReturnId: string, cap: number): Promise<number> {
  const lineCount = await tx.goodsReturnLine.count({ where: { goodsReturnId } });
  if (lineCount > cap) {
    // §20 — an ALREADY-corrupted document (more lines than its own cap) is
    // database corruption: 500 integrity, never disguised as the ordinary
    // 422 user validation failure.
    throw new ApiError(
      500,
      GOODS_RETURN_LINE_CAP_INVARIANT,
      "Stored document data exceeds its configured line cap. Please contact support.",
    );
  }
  if (lineCount === cap) {
    // §20 — the NORMAL write-time rejection for a legitimately full draft.
    throw new ApiError(
      422,
      GOODS_RETURN_ERROR_CODES.LINE_LIMIT,
      `A goods return can contain at most ${cap} lines.`,
    );
  }
  return lineCount;
}

/* -------------------------------- create ----------------------------------- */

export async function createGoodsReturn(input: {
  businessId: string;
  userId: string;
  goodsReceiptId: string;
  reference?: string;
  notes?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    // §13/§16/§17/§18 — the receipt must be tenant-scoped and POSTED; all
    // snapshots derive from ITS frozen columns (never client input, never
    // live Supplier/Product rows).
    const receipt = await loadPostedSourceReceipt(tx, input.businessId, input.goodsReceiptId);

    // §20 — reference: user-supplied (normalized) or server-generated.
    let reference = input.reference;
    if (reference === undefined) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const candidate = generateGoodsReturnReference(new Date(), (max) => randomInt(max));
        const clash = await tx.goodsReturn.findFirst({
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
          GOODS_RETURN_ERROR_CODES.DUPLICATE_REFERENCE,
          "Could not generate a unique reference. Please try again.",
        );
      }
    }

    try {
      const row = await tx.goodsReturn.create({
        data: {
          businessId: input.businessId, // §25 — server-derived, never client
          goodsReceiptId: receipt.id,
          reference,
          status: "DRAFT", // §10 — preparation only
          supplierNameAtReturn: receipt.supplierNameAtReceipt, // §16 — frozen identity
          goodsReceiptReferenceAtReturn: receipt.reference, // §17 — frozen identity
          purchaseOrderReferenceAtReturn: receipt.purchaseOrderReferenceAtReceipt, // §18 — frozen identity
          notes: input.notes ?? null, // §22 — document data only
          createdByUserId: input.userId, // §56 — server-derived
        },
        select: { id: true, reference: true, status: true },
      });

      await audit(
        auditInput(input.businessId, input.userId, "goods_return.create", row.id, row.reference, {
          goodsReceiptId: receipt.id,
          goodsReceiptReferenceAtReturn: receipt.reference,
          purchaseOrderReferenceAtReturn: receipt.purchaseOrderReferenceAtReceipt,
          supplierNameAtReturn: receipt.supplierNameAtReceipt,
          status: row.status,
        }),
        tx,
      );

      return row;
    } catch (error) {
      // §21 — database uniqueness stays authoritative for duplicates.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ApiError(
          409,
          GOODS_RETURN_ERROR_CODES.DUPLICATE_REFERENCE,
          "A goods return with this reference already exists.",
        );
      }
      throw error;
    }
  });
}

/* --------------------------------- list ------------------------------------ */

export async function listGoodsReturns(input: {
  businessId: string;
  q?: string;
  status?: string; // ALL → undefined
  goodsReceiptId?: string;
  from?: string;
  to?: string;
  timezone?: string; // §22-§23 — AUTHENTICATED business timezone (never client authority)
  page: number;
  pageSize: number;
}): Promise<{
  items: GoodsReturnListItemDto[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const cap = goodsReturnLineCap(process.env.GOODS_RETURN_MAX_LINES);
  const where: Prisma.GoodsReturnWhereInput = {
    businessId: input.businessId, // §67 — tenant scope
    ...(input.status && input.status !== "ALL" ? { status: input.status } : {}),
    ...(input.goodsReceiptId ? { goodsReceiptId: input.goodsReceiptId } : {}),
    ...(input.from || input.to
      ? (() => {
          // §22-§24 — the from/to calendar dates are interpreted in the
          // AUTHENTICATED BUSINESS's timezone (inclusive local start of
          // `from`, EXCLUSIVE local start of the day after `to`). A record
          // at 00:15 local belongs to its local date even when its UTC
          // date is the previous day. Unresolvable bounds → controlled 422.
          const window = goodsReturnDayWindow(input.from, input.to, input.timezone);
          if (!window) {
            throw new ApiError(422, "VALIDATION_ERROR", "Invalid date filter.");
          }
          return { createdAt: window };
        })()
      : {}),
    ...(input.q
      ? {
          OR: [
            { reference: { contains: input.q } }, // return reference (§73)
            { goodsReceiptReferenceAtReturn: { contains: input.q } }, // receipt reference
            { purchaseOrderReferenceAtReturn: { contains: input.q } }, // PO reference snapshot
            { supplierNameAtReturn: { contains: input.q } }, // supplier snapshot
            {
              lines: {
                some: {
                  OR: [
                    { productNameAtReturn: { contains: input.q } }, // product snapshot
                    { skuAtReturn: { contains: input.q } }, // SKU snapshot
                  ],
                },
              },
            },
          ],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    db.goodsReturn.count({ where }),
    // §72 — DB-level pagination; never findMany + slice.
    db.goodsReturn.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      select: {
        id: true,
        reference: true,
        status: true,
        goodsReceiptId: true,
        goodsReceiptReferenceAtReturn: true,
        purchaseOrderReferenceAtReturn: true,
        supplierNameAtReturn: true,
        postedAt: true,
        cancelledAt: true,
        createdAt: true,
        lines: {
          // §76 — bounded aggregate relation, not one query per row.
          // take cap+1 PROVES the slice is the whole line set: a return
          // over its own cap is corruption and fails the read below —
          // never a silently truncated total.
          select: { returnedQty: true },
          take: cap + 1,
        },
        _count: { select: { lines: true } },
      },
    }),
  ]);

  const items = rows.map((row) => {
    try {
      // §15/§16 — the THREE explicit completeness invariants (fetched ≤ cap,
      // counted ≤ cap, counted === fetched) are enforced by the ONE
      // canonical pure validator: a count mismatch fails the read EVEN WHEN
      // both numbers are below the cap — a subset total must never
      // masquerade as complete. Then §76 — the proven-complete slice feeds
      // the canonical sum, which re-validates every persisted quantity
      // (safe integer ≥ 1 — a stored zero is corruption, §7).
      assertGoodsReturnLineSetComplete(row.lines.length, row._count.lines, cap);
      const totalReturnedQty = computeReturnedQty(row.lines.map((l) => l.returnedQty));
      return goodsReturnListItemDto({
        id: row.id,
        reference: row.reference,
        status: row.status,
        goodsReceiptId: row.goodsReceiptId,
        goodsReceiptReferenceAtReturn: row.goodsReceiptReferenceAtReturn,
        purchaseOrderReferenceAtReturn: row.purchaseOrderReferenceAtReturn,
        supplierNameAtReturn: row.supplierNameAtReturn,
        lineCount: row._count.lines,
        totalReturnedQty,
        postedAt: row.postedAt,
        cancelledAt: row.cancelledAt,
        createdAt: row.createdAt,
        createdByUserId: "",
        createdByName: null,
        notes: null,
      });
    } catch (error) {
      // §38 — a corrupted quantity inside history surfaces as the stable
      // integrity 500, never a partial row and never a generic 500.
      return mapPureGoodsReturnDomainError(error);
    }
  });
  return { items, total, page: input.page, pageSize: input.pageSize };
}

/* -------------------------------- detail ----------------------------------- */

export async function getGoodsReturn(input: {
  businessId: string;
  id: string;
}): Promise<GoodsReturnDetailDto> {
  const cap = goodsReturnLineCap(process.env.GOODS_RETURN_MAX_LINES);
  // §76 — lines are bounded by the document's own cap; one bounded read.
  // take cap+1 proves completeness: the +1 row is corruption and fails the
  // read with the stable invariant code below — never a detail DTO
  // silently rendered from only the first cap lines.
  const row = await db.goodsReturn.findFirst({
    where: { id: input.id, businessId: input.businessId }, // §67
    select: {
      id: true,
      reference: true,
      status: true,
      notes: true,
      goodsReceiptId: true,
      goodsReceiptReferenceAtReturn: true,
      purchaseOrderReferenceAtReturn: true,
      supplierNameAtReturn: true,
      createdByUserId: true,
      postedAt: true,
      cancelledAt: true,
      createdAt: true,
      createdByUser: { select: { name: true } }, // §70 — name only
      lines: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: cap + 1,
        select: {
          id: true,
          goodsReceiptLineId: true,
          productId: true,
          productNameAtReturn: true,
          skuAtReturn: true,
          unitAtReturn: true,
          returnedQty: true,
          reasonCode: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });
  if (!row) throw new ApiError(404, "NOT_FOUND", "Goods return not found.");

  try {
    // §76 — never render a partial document: cap+1 rows fetched, so a
    // fetched count above the cap proves corruption (the counted arm is
    // identical here — no separate _count exists on this read).
    assertGoodsReturnLineSetComplete(row.lines.length, row.lines.length, cap);
    return goodsReturnDetailDto(
      {
        id: row.id,
        reference: row.reference,
        status: row.status,
        notes: row.notes,
        goodsReceiptId: row.goodsReceiptId,
        goodsReceiptReferenceAtReturn: row.goodsReceiptReferenceAtReturn,
        purchaseOrderReferenceAtReturn: row.purchaseOrderReferenceAtReturn,
        supplierNameAtReturn: row.supplierNameAtReturn,
        createdByUserId: row.createdByUserId,
        createdByName: row.createdByUser?.name ?? null,
        postedAt: row.postedAt,
        cancelledAt: row.cancelledAt,
        createdAt: row.createdAt,
      },
      row.lines,
    );
  } catch (error) {
    return mapPureGoodsReturnDomainError(error);
  }
}

/* ------------------------------ header patch ------------------------------- */

export async function updateGoodsReturn(input: {
  businessId: string;
  userId: string;
  id: string;
  reference?: string;
  notes?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const header = await loadReturnHeader(tx, input.businessId, input.id);
    requireDraft(header.status); // §59 — DRAFT-only edits

    const data: Prisma.GoodsReturnUpdateInput = {};
    if (input.reference !== undefined) data.reference = input.reference;
    if (input.notes !== undefined) data.notes = input.notes;

    try {
      const updated = await tx.goodsReturn.update({
        where: { id: header.id },
        data,
        select: { id: true, reference: true, status: true },
      });

      await audit(
        auditInput(
          input.businessId,
          input.userId,
          "goods_return.update",
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
          GOODS_RETURN_ERROR_CODES.DUPLICATE_REFERENCE,
          "A goods return with this reference already exists.",
        );
      }
      throw error;
    }
  });
}

/* -------------------------------- line add --------------------------------- */

export async function addGoodsReturnLine(input: {
  businessId: string;
  userId: string;
  id: string;
  goodsReceiptLineId: string;
  returnedQty: number;
  reasonCode: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const header = await loadReturnHeader(tx, input.businessId, input.id);
    requireDraft(header.status); // §62 — DRAFT-only

    // §62/§28 — the source receipt line must belong to THIS return's
    // tenant-scoped receipt. One tenant-scoped join validates
    // return→receipt→line ownership; a foreign line is indistinguishable
    // from an unknown one (§68 → 404, no existence leak).
    const receiptLine = await tx.goodsReceiptLine.findFirst({
      where: { id: input.goodsReceiptLineId, goodsReceiptId: header.goodsReceiptId },
      select: {
        id: true,
        productId: true,
        receivedQty: true,
        productNameAtReceipt: true, // §30 — snapshots copied from the receipt line
        skuAtReceipt: true,
        unitAtReceipt: true,
        product: { select: { id: true, businessId: true } },
      },
    });
    if (!receiptLine) {
      throw new ApiError(
        404,
        GOODS_RETURN_ERROR_CODES.SOURCE_LINE_NOT_FOUND,
        "Goods receipt line not found.",
      );
    }

    // §62 — the product must exist inside the SAME tenant (belt-and-braces:
    // the FK is Restrict so a hard-deleted product is nearly impossible,
    // but the safe controlled failure is demanded, never fabrication).
    if (receiptLine.product.businessId !== input.businessId) {
      throw new ApiError(
        404,
        GOODS_RETURN_ERROR_CODES.SOURCE_LINE_NOT_FOUND,
        "Goods receipt line not found.",
      );
    }

    // §62 — the source receipt must STILL be POSTED at line-add time (a
    // receipt cannot leave POSTED, but the defensive re-check keeps the
    // invariant local and fail-loud if that ever changed).
    await loadPostedSourceReceipt(tx, input.businessId, header.goodsReceiptId);

    const cap = goodsReturnLineCap(process.env.GOODS_RETURN_MAX_LINES);
    await assertLineCap(tx, header.id, cap); // §62 — defensive count

    // §62/§35 — ADVISORY cumulative check at line-add time: returnedQty ≤
    // (received − POSTED returned). Draft lines of OTHER returns are
    // deliberately NOT subtracted — over-allocation across drafts is the
    // documented §63 stale-draft scenario and only POST is authoritative.
    const alreadyReturned = await sumPostedReturnedQtyForReceiptLine(tx, receiptLine.id);
    const returnable = computeReturnableQty(receiptLine.receivedQty, alreadyReturned); // §36
    if (exceedsReturnable(receiptLine.receivedQty, alreadyReturned, input.returnedQty)) {
      throw new ApiError(
        409,
        GOODS_RETURN_ERROR_CODES.EXCEEDS_RETURNABLE,
        `Only ${returnable} unit(s) remain returnable on this receipt line.`,
      );
    }

    try {
      const line = await tx.goodsReturnLine.create({
        data: {
          goodsReturnId: header.id,
          goodsReceiptLineId: receiptLine.id,
          productId: receiptLine.productId, // §28/§47 — derived, never client authority
          returnedQty: input.returnedQty,
          reasonCode: input.reasonCode, // §23 — closed vocabulary (zod)
          // §30 — snapshots copied from the RECEIPT LINE, not live Product.
          productNameAtReturn: receiptLine.productNameAtReceipt,
          skuAtReturn: receiptLine.skuAtReceipt,
          unitAtReturn: receiptLine.unitAtReceipt,
        },
        select: { id: true },
      });

      await audit(
        auditInput(input.businessId, input.userId, "goods_return.line_add", header.id, header.reference, {
          lineId: line.id, // §132 — safe per-line metadata
          goodsReceiptLineId: receiptLine.id,
          productId: receiptLine.productId,
          productNameAtReturn: receiptLine.productNameAtReceipt,
          returnedQty: input.returnedQty,
          reasonCode: input.reasonCode,
        }),
        tx,
      );

      return { id: line.id };
    } catch (error) {
      // §29/§75 — DB uniqueness is authoritative for duplicate lines.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ApiError(
          409,
          GOODS_RETURN_ERROR_CODES.DUPLICATE_LINE,
          "This goods receipt line is already on the return.",
        );
      }
      throw error;
    }
  });
}

/* ------------------------------- line update ------------------------------- */

export async function updateGoodsReturnLine(input: {
  businessId: string;
  userId: string;
  id: string;
  lineId: string;
  returnedQty: number;
  reasonCode: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const header = await loadReturnHeader(tx, input.businessId, input.id);
    requireDraft(header.status); // §58 — DRAFT-only

    const line = await tx.goodsReturnLine.findFirst({
      where: { id: input.lineId, goodsReturnId: header.id }, // §67 — scoped via parent
      select: {
        id: true,
        goodsReceiptLineId: true,
        productId: true,
        returnedQty: true,
        reasonCode: true,
      },
    });
    if (!line) throw new ApiError(404, "NOT_FOUND", "Return line not found.");

    // §58 — the returnedQty still respects the advisory cumulative check
    // (POSTED sums only — see the §62 note in addGoodsReturnLine).
    const receiptLine = await tx.goodsReceiptLine.findFirst({
      where: { id: line.goodsReceiptLineId },
      select: { id: true, receivedQty: true },
    });
    if (!receiptLine) {
      throw new ApiError(
        404,
        GOODS_RETURN_ERROR_CODES.SOURCE_LINE_NOT_FOUND,
        "Goods receipt line not found.",
      );
    }
    const alreadyReturned = await sumPostedReturnedQtyForReceiptLine(tx, receiptLine.id);
    const returnable = computeReturnableQty(receiptLine.receivedQty, alreadyReturned); // §36
    if (exceedsReturnable(receiptLine.receivedQty, alreadyReturned, input.returnedQty)) {
      throw new ApiError(
        409,
        GOODS_RETURN_ERROR_CODES.EXCEEDS_RETURNABLE,
        `Only ${returnable} unit(s) remain returnable on this receipt line.`,
      );
    }

    // §58-analog — re-read the persisted row after mutation: the response
    // carries the REAL stored snapshot fields and timestamps.
    const updated = await tx.goodsReturnLine.update({
      where: { id: line.id },
      data: { returnedQty: input.returnedQty, reasonCode: input.reasonCode },
      select: {
        id: true,
        goodsReceiptLineId: true,
        productId: true,
        productNameAtReturn: true,
        skuAtReturn: true,
        unitAtReturn: true,
        returnedQty: true,
        reasonCode: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    await audit(
      auditInput(input.businessId, input.userId, "goods_return.line_update", header.id, header.reference, {
        lineId: line.id, // §132 — before/after quantity + reason only
        returnedQty: { from: line.returnedQty, to: updated.returnedQty },
        reasonCode: { from: line.reasonCode, to: updated.reasonCode },
      }),
      tx,
    );

    return goodsReturnLineDto(updated);
  });
}

/* ------------------------------- line remove ------------------------------- */

export async function removeGoodsReturnLine(input: {
  businessId: string;
  userId: string;
  id: string;
  lineId: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const header = await loadReturnHeader(tx, input.businessId, input.id);
    requireDraft(header.status); // §60 — DRAFT-only

    const line = await tx.goodsReturnLine.findFirst({
      where: { id: input.lineId, goodsReturnId: header.id },
      select: { id: true, goodsReceiptLineId: true, productId: true, returnedQty: true },
    });
    if (!line) throw new ApiError(404, "NOT_FOUND", "Return line not found.");

    await tx.goodsReturnLine.delete({ where: { id: line.id } });
    const lineCount = await tx.goodsReturnLine.count({ where: { goodsReturnId: header.id } });

    await audit(
      auditInput(input.businessId, input.userId, "goods_return.line_remove", header.id, header.reference, {
        lineId: line.id,
        goodsReceiptLineId: line.goodsReceiptLineId,
        productId: line.productId,
        returnedQty: line.returnedQty,
        lineCount,
      }),
      tx,
    );

    return { removed: true, lineCount };
  });
}

/* ---------------------------------- post ----------------------------------- */

/**
 * §43 — THE atomic stock posting transaction. Steps 1-21 in ONE
 * database transaction (§48); a failure at ANY step rolls back EVERYTHING
 * (§52) — no stock change, no adjustment, no status, no audit.
 */
export async function postGoodsReturn(input: {
  businessId: string;
  userId: string;
  id: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    // §43 steps 1-3 — reload return INSIDE the transaction; never trust an
    // earlier GET. Corrupted status is surfaced, never Draft. Only
    // DRAFT → POSTED (§9 — at most one successful transition §53).
    const header = await loadReturnHeader(tx, input.businessId, input.id);
    assertTransition(header.status, "POSTED");

    // §43 steps 5-6 — the source receipt must STILL exist in this tenant
    // and be POSTED (corrupted receipt status never becomes POSTED, §66).
    const receipt = await loadPostedSourceReceipt(tx, input.businessId, header.goodsReceiptId);

    // §43 steps 7-8 — load the return's own lines (bounded by the document
    // cap; cap+1 proves completeness).
    const cap = goodsReturnLineCap(process.env.GOODS_RETURN_MAX_LINES);
    const lines = await tx.goodsReturnLine.findMany({
      where: { goodsReturnId: header.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: cap + 1, // cap+1 proves completeness
      select: {
        id: true,
        goodsReceiptLineId: true,
        productId: true,
        returnedQty: true,
        productNameAtReturn: true,
      },
    });
    if (lines.length > cap) {
      // §18/§19 — a PERSISTED document holding more lines than its own
      // invariant permits is DATA CORRUPTION → 500
      // GOODS_RETURN_LINE_CAP_INVARIANT. Never the 422 write-time
      // LINE_LIMIT error (that classification is for a newly submitted
      // over-limit request). No status change, no stock mutation, no
      // adjustment, no audit.
      throw new ApiError(
        500,
        GOODS_RETURN_LINE_CAP_INVARIANT,
        "Stored document data exceeds its configured line cap. Please contact support.",
      );
    }

    // §61 — a return with zero lines can never post.
    if (lines.length === 0) {
      throw new ApiError(
        422,
        GOODS_RETURN_ERROR_CODES.EMPTY,
        "Add at least one line before posting this return.",
      );
    }

    // §13 — validate EVERY persisted line quantity BEFORE any mutation: a
    // corrupted persisted line (zero, negative, fractional, unsafe, or over
    // the domain max) must NEVER become a zero-delta or positive-stock
    // adjustment. Controlled integrity error — no stock mutation, no
    // InventoryAdjustment, no status mutation, no post audit.
    for (const line of lines) {
      if (!isValidPersistedReturnedQty(line.returnedQty)) {
        throw new ApiError(
          500,
          GOODS_RETURN_ERROR_CODES.CORRUPT_HISTORY,
          "Goods return data is inconsistent. Please contact support.",
        );
      }
    }

    // §43 step 9 — every line's source receipt line must belong to THIS
    // receipt (defensive re-verification of the document chain), with the
    // immutable receivedQty as the quantity authority (§34).
    const receiptLineIds = lines.map((l) => l.goodsReceiptLineId);
    const receiptLines = await tx.goodsReceiptLine.findMany({
      where: { id: { in: receiptLineIds } },
      select: { id: true, goodsReceiptId: true, receivedQty: true },
    });
    const receiptLineById = new Map(receiptLines.map((rl) => [rl.id, rl]));

    // §43 step 10 / §37 — ONE grouped aggregate for ALL prior POSTED
    // returns of these source lines (never per-line queries, never an
    // unbounded history read).
    const returnedByLine = await sumPostedReturnedQtyForReceiptLines(tx, receiptLineIds);

    const adjustmentIds: string[] = [];
    const stockChanges: { productId: string; from: number; to: number }[] = [];

    for (const line of lines) {
      const sourceLine = receiptLineById.get(line.goodsReceiptLineId);
      if (!sourceLine || sourceLine.goodsReceiptId !== receipt.id) {
        // §43 step 9 / §142 — a detached source line is corruption; fail
        // safely (no partial posting), no existence leak.
        throw new ApiError(
          404,
          GOODS_RETURN_ERROR_CODES.SOURCE_LINE_NOT_FOUND,
          "Goods receipt line not found.",
        );
      }

      // §43 step 11 / §35 — the HARD cumulative return cap, final
      // authority. Prior POSTED returns + this line ≤ receivedQty.
      const alreadyReturned = returnedByLine.get(line.goodsReceiptLineId) ?? 0;
      const returnable = computeReturnableQty(sourceLine.receivedQty, alreadyReturned); // §36
      if (exceedsReturnable(sourceLine.receivedQty, alreadyReturned, line.returnedQty)) {
        throw new ApiError(
          409,
          GOODS_RETURN_ERROR_CODES.EXCEEDS_RETURNABLE,
          `Only ${returnable} unit(s) remain returnable on this receipt line.`,
        );
      }

      // §43 step 12 — reload the product (tenant-scoped; the product id
      // derives from the receipt line, §47 — never client authority).
      const product = await tx.product.findFirst({
        where: { id: line.productId, businessId: input.businessId }, // §67
        select: { id: true, stockQty: true },
      });
      if (!product) {
        // A hard-deleted product fails the post safely (never fabrication).
        throw new ApiError(
          422,
          GOODS_RETURN_ERROR_CODES.SOURCE_LINE_NOT_FOUND,
          "A product on this return no longer exists.",
        );
      }

      // §41/§164 — corrupt/negative persisted stock is surfaced as the
      // controlled integrity failure BEFORE any sufficiency comparison:
      // a negative stock reading is corruption, not "insufficient stock",
      // and it is NEVER silently repaired or zeroed.
      if (!Number.isInteger(product.stockQty) || product.stockQty < 0) {
        throw new ApiError(
          500,
          GOODS_RETURN_ERROR_CODES.INVALID_PERSISTED_STOCK,
          "Product stock data is in an invalid state. Please contact support.",
        );
      }

      // §39 — CURRENT STOCK CHECK: the physical decrement needs enough
      // aggregate stock NOW (the application has no lot/batch provenance —
      // documented limitation §40/§197).
      if (product.stockQty < line.returnedQty) {
        throw new ApiError(
          409,
          GOODS_RETURN_ERROR_CODES.INSUFFICIENT_STOCK,
          `Insufficient stock for ${line.productNameAtReturn}: ${product.stockQty} on hand, ${line.returnedQty} to return.`,
        );
      }

      // §42 — exact integer arithmetic; stockAfterReturn re-validates both
      // operands and the non-negative result (defense in depth).
      const newStock = stockAfterReturn(product.stockQty, line.returnedQty);

      // §43 steps 16 — decrement stock.
      await tx.product.update({
        where: { id: product.id },
        data: { stockQty: newStock },
        select: { id: true },
      });
      stockChanges.push({ productId: product.id, from: product.stockQty, to: newStock });

      // §43 step 17 / §44-§47 — ONE negative InventoryAdjustment per line
      // (delta = -returnedQty), server-derived actor/business/product.
      const adjustment = await tx.inventoryAdjustment.create({
        data: {
          businessId: input.businessId, // §46 — server-derived
          productId: product.id, // §47 — derived from the receipt line chain
          delta: -line.returnedQty, // §44 — always negative
          reason: RETURN_ADJUSTMENT_REASON(header.reference), // §44 — stable identifier
          actorId: input.userId, // §45 — server-derived
        },
        select: { id: true },
      });
      adjustmentIds.push(adjustment.id);
    }

    // §43 steps 18-19 — complete the posting (server timestamps only).
    const postedAt = new Date();
    const updated = await tx.goodsReturn.update({
      where: { id: header.id },
      data: { status: "POSTED", postedAt },
      select: { id: true, reference: true, status: true, postedAt: true },
    });

    // §43 step 20 / §48/§133 — ONE audit record for the posting, written
    // in the SAME transaction; if it fails, everything above rolls back.
    const totalReturnedQty = computeReturnedQty(lines.map((l) => l.returnedQty));
    await audit(
      auditInput(input.businessId, input.userId, "goods_return.post", header.id, header.reference, {
        goodsReceiptId: receipt.id,
        goodsReceiptReferenceAtReturn: header.goodsReceiptReferenceAtReturn,
        lineCount: lines.length,
        totalReturnedQty, // §132 — quantity facts only; never notes
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
      totalReturnedQty,
      stockChanges,
    };
  });
}

/* --------------------------------- cancel ---------------------------------- */

export async function cancelGoodsReturn(input: {
  businessId: string;
  userId: string;
  id: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    // §12 — reload inside the transaction; only DRAFT may cancel.
    const header = await loadReturnHeader(tx, input.businessId, input.id);
    assertTransition(header.status, "CANCELLED"); // §9

    // §12 — cancelling a draft is a pure document transition: NO stock
    // mutation, NO adjustment, NO financial anything.
    const updated = await tx.goodsReturn.update({
      where: { id: header.id },
      data: { status: "CANCELLED", cancelledAt: new Date() },
      select: { id: true, reference: true, status: true, cancelledAt: true },
    });

    await audit(
      auditInput(input.businessId, input.userId, "goods_return.cancel", header.id, header.reference, {
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

/* ------------- P42 integration: receipt-side return facts ------------------ */

/**
 * §86/§87 — ADDITIVE per-receipt-line return facts for the GoodsReceipt
 * detail: receivedQty (immutable gross, §34), returnedQty (POSTED only,
 * §36) and returnableQty = received − returned. One grouped aggregate —
 * never one query per line (§141). `returnable` reports whether ANY line
 * still has returnableQty > 0 (the §87 CTA gate; client-advisory only —
 * the server revalidates at post time).
 */
export async function getGoodsReceiptReturnFacts(input: {
  businessId: string;
  receiptId: string;
  receivedLines: ReadonlyArray<{ id: string; receivedQty: number }>;
}): Promise<{
  returnable: boolean;
  lines: ReceiptLineReturnFactsDto[];
}> {
  const returnedByLine = await sumPostedReturnedQtyForReceiptLines(
    db,
    input.receivedLines.map((l) => l.id),
  );
  let returnable = false;
  const lines = input.receivedLines.map((l) => {
    const returnedQty = returnedByLine.get(l.id) ?? 0;
    try {
      // §36 — ONE canonical checked helper: returned > received (or any
      // invalid operand) is corruption; surface it, never clamp.
      const returnableQty = computeReturnableQty(l.receivedQty, returnedQty);
      if (returnableQty > 0) returnable = true;
      return receiptLineReturnFactsDto({
        goodsReceiptLineId: l.id,
        receivedQty: l.receivedQty,
        returnedQty,
      });
    } catch (error) {
      return mapPureGoodsReturnDomainError(error);
    }
  });
  return { returnable, lines };
}

/** §88 — bounded recent returns for the receipt detail (take 10). */
export async function listRecentReturnsForReceipt(input: {
  businessId: string;
  receiptId: string;
  take?: number;
}): Promise<ReceiptRecentReturnDto[]> {
  const take = Math.min(Math.max(input.take ?? 10, 1), 10); // §88 — bounded
  const cap = goodsReturnLineCap(process.env.GOODS_RETURN_MAX_LINES);
  const rows = await db.goodsReturn.findMany({
    where: { businessId: input.businessId, goodsReceiptId: input.receiptId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: {
      id: true,
      reference: true,
      status: true,
      postedAt: true,
      createdAt: true,
      // §76 — cap+1 completeness proof (same law as the list read).
      lines: { select: { returnedQty: true }, take: cap + 1 },
    },
  });
  return rows.map((r) => {
    try {
      // §76 — cap+1 completeness proof (same law as the list read), mapped
      // through the ONE canonical validator + failure mapper.
      assertGoodsReturnLineSetComplete(r.lines.length, r.lines.length, cap);
      return {
        id: r.id,
        reference: r.reference,
        status: parseDbStatus(r.status),
        postedAt: r.postedAt ? r.postedAt.toISOString() : null,
        totalReturnedQty: computeReturnedQty(r.lines.map((l) => l.returnedQty)),
      };
    } catch (error) {
      return mapPureGoodsReturnDomainError(error);
    }
  });
}

/** §99 — bounded recent returns for the Product detail (take 10). */
export async function listRecentReturnsForProduct(input: {
  businessId: string;
  productId: string;
  take?: number;
}): Promise<ProductRecentReturnDto[]> {
  const take = Math.min(Math.max(input.take ?? 10, 1), 10); // §99 — bounded
  const rows = await db.goodsReturnLine.findMany({
    where: {
      productId: input.productId,
      goodsReturn: { businessId: input.businessId },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: {
      returnedQty: true,
      reasonCode: true,
      goodsReturn: {
        select: {
          id: true,
          reference: true,
          status: true,
          goodsReceiptReferenceAtReturn: true,
          postedAt: true,
        },
      },
    },
  });
  return rows.map((r) => {
    try {
      // §99/§7/§51 — a persisted line quantity of zero (or any invalid
      // value) and a corrupted reason code are NEVER treated as legitimate
      // history: the widget fails with the stable integrity code instead.
      computeReturnedQty([r.returnedQty]); // safe integer ≥ 1 (§7)
      if (!isGoodsReturnReasonCode(r.reasonCode)) {
        throw new GoodsReturnIntegrityError(
          `${GOODS_RETURN_CORRUPT_HISTORY}: invalid persisted reason code`,
        );
      }
      return {
        id: r.goodsReturn.id,
        reference: r.goodsReturn.reference,
        status: parseDbStatus(r.goodsReturn.status),
        goodsReceiptReferenceAtReturn: r.goodsReturn.goodsReceiptReferenceAtReturn,
        returnedQty: r.returnedQty,
        reasonCode: r.reasonCode,
        postedAt: r.goodsReturn.postedAt ? r.goodsReturn.postedAt.toISOString() : null,
      };
    } catch (error) {
      return mapPureGoodsReturnDomainError(error);
    }
  });
}

/** §100 — bounded recent returns for the Supplier 360 (take 10). */
export async function listRecentReturnsForSupplier(input: {
  businessId: string;
  supplierId: string;
  take?: number;
}): Promise<SupplierRecentReturnDto[]> {
  const take = Math.min(Math.max(input.take ?? 10, 1), 10); // §100 — bounded
  const cap = goodsReturnLineCap(process.env.GOODS_RETURN_MAX_LINES);
  const rows = await db.goodsReturn.findMany({
    where: {
      businessId: input.businessId,
      goodsReceipt: { purchaseOrder: { supplierId: input.supplierId } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: {
      id: true,
      reference: true,
      status: true,
      supplierNameAtReturn: true,
      goodsReceiptReferenceAtReturn: true,
      postedAt: true,
      // §76 — cap+1 completeness proof (same law as the list read).
      lines: { select: { returnedQty: true }, take: cap + 1 },
    },
  });
  return rows.map((r) => {
    try {
      // §76 — cap+1 completeness proof (same law as the list read).
      assertGoodsReturnLineSetComplete(r.lines.length, r.lines.length, cap);
      return {
        id: r.id,
        reference: r.reference,
        status: parseDbStatus(r.status),
        supplierNameAtReturn: r.supplierNameAtReturn,
        goodsReceiptReferenceAtReturn: r.goodsReceiptReferenceAtReturn,
        postedAt: r.postedAt ? r.postedAt.toISOString() : null,
        totalReturnedQty: computeReturnedQty(r.lines.map((l) => l.returnedQty)),
      };
    } catch (error) {
      return mapPureGoodsReturnDomainError(error);
    }
  });
}
