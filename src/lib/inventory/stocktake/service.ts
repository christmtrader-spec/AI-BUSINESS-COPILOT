import "server-only";

/**
 * Prompt 40 — stocktake service (server-only, §118).
 *
 * LAWS:
 *  - Every query is tenant-scoped by ctx.businessId (§54) — never a client
 *    businessId. Foreign stocktake/product → 404, no existence leakage (§55).
 *  - Status transitions are server-authoritative through dedicated
 *    operations (§9); invalid transitions → 422 INVALID_STOCKTAKE_TRANSITION.
 *  - systemQtyAtCount is ALWAYS the server-read Product.stockQty at count
 *    time (§15); the client supplies ONLY countedQty (§16); variance is
 *    server-derived (§16/§18).
 *  - Finalization is ONE atomic transaction (§39): stale-count check against
 *    CURRENT stockQty (§40/§41 — never auto-rebased), InventoryAdjustment
 *    rows for non-zero variances (§43), zero-variance lines skip the
 *    adjustment (§44), no partial finalization (§156).
 *  - FINALIZED/CANCELLED are immutable (§50/§51).
 *  - Audit through the single sanctioned helper inside the same transaction
 *    (§71); NO audit on reads (§69); safe metadata only (§70/§140).
 */
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api-helpers";
import {
  computeStocktakeSummary,
  computeVarianceQty,
  isStocktakeStatus,
  canTransitionStocktake,
  stocktakeLineCap,
  STOCKTAKE_ERROR_CODES,
  type StocktakeStatus,
} from "./types";
import {
  stocktakeDetailDto,
  stocktakeListItemDto,
} from "./dto";

type Tx = Prisma.TransactionClient;

const ADJUSTMENT_REASON = (reference: string) =>
  `Stocktake ${reference}: physical count reconciliation`;

/* ---------------------------- shared internals ----------------------------- */

function assertTransition(from: StocktakeStatus, to: StocktakeStatus): void {
  if (!canTransitionStocktake(from, to)) {
    throw new ApiError(
      422,
      STOCKTAKE_ERROR_CODES.INVALID_TRANSITION,
      `Cannot move a stocktake from ${from} to ${to}.`,
    );
  }
}

async function loadStocktake(
  tx: Tx,
  businessId: string,
  id: string,
): Promise<{
  id: string;
  reference: string;
  status: StocktakeStatus;
  countType: string;
  notes: string | null;
  createdByUserId: string;
  startedAt: Date | null;
  reviewedAt: Date | null;
  finalizedAt: Date | null;
  canceledAt: Date | null;
  createdAt: Date;
}> {
  const row = await tx.inventoryStocktake.findFirst({
    where: { id, businessId }, // §54 — tenant scope from auth context only
    select: {
      id: true,
      reference: true,
      status: true,
      countType: true,
      notes: true,
      createdByUserId: true,
      startedAt: true,
      reviewedAt: true,
      finalizedAt: true,
      canceledAt: true,
      createdAt: true,
    },
  });
  if (!row) throw new ApiError(404, "NOT_FOUND", "Stocktake not found.");
  return { ...row, status: isStocktakeStatus(row.status) ? row.status : "DRAFT" };
}

function auditInput(
  businessId: string,
  actorId: string,
  action: string,
  stocktakeId: string,
  reference: string,
  after: Record<string, unknown>,
  before?: Record<string, unknown>,
) {
  return {
    businessId,
    actorId,
    action,
    entityType: "InventoryStocktake",
    entityId: stocktakeId,
    ...(before ? { before } : {}),
    after: { reference, ...after }, // §70 — safe metadata; never notes content
  };
}

/* -------------------------------- create ---------------------------------- */

export async function createStocktake(input: {
  businessId: string;
  userId: string;
  reference: string;
  notes: string | null;
  countType?: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return db.$transaction(async (tx) => {
    try {
      const row = await tx.inventoryStocktake.create({
        data: {
          businessId: input.businessId,
          reference: input.reference,
          notes: input.notes,
          countType: "SELECTED", // §24 — only SELECTED exists
          status: "DRAFT",
          createdByUserId: input.userId,
        },
        select: { id: true, reference: true, status: true },
      });
      await audit(
        auditInput(input.businessId, input.userId, "inventory.stocktake.create", row.id, row.reference, {
          status: row.status,
          countType: "SELECTED",
        }),
        tx,
      );
      return row;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ApiError(409, "DUPLICATE_REFERENCE", "A stocktake with this reference already exists.");
      }
      throw error;
    }
  });
}

/* --------------------------------- list ----------------------------------- */

export async function listStocktakes(input: {
  businessId: string;
  q?: string;
  status?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}) {
  const where: Prisma.InventoryStocktakeWhereInput = { businessId: input.businessId };
  if (input.q) where.reference = { contains: input.q };
  if (input.status && isStocktakeStatus(input.status)) where.status = input.status;
  if (input.from || input.to) {
    where.createdAt = {};
    if (input.from) where.createdAt.gte = new Date(`${input.from}T00:00:00.000Z`);
    if (input.to) where.createdAt.lte = new Date(`${input.to}T23:59:59.999Z`);
  }

  const [rows, total] = await Promise.all([
    db.inventoryStocktake.findMany({
      where,
      orderBy: { createdAt: "desc" }, // deterministic newest-first list (§134)
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      // §67 — list select minimization; a bounded line slice feeds the
      // counted/net columns without loading full line tables.
      select: {
        id: true,
        reference: true,
        status: true,
        countType: true,
        createdAt: true,
        createdByUser: { select: { id: true, name: true, email: true } },
        _count: { select: { lines: true } },
        lines: { select: { countedAt: true, varianceQty: true } },
      },
    }),
    db.inventoryStocktake.count({ where }),
  ]);

  return {
    items: rows.map(stocktakeListItemDto),
    total,
    page: input.page,
    pageSize: input.pageSize,
  };
}

/* -------------------------------- detail ---------------------------------- */

export async function getStocktake(input: {
  businessId: string;
  id: string;
  page: number;
  pageSize: number;
}) {
  const header = await loadStocktake(db, input.businessId, input.id);
  // §36 — summary over ALL lines (aggregate-light select, §66).
  const [summaryRows, lineRows, lineTotal] = await Promise.all([
    db.inventoryStocktakeLine.findMany({
      where: { stocktakeId: header.id },
      select: { countedAt: true, varianceQty: true },
    }),
    db.inventoryStocktakeLine.findMany({
      where: { stocktakeId: header.id },
      orderBy: [{ countedAt: "asc" }, { id: "asc" }], // deterministic ordering
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      select: {
        id: true,
        productId: true,
        productNameAtCount: true,
        skuAtCount: true,
        unitAtCount: true,
        systemQtyAtCount: true,
        countedQty: true,
        varianceQty: true,
        countedAt: true,
        countedByUser: { select: { id: true, name: true, email: true } },
        // Current-product join: display fallback for UNCOUNTED preparation
        // lines (their snapshot is still the empty placeholder). Counted
        // lines always render their historical snapshot (dto decides).
        product: { select: { name: true, sku: true, unit: true, stockQty: true } },
      },
    }),
    db.inventoryStocktakeLine.count({ where: { stocktakeId: header.id } }),
  ]);

  return stocktakeDetailDto({
    ...header,
    createdByUser: await db.user.findUnique({
      where: { id: header.createdByUserId },
      select: { id: true, name: true, email: true },
    }),
    summary: computeStocktakeSummary(summaryRows),
    lines: lineRows,
    linesPage: { page: input.page, pageSize: input.pageSize, total: lineTotal },
  });
}

/* ------------------------------- add line --------------------------------- */

export async function addStocktakeLine(input: {
  businessId: string;
  userId: string;
  stocktakeId: string;
  productId: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  const cap = stocktakeLineCap(process.env.INVENTORY_STOCKTAKE_MAX_LINES);
  return db.$transaction(async (tx) => {
    const stocktake = await loadStocktake(tx, input.businessId, input.stocktakeId);
    if (stocktake.status !== "DRAFT") {
      // §27 — DRAFT-only line preparation.
      throw new ApiError(
        422,
        STOCKTAKE_ERROR_CODES.INVALID_TRANSITION,
        "Products can only be added while the stocktake is a draft.",
      );
    }
    const lineCount = await tx.inventoryStocktakeLine.count({
      where: { stocktakeId: stocktake.id },
    });
    if (lineCount >= cap) {
      // §61 — bounded transaction sizes; surfaced to the UI (lines/max).
      throw new ApiError(
        422,
        STOCKTAKE_ERROR_CODES.LINE_LIMIT,
        `Stocktake line limit reached (${cap}).`,
      );
    }
    // §20/§21/§56/§57 — same business, not deleted, active. Foreign/deleted
    // product → 404 (no existence leakage); inactive → documented 422.
    const product = await tx.product.findFirst({
      where: { id: input.productId, businessId: input.businessId },
      select: { id: true, deletedAt: true, isActive: true },
    });
    if (!product || product.deletedAt) {
      throw new ApiError(404, "NOT_FOUND", "Product not found.");
    }
    if (!product.isActive) {
      throw new ApiError(
        422,
        STOCKTAKE_ERROR_CODES.PRODUCT_INACTIVE,
        "Inactive products cannot be added to a stocktake.",
      );
    }
    try {
      const line = await tx.inventoryStocktakeLine.create({
        data: {
          stocktakeId: stocktake.id,
          productId: product.id,
          // Line is PREPARATION data until counted (§29) — zero placeholders.
          systemQtyAtCount: 0,
          countedQty: 0,
          varianceQty: 0,
          countedAt: new Date(0),
          countedByUserId: input.userId,
          productNameAtCount: "",
          skuAtCount: null,
          unitAtCount: null,
        },
        select: { id: true, productId: true },
      });
      await audit(
        auditInput(input.businessId, input.userId, "inventory.stocktake.line_add", stocktake.id, stocktake.reference, {
          lineId: line.id,
          productId: product.id,
        }),
        tx,
      );
      return line;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        // §28/§48 — DB uniqueness is the final protection.
        throw new ApiError(
          409,
          STOCKTAKE_ERROR_CODES.DUPLICATE_PRODUCT,
          "This product is already in the stocktake.",
        );
      }
      throw error;
    }
  });
}

/* ------------------------------ remove line ------------------------------- */

export async function removeStocktakeLine(input: {
  businessId: string;
  userId: string;
  stocktakeId: string;
  lineId: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return db.$transaction(async (tx) => {
    const stocktake = await loadStocktake(tx, input.businessId, input.stocktakeId);
    if (stocktake.status !== "DRAFT") {
      throw new ApiError(
        422,
        STOCKTAKE_ERROR_CODES.INVALID_TRANSITION,
        "Lines can only be removed while the stocktake is a draft.",
      );
    }
    const line = await tx.inventoryStocktakeLine.findFirst({
      where: { id: input.lineId, stocktakeId: stocktake.id },
      select: { id: true, productId: true },
    });
    if (!line) throw new ApiError(404, "NOT_FOUND", "Stocktake line not found.");
    await tx.inventoryStocktakeLine.delete({ where: { id: line.id } });
    await audit(
      auditInput(input.businessId, input.userId, "inventory.stocktake.line_remove", stocktake.id, stocktake.reference, {
        lineId: line.id,
        productId: line.productId,
      }),
      tx,
    );
    return { id: line.id };
  });
}

/* --------------------------------- count ---------------------------------- */

export async function countStocktakeLine(input: {
  businessId: string;
  userId: string;
  stocktakeId: string;
  lineId: string;
  countedQty: number;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return db.$transaction(async (tx) => {
    // §30 — load stocktake → verify status (COUNTING|REVIEW, §31) → verify
    // line → verify product tenant/active → read current stock → snapshot.
    const stocktake = await loadStocktake(tx, input.businessId, input.stocktakeId);
    if (stocktake.status !== "COUNTING" && stocktake.status !== "REVIEW") {
      throw new ApiError(
        422,
        STOCKTAKE_ERROR_CODES.INVALID_TRANSITION,
        "Counting is only possible while the stocktake is counting or in review.",
      );
    }
    const line = await tx.inventoryStocktakeLine.findFirst({
      where: { id: input.lineId, stocktakeId: stocktake.id },
      select: {
        id: true,
        productId: true,
        countedAt: true,
        systemQtyAtCount: true,
        countedQty: true,
        varianceQty: true,
      },
    });
    if (!line) throw new ApiError(404, "NOT_FOUND", "Stocktake line not found.");

    // §15 — server reads the CURRENT stock; client never supplies it.
    const product = await tx.product.findFirst({
      where: { id: line.productId, businessId: input.businessId },
      select: { id: true, name: true, sku: true, unit: true, stockQty: true, deletedAt: true, isActive: true },
    });
    if (!product || product.deletedAt) {
      throw new ApiError(404, "NOT_FOUND", "Product not found.");
    }
    if (!product.isActive) {
      throw new ApiError(
        422,
        STOCKTAKE_ERROR_CODES.PRODUCT_INACTIVE,
        "Inactive products cannot be counted.",
      );
    }

    const systemQtyAtCount = product.stockQty; // §15 snapshot at count time
    const varianceQty = computeVarianceQty(input.countedQty, systemQtyAtCount); // §16/§18
    const now = new Date();
    const isRecount = line.countedAt !== null && line.countedAt.getTime() !== 0;

    const updated = await tx.inventoryStocktakeLine.update({
      where: { id: line.id },
      data: {
        systemQtyAtCount,
        countedQty: input.countedQty,
        varianceQty,
        countedAt: now, // §30 step 14
        countedByUserId: input.userId, // last successful count is authoritative (§47)
        productNameAtCount: product.name, // §19 metadata snapshot
        skuAtCount: product.sku,
        unitAtCount: product.unit,
      },
      select: { id: true, productId: true, systemQtyAtCount: true, countedQty: true, varianceQty: true },
    });

    if (isRecount) {
      // §32/§33 — replace in place; audit the safe before/after metadata.
      await audit(
        auditInput(
          input.businessId,
          input.userId,
          "inventory.stocktake.recount",
          stocktake.id,
          stocktake.reference,
          {
            lineId: line.id,
            productId: line.productId,
            newSystemQty: updated.systemQtyAtCount,
            newCountedQty: updated.countedQty,
            newVariance: updated.varianceQty,
          },
          {
            previousSystemQty: line.systemQtyAtCount,
            previousCountedQty: line.countedQty,
            previousVariance: line.varianceQty,
          },
        ),
        tx,
      );
    } else {
      await audit(
        auditInput(input.businessId, input.userId, "inventory.stocktake.count", stocktake.id, stocktake.reference, {
          lineId: line.id,
          productId: line.productId,
          systemQtyAtCount: updated.systemQtyAtCount,
          countedQty: updated.countedQty,
          variance: updated.varianceQty,
        }),
        tx,
      );
    }
    return updated;
  });
}

/* -------------------------- lifecycle transitions ------------------------- */

export async function startStocktake(input: {
  businessId: string;
  userId: string;
  stocktakeId: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return db.$transaction(async (tx) => {
    const stocktake = await loadStocktake(tx, input.businessId, input.stocktakeId);
    assertTransition(stocktake.status, "COUNTING"); // §8/§34 — DRAFT only
    const lineCount = await tx.inventoryStocktakeLine.count({
      where: { stocktakeId: stocktake.id },
    });
    if (lineCount < 1) {
      throw new ApiError(422, STOCKTAKE_ERROR_CODES.INVALID_TRANSITION, "Add at least one product before starting.");
    }
    const updated = await tx.inventoryStocktake.update({
      where: { id: stocktake.id },
      data: { status: "COUNTING", startedAt: new Date() },
      select: { id: true, status: true, startedAt: true },
    });
    await audit(
      auditInput(input.businessId, input.userId, "inventory.stocktake.start", stocktake.id, stocktake.reference, {
        status: "COUNTING",
        lineCount,
      }),
      tx,
    );
    return updated;
  });
}

export async function reopenStocktake(input: {
  businessId: string;
  userId: string;
  stocktakeId: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return db.$transaction(async (tx) => {
    const stocktake = await loadStocktake(tx, input.businessId, input.stocktakeId);
    assertTransition(stocktake.status, "COUNTING"); // §8 — REVIEW → COUNTING
    const updated = await tx.inventoryStocktake.update({
      where: { id: stocktake.id },
      data: { status: "COUNTING", reviewedAt: null },
      select: { id: true, status: true },
    });
    await audit(
      auditInput(input.businessId, input.userId, "inventory.stocktake.reopen", stocktake.id, stocktake.reference, {
        status: "COUNTING",
      }),
      tx,
    );
    return updated;
  });
}

export async function reviewStocktake(input: {
  businessId: string;
  userId: string;
  stocktakeId: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return db.$transaction(async (tx) => {
    const stocktake = await loadStocktake(tx, input.businessId, input.stocktakeId);
    assertTransition(stocktake.status, "REVIEW"); // §35 — COUNTING only
    const lines = await tx.inventoryStocktakeLine.findMany({
      where: { stocktakeId: stocktake.id },
      select: { countedAt: true },
    });
    if (lines.length === 0 || lines.some((l) => l.countedAt === null || l.countedAt.getTime() === 0)) {
      // §35 — every line must be counted before review.
      throw new ApiError(
        422,
        STOCKTAKE_ERROR_CODES.INVALID_TRANSITION,
        "Count every product before sending the stocktake to review.",
      );
    }
    const updated = await tx.inventoryStocktake.update({
      where: { id: stocktake.id },
      data: { status: "REVIEW", reviewedAt: new Date() },
      select: { id: true, status: true, reviewedAt: true },
    });
    await audit(
      auditInput(input.businessId, input.userId, "inventory.stocktake.review", stocktake.id, stocktake.reference, {
        status: "REVIEW",
        lineCount: lines.length,
      }),
      tx,
    );
    return updated;
  });
}

/* ------------------------------- finalize --------------------------------- */

export async function finalizeStocktake(input: {
  businessId: string;
  userId: string;
  stocktakeId: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return db.$transaction(async (tx) => {
    // §39 — ONE transaction: verify → stale-check → reconcile → finalize.
    const stocktake = await loadStocktake(tx, input.businessId, input.stocktakeId);
    assertTransition(stocktake.status, "FINALIZED"); // §38 — REVIEW only

    const lines = await tx.inventoryStocktakeLine.findMany({
      where: { stocktakeId: stocktake.id },
      select: {
        id: true,
        productId: true,
        systemQtyAtCount: true,
        countedQty: true,
        varianceQty: true,
        countedAt: true,
        productNameAtCount: true,
      },
    });
    if (lines.length === 0 || lines.some((l) => l.countedAt === null || l.countedAt.getTime() === 0)) {
      throw new ApiError(
        422,
        STOCKTAKE_ERROR_CODES.INVALID_TRANSITION,
        "Every product must be counted before finalization.",
      );
    }

    // §40 stale check — every product's CURRENT stockQty must still equal
    // systemQtyAtCount, and the product must still be active + not deleted
    // (§57/§58). No auto-rebase (§41). Collect ALL stale/invalid lines so the
    // client can recount each one (§139 — current-business products only).
    const stale: Array<{
      lineId: string;
      productId: string;
      productName: string;
      systemQtyAtCount: number;
      currentQty: number;
      kind: "STALE" | "INACTIVE" | "DELETED";
    }> = [];
    const products = await tx.product.findMany({
      where: { id: { in: lines.map((l) => l.productId) }, businessId: input.businessId },
      select: { id: true, stockQty: true, deletedAt: true, isActive: true },
    });
    const productById = new Map(products.map((p) => [p.id, p]));
    for (const line of lines) {
      const product = productById.get(line.productId);
      if (!product || product.deletedAt) {
        stale.push({
          lineId: line.id,
          productId: line.productId,
          productName: line.productNameAtCount,
          systemQtyAtCount: line.systemQtyAtCount,
          currentQty: product?.stockQty ?? line.systemQtyAtCount,
          kind: "DELETED",
        });
        continue;
      }
      if (!product.isActive) {
        stale.push({
          lineId: line.id,
          productId: line.productId,
          productName: line.productNameAtCount,
          systemQtyAtCount: line.systemQtyAtCount,
          currentQty: product.stockQty,
          kind: "INACTIVE",
        });
        continue;
      }
      if (product.stockQty !== line.systemQtyAtCount) {
        stale.push({
          lineId: line.id,
          productId: line.productId,
          productName: line.productNameAtCount,
          systemQtyAtCount: line.systemQtyAtCount,
          currentQty: product.stockQty,
          kind: "STALE",
        });
      }
    }
    if (stale.length > 0) {
      const hasInactive = stale.some((s) => s.kind === "INACTIVE");
      const hasDeleted = stale.some((s) => s.kind === "DELETED");
      throw new ApiError(
        409,
        hasInactive
          ? STOCKTAKE_ERROR_CODES.PRODUCT_INACTIVE
          : hasDeleted
            ? STOCKTAKE_ERROR_CODES.STALE_COUNT
            : STOCKTAKE_ERROR_CODES.STALE_COUNT,
        "Inventory changed after counting. Recount the affected product(s).",
        { products: stale }, // §139 — affected current-business products only
      );
    }

    // §43/§44 — reconcile through the EXISTING InventoryAdjustment semantics.
    let adjustedLineCount = 0;
    for (const line of lines) {
      if (line.varianceQty === 0) continue; // §44 — zero variance: no adjustment
      const adjustment = await tx.inventoryAdjustment.create({
        data: {
          businessId: input.businessId,
          productId: line.productId,
          delta: line.varianceQty, // signed — §18
          reason: ADJUSTMENT_REASON(stocktake.reference),
          actorId: input.userId,
        },
        select: { id: true },
      });
      await tx.product.update({
        where: { id: line.productId },
        data: { stockQty: line.countedQty }, // §45 — stock becomes the counted value
      });
      adjustedLineCount += 1;
      // §72/§73 — the InventoryAdjustment row itself carries the quantity
      // history; no duplicate per-line audit event here. The finalize audit
      // below records the workflow-level change once.
      void adjustment;
    }

    const updated = await tx.inventoryStocktake.update({
      where: { id: stocktake.id },
      data: { status: "FINALIZED", finalizedAt: new Date() },
      select: { id: true, status: true, finalizedAt: true },
    });

    // §69/§73 — ONE finalize audit for the workflow; InventoryAdjustment rows
    // are the quantity-level history. Safe metadata only (§70/§140).
    await audit(
      auditInput(input.businessId, input.userId, "inventory.stocktake.finalize", stocktake.id, stocktake.reference, {
        status: "FINALIZED",
        lineCount: lines.length,
        adjustedLineCount,
      }),
      tx,
    );
    return { ...updated, adjustedLineCount };
  });
}

/* --------------------------------- cancel --------------------------------- */

export async function cancelStocktake(input: {
  businessId: string;
  userId: string;
  stocktakeId: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return db.$transaction(async (tx) => {
    const stocktake = await loadStocktake(tx, input.businessId, input.stocktakeId);
    assertTransition(stocktake.status, "CANCELLED"); // §49 — DRAFT|COUNTING|REVIEW
    const updated = await tx.inventoryStocktake.update({
      where: { id: stocktake.id },
      data: { status: "CANCELLED", canceledAt: new Date() },
      select: { id: true, status: true, canceledAt: true },
    });
    await audit(
      auditInput(input.businessId, input.userId, "inventory.stocktake.cancel", stocktake.id, stocktake.reference, {
        status: "CANCELLED",
        previousStatus: stocktake.status,
      }),
      tx,
    );
    return updated;
  });
}

/* ---------------------------- DRAFT-only edit ----------------------------- */

export async function updateStocktake(input: {
  businessId: string;
  userId: string;
  stocktakeId: string;
  reference?: string;
  notes?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return db.$transaction(async (tx) => {
    const stocktake = await loadStocktake(tx, input.businessId, input.stocktakeId);
    // §50/§52 — reference/notes are editable ONLY while DRAFT.
    if (stocktake.status !== "DRAFT") {
      throw new ApiError(
        422,
        STOCKTAKE_ERROR_CODES.INVALID_TRANSITION,
        "Only draft stocktakes can be edited.",
      );
    }
    try {
      const updated = await tx.inventoryStocktake.update({
        where: { id: stocktake.id },
        data: {
          ...(input.reference !== undefined ? { reference: input.reference } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
        },
        select: { id: true, reference: true, notes: true },
      });
      await audit(
        auditInput(
          input.businessId,
          input.userId,
          "inventory.stocktake.edit",
          stocktake.id,
          updated.reference,
          { status: stocktake.status },
          { reference: stocktake.reference }, // §70 — never the notes content
        ),
        tx,
      );
      return updated;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ApiError(409, "DUPLICATE_REFERENCE", "A stocktake with this reference already exists.");
      }
      throw error;
    }
  });
}
