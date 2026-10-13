import "server-only";

/**
 * Prompt 48 — supplier-bill service (server-only).
 *
 * LAWS:
 *  - NO-DUPLICATE-PAYABLE (P48 §2): posting creates EXACTLY ONE linked
 *    Expense inside the SAME transaction (§11). A DRAFT/CANCELLED bill has
 *    NO Expense. The @unique expenseId constraint is the database-level
 *    guarantee; the in-transaction reload + status re-check is the first.
 *  - THREE-WAY QUANTITY MATCHING (§7): billed ≤ received(POSTED receipts)
 *    − returned(POSTED returns) − previouslyBilled(POSTED bills), computed
 *    by DB aggregates and the ONE pure law in ./types. Corrupted history is
 *    surfaced (500), never clamped. The posting transaction is the FINAL
 *    authority; draft-time checks are advisory only (§7).
 *  - POSTING TOUCHES NOTHING ELSE (§11): no stock, no InventoryAdjustment,
 *    no receipt/return, no PO quantity, no Payment, no Sale, no receivable.
 *    The ONLY new financial row is the linked Expense payable.
 *  - POSTED IS IMMUTABLE (§10): no edit, no cancel, no re-post in this
 *    phase. CANCELLED is terminal. No generic status PATCH.
 *  - Every query is tenant-scoped by ctx.businessId — never client input.
 *    Foreign PO/PO-line/bill → 404, no existence leak.
 *  - Snapshots are frozen at write time from ALREADY-FROZEN PO data and
 *    NEVER overwritten from live rows (§5/§6).
 *  - Money is exact integer minor units via BigInt math (§8/§9); totals are
 *    ALWAYS server-derived; client totals are structurally rejected.
 *  - internalNotes NEVER enter audit bodies, search, or exports (§16).
 *  - Every mutation writes its audit INSIDE the same transaction (P48 §21);
 *    the posting audit uses the STRICT variant so an audit failure rolls
 *    back the payable-creating transition (§14-F / audit.ts auditStrict).
 */
import { randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { withWriteTransaction } from "@/lib/db/write-transaction";
import { audit, auditStrict } from "@/lib/audit";
import { ApiError } from "@/lib/api-helpers";
import {
  SUPPLIER_BILL_ERROR_CODES as CODES,
  computeAvailableBillableQty,
  computeBillLineTotalMinor,
  computeSupplierBillTotals,
  calendarDateToUtcMidnoon,
  generateSupplierBillReference,
  isValidBillUnitPriceMinor,
  isValidBilledQty,
  parseSupplierBillStatus,
  purchaseOrderIsBillable,
  supplierBillLineCap,
  type SupplierBillStatus,
} from "./types";
import {
  mapSupplierBillDetail,
  mapSupplierBillLine,
  mapSupplierBillListItem,
  type SupplierBillDetailDto,
  type SupplierBillLineDto,
  type SupplierBillListItemDto,
  type SupplierBillPayableDto,
  type SupplierBillPaymentDto,
} from "./dto";

type Tx = Prisma.TransactionClient;
const withWriteTx = withWriteTransaction;

/**
 * Structural aggregate client — BOTH PrismaClient and TransactionClient
 * satisfy it, so the matching helpers work identically inside posting
 * transactions and on read-only summary paths.
 */
type AggregateClient = {
  goodsReceiptLine: { aggregate: typeof db.goodsReceiptLine.aggregate };
  goodsReturnLine: { aggregate: typeof db.goodsReturnLine.aggregate };
  supplierBillLine: { aggregate: typeof db.supplierBillLine.aggregate };
};

/** Bounded payments list per linked payable (P34 §85 convention). */
const PAYMENTS_TAKE = 20;

/* ---------------------------- pure error mapping --------------------------- */

/**
 * THE ONE mapper from pure domain failures to controlled HTTP results:
 *  - corrupted persisted status → 500 INVALID_PERSISTED_STATUS (never Draft)
 *  - inconsistent matching history → 500 CORRUPT_HISTORY (never clamped)
 *  - exact-math overflow → 422 PRICE/TOTAL_OVERFLOW (never silent rounding)
 * Exported for the PO detail route so corrupted aggregates surface the SAME
 * stable codes there.
 */
export function mapPureSupplierBillDomainError(error: unknown): never {
  if (error instanceof Error && error.name === "SupplierBillStatusIntegrityError") {
    throw new ApiError(
      500,
      CODES.INVALID_PERSISTED_STATUS,
      "Supplier bill data is in an invalid state. Please contact support.",
    );
  }
  if (error instanceof Error && error.name === "SupplierBillMatchingIntegrityError") {
    throw new ApiError(
      500,
      CODES.CORRUPT_HISTORY,
      "Procurement or billing history is inconsistent. Please contact support.",
    );
  }
  if (error instanceof Error) {
    if (error.message === "SUPPLIER_BILL_PRICE_OVERFLOW") {
      throw new ApiError(422, CODES.PRICE_OVERFLOW, "Line amount exceeds the safe integer range.");
    }
    if (error.message === "SUPPLIER_BILL_TOTAL_OVERFLOW") {
      throw new ApiError(422, CODES.TOTAL_OVERFLOW, "Bill total exceeds the safe integer range.");
    }
    if (error.message === "SUPPLIER_BILL_INVALID_DISCOUNT") {
      throw new ApiError(
        422,
        CODES.INVALID_DISCOUNT,
        "Discount must be a non-negative amount not greater than the subtotal.",
      );
    }
  }
  throw error;
}

/** Corrupted persisted status → controlled 500 (never Draft). */
function parseDbStatus(value: string): SupplierBillStatus {
  try {
    return parseSupplierBillStatus(value);
  } catch (error) {
    mapPureSupplierBillDomainError(error);
  }
}

/* ------------------------------- internals -------------------------------- */

function requireDraft(status: SupplierBillStatus): void {
  if (status !== "DRAFT") {
    // §10 — POSTED is immutable; CANCELLED is terminal.
    throw new ApiError(409, CODES.IMMUTABLE, "Only DRAFT supplier bills can be changed.");
  }
}

function assertTransition(from: SupplierBillStatus, to: SupplierBillStatus): void {
  const allowed = from === "DRAFT" && (to === "POSTED" || to === "CANCELLED");
  if (!allowed) {
    if (from === "POSTED" && to === "POSTED") {
      // §14-I — a repeated post after success is the ONE documented
      // stable conflict, not a generic transition error.
      throw new ApiError(409, CODES.ALREADY_POSTED, "This supplier bill has already been posted.");
    }
    throw new ApiError(
      409,
      CODES.INVALID_TRANSITION,
      `Cannot move a supplier bill from ${from} to ${to}.`,
    );
  }
}

function assertPurchaseOrderBillable(status: string): void {
  if (!purchaseOrderIsBillable(status)) {
    throw new ApiError(
      422,
      CODES.PO_NOT_BILLABLE,
      "Supplier bills can be recorded only against a confirmed or closed purchase order.",
    );
  }
}

/** The ONE read-cap invariant failure (cap+1 fetch must never return cap+1). */
function assertLineCapInvariant(actualLines: number, cap: number): void {
  if (actualLines > cap) {
    throw new ApiError(
      500,
      CODES.LINE_CAP_INVARIANT,
      "Stored document data exceeds its configured line cap. Please contact support.",
    );
  }
}

async function assertLineCap(tx: Tx, supplierBillId: string, cap: number): Promise<number> {
  const count = await tx.supplierBillLine.count({ where: { supplierBillId } });
  if (count >= cap) {
    throw new ApiError(422, CODES.LINE_LIMIT, "This bill has reached its line limit.");
  }
  return count;
}

/**
 * Map a Prisma unique-violation to its ONE stable controlled code. Order
 * matters: the composite invoice-reference index name CONTAINS the plain
 * "reference" substring, so it is tested first.
 */
function mapUniqueViolation(error: unknown): ApiError | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    const meta = error.meta as { target?: unknown } | undefined;
    const target = Array.isArray(meta?.target)
      ? (meta.target as string[]).join(",")
      : String(meta?.target ?? "");
    if (target.includes("supplierInvoiceReference")) {
      return new ApiError(
        409,
        CODES.DUPLICATE_INVOICE_REFERENCE,
        "This supplier already has a bill with this invoice reference.",
      );
    }
    if (target.includes("purchaseOrderLineId")) {
      return new ApiError(
        409,
        CODES.DUPLICATE_PO_LINE,
        "Each purchase order line can appear at most once on a bill.",
      );
    }
    if (target.includes("expenseId")) {
      return new ApiError(
        409,
        CODES.ALREADY_LINKED,
        "This payable is already linked to a supplier bill.",
      );
    }
    if (target.includes("reference")) {
      return new ApiError(409, CODES.DUPLICATE_REFERENCE, "This bill reference is already in use.");
    }
  }
  return null;
}

async function loadBillHeader(
  tx: Tx,
  businessId: string,
  id: string,
): Promise<{
  id: string;
  reference: string;
  status: SupplierBillStatus;
  supplierId: string;
  purchaseOrderId: string;
  purchaseOrderReferenceAtBill: string;
  supplierNameAtBill: string;
  supplierInvoiceReference: string | null;
  currencyCodeAtBill: string;
  currencySymbolAtBill: string;
  decimalPrecisionAtBill: number;
  billDate: Date;
  dueDate: Date | null;
  discountMinor: number;
  subtotalMinor: number;
  totalMinor: number;
  internalNotes: string | null;
  expenseId: string | null;
  postedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}> {
  const row = await tx.supplierBill.findFirst({
    where: { id, businessId }, // tenant scope from auth context only
    select: {
      id: true,
      reference: true,
      status: true,
      supplierId: true,
      purchaseOrderId: true,
      purchaseOrderReferenceAtBill: true,
      supplierNameAtBill: true,
      supplierInvoiceReference: true,
      currencyCodeAtBill: true,
      currencySymbolAtBill: true,
      decimalPrecisionAtBill: true,
      billDate: true,
      dueDate: true,
      discountMinor: true,
      subtotalMinor: true,
      totalMinor: true,
      internalNotes: true,
      expenseId: true,
      postedAt: true,
      cancelledAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!row) throw new ApiError(404, CODES.NOT_FOUND, "Supplier bill not found.");
  return { ...row, status: parseDbStatus(row.status) };
}

function auditInput(
  businessId: string,
  userId: string,
  action: string,
  entityId: string,
  reference: string,
  after: Record<string, unknown>,
) {
  return {
    businessId,
    actorId: userId,
    action,
    entityType: "SupplierBill",
    entityId,
    after: { reference, ...after }, // NO internalNotes, NO bodies (§21)
  };
}

/* --------------------- §7 three-way matching aggregates -------------------- */

/** received = SUM(POSTED GoodsReceiptLine.receivedQty) for the PO line. */
async function sumPostedReceivedQty(tx: AggregateClient, purchaseOrderLineId: string): Promise<number> {
  const agg = await tx.goodsReceiptLine.aggregate({
    where: { purchaseOrderLineId, goodsReceipt: { status: "POSTED" } },
    _sum: { receivedQty: true },
  });
  return agg._sum.receivedQty ?? 0;
}

/** returned = SUM(POSTED GoodsReturnLine.returnedQty) for the PO line. */
async function sumPostedReturnedQty(tx: AggregateClient, purchaseOrderLineId: string): Promise<number> {
  const agg = await tx.goodsReturnLine.aggregate({
    where: {
      goodsReceiptLine: { purchaseOrderLineId },
      goodsReturn: { status: "POSTED" },
    },
    _sum: { returnedQty: true },
  });
  return agg._sum.returnedQty ?? 0;
}

/** billed = SUM(POSTED SupplierBillLine.billedQty), optionally excluding one bill. */
async function sumPostedBilledQty(
  tx: AggregateClient,
  purchaseOrderLineId: string,
  excludeBillId?: string,
): Promise<number> {
  const agg = await tx.supplierBillLine.aggregate({
    where: {
      purchaseOrderLineId,
      supplierBill: {
        status: "POSTED",
        ...(excludeBillId ? { id: { not: excludeBillId } } : {}),
      },
    },
    _sum: { billedQty: true },
  });
  return agg._sum.billedQty ?? 0;
}

/**
 * THE ONE canonical billable-quantity read for a PO line: DB aggregates +
 * the pure law. Returns the full matching breakdown for display AND the
 * authoritative availability check.
 */
async function computeBillableForPoLine(
  tx: AggregateClient,
  poLine: { id: string; orderedQty: number },
  excludeBillId?: string,
): Promise<{
  orderedQty: number;
  receivedQty: number;
  returnedQty: number;
  previouslyBilledQty: number;
  availableQty: number;
}> {
  const [receivedQty, returnedQty, previouslyBilledQty] = await Promise.all([
    sumPostedReceivedQty(tx, poLine.id),
    sumPostedReturnedQty(tx, poLine.id),
    sumPostedBilledQty(tx, poLine.id, excludeBillId),
  ]);
  let availableQty: number;
  try {
    availableQty = computeAvailableBillableQty({
      orderedQty: poLine.orderedQty,
      receivedQty,
      returnedQty,
      previouslyBilledQty,
    });
  } catch (error) {
    mapPureSupplierBillDomainError(error); // stable CORRUPT_HISTORY 500, never clamped
  }
  return { orderedQty: poLine.orderedQty, receivedQty, returnedQty, previouslyBilledQty, availableQty };
}

/** §7 precision: over-received vs over-returned vs plain over-bill. */
function assertQtyWithinAvailability(
  billedQty: number,
  match: { receivedQty: number; returnedQty: number; previouslyBilledQty: number; availableQty: number },
): void {
  if (billedQty > match.receivedQty) {
    throw new ApiError(
      422,
      CODES.QUANTITY_EXCEEDS_RECEIVED,
      `Only ${match.receivedQty} unit(s) of this line have been received.`,
      { availableQty: match.availableQty },
    );
  }
  if (billedQty > match.availableQty) {
    if (match.previouslyBilledQty === 0 && match.returnedQty > 0) {
      throw new ApiError(
        422,
        CODES.RETURNED_QUANTITY,
        `${match.returnedQty} unit(s) of this line were returned to the supplier and cannot be invoiced.`,
        { availableQty: match.availableQty },
      );
    }
    throw new ApiError(
      422,
      CODES.QUANTITY_EXCEEDS_AVAILABLE,
      `Only ${match.availableQty} unit(s) remain available to invoice on this line.`,
      {
        availableQty: match.availableQty,
        receivedQty: match.receivedQty,
        returnedQty: match.returnedQty,
        previouslyBilledQty: match.previouslyBilledQty,
      },
    );
  }
}

/* ------------------------------ totals recompute --------------------------- */

/** Recompute + persist the bill's canonical totals from its current lines. */
async function recomputeBillTotals(
  tx: Tx,
  billId: string,
  discountMinor: number,
): Promise<{ subtotalMinor: number; discountMinor: number; totalMinor: number; lineCount: number }> {
  const lines = await tx.supplierBillLine.findMany({
    where: { supplierBillId: billId },
    select: { lineTotalMinor: true },
  });
  let totals: { subtotalMinor: number; discountMinor: number; totalMinor: number; lineCount: number };
  try {
    totals = computeSupplierBillTotals(lines, discountMinor);
  } catch (error) {
    mapPureSupplierBillDomainError(error);
  }
  await tx.supplierBill.update({
    where: { id: billId },
    data: {
      subtotalMinor: totals.subtotalMinor,
      discountMinor: totals.discountMinor,
      totalMinor: totals.totalMinor,
    },
    select: { id: true },
  });
  return totals;
}

/* -------------------------------- create ---------------------------------- */

export async function createSupplierBill(input: {
  businessId: string;
  userId: string;
  purchaseOrderId: string;
  reference?: string;
  supplierInvoiceReference?: string | null;
  billDate: string; // YYYY-MM-DD (schema-validated calendar date)
  dueDate?: string;
  discountMinor?: number;
  internalNotes?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<SupplierBillDetailDto> {
  const discountMinor = input.discountMinor ?? 0;
  const billDate = calendarDateToUtcMidnoon(input.billDate);
  const dueDate = input.dueDate ? calendarDateToUtcMidnoon(input.dueDate) : null;

  // §5 — the PO is the procurement authority: tenant-scoped, billable
  // status, and its FROZEN supplier/currency snapshots feed the bill.
  const po = await db.purchaseOrder.findFirst({
    where: { id: input.purchaseOrderId, businessId: input.businessId },
    select: {
      id: true,
      reference: true,
      status: true,
      supplierId: true,
      supplierNameAtOrder: true,
      currencyCodeAtOrder: true,
      currencySymbolAtOrder: true,
      decimalPrecisionAtOrder: true,
    },
  });
  if (!po) throw new ApiError(404, "NOT_FOUND", "Purchase order not found.");
  assertPurchaseOrderBillable(po.status);

  // §5 — early invoice-reference duplicate detection (the composite DB
  // constraint stays the concurrency authority).
  if (input.supplierInvoiceReference) {
    const dup = await db.supplierBill.findFirst({
      where: {
        businessId: input.businessId,
        supplierId: po.supplierId,
        supplierInvoiceReference: input.supplierInvoiceReference,
      },
      select: { id: true, reference: true },
    });
    if (dup) {
      throw new ApiError(
        409,
        CODES.DUPLICATE_INVOICE_REFERENCE,
        "This supplier already has a bill with this invoice reference.",
      );
    }
  }

  const billId = await withWriteTx(async (tx) => {
    const now = new Date();
    let reference = input.reference ?? generateSupplierBillReference(now, (max) => randomInt(max));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const bill = await tx.supplierBill.create({
          data: {
            businessId: input.businessId, // server-derived tenant scope
            supplierId: po.supplierId, // derived from the PO (§5)
            purchaseOrderId: po.id,
            reference,
            supplierInvoiceReference: input.supplierInvoiceReference ?? null,
            // Snapshots frozen from the PO's ALREADY-FROZEN columns (§5).
            supplierNameAtBill: po.supplierNameAtOrder,
            purchaseOrderReferenceAtBill: po.reference,
            currencyCodeAtBill: po.currencyCodeAtOrder,
            currencySymbolAtBill: po.currencySymbolAtOrder,
            decimalPrecisionAtBill: po.decimalPrecisionAtOrder,
            status: "DRAFT",
            billDate,
            dueDate,
            discountMinor,
            subtotalMinor: 0,
            totalMinor: 0,
            internalNotes: input.internalNotes ?? null,
            createdByUserId: input.userId, // server-derived creator
          },
          select: { id: true },
        });
        await audit(
          auditInput(input.businessId, input.userId, "supplier_bill.create", bill.id, reference, {
            purchaseOrderId: po.id,
            purchaseOrderReferenceAtBill: po.reference,
            supplierInvoiceReference: input.supplierInvoiceReference ?? null,
            billDate: input.billDate,
            dueDate: input.dueDate ?? null,
            discountMinor,
          }),
          tx,
        );
        return bill.id;
      } catch (error) {
        const mapped = mapUniqueViolation(error);
        if (mapped?.code === CODES.DUPLICATE_REFERENCE && !input.reference) {
          // Generated-reference collision (astronomically unlikely) —
          // regenerate; a USER-provided duplicate is a hard conflict.
          reference = generateSupplierBillReference(new Date(), (max) => randomInt(max));
          continue;
        }
        if (mapped) throw mapped;
        throw error;
      }
    }
    throw new ApiError(409, CODES.DUPLICATE_REFERENCE, "This bill reference is already in use.");
  });

  return getSupplierBill({ businessId: input.businessId, id: billId });
}

/* --------------------------------- list ----------------------------------- */

export async function listSupplierBills(input: {
  businessId: string;
  q?: string;
  supplierId?: string;
  purchaseOrderId?: string;
  status?: SupplierBillStatus;
  billDateFrom?: string;
  billDateTo?: string;
  dueDateFrom?: string;
  dueDateTo?: string;
  page: number;
  pageSize: number;
}): Promise<{ items: SupplierBillListItemDto[]; total: number; page: number; pageSize: number }> {
  const where: Prisma.SupplierBillWhereInput = { businessId: input.businessId };
  if (input.q) {
    where.OR = [
      { reference: { contains: input.q } },
      { supplierInvoiceReference: { contains: input.q } },
      { supplierNameAtBill: { contains: input.q } },
      { purchaseOrderReferenceAtBill: { contains: input.q } },
      { lines: { some: { OR: [{ productNameAtBill: { contains: input.q } }, { skuAtBill: { contains: input.q } }] } } },
    ];
  }
  if (input.supplierId) where.supplierId = input.supplierId;
  if (input.purchaseOrderId) where.purchaseOrderId = input.purchaseOrderId;
  if (input.status) where.status = input.status;
  // Date-only windows: every stored billDate/dueDate is a UTC-midnoon
  // instant, so midnoon-to-midnoon bounds match calendar days exactly.
  const billWindow: Prisma.DateTimeFilter = {};
  if (input.billDateFrom) billWindow.gte = calendarDateToUtcMidnoon(input.billDateFrom);
  if (input.billDateTo) billWindow.lte = calendarDateToUtcMidnoon(input.billDateTo);
  if (Object.keys(billWindow).length > 0) where.billDate = billWindow;
  const dueWindow: Prisma.DateTimeFilter = {};
  if (input.dueDateFrom) dueWindow.gte = calendarDateToUtcMidnoon(input.dueDateFrom);
  if (input.dueDateTo) dueWindow.lte = calendarDateToUtcMidnoon(input.dueDateTo);
  if (Object.keys(dueWindow).length > 0) where.dueDate = dueWindow;

  const [rows, total] = await Promise.all([
    db.supplierBill.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      select: {
        id: true,
        reference: true,
        supplierInvoiceReference: true,
        supplierId: true,
        supplierNameAtBill: true,
        purchaseOrderId: true,
        purchaseOrderReferenceAtBill: true,
        status: true,
        billDate: true,
        dueDate: true,
        currencyCodeAtBill: true,
        currencySymbolAtBill: true,
        decimalPrecisionAtBill: true,
        subtotalMinor: true,
        discountMinor: true,
        totalMinor: true,
        createdAt: true,
        _count: { select: { lines: true } },
        expense: { select: { id: true, amountMinor: true, paidMinor: true, status: true } },
      },
    }),
    db.supplierBill.count({ where }),
  ]);

  return {
    items: rows.map((row) => mapSupplierBillListItem(row)),
    total,
    page: input.page,
    pageSize: input.pageSize,
  };
}

/* --------------------------------- detail --------------------------------- */

const DETAIL_LINE_SELECT = {
  id: true,
  purchaseOrderLineId: true,
  productId: true,
  billedQty: true,
  unitPriceMinor: true,
  lineTotalMinor: true,
  productNameAtBill: true,
  skuAtBill: true,
  unitAtBill: true,
  purchaseOrderUnitPriceMinor: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Bill detail: header + complete lines + LIVE linked payable + payments. */
export async function getSupplierBill(input: {
  businessId: string;
  id: string;
}): Promise<SupplierBillDetailDto> {
  const cap = supplierBillLineCap(process.env.SUPPLIER_BILL_MAX_LINES);
  const header = await db.supplierBill.findFirst({
    where: { id: input.id, businessId: input.businessId }, // tenant scope
    select: {
      id: true,
      reference: true,
      supplierInvoiceReference: true,
      supplierId: true,
      supplierNameAtBill: true,
      purchaseOrderId: true,
      purchaseOrderReferenceAtBill: true,
      status: true,
      billDate: true,
      dueDate: true,
      currencyCodeAtBill: true,
      currencySymbolAtBill: true,
      decimalPrecisionAtBill: true,
      subtotalMinor: true,
      discountMinor: true,
      totalMinor: true,
      internalNotes: true,
      expenseId: true,
      postedAt: true,
      cancelledAt: true,
      createdAt: true,
      updatedAt: true,
      createdByUser: { select: { id: true, name: true, email: true } },
    },
  });
  if (!header) throw new ApiError(404, CODES.NOT_FOUND, "Supplier bill not found.");
  const status = parseDbStatus(header.status);

  // cap+1 proves completeness — an over-cap bill is corruption (§10 read law).
  const lineRows = await db.supplierBillLine.findMany({
    where: { supplierBillId: header.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: cap + 1,
    select: DETAIL_LINE_SELECT,
  });
  assertLineCapInvariant(lineRows.length, cap);
  const lines: SupplierBillLineDto[] = lineRows.map((row) => mapSupplierBillLine(row));

  // §12/§18 — the payable state is ALWAYS read from the live linked
  // Expense (never a copied mutable balance on the bill).
  let payable: SupplierBillPayableDto | null = null;
  let payments: SupplierBillPaymentDto[] = [];
  if (header.status === "POSTED" || header.expenseId) {
    const expense = await db.expense.findFirst({
      where: { id: header.expenseId ?? "", businessId: input.businessId },
      select: {
        id: true,
        amountMinor: true,
        paidMinor: true,
        status: true,
        spentAt: true,
        dueDate: true,
        reference: true,
        category: true,
      },
    });
    if (expense) {
      payable = {
        expenseId: expense.id,
        amountMinor: expense.amountMinor,
        paidMinor: expense.paidMinor,
        outstandingMinor: expense.amountMinor - expense.paidMinor,
        status: expense.status,
        spentAt: expense.spentAt.toISOString(),
        dueDate: expense.dueDate ? expense.dueDate.toISOString() : null,
        reference: expense.reference,
        category: expense.category,
      };
      const paymentRows = await db.payment.findMany({
        where: { businessId: input.businessId, expenseId: expense.id },
        orderBy: [{ paidAt: "desc" }, { id: "desc" }],
        take: PAYMENTS_TAKE,
        select: {
          id: true,
          amountMinor: true,
          method: true,
          paidAt: true,
          note: true,
          actor: { select: { name: true, email: true } },
        },
      });
      payments = paymentRows.map((p) => ({
        id: p.id,
        amountMinor: p.amountMinor,
        method: p.method,
        paidAt: p.paidAt.toISOString(),
        note: p.note,
        actorName: p.actor?.name ?? p.actor?.email ?? null,
      }));
    }
  }

  return mapSupplierBillDetail({ ...header, status }, lines, payable, payments);
}

/* ----------------------------- header patch ------------------------------- */

export async function updateSupplierBill(input: {
  businessId: string;
  userId: string;
  id: string;
  supplierInvoiceReference?: string | null;
  billDate?: string;
  dueDate?: string | null;
  discountMinor?: number;
  internalNotes?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<SupplierBillDetailDto> {
  await withWriteTx(async (tx) => {
    const header = await loadBillHeader(tx, input.businessId, input.id);
    requireDraft(header.status); // §10 — DRAFT-only edit

    const patch: Prisma.SupplierBillUncheckedUpdateInput = {};
    if (input.supplierInvoiceReference !== undefined) {
      const next = input.supplierInvoiceReference;
      if (next) {
        // §5 — early duplicate check (DB constraint is the final authority).
        const dup = await tx.supplierBill.findFirst({
          where: {
            businessId: input.businessId,
            supplierId: header.supplierId,
            supplierInvoiceReference: next,
            id: { not: header.id },
          },
          select: { id: true },
        });
        if (dup) {
          throw new ApiError(
            409,
            CODES.DUPLICATE_INVOICE_REFERENCE,
            "This supplier already has a bill with this invoice reference.",
          );
        }
      }
      patch.supplierInvoiceReference = next;
    }
    if (input.billDate !== undefined) patch.billDate = calendarDateToUtcMidnoon(input.billDate);
    if (input.dueDate !== undefined) {
      patch.dueDate = input.dueDate === null ? null : calendarDateToUtcMidnoon(input.dueDate);
    }
    if (input.discountMinor !== undefined) patch.discountMinor = input.discountMinor;
    if (input.internalNotes !== undefined) patch.internalNotes = input.internalNotes;

    await tx.supplierBill.update({ where: { id: header.id }, data: patch });

    // Discount changes recompute the canonical totals from current lines.
    const discountMinor = input.discountMinor !== undefined ? input.discountMinor : header.discountMinor;
    try {
      await recomputeBillTotals(tx, header.id, discountMinor);
    } catch (error) {
      mapPureSupplierBillDomainError(error);
    }

    await audit(
      auditInput(input.businessId, input.userId, "supplier_bill.update", header.id, header.reference, {
        supplierInvoiceReference: input.supplierInvoiceReference ?? undefined,
        billDate: input.billDate ?? undefined,
        dueDate: input.dueDate === undefined ? undefined : input.dueDate,
        discountMinor: input.discountMinor ?? undefined,
      }),
      tx,
    );
  });

  return getSupplierBill({ businessId: input.businessId, id: input.id });
}

/* --------------------------------- lines ---------------------------------- */

async function loadPoLineOrThrow(
  tx: Tx,
  businessId: string,
  purchaseOrderLineId: string,
  bill: { purchaseOrderId: string },
) {
  const poLine = await tx.purchaseOrderLine.findFirst({
    where: { id: purchaseOrderLineId, purchaseOrder: { businessId } },
    select: {
      id: true,
      purchaseOrderId: true,
      productId: true,
      unitPriceMinor: true,
      orderedQty: true,
      productNameAtOrder: true,
      skuAtOrder: true,
      unitAtOrder: true,
    },
  });
  if (!poLine) throw new ApiError(404, "NOT_FOUND", "Purchase order line not found.");
  if (poLine.purchaseOrderId !== bill.purchaseOrderId) {
    // Same tenant, wrong order → the ONE stable foreign-entity code (§21).
    throw new ApiError(
      404,
      CODES.FOREIGN_ENTITY,
      "This purchase order line does not belong to the bill's purchase order.",
    );
  }
  return poLine;
}

export async function addSupplierBillLine(input: {
  businessId: string;
  userId: string;
  id: string;
  purchaseOrderLineId: string;
  billedQty: number;
  unitPriceMinor: number;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<SupplierBillDetailDto> {
  if (!isValidBilledQty(input.billedQty)) {
    throw new ApiError(422, CODES.INVALID_QUANTITY, "billedQty must be an integer between 1 and 1,000,000.");
  }
  if (!isValidBillUnitPriceMinor(input.unitPriceMinor)) {
    throw new ApiError(422, CODES.PRICE_OVERFLOW, "unitPriceMinor must be an integer between 0 and 1,000,000,000.");
  }

  await withWriteTx(async (tx) => {
    const header = await loadBillHeader(tx, input.businessId, input.id);
    requireDraft(header.status); // §10

    // §6 — the PO line must belong to THIS bill's PO (no substitutions).
    const poLine = await loadPoLineOrThrow(tx, input.businessId, input.purchaseOrderLineId, header);

    // §6 — each PO line at most once per bill.
    const dup = await tx.supplierBillLine.findFirst({
      where: { supplierBillId: header.id, purchaseOrderLineId: poLine.id },
      select: { id: true },
    });
    if (dup) {
      throw new ApiError(
        409,
        CODES.DUPLICATE_PO_LINE,
        "Each purchase order line can appear at most once on a bill.",
      );
    }

    const cap = supplierBillLineCap(process.env.SUPPLIER_BILL_MAX_LINES);
    await assertLineCap(tx, header.id, cap);

    // §7 — ADVISORY early validation (posting re-checks authoritatively).
    const match = await computeBillableForPoLine(tx, poLine, header.id);
    assertQtyWithinAvailability(input.billedQty, match);

    // §8 — exact line total (BigInt law).
    let lineTotalMinor: number;
    try {
      lineTotalMinor = computeBillLineTotalMinor(input.billedQty, input.unitPriceMinor);
    } catch (error) {
      mapPureSupplierBillDomainError(error);
    }

    // §6 — snapshots copied from the PO LINE's frozen snapshot columns.
    await tx.supplierBillLine.create({
      data: {
        supplierBillId: header.id,
        purchaseOrderLineId: poLine.id,
        productId: poLine.productId, // derived from the PO line (never client authority)
        billedQty: input.billedQty,
        unitPriceMinor: input.unitPriceMinor,
        lineTotalMinor,
        productNameAtBill: poLine.productNameAtOrder,
        skuAtBill: poLine.skuAtOrder,
        unitAtBill: poLine.unitAtOrder,
        purchaseOrderUnitPriceMinor: poLine.unitPriceMinor,
      },
    });

    try {
      await recomputeBillTotals(tx, header.id, header.discountMinor);
    } catch (error) {
      mapPureSupplierBillDomainError(error);
    }

    await audit(
      auditInput(input.businessId, input.userId, "supplier_bill.line_add", header.id, header.reference, {
        purchaseOrderLineId: poLine.id,
        billedQty: input.billedQty,
        unitPriceMinor: input.unitPriceMinor,
        lineTotalMinor,
      }),
      tx,
    );
  });

  return getSupplierBill({ businessId: input.businessId, id: input.id });
}

export async function updateSupplierBillLine(input: {
  businessId: string;
  userId: string;
  id: string;
  lineId: string;
  billedQty?: number;
  unitPriceMinor?: number;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<SupplierBillDetailDto> {
  if (input.billedQty !== undefined && !isValidBilledQty(input.billedQty)) {
    throw new ApiError(422, CODES.INVALID_QUANTITY, "billedQty must be an integer between 1 and 1,000,000.");
  }
  if (input.unitPriceMinor !== undefined && !isValidBillUnitPriceMinor(input.unitPriceMinor)) {
    throw new ApiError(
      422,
      CODES.PRICE_OVERFLOW,
      "unitPriceMinor must be an integer between 0 and 1,000,000,000.",
    );
  }

  await withWriteTx(async (tx) => {
    const header = await loadBillHeader(tx, input.businessId, input.id);
    requireDraft(header.status); // §10

    const line = await tx.supplierBillLine.findFirst({
      where: { id: input.lineId, supplierBillId: header.id },
      select: { id: true, purchaseOrderLineId: true },
    });
    if (!line) throw new ApiError(404, "NOT_FOUND", "Bill line not found.");

    const billedQty = input.billedQty ?? undefined;
    const unitPriceMinor = input.unitPriceMinor ?? undefined;
    if (billedQty !== undefined || unitPriceMinor !== undefined) {
      // §7 — ADVISORY early validation against the same availability law.
      const poLine = await tx.purchaseOrderLine.findFirst({
        where: { id: line.purchaseOrderLineId },
        select: { id: true, orderedQty: true },
      });
      if (!poLine) {
        throw new ApiError(404, "NOT_FOUND", "Purchase order line not found.");
      }
      const match = await computeBillableForPoLine(tx, poLine, header.id);
      assertQtyWithinAvailability(billedQty ?? 0, match);
    }

    const data: Prisma.SupplierBillLineUncheckedUpdateInput = {};
    let nextQty = 0;
    let nextPrice = 0;
    if (billedQty !== undefined || unitPriceMinor !== undefined) {
      const current = await tx.supplierBillLine.findUniqueOrThrow({
        where: { id: line.id },
        select: { billedQty: true, unitPriceMinor: true },
      });
      nextQty = billedQty ?? current.billedQty;
      nextPrice = unitPriceMinor ?? current.unitPriceMinor;
      let lineTotalMinor: number;
      try {
        lineTotalMinor = computeBillLineTotalMinor(nextQty, nextPrice);
      } catch (error) {
        mapPureSupplierBillDomainError(error);
      }
      data.billedQty = nextQty;
      data.unitPriceMinor = nextPrice;
      data.lineTotalMinor = lineTotalMinor;
    }

    await tx.supplierBillLine.update({ where: { id: line.id }, data });

    try {
      await recomputeBillTotals(tx, header.id, header.discountMinor);
    } catch (error) {
      mapPureSupplierBillDomainError(error);
    }

    await audit(
      auditInput(input.businessId, input.userId, "supplier_bill.line_update", header.id, header.reference, {
        lineId: line.id,
        billedQty: billedQty,
        unitPriceMinor: unitPriceMinor,
      }),
      tx,
    );
  });

  return getSupplierBill({ businessId: input.businessId, id: input.id });
}

export async function removeSupplierBillLine(input: {
  businessId: string;
  userId: string;
  id: string;
  lineId: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<SupplierBillDetailDto> {
  await withWriteTx(async (tx) => {
    const header = await loadBillHeader(tx, input.businessId, input.id);
    requireDraft(header.status); // §10

    const line = await tx.supplierBillLine.findFirst({
      where: { id: input.lineId, supplierBillId: header.id },
      select: { id: true },
    });
    if (!line) throw new ApiError(404, "NOT_FOUND", "Bill line not found.");

    await tx.supplierBillLine.delete({ where: { id: line.id } });

    try {
      await recomputeBillTotals(tx, header.id, header.discountMinor);
    } catch (error) {
      mapPureSupplierBillDomainError(error);
    }

    await audit(
      auditInput(input.businessId, input.userId, "supplier_bill.line_remove", header.id, header.reference, {
        lineId: line.id,
      }),
      tx,
    );
  });

  return getSupplierBill({ businessId: input.businessId, id: input.id });
}

/* ------------------------------ §11 posting ------------------------------- */

/**
 * §11 — THE atomic posting transaction. Failure at ANY step rolls back
 * EVERYTHING: no Expense, no status change, no audit, no partial write.
 * Posting creates EXACTLY ONE linked Expense (§11 steps 15-24) and mutates
 * NOTHING else — no stock, no adjustment, no receipt/return, no PO, no
 * payment, no sale (§11 immutable list).
 */
export async function postSupplierBill(input: {
  businessId: string;
  userId: string;
  id: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<{
  id: string;
  reference: string;
  status: SupplierBillStatus;
  postedAt: Date;
  expenseId: string;
  expenseAmountMinor: number;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  lineCount: number;
}> {
  return withWriteTx(async (tx) => {
    const cap = supplierBillLineCap(process.env.SUPPLIER_BILL_MAX_LINES);

    // §11 steps 1-2 — reload INSIDE the transaction; never trust an earlier GET.
    const header = await loadBillHeader(tx, input.businessId, input.id);

    // §2/§14 — already-linked guard BEFORE the status gate: every loser —
    // including a retry after the winner committed — receives the ONE
    // documented stable conflict code.
    if (header.expenseId) {
      throw new ApiError(
        409,
        CODES.ALREADY_LINKED,
        "This bill already has a linked payable.",
      );
    }
    // §11 step 3 — only DRAFT posts. A repeated post is ALREADY_POSTED.
    assertTransition(header.status, "POSTED");

    // §11 step 4 — the PO must still belong to this business, still be
    // billable (CONFIRMED|CLOSED), and match the bill's supplier.
    const po = await tx.purchaseOrder.findFirst({
      where: { id: header.purchaseOrderId, businessId: input.businessId },
      select: {
        id: true,
        reference: true,
        status: true,
        supplierId: true,
        supplierNameAtOrder: true,
        currencyCodeAtOrder: true,
        currencySymbolAtOrder: true,
        decimalPrecisionAtOrder: true,
      },
    });
    if (!po) throw new ApiError(404, "NOT_FOUND", "Purchase order not found.");
    assertPurchaseOrderBillable(po.status);
    if (po.supplierId !== header.supplierId) {
      throw new ApiError(
        422,
        CODES.SUPPLIER_MISMATCH,
        "The bill supplier no longer matches the purchase order supplier.",
      );
    }

    // §11 step 8 — currency consistency with the PO (FX out of scope, §8).
    if (
      header.currencyCodeAtBill !== po.currencyCodeAtOrder ||
      header.currencySymbolAtBill !== po.currencySymbolAtOrder ||
      header.decimalPrecisionAtBill !== po.decimalPrecisionAtOrder
    ) {
      throw new ApiError(
        422,
        CODES.CURRENCY_MISMATCH,
        "The bill currency does not match the purchase order currency.",
      );
    }

    // §11 step 5 — lines + completeness cap.
    const lineRows = await tx.supplierBillLine.findMany({
      where: { supplierBillId: header.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: cap + 1,
      select: {
        id: true,
        purchaseOrderLineId: true,
        productId: true,
        billedQty: true,
        unitPriceMinor: true,
        lineTotalMinor: true,
      },
    });
    assertLineCapInvariant(lineRows.length, cap);

    // §11 step 7 — a bill with zero lines can never post.
    if (lineRows.length === 0) {
      throw new ApiError(422, CODES.EMPTY, "Add at least one line before posting this bill.");
    }

    // §11 steps 4/13 — every line's PO line belongs to THIS PO; the product
    // chain is intact (Restrict makes a hard-deleted product impossible;
    // a violation is corruption).
    const poLineIds = [...new Set(lineRows.map((l) => l.purchaseOrderLineId))];
    const poLines = await tx.purchaseOrderLine.findMany({
      where: { id: { in: poLineIds }, purchaseOrderId: po.id },
      select: { id: true, orderedQty: true, productId: true },
    });
    const poLineById = new Map(poLines.map((l) => [l.id, l]));
    for (const line of lineRows) {
      const poLine = poLineById.get(line.purchaseOrderLineId);
      if (!poLine) {
        throw new ApiError(
          404,
          CODES.FOREIGN_ENTITY,
          "A bill line references a purchase order line outside this order.",
        );
      }
      const productExists = await tx.product.findFirst({
        where: { id: line.productId, businessId: input.businessId },
        select: { id: true },
      });
      if (!productExists) {
        // Impossible via Restrict — surfacing preserves honesty (§7).
        throw new ApiError(
          500,
          CODES.CORRUPT_HISTORY,
          "Bill product history is inconsistent. Please contact support.",
        );
      }
    }

    // §11 steps 6-12 — THE authoritative three-way match, per DISTINCT PO
    // line, with DB aggregates and the pure law. Concurrent competition is
    // resolved HERE: the aggregates already include the winner's posted
    // lines, so the loser fails with the stable controlled error.
    const billedPerPoLine = new Map<string, number>();
    for (const line of lineRows) {
      billedPerPoLine.set(
        line.purchaseOrderLineId,
        (billedPerPoLine.get(line.purchaseOrderLineId) ?? 0) + line.billedQty,
      );
    }
    for (const [poLineId, billedQty] of billedPerPoLine) {
      const poLine = poLineById.get(poLineId);
      if (!poLine) continue;
      const match = await computeBillableForPoLine(tx, poLine, header.id);
      assertQtyWithinAvailability(billedQty, match);
    }

    // §11 steps 6/7/14 — canonical totals (server authority; drafts are
    // pre-author documents, so recomputed values are persisted atomically).
    let lineTotals: number[];
    let totals: { subtotalMinor: number; discountMinor: number; totalMinor: number; lineCount: number };
    try {
      lineTotals = lineRows.map((l) =>
        computeBillLineTotalMinor(l.billedQty, l.unitPriceMinor),
      );
      totals = computeSupplierBillTotals(
        lineRows.map((l, i) => ({ lineTotalMinor: lineTotals[i] })),
        header.discountMinor,
      );
    } catch (error) {
      mapPureSupplierBillDomainError(error);
    }
    if (totals.totalMinor < 1) {
      // §9 — zero-value invoices are not supported by the existing payable
      // semantics (Expense.amountMinor requires ≥ 1): stable controlled error.
      throw new ApiError(
        422,
        CODES.ZERO_TOTAL,
        "A supplier bill must total at least one minor unit to create a payable.",
      );
    }

    // §11 steps 6 — persist the recomputed line totals (server authority).
    for (let i = 0; i < lineRows.length; i += 1) {
      if (lineRows[i].lineTotalMinor !== lineTotals[i]) {
        await tx.supplierBillLine.update({
          where: { id: lineRows[i].id },
          data: { lineTotalMinor: lineTotals[i] },
          select: { id: true },
        });
      }
    }

    // §11 step 15-22 — generate the Expense payable from the bill's
    // authoritative values. paidMinor starts at zero; status follows the
    // existing unpaid convention; dates follow the same UTC-midnoon
    // normalization; the supplier invoice reference maps to Expense.reference
    // (the statement engine's reference contract). internalNotes are NOT
    // copied (privacy, §16). Category is the documented canonical value.
    const postedAt = new Date();
    const expense = await tx.expense.create({
      data: {
        businessId: input.businessId, // server-derived
        supplierId: header.supplierId, // §11 step 16
        category: "Supplier bill", // §11 step 23 (SUPPLIER_BILL_EXPENSE_CATEGORY)
        amountMinor: totals.totalMinor, // §11 step 17 — exact equality with the bill
        paidMinor: 0, // §11 step 18
        status: "UNPAID", // §11 step 19 — existing unpaid convention
        spentAt: header.billDate, // §11 step 20 — same date-only normalization
        dueDate: header.dueDate, // §11 step 21
        reference: header.supplierInvoiceReference, // §11 step 22
        note: null,
      },
      select: { id: true, amountMinor: true },
    });

    // §11 steps 24-26 — complete the posting (status + link + timestamps +
    // canonical totals) in the SAME transaction.
    const updated = await tx.supplierBill.update({
      where: { id: header.id },
      data: {
        status: "POSTED",
        postedAt,
        expenseId: expense.id,
        subtotalMinor: totals.subtotalMinor,
        discountMinor: totals.discountMinor,
        totalMinor: totals.totalMinor,
      },
      select: { id: true, reference: true, status: true, postedAt: true },
    });

    // §11 step 27 / §14-F — STRICT audits INSIDE the transaction: an audit
    // failure rolls back the ENTIRE posting (bill + payable). Details carry
    // facts only — never internalNotes, never request bodies (§21).
    await auditStrict(
      auditInput(input.businessId, input.userId, "supplier_bill.post", header.id, header.reference, {
        previousStatus: header.status,
        newStatus: updated.status,
        postedAt: postedAt.toISOString(),
        expenseId: expense.id,
        expenseAmountMinor: expense.amountMinor,
        subtotalMinor: totals.subtotalMinor,
        discountMinor: totals.discountMinor,
        totalMinor: totals.totalMinor,
        lineCount: lineRows.length,
        purchaseOrderId: po.id,
        purchaseOrderReferenceAtBill: po.reference,
        supplierInvoiceReference: header.supplierInvoiceReference,
      }),
      tx,
    );
    await auditStrict(
      {
        businessId: input.businessId,
        actorId: input.userId,
        action: "expense.create",
        entityType: "Expense",
        entityId: expense.id,
        after: {
          source: "supplier_bill.post",
          supplierBillId: header.id,
          supplierBillReference: header.reference,
          amountMinor: expense.amountMinor,
          paidMinor: 0,
          status: "UNPAID",
          supplierId: header.supplierId,
          category: "Supplier bill",
          spentAt: header.billDate.toISOString(),
          dueDate: header.dueDate ? header.dueDate.toISOString() : null,
          reference: header.supplierInvoiceReference,
        },
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
      tx,
    );

    return {
      id: updated.id,
      reference: updated.reference,
      status: "POSTED" as SupplierBillStatus,
      postedAt: updated.postedAt ?? postedAt,
      expenseId: expense.id,
      expenseAmountMinor: expense.amountMinor,
      subtotalMinor: totals.subtotalMinor,
      discountMinor: totals.discountMinor,
      totalMinor: totals.totalMinor,
      lineCount: lineRows.length,
    };
  }).catch((error) => {
    const mapped = mapUniqueViolation(error);
    if (mapped) throw mapped;
    throw error;
  });
}

/* -------------------------------- cancel ---------------------------------- */

export async function cancelSupplierBill(input: {
  businessId: string;
  userId: string;
  id: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<{ id: string; reference: string; status: SupplierBillStatus; cancelledAt: Date | null }> {
  return withWriteTx(async (tx) => {
    // §10 — reload inside the transaction; only DRAFT may cancel.
    const header = await loadBillHeader(tx, input.businessId, input.id);
    assertTransition(header.status, "CANCELLED");

    // §10 — cancelling a draft is a pure document transition: NO expense,
    // NO payment, NO statement movement, NO inventory anything.
    const updated = await tx.supplierBill.update({
      where: { id: header.id },
      data: { status: "CANCELLED", cancelledAt: new Date() },
      select: { id: true, reference: true, status: true, cancelledAt: true },
    });

    await audit(
      auditInput(input.businessId, input.userId, "supplier_bill.cancel", header.id, header.reference, {
        previousStatus: header.status,
        newStatus: updated.status,
        cancelledAt: updated.cancelledAt?.toISOString() ?? null,
      }),
      tx,
    );

    return {
      id: updated.id,
      reference: updated.reference,
      status: "CANCELLED" as SupplierBillStatus,
      cancelledAt: updated.cancelledAt,
    };
  });
}

/* --------------------- §17/§18 integration (read-only) --------------------- */

/** Bounded recent-bills list for the PO detail page (§17). */
export async function listRecentBillsForPurchaseOrder(input: {
  businessId: string;
  purchaseOrderId: string;
  take: number;
}): Promise<
  Array<{
    id: string;
    reference: string;
    supplierInvoiceReference: string | null;
    status: SupplierBillStatus;
    billDate: string;
    totalMinor: number;
    currencySymbolAtBill: string;
    lineCount: number;
  }>
> {
  const rows = await db.supplierBill.findMany({
    where: { businessId: input.businessId, purchaseOrderId: input.purchaseOrderId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.max(1, Math.min(input.take, 25)),
    select: {
      id: true,
      reference: true,
      supplierInvoiceReference: true,
      status: true,
      billDate: true,
      totalMinor: true,
      currencySymbolAtBill: true,
      _count: { select: { lines: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    supplierInvoiceReference: row.supplierInvoiceReference,
    status: parseDbStatus(row.status),
    billDate: row.billDate.toISOString(),
    totalMinor: row.totalMinor,
    currencySymbolAtBill: row.currencySymbolAtBill,
    lineCount: row._count.lines,
  }));
}

/** Bounded recent-bills list for the Supplier 360 page (§18). */
export async function listRecentBillsForSupplier(input: {
  businessId: string;
  supplierId: string;
  take: number;
}): Promise<
  Array<{
    id: string;
    reference: string;
    supplierInvoiceReference: string | null;
    purchaseOrderReferenceAtBill: string;
    status: SupplierBillStatus;
    billDate: string;
    dueDate: string | null;
    totalMinor: number;
    currencySymbolAtBill: string;
    payableStatus: string | null;
    paidMinor: number | null;
  }>
> {
  const rows = await db.supplierBill.findMany({
    where: { businessId: input.businessId, supplierId: input.supplierId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.max(1, Math.min(input.take, 25)),
    select: {
      id: true,
      reference: true,
      supplierInvoiceReference: true,
      purchaseOrderReferenceAtBill: true,
      status: true,
      billDate: true,
      dueDate: true,
      totalMinor: true,
      currencySymbolAtBill: true,
      expense: { select: { status: true, paidMinor: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    supplierInvoiceReference: row.supplierInvoiceReference,
    purchaseOrderReferenceAtBill: row.purchaseOrderReferenceAtBill,
    status: parseDbStatus(row.status),
    billDate: row.billDate.toISOString(),
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    totalMinor: row.totalMinor,
    currencySymbolAtBill: row.currencySymbolAtBill,
    payableStatus: row.expense?.status ?? null,
    paidMinor: row.expense?.paidMinor ?? null,
  }));
}

/**
 * §17 — PO-level billing summary for the PO detail page: posted bill
 * count, billed quantity, and the remaining invoiceable quantity across
 * ALL lines of the order (computed by the ONE matching law; corrupted
 * history surfaces the stable 500 instead of clamping).
 */
export async function getPurchaseOrderBillingSummary(input: {
  businessId: string;
  purchaseOrderId: string;
}): Promise<{
  postedBillCount: number;
  totalBilledQty: number;
  totalAvailableQty: number;
  postedBilledAmountMinor: number | null;
}> {
  const poLines = await db.purchaseOrderLine.findMany({
    where: { purchaseOrderId: input.purchaseOrderId, purchaseOrder: { businessId: input.businessId } },
    select: { id: true, orderedQty: true },
  });
  let totalAvailableQty = 0;
  for (const poLine of poLines) {
    const match = await computeBillableForPoLine(db, poLine);
    totalAvailableQty += match.availableQty;
  }
  const [billCount, billedAgg, amountAgg] = await Promise.all([
    db.supplierBill.count({
      where: { businessId: input.businessId, purchaseOrderId: input.purchaseOrderId, status: "POSTED" },
    }),
    db.supplierBillLine.aggregate({
      where: {
        purchaseOrderLineId: { in: poLines.map((l) => l.id) },
        supplierBill: { status: "POSTED" },
      },
      _sum: { billedQty: true },
    }),
    db.supplierBill.aggregate({
      where: { businessId: input.businessId, purchaseOrderId: input.purchaseOrderId, status: "POSTED" },
      _sum: { totalMinor: true },
    }),
  ]);
  return {
    postedBillCount: billCount,
    totalBilledQty: billedAgg._sum.billedQty ?? 0,
    totalAvailableQty,
    postedBilledAmountMinor: amountAgg._sum.totalMinor,
  };
}
