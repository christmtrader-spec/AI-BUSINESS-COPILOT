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
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api-helpers";
import {
  PURCHASE_ORDER_ERROR_CODES,
  PURCHASE_ORDER_TRANSITION_TARGET,
  canTransitionPurchaseOrder,
  computePurchaseOrderTotal,
  generatePurchaseOrderReference,
  isPurchaseOrderStatus,
  purchaseOrderLineCap,
  type PurchaseOrderStatus,
} from "./types";
import {
  purchaseOrderDetailDto,
  purchaseOrderLineDto,
  purchaseOrderListItemDto,
} from "./dto";

type Tx = Prisma.TransactionClient;

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
  return { ...row, status: isPurchaseOrderStatus(row.status) ? row.status : "DRAFT" };
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

  return db.$transaction(async (tx) => {
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
        // §51/§206 — bounded line slice feeds the aggregates without a
        // second query (same P40 list precedent; bounded by the line cap).
        lines: { select: { orderedQty: true, unitPriceMinor: true } },
        _count: { select: { lines: true } },
      },
    }),
    db.purchaseOrder.count({ where }),
  ]);

  return {
    items: rows.map((row) =>
      purchaseOrderListItemDto({
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
      }),
    ),
    total,
    page: input.page,
    pageSize: input.pageSize,
  };
}

/* -------------------------------- detail ---------------------------------- */

export async function getPurchaseOrder(input: { businessId: string; id: string }) {
  const cap = purchaseOrderLineCap(process.env.PURCHASE_ORDER_MAX_LINES);
  const header = await db.$transaction(async (tx) => loadOrderHeader(tx, input.businessId, input.id));

  const [supplier, creator, lineRows] = await Promise.all([
    db.supplier.findUnique({
      where: { id: header.supplierId },
      select: { name: true, deletedAt: true },
    }),
    db.user.findUnique({
      where: { id: header.createdByUserId },
      select: { id: true, name: true },
    }),
    // §158 — ALL lines (the order is hard-capped); cap+1 proves completeness.
    db.purchaseOrderLine.findMany({
      where: { purchaseOrderId: header.id },
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

  if (lineRows.length > cap) {
    // Defensive: the write path prevents this; never render a partial document.
    throw new ApiError(500, "INTERNAL_ERROR", "Purchase order line cap invariant violated.");
  }

  return purchaseOrderDetailDto(
    {
      ...header,
      // §11 — live name ONLY as a navigation aid; display identity is the
      // snapshot. A soft-deleted supplier renders as "no longer listed".
      supplierName: supplier && supplier.deletedAt === null ? supplier.name : null,
      createdByName: creator?.name ?? null,
    },
    lineRows,
  );
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
  return db.$transaction(async (tx) => {
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
  return db.$transaction(async (tx) => {
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
        select: { id: true, orderedQty: true, unitPriceMinor: true },
      });

      // §58 step 10 — audit inside the same transaction.
      await audit(
        auditInput(input.businessId, input.userId, "purchase_order.line_add", header.id, header.reference, {
          lineId: line.id,
          productId: product.id,
          productNameAtOrder: product.name,
          orderedQty: line.orderedQty,
          unitPriceMinor: line.unitPriceMinor,
          lineCount: lineCount + 1,
        }),
        tx,
      );

      // §32 — the resulting document total must remain a safe integer.
      const lines = await tx.purchaseOrderLine.findMany({
        where: { purchaseOrderId: header.id },
        select: { orderedQty: true, unitPriceMinor: true },
      });
      assertSafeTotal(lines);

      return purchaseOrderLineDto({
        ...line,
        productId: product.id,
        productNameAtOrder: product.name,
        skuAtOrder: product.sku,
        unitAtOrder: product.unit,
        createdAt: new Date(),
        updatedAt: new Date(),
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
  return db.$transaction(async (tx) => {
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

    const updated = await tx.purchaseOrderLine.update({
      where: { id: line.id },
      data,
      select: { id: true, orderedQty: true, unitPriceMinor: true },
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

    return purchaseOrderLineDto({
      ...updated,
      productId: line.productId,
      productNameAtOrder: "",
      skuAtOrder: null,
      unitAtOrder: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
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
  return db.$transaction(async (tx) => {
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

  return db.$transaction(async (tx) => {
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
