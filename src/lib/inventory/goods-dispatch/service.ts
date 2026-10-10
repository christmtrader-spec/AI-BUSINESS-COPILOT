import "server-only";

/**
 * Prompt 44 — goods-dispatch service (server-only).
 *
 * LAWS:
 *  - PHYSICAL INVENTORY OUTFLOW ONLY: posting DECREASES Product.stockQty
 *    and creates ONE negative InventoryAdjustment per line (delta = -qty).
 *    It NEVER creates Sale, Expense, Payment, receivable, credit note,
 *    statement movement or any accounting entry. Draft/cancel mutate
 *    NOTHING but the dispatch document.
 *  - PRODUCT IS THE SOURCE: an outbound dispatch is not chained to a
 *    purchase-order document. The tenant-scoped Product row and its
 *    CURRENT aggregate stock are the quantity authority at POST time (no
 *    lot/batch provenance — the same documented aggregate-stock trade-off
 *    as P40/P42/P43).
 *  - CURRENT STOCK CHECK: each posted line requires Product.stockQty ≥
 *    qty; the aggregate stock can NEVER go negative — no override, no
 *    silent zero-clamp (exact integer math via the ONE pure helper).
 *  - Every query is tenant-scoped by ctx.businessId — never a client
 *    businessId. Foreign product/customer/dispatch/dispatch-line → 404,
 *    no existence leak.
 *  - Status transitions are server-authoritative through dedicated
 *    operations; the current status is RE-CHECKED INSIDE the write
 *    transaction so concurrent posts/cancels cannot double-apply.
 *  - Snapshots (customer name, product name/sku/unit) are frozen at write
 *    time and NEVER overwritten from live data.
 *  - Quantities are exact integers; corrupt persisted state is surfaced,
 *    never repaired (safe-integer laws inherited from P43).
 *  - READ-CAP LAW: every bounded read fetches cap+1 rows to PROVE
 *    completeness — a document holding more rows than its own cap (or a
 *    `_count` mismatch) fails the read with the stable
 *    GOODS_DISPATCH_LINE_CAP_INVARIANT code. Read paths NEVER render a
 *    silently truncated slice or a partial total.
 *  - AGGREGATE LAW: POSTED dispatched quantities are summed by the
 *    DATABASE (aggregate/groupBy _sum), never by loading dispatch history
 *    into application memory; the aggregate result is re-validated.
 *  - Audit through the single sanctioned helper INSIDE the same
 *    transaction as every mutation — safe metadata only, never notes
 *    content.
 */
import { randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { withWriteTransaction } from "@/lib/db/write-transaction";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api-helpers";
import {
  assertGoodsDispatchLineSetComplete,
  canTransitionGoodsDispatch,
  computeDispatchedQty,
  exceedsAvailableStock,
  generateGoodsDispatchReference,
  GOODS_DISPATCH_CORRUPT_HISTORY,
  GOODS_DISPATCH_ERROR_CODES,
  GOODS_DISPATCH_INVALID_PERSISTED_STATUS,
  GOODS_DISPATCH_LINE_CAP_INVARIANT,
  GOODS_DISPATCH_QTY_MAX,
  GoodsDispatchIntegrityError,
  goodsDispatchDayWindow,
  goodsDispatchLineCap,
  isGoodsDispatchReasonCode,
  isValidPersistedDispatchQty,
  parseGoodsDispatchStatus,
  stockAfterDispatch,
  type GoodsDispatchStatus,
} from "./types";
import {
  customerRecentDispatchDto,
  goodsDispatchDetailDto,
  goodsDispatchLineDto,
  goodsDispatchListItemDto,
  productRecentDispatchDto,
  type CustomerRecentDispatchDto,
  type GoodsDispatchDetailDto,
  type GoodsDispatchListItemDto,
  type ProductRecentDispatchDto,
} from "./dto";

type Tx = Prisma.TransactionClient;
/** Read-side helpers accept either the raw client or a transaction client. */
type DbLike = Pick<Tx, "goodsDispatchLine">;

/**
 * The ONE shared SQLite write-transaction law (FIFO serialized writes +
 * bounded transient retry). The P41 procurement, P42 receiving, P43
 * return and P44 dispatch paths all run through the same helper so none
 * can interleave with another on the single write lock (no lost update
 * against receipts, returns, manual adjustments or stocktake
 * finalization).
 */
const withWriteTx = withWriteTransaction;

/** The adjustment reason ties every posted line to its dispatch. */
const DISPATCH_ADJUSTMENT_REASON = (reference: string) =>
  `Goods dispatch ${reference}: inventory dispatched out of stock`;

/* ---------------------------- shared internals ----------------------------- */

/** Corrupted persisted status → controlled 500 (never Draft). */
function parseDbStatus(value: string): GoodsDispatchStatus {
  try {
    return parseGoodsDispatchStatus(value);
  } catch (error) {
    if (error instanceof Error && error.name === "GoodsDispatchStatusIntegrityError") {
      throw new ApiError(
        500,
        GOODS_DISPATCH_INVALID_PERSISTED_STATUS,
        "Goods dispatch data is in an invalid state. Please contact support.",
      );
    }
    throw error;
  }
}

/**
 * Map pure canonical-math integrity failures to their controlled HTTP
 * result: corrupted dispatch history / corrupt stock is a 500, never a
 * silent clamp. Exported for cross-service mapping.
 */
export function mapPureGoodsDispatchDomainError(error: unknown): never {
  if (error instanceof Error && error.name === "GoodsDispatchStatusIntegrityError") {
    throw new ApiError(
      500,
      GOODS_DISPATCH_INVALID_PERSISTED_STATUS,
      "Goods dispatch data is in an invalid state. Please contact support.",
    );
  }
  if (error instanceof Error && error.name === "GoodsDispatchIntegrityError") {
    // The line-set completeness invariant (over-cap document or a
    // counted/fetched mismatch) is ITS OWN stable integrity code — never
    // misreported as generic history corruption.
    if (error.message.includes(GOODS_DISPATCH_LINE_CAP_INVARIANT)) {
      throw new ApiError(
        500,
        GOODS_DISPATCH_LINE_CAP_INVARIANT,
        "Stored document data exceeds its configured line cap. Please contact support.",
      );
    }
    const corruptStock = error.message.includes("GOODS_DISPATCH_INVALID_PERSISTED_STOCK");
    throw new ApiError(
      500,
      corruptStock
        ? GOODS_DISPATCH_ERROR_CODES.INVALID_PERSISTED_STOCK
        : GOODS_DISPATCH_ERROR_CODES.CORRUPT_HISTORY,
      corruptStock
        ? "Product stock data is in an invalid state. Please contact support."
        : "Goods dispatch data is inconsistent. Please contact support.",
    );
  }
  throw error;
}

function requireDraft(status: GoodsDispatchStatus): void {
  if (status !== "DRAFT") {
    // POSTED is immutable; CANCELLED is terminal.
    throw new ApiError(
      409,
      GOODS_DISPATCH_ERROR_CODES.IMMUTABLE,
      "Only DRAFT goods dispatches can be changed.",
    );
  }
}

function assertTransition(from: GoodsDispatchStatus, to: GoodsDispatchStatus): void {
  if (!canTransitionGoodsDispatch(from, to)) {
    throw new ApiError(
      409,
      GOODS_DISPATCH_ERROR_CODES.INVALID_TRANSITION,
      `Cannot move a goods dispatch from ${from} to ${to}.`,
    );
  }
}

async function loadDispatchHeader(
  tx: Tx,
  businessId: string,
  id: string,
): Promise<{
  id: string;
  reference: string;
  status: GoodsDispatchStatus;
  customerId: string | null;
  customerNameAtDispatch: string;
  notes: string | null;
  createdByUserId: string;
  postedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
}> {
  const row = await tx.goodsDispatch.findFirst({
    where: { id, businessId }, // tenant scope from auth context only
    select: {
      id: true,
      reference: true,
      status: true,
      customerId: true,
      customerNameAtDispatch: true,
      notes: true,
      createdByUserId: true,
      postedAt: true,
      cancelledAt: true,
      createdAt: true,
    },
  });
  if (!row) throw new ApiError(404, "NOT_FOUND", "Goods dispatch not found.");
  // A corrupted persisted status NEVER silently becomes DRAFT.
  return { ...row, status: parseDbStatus(row.status) };
}

/**
 * Load the tenant-scoped (and not-soft-deleted) customer for the optional
 * customer link and return its name for the frozen snapshot. A foreign
 * customer is indistinguishable from an unknown one (404, no leak).
 */
async function loadActiveCustomerName(
  tx: Tx,
  businessId: string,
  customerId: string,
): Promise<string> {
  const customer = await tx.customer.findFirst({
    where: { id: customerId, businessId, deletedAt: null },
    select: { name: true },
  });
  if (!customer) {
    throw new ApiError(
      404,
      GOODS_DISPATCH_ERROR_CODES.CUSTOMER_NOT_FOUND,
      "Customer not found.",
    );
  }
  return customer.name;
}

function auditInput(
  businessId: string,
  actorId: string,
  action: string,
  goodsDispatchId: string,
  reference: string,
  after: Record<string, unknown>,
  before?: Record<string, unknown>,
) {
  return {
    businessId,
    actorId,
    action,
    entityType: "GoodsDispatch",
    entityId: goodsDispatchId,
    ...(before ? { before } : {}),
    after: { reference, ...after }, // safe metadata; never notes content
  };
}

/**
 * The ONE canonical POSTED dispatched-quantity sum for ONE product.
 * DRAFT/CANCELLED dispatches never count. Database aggregate (_sum),
 * never a findMany of history into memory; the result is re-validated
 * (exact integer, ≥ 0) and corruption surfaces through the ONE mapping,
 * never clamped.
 */
export async function sumPostedDispatchedQtyForProduct(
  tx: DbLike,
  productId: string,
): Promise<number> {
  const agg = await tx.goodsDispatchLine.aggregate({
    where: {
      productId,
      goodsDispatch: { status: "POSTED" }, // POSTED only
    },
    _sum: { qty: true },
  });
  return validateDispatchedSum(agg._sum.qty ?? 0);
}

/** Aggregate result re-validation (SAFE integer, ≥ 0, no clamp). */
function validateDispatchedSum(sum: number): number {
  if (!Number.isSafeInteger(sum) || sum < 0) {
    throw mapPureGoodsDispatchDomainError(
      new Error("GOODS_DISPATCH_CORRUPT_HISTORY: negative or unsafe aggregate"),
    );
  }
  return sum;
}

/** Defensive line-count validation (add line). */
async function assertLineCap(tx: Tx, goodsDispatchId: string, cap: number): Promise<number> {
  const lineCount = await tx.goodsDispatchLine.count({ where: { goodsDispatchId } });
  if (lineCount > cap) {
    // An ALREADY-corrupted document (more lines than its own cap) is
    // database corruption: 500 integrity, never disguised as the ordinary
    // 422 user validation failure.
    throw new ApiError(
      500,
      GOODS_DISPATCH_LINE_CAP_INVARIANT,
      "Stored document data exceeds its configured line cap. Please contact support.",
    );
  }
  if (lineCount === cap) {
    // The NORMAL write-time rejection for a legitimately full draft.
    throw new ApiError(
      422,
      GOODS_DISPATCH_ERROR_CODES.LINE_LIMIT,
      `A goods dispatch can contain at most ${cap} lines.`,
    );
  }
  return lineCount;
}

/* -------------------------------- create ----------------------------------- */

export async function createGoodsDispatch(input: {
  businessId: string;
  userId: string;
  customerId?: string;
  reference?: string;
  notes?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    // Optional customer link: tenant-scoped, not soft-deleted; the name
    // snapshot is frozen at creation (deletion/renames never rewrite it).
    let customerNameAtDispatch = "";
    if (input.customerId) {
      customerNameAtDispatch = await loadActiveCustomerName(
        tx,
        input.businessId,
        input.customerId,
      );
    }

    // Reference: user-supplied (normalized) or server-generated.
    let reference = input.reference;
    if (reference === undefined) {
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
        // Astronomically unlikely (31^6); fail honestly rather than loop.
        throw new ApiError(
          409,
          GOODS_DISPATCH_ERROR_CODES.DUPLICATE_REFERENCE,
          "Could not generate a unique reference. Please try again.",
        );
      }
    }

    try {
      const row = await tx.goodsDispatch.create({
        data: {
          businessId: input.businessId, // server-derived, never client
          customerId: input.customerId ?? null,
          customerNameAtDispatch, // frozen snapshot ("" when no customer)
          reference,
          status: "DRAFT", // preparation only
          notes: input.notes ?? null, // document data only
          createdByUserId: input.userId, // server-derived
        },
        select: { id: true, reference: true, status: true },
      });

      await audit(
        auditInput(input.businessId, input.userId, "goods_dispatch.create", row.id, row.reference, {
          customerId: input.customerId ?? null,
          customerNameAtDispatch,
          status: row.status,
        }),
        tx,
      );

      return row;
    } catch (error) {
      // Database uniqueness stays authoritative for duplicates.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ApiError(
          409,
          GOODS_DISPATCH_ERROR_CODES.DUPLICATE_REFERENCE,
          "A goods dispatch with this reference already exists.",
        );
      }
      throw error;
    }
  });
}

/* --------------------------------- list ------------------------------------ */

export async function listGoodsDispatches(input: {
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
  items: GoodsDispatchListItemDto[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const cap = goodsDispatchLineCap(process.env.GOODS_DISPATCH_MAX_LINES);
  const where: Prisma.GoodsDispatchWhereInput = {
    businessId: input.businessId, // tenant scope
    ...(input.status && input.status !== "ALL" ? { status: input.status } : {}),
    ...(input.customerId ? { customerId: input.customerId } : {}),
    ...(input.from || input.to
      ? (() => {
          // The from/to calendar dates are interpreted in the
          // AUTHENTICATED BUSINESS's timezone (inclusive local start of
          // `from`, EXCLUSIVE local start of the day after `to`). A record
          // at 00:15 local belongs to its local date even when its UTC
          // date is the previous day. Unresolvable bounds → controlled 422.
          const window = goodsDispatchDayWindow(input.from, input.to, input.timezone);
          if (!window) {
            throw new ApiError(422, "VALIDATION_ERROR", "Invalid date filter.");
          }
          return { createdAt: window };
        })()
      : {}),
    ...(input.q
      ? {
          OR: [
            { reference: { contains: input.q } }, // dispatch reference
            { customerNameAtDispatch: { contains: input.q } }, // customer snapshot
            {
              lines: {
                some: {
                  OR: [
                    { productNameAtDispatch: { contains: input.q } }, // product snapshot
                    { skuAtDispatch: { contains: input.q } }, // SKU snapshot
                  ],
                },
              },
            },
          ],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    db.goodsDispatch.count({ where }),
    // DB-level pagination; never findMany + slice.
    db.goodsDispatch.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      select: {
        id: true,
        reference: true,
        status: true,
        customerId: true,
        customerNameAtDispatch: true,
        postedAt: true,
        cancelledAt: true,
        createdAt: true,
        lines: {
          // Bounded aggregate relation, not one query per row.
          // take cap+1 PROVES the slice is the whole line set: a dispatch
          // over its own cap is corruption and fails the read below —
          // never a silently truncated total.
          select: { qty: true },
          take: cap + 1,
        },
        _count: { select: { lines: true } },
      },
    }),
  ]);

  const items = rows.map((row) => {
    try {
      // The THREE explicit completeness invariants (fetched ≤ cap,
      // counted ≤ cap, counted === fetched) are enforced by the ONE
      // canonical pure validator: a count mismatch fails the read EVEN
      // WHEN both numbers are below the cap — a subset total must never
      // masquerade as complete. Then the proven-complete slice feeds the
      // canonical sum, which re-validates every persisted quantity
      // (safe integer ≥ 1 — a stored zero is corruption).
      assertGoodsDispatchLineSetComplete(row.lines.length, row._count.lines, cap);
      const totalDispatchedQty = computeDispatchedQty(row.lines.map((l) => l.qty));
      return goodsDispatchListItemDto({
        id: row.id,
        reference: row.reference,
        status: row.status,
        customerId: row.customerId,
        customerNameAtDispatch: row.customerNameAtDispatch,
        lineCount: row._count.lines,
        totalDispatchedQty,
        postedAt: row.postedAt,
        cancelledAt: row.cancelledAt,
        createdAt: row.createdAt,
        createdByUserId: "",
        createdByName: null,
        notes: null,
      });
    } catch (error) {
      // A corrupted quantity inside history surfaces as the stable
      // integrity 500, never a partial row and never a generic 500.
      return mapPureGoodsDispatchDomainError(error);
    }
  });
  return { items, total, page: input.page, pageSize: input.pageSize };
}

/* -------------------------------- detail ----------------------------------- */

export async function getGoodsDispatch(input: {
  businessId: string;
  id: string;
}): Promise<GoodsDispatchDetailDto> {
  const cap = goodsDispatchLineCap(process.env.GOODS_DISPATCH_MAX_LINES);
  // Lines are bounded by the document's own cap; one bounded read.
  // take cap+1 proves completeness: the +1 row is corruption and fails the
  // read with the stable invariant code below — never a detail DTO
  // silently rendered from only the first cap lines.
  const row = await db.goodsDispatch.findFirst({
    where: { id: input.id, businessId: input.businessId }, // tenant scope
    select: {
      id: true,
      reference: true,
      status: true,
      notes: true,
      customerId: true,
      customerNameAtDispatch: true,
      createdByUserId: true,
      postedAt: true,
      cancelledAt: true,
      createdAt: true,
      createdByUser: { select: { name: true } }, // name only
      lines: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: cap + 1,
        select: {
          id: true,
          productId: true,
          productNameAtDispatch: true,
          skuAtDispatch: true,
          unitAtDispatch: true,
          qty: true,
          reasonCode: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });
  if (!row) throw new ApiError(404, "NOT_FOUND", "Goods dispatch not found.");

  try {
    // Never render a partial document: cap+1 rows fetched, so a fetched
    // count above the cap proves corruption (the counted arm is identical
    // here — no separate _count exists on this read).
    assertGoodsDispatchLineSetComplete(row.lines.length, row.lines.length, cap);
    return goodsDispatchDetailDto(
      {
        id: row.id,
        reference: row.reference,
        status: row.status,
        notes: row.notes,
        customerId: row.customerId,
        customerNameAtDispatch: row.customerNameAtDispatch,
        createdByUserId: row.createdByUserId,
        createdByName: row.createdByUser?.name ?? null,
        postedAt: row.postedAt,
        cancelledAt: row.cancelledAt,
        createdAt: row.createdAt,
      },
      row.lines,
    );
  } catch (error) {
    return mapPureGoodsDispatchDomainError(error);
  }
}

/* ------------------------------ header patch ------------------------------- */

export async function updateGoodsDispatch(input: {
  businessId: string;
  userId: string;
  id: string;
  reference?: string;
  notes?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const header = await loadDispatchHeader(tx, input.businessId, input.id);
    requireDraft(header.status); // DRAFT-only edits

    const data: Prisma.GoodsDispatchUpdateInput = {};
    if (input.reference !== undefined) data.reference = input.reference;
    if (input.notes !== undefined) data.notes = input.notes;

    try {
      const updated = await tx.goodsDispatch.update({
        where: { id: header.id },
        data,
        select: { id: true, reference: true, status: true },
      });

      await audit(
        auditInput(
          input.businessId,
          input.userId,
          "goods_dispatch.update",
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
          GOODS_DISPATCH_ERROR_CODES.DUPLICATE_REFERENCE,
          "A goods dispatch with this reference already exists.",
        );
      }
      throw error;
    }
  });
}

/* -------------------------------- line add --------------------------------- */

export async function addGoodsDispatchLine(input: {
  businessId: string;
  userId: string;
  id: string;
  productId: string;
  qty: number;
  reasonCode: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const header = await loadDispatchHeader(tx, input.businessId, input.id);
    requireDraft(header.status); // DRAFT-only

    // The product IS the authoritative outbound source: it must exist
    // inside the SAME tenant and be ACTIVE (a new dispatch line cannot
    // target a soft-deleted product). A foreign product is
    // indistinguishable from an unknown one (404, no existence leak).
    const product = await tx.product.findFirst({
      where: { id: input.productId, businessId: input.businessId, deletedAt: null },
      select: {
        id: true,
        name: true,
        sku: true,
        unit: true,
        stockQty: true,
        isActive: true,
      },
    });
    if (!product || !product.isActive) {
      throw new ApiError(
        404,
        GOODS_DISPATCH_ERROR_CODES.PRODUCT_NOT_FOUND,
        "Product not found.",
      );
    }

    const cap = goodsDispatchLineCap(process.env.GOODS_DISPATCH_MAX_LINES);
    await assertLineCap(tx, header.id, cap); // defensive count

    // ADVISORY availability check at line-add time: qty ≤ current stock.
    // Draft lines of OTHER dispatches are deliberately NOT subtracted —
    // over-allocation across drafts is the documented stale-draft
    // scenario and only POST is authoritative (inside the write tx).
    if (exceedsAvailableStock(product.stockQty, input.qty)) {
      throw new ApiError(
        409,
        GOODS_DISPATCH_ERROR_CODES.INSUFFICIENT_STOCK,
        `Insufficient stock for ${product.name}: ${product.stockQty} on hand, ${input.qty} to dispatch.`,
      );
    }

    try {
      const line = await tx.goodsDispatchLine.create({
        data: {
          goodsDispatchId: header.id,
          productId: product.id,
          qty: input.qty,
          reasonCode: input.reasonCode, // closed vocabulary (zod)
          // Snapshots copied from the PRODUCT at add time, then frozen —
          // never re-read live afterwards.
          productNameAtDispatch: product.name,
          skuAtDispatch: product.sku,
          unitAtDispatch: product.unit,
        },
        select: { id: true },
      });

      await audit(
        auditInput(
          input.businessId,
          input.userId,
          "goods_dispatch.line_add",
          header.id,
          header.reference,
          {
            lineId: line.id, // safe per-line metadata
            productId: product.id,
            productNameAtDispatch: product.name,
            qty: input.qty,
            reasonCode: input.reasonCode,
          },
        ),
        tx,
      );

      return { id: line.id };
    } catch (error) {
      // DB uniqueness is authoritative for duplicate lines (one line per
      // product per dispatch).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ApiError(
          409,
          GOODS_DISPATCH_ERROR_CODES.DUPLICATE_LINE,
          "This product is already on the dispatch.",
        );
      }
      throw error;
    }
  });
}

/* ------------------------------- line update ------------------------------- */

export async function updateGoodsDispatchLine(input: {
  businessId: string;
  userId: string;
  id: string;
  lineId: string;
  qty: number;
  reasonCode: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const header = await loadDispatchHeader(tx, input.businessId, input.id);
    requireDraft(header.status); // DRAFT-only

    const line = await tx.goodsDispatchLine.findFirst({
      where: { id: input.lineId, goodsDispatchId: header.id }, // scoped via parent
      select: {
        id: true,
        productId: true,
        qty: true,
        reasonCode: true,
      },
    });
    if (!line) throw new ApiError(404, "NOT_FOUND", "Dispatch line not found.");

    // The qty still respects the advisory availability check (POSTED sums
    // are not subtracted — see the note in addGoodsDispatchLine; only
    // POST is authoritative).
    const product = await tx.product.findFirst({
      where: { id: line.productId, businessId: input.businessId },
      select: { id: true, name: true, stockQty: true },
    });
    if (!product) {
      throw new ApiError(
        404,
        GOODS_DISPATCH_ERROR_CODES.PRODUCT_NOT_FOUND,
        "Product not found.",
      );
    }
    if (exceedsAvailableStock(product.stockQty, input.qty)) {
      throw new ApiError(
        409,
        GOODS_DISPATCH_ERROR_CODES.INSUFFICIENT_STOCK,
        `Insufficient stock for ${product.name}: ${product.stockQty} on hand, ${input.qty} to dispatch.`,
      );
    }

    // Re-read the persisted row after mutation: the response carries the
    // REAL stored snapshot fields and timestamps (snapshots stay frozen).
    const updated = await tx.goodsDispatchLine.update({
      where: { id: line.id },
      data: { qty: input.qty, reasonCode: input.reasonCode },
      select: {
        id: true,
        productId: true,
        productNameAtDispatch: true,
        skuAtDispatch: true,
        unitAtDispatch: true,
        qty: true,
        reasonCode: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    await audit(
      auditInput(
        input.businessId,
        input.userId,
        "goods_dispatch.line_update",
        header.id,
        header.reference,
        {
          lineId: line.id, // before/after quantity + reason only
          qty: { from: line.qty, to: updated.qty },
          reasonCode: { from: line.reasonCode, to: updated.reasonCode },
        },
      ),
      tx,
    );

    return goodsDispatchLineDto(updated);
  });
}

/* ------------------------------- line remove ------------------------------- */

export async function removeGoodsDispatchLine(input: {
  businessId: string;
  userId: string;
  id: string;
  lineId: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const header = await loadDispatchHeader(tx, input.businessId, input.id);
    requireDraft(header.status); // DRAFT-only

    const line = await tx.goodsDispatchLine.findFirst({
      where: { id: input.lineId, goodsDispatchId: header.id },
      select: { id: true, productId: true, qty: true },
    });
    if (!line) throw new ApiError(404, "NOT_FOUND", "Dispatch line not found.");

    await tx.goodsDispatchLine.delete({ where: { id: line.id } });
    const lineCount = await tx.goodsDispatchLine.count({ where: { goodsDispatchId: header.id } });

    await audit(
      auditInput(
        input.businessId,
        input.userId,
        "goods_dispatch.line_remove",
        header.id,
        header.reference,
        {
          lineId: line.id,
          productId: line.productId,
          qty: line.qty,
          lineCount,
        },
      ),
      tx,
    );

    return { removed: true, lineCount };
  });
}

/* ---------------------------------- post ----------------------------------- */

/**
 * THE atomic stock posting transaction. All steps in ONE database
 * transaction; a failure at ANY step rolls back EVERYTHING — no stock
 * change, no adjustment, no status, no audit.
 */
export async function postGoodsDispatch(input: {
  businessId: string;
  userId: string;
  id: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    // Reload dispatch INSIDE the transaction; never trust an earlier GET.
    // Corrupted status is surfaced, never Draft. Only DRAFT → POSTED (at
    // most one successful transition; concurrent posts serialize on the
    // shared write transaction).
    const header = await loadDispatchHeader(tx, input.businessId, input.id);
    assertTransition(header.status, "POSTED");

    // Load the dispatch's own lines (bounded by the document cap; cap+1
    // proves completeness).
    const cap = goodsDispatchLineCap(process.env.GOODS_DISPATCH_MAX_LINES);
    const lines = await tx.goodsDispatchLine.findMany({
      where: { goodsDispatchId: header.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: cap + 1, // cap+1 proves completeness
      select: {
        id: true,
        productId: true,
        qty: true,
        reasonCode: true,
        productNameAtDispatch: true,
      },
    });
    if (lines.length > cap) {
      // A PERSISTED document holding more lines than its own invariant
      // permits is DATA CORRUPTION → 500 GOODS_DISPATCH_LINE_CAP_INVARIANT.
      // Never the 422 write-time LINE_LIMIT error (that classification is
      // for a newly submitted over-limit request). No status change, no
      // stock mutation, no adjustment, no audit.
      throw new ApiError(
        500,
        GOODS_DISPATCH_LINE_CAP_INVARIANT,
        "Stored document data exceeds its configured line cap. Please contact support.",
      );
    }

    // A dispatch with zero lines can never post.
    if (lines.length === 0) {
      throw new ApiError(
        422,
        GOODS_DISPATCH_ERROR_CODES.EMPTY,
        "Add at least one line before posting this dispatch.",
      );
    }

    // Validate EVERY persisted line BEFORE any mutation: a corrupted
    // persisted line (zero, negative, fractional, unsafe, over the domain
    // max, or an unknown reason code) must NEVER become a zero-delta or
    // positive-stock adjustment. Controlled integrity error — no stock
    // mutation, no InventoryAdjustment, no status mutation, no post audit.
    for (const line of lines) {
      if (!isValidPersistedDispatchQty(line.qty)) {
        throw new ApiError(
          500,
          GOODS_DISPATCH_ERROR_CODES.CORRUPT_HISTORY,
          "Goods dispatch data is inconsistent. Please contact support.",
        );
      }
      if (!isGoodsDispatchReasonCode(line.reasonCode)) {
        throw new ApiError(
          500,
          GOODS_DISPATCH_ERROR_CODES.CORRUPT_HISTORY,
          "Goods dispatch data is inconsistent. Please contact support.",
        );
      }
    }

    const adjustmentIds: string[] = [];
    const stockChanges: { productId: string; from: number; to: number }[] = [];

    // Group products once (bounded by the line cap — no N+1 per line).
    const productIds = Array.from(new Set(lines.map((l) => l.productId)));
    const products = await tx.product.findMany({
      where: { id: { in: productIds }, businessId: input.businessId }, // tenant scope
      select: { id: true, name: true, stockQty: true },
    });
    const productById = new Map(products.map((p) => [p.id, p]));

    for (const line of lines) {
      const product = productById.get(line.productId);
      if (!product) {
        // A hard-deleted product fails the post safely (never fabrication).
        throw new ApiError(
          422,
          GOODS_DISPATCH_ERROR_CODES.PRODUCT_NOT_FOUND,
          "A product on this dispatch no longer exists.",
        );
      }

      // Corrupt/negative persisted stock is surfaced as the controlled
      // integrity failure BEFORE any sufficiency comparison: a negative
      // stock reading is corruption, not "insufficient stock", and it is
      // NEVER silently repaired or zeroed.
      if (!Number.isSafeInteger(product.stockQty) || product.stockQty < 0) {
        throw new ApiError(
          500,
          GOODS_DISPATCH_ERROR_CODES.INVALID_PERSISTED_STOCK,
          "Product stock data is in an invalid state. Please contact support.",
        );
      }

      // CURRENT STOCK CHECK (final authority): the physical decrement
      // needs enough aggregate stock NOW (no lot/batch provenance — the
      // documented aggregate-stock trade-off).
      if (exceedsAvailableStock(product.stockQty, line.qty)) {
        throw new ApiError(
          409,
          GOODS_DISPATCH_ERROR_CODES.INSUFFICIENT_STOCK,
          `Insufficient stock for ${line.productNameAtDispatch}: ${product.stockQty} on hand, ${line.qty} to dispatch.`,
        );
      }

      // Exact integer arithmetic; stockAfterDispatch re-validates both
      // operands and the non-negative result (defense in depth).
      const newStock = stockAfterDispatch(product.stockQty, line.qty);

      // Decrement stock.
      await tx.product.update({
        where: { id: product.id },
        data: { stockQty: newStock },
        select: { id: true },
      });
      stockChanges.push({ productId: product.id, from: product.stockQty, to: newStock });

      // ONE negative InventoryAdjustment per line (delta = -qty),
      // server-derived actor/business/product.
      const adjustment = await tx.inventoryAdjustment.create({
        data: {
          businessId: input.businessId, // server-derived
          productId: product.id, // derived from the dispatch line
          delta: -line.qty, // always negative
          reason: DISPATCH_ADJUSTMENT_REASON(header.reference), // stable identifier
          actorId: input.userId, // server-derived
        },
        select: { id: true },
      });
      adjustmentIds.push(adjustment.id);
    }

    // Complete the posting (server timestamps only).
    const postedAt = new Date();
    const updated = await tx.goodsDispatch.update({
      where: { id: header.id },
      data: { status: "POSTED", postedAt },
      select: { id: true, reference: true, status: true, postedAt: true },
    });

    // ONE audit record for the posting, written in the SAME transaction;
    // if it fails, everything above rolls back.
    const totalDispatchedQty = computeDispatchedQty(lines.map((l) => l.qty));
    await audit(
      auditInput(input.businessId, input.userId, "goods_dispatch.post", header.id, header.reference, {
        customerId: header.customerId,
        customerNameAtDispatch: header.customerNameAtDispatch,
        lineCount: lines.length,
        totalDispatchedQty, // quantity facts only; never notes
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
      totalDispatchedQty,
      stockChanges,
    };
  });
}

/* --------------------------------- cancel ---------------------------------- */

export async function cancelGoodsDispatch(input: {
  businessId: string;
  userId: string;
  id: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    // Reload inside the transaction; only DRAFT may cancel.
    const header = await loadDispatchHeader(tx, input.businessId, input.id);
    assertTransition(header.status, "CANCELLED");

    // Cancelling a draft is a pure document transition: NO stock
    // mutation, NO adjustment, NO financial anything.
    const updated = await tx.goodsDispatch.update({
      where: { id: header.id },
      data: { status: "CANCELLED", cancelledAt: new Date() },
      select: { id: true, reference: true, status: true, cancelledAt: true },
    });

    await audit(
      auditInput(input.businessId, input.userId, "goods_dispatch.cancel", header.id, header.reference, {
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

/* --------------------- product/customer integration ------------------------ */

/** Bounded recent dispatches for the Product detail (take 10). */
export async function listRecentDispatchesForProduct(input: {
  businessId: string;
  productId: string;
  take?: number;
}): Promise<ProductRecentDispatchDto[]> {
  const take = Math.min(Math.max(input.take ?? 10, 1), 10); // bounded
  const rows = await db.goodsDispatchLine.findMany({
    where: {
      productId: input.productId,
      goodsDispatch: { businessId: input.businessId },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: {
      qty: true,
      reasonCode: true,
      goodsDispatch: {
        select: {
          id: true,
          reference: true,
          status: true,
          customerNameAtDispatch: true,
          postedAt: true,
        },
      },
    },
  });
  return rows.map((r) => {
    try {
      // A persisted line quantity of zero (or any invalid value) and a
      // corrupted reason code are NEVER treated as legitimate history:
      // the widget fails with the stable integrity code instead.
      computeDispatchedQty([r.qty]); // safe integer ≥ 1
      if (!isGoodsDispatchReasonCode(r.reasonCode)) {
        throw new GoodsDispatchIntegrityError(
          `${GOODS_DISPATCH_CORRUPT_HISTORY}: invalid persisted reason code`,
        );
      }
      return productRecentDispatchDto({
        id: r.goodsDispatch.id,
        reference: r.goodsDispatch.reference,
        status: r.goodsDispatch.status,
        customerNameAtDispatch: r.goodsDispatch.customerNameAtDispatch,
        qty: r.qty,
        reasonCode: r.reasonCode,
        postedAt: r.goodsDispatch.postedAt,
      });
    } catch (error) {
      return mapPureGoodsDispatchDomainError(error);
    }
  });
}

/** Bounded recent dispatches for the Customer 360 (take 10). */
export async function listRecentDispatchesForCustomer(input: {
  businessId: string;
  customerId: string;
  take?: number;
}): Promise<CustomerRecentDispatchDto[]> {
  const take = Math.min(Math.max(input.take ?? 10, 1), 10); // bounded
  const cap = goodsDispatchLineCap(process.env.GOODS_DISPATCH_MAX_LINES);
  const rows = await db.goodsDispatch.findMany({
    where: {
      businessId: input.businessId,
      customerId: input.customerId,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: {
      id: true,
      reference: true,
      status: true,
      customerNameAtDispatch: true,
      postedAt: true,
      // cap+1 completeness proof (same law as the list read).
      lines: { select: { qty: true }, take: cap + 1 },
    },
  });
  return rows.map((r) => {
    try {
      // cap+1 completeness proof (same law as the list read).
      assertGoodsDispatchLineSetComplete(r.lines.length, r.lines.length, cap);
      return customerRecentDispatchDto({
        id: r.id,
        reference: r.reference,
        status: r.status,
        customerNameAtDispatch: r.customerNameAtDispatch,
        postedAt: r.postedAt,
        totalDispatchedQty: computeDispatchedQty(r.lines.map((l) => l.qty)),
      });
    } catch (error) {
      return mapPureGoodsDispatchDomainError(error);
    }
  });
}
