import "server-only";

/**
 * Prompt 47 — sales-quotation service (server-only).
 *
 * LAWS:
 *  - COMMERCIAL OFFER ONLY (§1): every quotation operation (create, edit,
 *    mark-sent, accept, reject, cancel, expire, convert) mutates NOTHING
 *    but the quotation itself (and, for conversion, the ONE legitimate
 *    linked SalesOrder §13). No stock change, no reservation, no Sale, no
 *    Payment, no Expense, no receivable, no statement, no aging, no
 *    InventoryAdjustment, no notification falsely claiming an invoice or
 *    payment — for ANY lifecycle action.
 *  - CONVERSION LAW (§13): ACCEPTED → exactly ONE CONFIRMED SalesOrder.
 *    ONE atomic transaction: quotation reload + status re-check (inside
 *    the tx), already-converted guard BEFORE the status gate (every loser
 *    gets the ONE stable conflict code), complete-line proof, canonical
 *    totals recomputed from persisted lines, snapshot validation, order +
 *    lines copied from the FROZEN quotation snapshots (never re-priced
 *    from live Products), quotation → CONVERTED + convertedAt, two audit
 *    events, commit together. The DB UNIQUE constraint on
 *    SalesOrder.sourceQuotationId is the final race authority (§7).
 *  - CONVERSION PRODUCES NO FINANCIAL/INVENTORY RECORDS: no Sale invoice,
 *    no Payment, no receivable, no InventoryAdjustment, no stock
 *    reservation, no Product.stockQty change (§13 invariants).
 *  - STATUS LAW (§8): closed vocabulary, canonical transition matrix,
 *    status RE-CHECKED INSIDE the write transaction; corrupted persisted
 *    status is a controlled 500 — never DRAFT.
 *  - VALIDITY LAW (§9): accept/reject require the offer to still be
 *    within validity in the AUTHENTICATED business timezone (server
 *    clock). expire requires the offer to ACTUALLY be past validity.
 *    ACCEPTED never expires.
 *  - TENANT LAW (§2.4): every query is scoped by ctx.businessId; foreign
 *    ids are indistinguishable from unknown ones (404).
 *  - SNAPSHOT LAW (§12): customer/product identity frozen at write time
 *    from verified rows; conversion copies the FROZEN values; corrupted
 *    snapshots surface, never silently substituted.
 *  - NOTES LAW (§10): customerNotes/internalNotes never enter audit
 *    payloads (changed-flag only), never the search index, and
 *    internalNotes never the print view (§16).
 *  - Every mutation writes its audit INSIDE the same transaction.
 *  - READ-CAP LAW (§11): every bounded read fetches cap+1 rows to prove
 *    completeness; over-cap documents fail with the stable invariant code.
 *  - NO quotation delete API exists (§14/§15): history is preserved;
 *    traceability of a converted offer can never be destroyed.
 */
import { randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { withWriteTransaction } from "@/lib/db/write-transaction";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api-helpers";
import {
  generateSalesOrderReference,
  computeOrderSubtotalMinor,
} from "@/lib/sales-orders/types";
import {
  assertSalesQuotationLineSetComplete,
  businessLocalCalendarDate,
  canTransitionSalesQuotation,
  computeQuotationLineTotalMinor,
  computeQuotationSubtotalMinor,
  computeQuotationTotalMinor,
  effectiveQuotationStatus,
  generateSalesQuotationReference,
  isQuotationDateRangeValid,
  isQuotationExpiredInBusinessTz,
  isValidQuotationPrice,
  isValidPersistedQuotationQty,
  midnoonDateToCalendarDate,
  normalizeSalesQuotationReference,
  parseSalesQuotationStatus,
  salesQuotationDayWindow,
  salesQuotationLineCap,
  validateQuotationDiscount,
  SalesQuotationIntegrityError,
  SALES_QUOTATION_ERROR_CODES,
  type SalesQuotationStatus,
} from "./types";
import { mapPureSalesQuotationDomainError } from "./integration";
import {
  salesQuotationDetailDto,
  salesQuotationLineDto,
  salesQuotationPrintDto,
  customerRecentSalesQuotationDto,
  productRecentSalesQuotationDto,
  type SalesQuotationDetailDto,
  type SalesQuotationPrintDto,
  type CustomerRecentSalesQuotationDto,
  type ProductRecentSalesQuotationDto,
} from "./dto";

type Tx = Prisma.TransactionClient;

/**
 * The ONE shared SQLite write-transaction law (FIFO serialized writes +
 * bounded transient retry) — the same helper every P41–P45 write path
 * uses, so quotation lifecycle writes and conversion can never interleave
 * on the single write lock.
 */
const withWriteTx = withWriteTransaction;

/* ------------------------- shared quotation internals ------------------------ */

/** Corrupted persisted status → controlled 500 (never Draft, §8). */
function parseDbStatus(value: string): SalesQuotationStatus {
  try {
    return parseSalesQuotationStatus(value);
  } catch (error) {
    mapPureSalesQuotationDomainError(error);
  }
}

function auditInput(
  businessId: string,
  actorId: string,
  action: string,
  salesQuotationId: string,
  reference: string,
  after: Record<string, unknown>,
  before?: Record<string, unknown>,
) {
  return {
    businessId,
    actorId,
    action,
    entityType: "SalesQuotation",
    entityId: salesQuotationId,
    ...(before ? { before } : {}),
    after: { reference, ...after }, // safe metadata; NEVER note contents (§10)
  };
}

async function loadQuotationHeader(
  tx: Tx,
  businessId: string,
  id: string,
): Promise<{
  id: string;
  reference: string;
  status: SalesQuotationStatus;
  customerId: string | null;
  customerNameAtQuotation: string;
  currencyCodeAtQuotation: string;
  currencySymbolAtQuotation: string;
  decimalPrecisionAtQuotation: number;
  quotationDate: Date;
  validUntilDate: Date;
  expectedDeliveryDate: Date | null;
  discountMinor: number;
  customerNotes: string | null;
  internalNotes: string | null;
  createdByUserId: string;
  createdByName: string | null;
  sentAt: Date | null;
  acceptedAt: Date | null;
  rejectedAt: Date | null;
  cancelledAt: Date | null;
  convertedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}> {
  const row = await tx.salesQuotation.findFirst({
    where: { id, businessId }, // tenant scope from auth context only
    select: {
      id: true,
      reference: true,
      status: true,
      customerId: true,
      customerNameAtQuotation: true,
      currencyCodeAtQuotation: true,
      currencySymbolAtQuotation: true,
      decimalPrecisionAtQuotation: true,
      quotationDate: true,
      validUntilDate: true,
      expectedDeliveryDate: true,
      discountMinor: true,
      customerNotes: true,
      internalNotes: true,
      createdByUserId: true,
      createdByUser: { select: { name: true } },
      sentAt: true,
      acceptedAt: true,
      rejectedAt: true,
      cancelledAt: true,
      convertedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!row) throw new ApiError(404, SALES_QUOTATION_ERROR_CODES.NOT_FOUND, "Sales quotation not found.");
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
      SALES_QUOTATION_ERROR_CODES.CUSTOMER_NOT_FOUND,
      "Customer not found.",
    );
  }
  return customer;
}

/** Load a PROVEN-COMPLETE, validated line set for one quotation (§11). */
async function loadCompleteLines(
  tx: Tx,
  salesQuotationId: string,
  cap: number,
): Promise<
  Array<{
    id: string;
    productId: string;
    productNameAtQuotation: string;
    skuAtQuotation: string | null;
    unitAtQuotation: string | null;
    qty: number;
    unitPriceMinor: number;
  }>
> {
  const lines = await tx.salesQuotationLine.findMany({
    where: { salesQuotationId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: cap + 1, // cap+1 proves completeness
    select: {
      id: true,
      productId: true,
      productNameAtQuotation: true,
      skuAtQuotation: true,
      unitAtQuotation: true,
      qty: true,
      unitPriceMinor: true,
    },
  });
  const counted = await tx.salesQuotationLine.count({ where: { salesQuotationId } });
  // THREE explicit invariants (§11): fetched ≤ cap, counted ≤ cap,
  // counted === fetched — a mismatch below the cap NEVER passes. The pure
  // integrity error is routed through the ONE centralized domain→HTTP
  // mapping (integration.ts) so EVERY consumer of this loader (lifecycle
  // gate, conversion, line-write rechecks) surfaces the stable 500 code —
  // never a raw pure error degrading to a generic INTERNAL_ERROR.
  try {
    assertSalesQuotationLineSetComplete(lines.length, counted, cap);
  } catch (error) {
    mapPureSalesQuotationDomainError(error);
  }
  // Every persisted line must be materially valid BEFORE use (§6/§11/§12).
  for (const line of lines) {
    if (!isValidPersistedQuotationQty(line.qty) || !isValidQuotationPrice(line.unitPriceMinor)) {
      mapPureSalesQuotationDomainError(
        new SalesQuotationIntegrityError(
          `${SALES_QUOTATION_ERROR_CODES.CORRUPT_HISTORY}: invalid persisted line quantities`,
        ),
      );
    }
    if (typeof line.productNameAtQuotation !== "string" || line.productNameAtQuotation.length === 0) {
      mapPureSalesQuotationDomainError(
        new SalesQuotationIntegrityError(
          `${SALES_QUOTATION_ERROR_CODES.CORRUPT_HISTORY}: missing product snapshot`,
        ),
      );
    }
  }
  return lines;
}

/** Defensive line-count validation for line writes (§11). */
async function assertLineCap(tx: Tx, salesQuotationId: string, cap: number): Promise<number> {
  const lineCount = await tx.salesQuotationLine.count({ where: { salesQuotationId } });
  if (lineCount > cap) {
    // An ALREADY-corrupted over-cap quotation is database corruption: 500
    // integrity, never disguised as the ordinary 422 user failure.
    throw new ApiError(
      500,
      SALES_QUOTATION_ERROR_CODES.LINE_CAP_INVARIANT,
      "Stored document data exceeds its configured line cap. Please contact support.",
    );
  }
  if (lineCount === cap) {
    // The NORMAL write-time rejection for a legitimately full draft.
    throw new ApiError(
      422,
      SALES_QUOTATION_ERROR_CODES.LINE_LIMIT,
      `A sales quotation can contain at most ${cap} lines.`,
    );
  }
  return lineCount;
}

/** Current canonical subtotal of a quotation (validated complete lines). */
async function currentSubtotalMinor(tx: Tx, salesQuotationId: string, cap: number): Promise<number> {
  const lines = await loadCompleteLines(tx, salesQuotationId, cap);
  try {
    return computeQuotationSubtotalMinor(lines).subtotalMinor;
  } catch (error) {
    mapPureSalesQuotationDomainError(error);
  }
}

/**
 * Input-time subtotal recomputation for LINE WRITES (§11): the client's
 * requested line can push the ACCUMULATED subtotal out of the safe integer
 * range even when the single line total is exact (two max-magnitude lines).
 * The documented contract (§11) maps the INPUT-TIME overflow to the 422
 * SALES_QUOTATION_TOTAL_OVERFLOW — the write rolls back either way, this
 * only fixes the surfaced status/code (persisted-data overflow keeps the
 * integrity 500 through mapPureSalesQuotationDomainError elsewhere).
 */
async function lineWriteSubtotalMinor(tx: Tx, salesQuotationId: string, cap: number): Promise<number> {
  const lines = await loadCompleteLines(tx, salesQuotationId, cap);
  try {
    return computeQuotationSubtotalMinor(lines).subtotalMinor;
  } catch (error) {
    if (error instanceof Error && error.name === "SalesQuotationTotalOverflowError") {
      throw new ApiError(
        422,
        SALES_QUOTATION_ERROR_CODES.TOTAL_OVERFLOW,
        "The requested quantity × price exceeds the supported total range.",
      );
    }
    throw error;
  }
}

/** Business-local unique reference generation (§10 — never MAX+1). */
async function generateUniqueQuotationReference(
  tx: Tx,
  businessId: string,
): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generateSalesQuotationReference(new Date(), (max) => randomInt(max));
    const clash = await tx.salesQuotation.findFirst({
      where: { businessId, reference: candidate },
      select: { id: true },
    });
    if (!clash) return candidate;
  }
  // Astronomically unlikely (31^6); fail honestly rather than loop.
  throw new ApiError(
    409,
    SALES_QUOTATION_ERROR_CODES.DUPLICATE_REFERENCE,
    "Could not generate a unique reference. Please try again.",
  );
}

/** Header snapshot validation (§12) — shared by read/convert/export. */
function validateHeaderSnapshots(header: {
  currencyCodeAtQuotation: string;
  currencySymbolAtQuotation: string;
  decimalPrecisionAtQuotation: number;
  customerId: string | null;
  customerNameAtQuotation: string;
}): void {
  if (
    typeof header.currencyCodeAtQuotation !== "string" ||
    header.currencyCodeAtQuotation.length === 0 ||
    typeof header.currencySymbolAtQuotation !== "string" ||
    header.currencySymbolAtQuotation.length === 0 ||
    !Number.isInteger(header.decimalPrecisionAtQuotation)
  ) {
    mapPureSalesQuotationDomainError(
      new SalesQuotationIntegrityError(
        `${SALES_QUOTATION_ERROR_CODES.CORRUPT_HISTORY}: missing currency snapshot`,
      ),
    );
  }
  // A customer-linked quotation must carry its frozen identity snapshot;
  // an anonymous quotation legitimately carries "".
  if (header.customerId !== null && header.customerNameAtQuotation.length === 0) {
    mapPureSalesQuotationDomainError(
      new SalesQuotationIntegrityError(
        `${SALES_QUOTATION_ERROR_CODES.CORRUPT_HISTORY}: missing customer snapshot`,
      ),
    );
  }
}

/** Lifecycle-timestamp consistency law (§8): a persisted timestamp must
 *  never contradict its persisted status — contradictions are corruption. */
function validateLifecycleConsistency(header: {
  status: SalesQuotationStatus;
  sentAt: Date | null;
  acceptedAt: Date | null;
  rejectedAt: Date | null;
  cancelledAt: Date | null;
  convertedAt: Date | null;
}): void {
  const corrupt = (what: string) =>
    mapPureSalesQuotationDomainError(
      new SalesQuotationIntegrityError(
        `${SALES_QUOTATION_ERROR_CODES.CORRUPT_HISTORY}: ${what}`,
      ),
    );
  const needs = (t: Date | null, s: SalesQuotationStatus[]) => {
    const required = s.includes(header.status);
    if (required && !t) corrupt(`status ${header.status} without its transition timestamp`);
    if (!required && t) corrupt(`timestamp present for status ${header.status}`);
  };
  needs(header.sentAt, ["SENT", "ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED", "CONVERTED"]);
  needs(header.acceptedAt, ["ACCEPTED", "CONVERTED"]);
  needs(header.rejectedAt, ["REJECTED"]);
  needs(header.cancelledAt, ["CANCELLED"]);
  needs(header.convertedAt, ["CONVERTED"]);
}

/* -------------------------------- create ---------------------------------- */

export async function createSalesQuotation(input: {
  businessId: string;
  userId: string;
  timezone: string; // AUTHENTICATED business timezone (server clock law §9)
  customerId?: string;
  reference?: string;
  quotationDate?: string; // calendar date (strict, zod) — default business-local today
  validUntilDate: string;
  expectedDeliveryDate?: string;
  discountMinor?: number;
  customerNotes?: string | null;
  internalNotes?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    // §10 — currency snapshot comes from the BUSINESS configuration
    // (server-derived); the client can never select a different currency.
    const business = await tx.business.findUnique({
      where: { id: input.businessId },
      select: { currencyCode: true, currencySymbol: true, decimalPrecision: true },
    });
    if (!business) throw new ApiError(404, "NOT_FOUND", "Business not found.");

    // §10 — optional customer: tenant-scoped, not soft-deleted; the name
    // snapshot is frozen at creation (§12).
    let customerNameAtQuotation = "";
    if (input.customerId) {
      const customer = await loadActiveCustomer(tx, input.businessId, input.customerId);
      customerNameAtQuotation = customer.name;
    }

    // §9 — dates: quotationDate defaults to the SERVER's business-local
    // today (never the browser clock); validUntilDate is required and
    // must not precede quotationDate (inclusive-until law).
    const quotationDate = input.quotationDate ?? businessLocalCalendarDate(new Date(), input.timezone);
    if (!isQuotationDateRangeValid(quotationDate, input.validUntilDate)) {
      throw new ApiError(
        422,
        SALES_QUOTATION_ERROR_CODES.INVALID_DATE_RANGE,
        "The validity date cannot be earlier than the quotation date.",
      );
    }

    // §11 — a quotation with no lines has subtotal 0: a non-zero creation
    // discount would violate the discount law on day one (mirrors P45).
    if ((input.discountMinor ?? 0) > 0) {
      throw new ApiError(
        422,
        SALES_QUOTATION_ERROR_CODES.INVALID_DISCOUNT,
        "Add lines first — an empty quotation cannot carry a discount.",
      );
    }

    // Reference: user-supplied (normalized) or server-generated (§10).
    let reference = input.reference;
    if (reference === undefined) {
      reference = await generateUniqueQuotationReference(tx, input.businessId);
    }

    try {
      const row = await tx.salesQuotation.create({
        data: {
          businessId: input.businessId, // server-derived, never client (§2.4)
          customerId: input.customerId ?? null,
          customerNameAtQuotation, // frozen snapshot ("" when no customer)
          reference,
          status: "DRAFT", // commercial preparation only (§8)
          currencyCodeAtQuotation: business.currencyCode,
          currencySymbolAtQuotation: business.currencySymbol,
          decimalPrecisionAtQuotation: business.decimalPrecision,
          quotationDate: new Date(`${quotationDate}T12:00:00.000Z`),
          validUntilDate: new Date(`${input.validUntilDate}T12:00:00.000Z`),
          expectedDeliveryDate: input.expectedDeliveryDate
            ? new Date(`${input.expectedDeliveryDate}T12:00:00.000Z`)
            : null,
          discountMinor: 0,
          customerNotes: input.customerNotes ?? null, // document data only
          internalNotes: input.internalNotes ?? null, // staff-only document data
          createdByUserId: input.userId, // server-derived
        },
        select: { id: true, reference: true, status: true },
      });

      await audit(
        auditInput(input.businessId, input.userId, "sales_quotation.create", row.id, row.reference, {
          customerId: input.customerId ?? null,
          customerNameAtQuotation,
          status: row.status,
          quotationDate,
          validUntilDate: input.validUntilDate,
        }),
        tx,
      );

      return row;
    } catch (error) {
      // Database uniqueness stays authoritative for duplicates (§10).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ApiError(
          409,
          SALES_QUOTATION_ERROR_CODES.DUPLICATE_REFERENCE,
          "A sales quotation with this reference already exists.",
        );
      }
      throw error;
    }
  });
}

/* --------------------------------- list ----------------------------------- */

export async function listSalesQuotations(input: {
  businessId: string;
  q?: string;
  status?: string; // ALL → undefined (persisted-status filter, §15)
  customerId?: string;
  from?: string;
  to?: string;
  timezone: string; // AUTHENTICATED business timezone (never client authority)
  page: number;
  pageSize: number;
}): Promise<{
  items: Array<{
    id: string;
    reference: string;
    persistedStatus: SalesQuotationStatus;
    effectiveStatus: SalesQuotationStatus;
    customerId: string | null;
    customerNameAtQuotation: string;
    quotationDate: string;
    validUntilDate: string;
    lineCount: number;
    totalQty: number;
    subtotalMinor: number;
    discountMinor: number;
    totalMinor: number;
    convertedOrderReference: string | null;
    createdAt: string;
  }>;
  total: number;
  page: number;
  pageSize: number;
}> {
  const cap = salesQuotationLineCap(process.env.SALES_QUOTATION_MAX_LINES);
  const now = new Date();
  const where: Prisma.SalesQuotationWhereInput = {
    businessId: input.businessId, // tenant scope
    ...(input.status && input.status !== "ALL" ? { status: input.status } : {}),
    ...(input.customerId ? { customerId: input.customerId } : {}),
    ...(input.from || input.to
      ? (() => {
          // from/to are interpreted in the AUTHENTICATED business timezone
          // (inclusive local start of `from`, EXCLUSIVE local start of the
          // day after `to`) — the ONE canonical window law (§types).
          const window = salesQuotationDayWindow(input.from, input.to, input.timezone);
          if (!window) {
            throw new ApiError(422, "VALIDATION_ERROR", "Invalid date filter.");
          }
          return { quotationDate: window };
        })()
      : {}),
    ...(input.q
      ? {
          OR: [
            { reference: { contains: input.q } }, // quotation reference
            { customerNameAtQuotation: { contains: input.q } }, // customer snapshot
            {
              lines: {
                some: {
                  OR: [
                    { productNameAtQuotation: { contains: input.q } }, // product snapshot
                    { skuAtQuotation: { contains: input.q } }, // SKU snapshot
                  ],
                },
              },
            },
          ],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    db.salesQuotation.count({ where }),
    // DB-level pagination; never findMany + slice.
    db.salesQuotation.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
      select: {
        id: true,
        reference: true,
        status: true,
        customerId: true,
        customerNameAtQuotation: true,
        quotationDate: true,
        validUntilDate: true,
        discountMinor: true,
        createdAt: true,
        convertedSalesOrder: { select: { reference: true } }, // §7 — link presence
        lines: {
          // Bounded per-quotation aggregate relation, not one query per row.
          // take cap+1 PROVES the slice is the whole line set (§11).
          select: { id: true, qty: true, unitPriceMinor: true },
          take: cap + 1,
        },
        _count: { select: { lines: true } },
      },
    }),
  ]);

  const items = rows.map((row) => {
    try {
      assertSalesQuotationLineSetComplete(row.lines.length, row._count.lines, cap);
      let totalQty = 0;
      let subtotalMinor = 0;
      for (const line of row.lines) {
        if (!isValidPersistedQuotationQty(line.qty) || !isValidQuotationPrice(line.unitPriceMinor)) {
          mapPureSalesQuotationDomainError(
            new SalesQuotationIntegrityError(
              `${SALES_QUOTATION_ERROR_CODES.CORRUPT_HISTORY}: invalid persisted line`,
            ),
          );
        }
        totalQty += line.qty;
        subtotalMinor += computeQuotationLineTotalMinor(line.qty, line.unitPriceMinor);
      }
      if (!Number.isSafeInteger(subtotalMinor)) {
        mapPureSalesQuotationDomainError(
          new SalesQuotationIntegrityError(
            `${SALES_QUOTATION_ERROR_CODES.TOTAL_OVERFLOW}: list subtotal overflow`,
          ),
        );
      }
      const totalMinor = computeQuotationTotalMinor(subtotalMinor, row.discountMinor);
      const persistedStatus = parseDbStatus(row.status);
      // §9 — persisted vs effective are EXPLICIT and distinct.
      const effectiveStatus = effectiveQuotationStatus(
        persistedStatus,
        row.validUntilDate,
        now,
        input.timezone,
      );
      return {
        id: row.id,
        reference: row.reference,
        persistedStatus,
        effectiveStatus,
        customerId: row.customerId,
        customerNameAtQuotation: row.customerNameAtQuotation,
        quotationDate: row.quotationDate.toISOString(),
        validUntilDate: row.validUntilDate.toISOString(),
        lineCount: row._count.lines,
        totalQty,
        subtotalMinor,
        discountMinor: row.discountMinor,
        totalMinor,
        convertedOrderReference: row.convertedSalesOrder?.reference ?? null, // ONLY when the relation exists (§7)
        createdAt: row.createdAt.toISOString(),
      };
    } catch (error) {
      return mapPureSalesQuotationDomainError(error);
    }
  });
  return { items, total, page: input.page, pageSize: input.pageSize };
}

/* -------------------------------- detail ---------------------------------- */

export async function getSalesQuotation(input: {
  businessId: string;
  id: string;
  timezone: string;
}): Promise<SalesQuotationDetailDto> {
  const cap = salesQuotationLineCap(process.env.SALES_QUOTATION_MAX_LINES);
  const row = await db.salesQuotation.findFirst({
    where: { id: input.id, businessId: input.businessId }, // tenant scope
    select: {
      id: true,
      reference: true,
      status: true,
      customerId: true,
      customerNameAtQuotation: true,
      currencyCodeAtQuotation: true,
      currencySymbolAtQuotation: true,
      decimalPrecisionAtQuotation: true,
      quotationDate: true,
      validUntilDate: true,
      expectedDeliveryDate: true,
      discountMinor: true,
      customerNotes: true,
      internalNotes: true,
      createdByUserId: true,
      createdByUser: { select: { name: true } },
      sentAt: true,
      acceptedAt: true,
      rejectedAt: true,
      cancelledAt: true,
      convertedAt: true,
      createdAt: true,
      updatedAt: true,
      convertedSalesOrder: {
        select: { id: true, reference: true, status: true },
      },
      lines: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: cap + 1, // cap+1 proves completeness (§11)
        select: {
          id: true,
          productId: true,
          productNameAtQuotation: true,
          skuAtQuotation: true,
          unitAtQuotation: true,
          qty: true,
          unitPriceMinor: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      _count: { select: { lines: true } },
    },
  });
  if (!row) throw new ApiError(404, SALES_QUOTATION_ERROR_CODES.NOT_FOUND, "Sales quotation not found.");

  try {
    assertSalesQuotationLineSetComplete(row.lines.length, row._count.lines, cap);
    const persistedStatus = parseDbStatus(row.status);
    const effectiveStatus = effectiveQuotationStatus(
      persistedStatus,
      row.validUntilDate,
      new Date(),
      input.timezone,
    );
    validateHeaderSnapshots(row);
    validateLifecycleConsistency({ ...row, status: persistedStatus });
    const lines = row.lines.map((l) => salesQuotationLineDto(l));
    const subtotalMinor = computeQuotationSubtotalMinor(
      lines.map((l) => ({ qty: l.qty, unitPriceMinor: l.unitPriceMinor })),
    ).subtotalMinor;
    const totalMinor = computeQuotationTotalMinor(subtotalMinor, row.discountMinor);
    return salesQuotationDetailDto(
      {
        id: row.id,
        reference: row.reference,
        persistedStatus,
        effectiveStatus,
        validUntilCalendarDate: midnoonDateToCalendarDate(row.validUntilDate),
        isExpired: isQuotationExpiredInBusinessTz(row.validUntilDate, new Date(), input.timezone),
        customerId: row.customerId,
        customerNameAtQuotation: row.customerNameAtQuotation,
        currencyCodeAtQuotation: row.currencyCodeAtQuotation,
        currencySymbolAtQuotation: row.currencySymbolAtQuotation,
        decimalPrecisionAtQuotation: row.decimalPrecisionAtQuotation,
        quotationDate: row.quotationDate,
        validUntilDate: row.validUntilDate,
        expectedDeliveryDate: row.expectedDeliveryDate,
        discountMinor: row.discountMinor,
        customerNotes: row.customerNotes,
        internalNotes: row.internalNotes,
        createdBy: { id: row.createdByUserId, name: row.createdByUser?.name ?? null },
        sentAt: row.sentAt,
        acceptedAt: row.acceptedAt,
        rejectedAt: row.rejectedAt,
        cancelledAt: row.cancelledAt,
        convertedAt: row.convertedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      {
        lineCount: row._count.lines,
        totalQty: lines.reduce((acc, l) => acc + l.qty, 0),
        subtotalMinor,
        discountMinor: row.discountMinor,
        totalMinor,
      },
      lines,
      // §7 — the converted-order DTO appears ONLY when the relation exists.
      row.convertedSalesOrder
        ? {
            id: row.convertedSalesOrder.id,
            reference: row.convertedSalesOrder.reference,
            status: row.convertedSalesOrder.status,
          }
        : null,
    );
  } catch (error) {
    return mapPureSalesQuotationDomainError(error);
  }
}

/**
 * §16 — the customer-facing PRINT payload: an explicitly REDUCED
 * projection of the SAME validated detail data. internalNotes are
 * structurally absent (never rendered, never leaked); no database ids, no
 * audit metadata, no raw technical statuses. Tenant-authorized reads only.
 */
export async function getSalesQuotationPrintView(input: {
  businessId: string;
  id: string;
  timezone: string;
}): Promise<SalesQuotationPrintDto> {
  const detail = await getSalesQuotation({ businessId: input.businessId, id: input.id, timezone: input.timezone });
  return salesQuotationPrintDto({
    reference: detail.quotation.reference,
    quotationDate: detail.quotation.quotationDate,
    validUntilDate: detail.quotation.validUntilDate,
    customerNameAtQuotation: detail.quotation.customerNameAtQuotation,
    currencyCodeAtQuotation: detail.quotation.currencyCodeAtQuotation,
    currencySymbolAtQuotation: detail.quotation.currencySymbolAtQuotation,
    decimalPrecisionAtQuotation: detail.quotation.decimalPrecisionAtQuotation,
    expectedDeliveryDate: detail.quotation.expectedDeliveryDate,
    customerNotes: detail.quotation.customerNotes,
    lines: detail.lines.map((l) => ({
      productNameAtQuotation: l.productNameAtQuotation,
      skuAtQuotation: l.skuAtQuotation,
      unitAtQuotation: l.unitAtQuotation,
      qty: l.qty,
      unitPriceMinor: l.unitPriceMinor,
      lineTotalMinor: l.lineTotalMinor,
    })),
    subtotalMinor: detail.summary.subtotalMinor,
    discountMinor: detail.summary.discountMinor,
    totalMinor: detail.summary.totalMinor,
  });
}

/* ------------------------------ header patch ------------------------------ */

export async function updateSalesQuotation(input: {
  businessId: string;
  userId: string;
  id: string;
  customerId?: string | null;
  reference?: string;
  quotationDate?: string;
  validUntilDate?: string;
  expectedDeliveryDate?: string | null;
  discountMinor?: number;
  customerNotes?: string | null;
  internalNotes?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const cap = salesQuotationLineCap(process.env.SALES_QUOTATION_MAX_LINES);
    const header = await loadQuotationHeader(tx, input.businessId, input.id);
    if (header.status !== "DRAFT") {
      // §8 — SENT and later are immutable (no silent correction).
      throw new ApiError(
        409,
        SALES_QUOTATION_ERROR_CODES.IMMUTABLE,
        "Only DRAFT sales quotations can be changed.",
      );
    }

    const data: Prisma.SalesQuotationUpdateInput = {};
    let quotationDate = midnoonDateToCalendarDate(header.quotationDate);
    let validUntilDate = midnoonDateToCalendarDate(header.validUntilDate);

    if (input.customerId !== undefined) {
      if (input.customerId === null) {
        data.customer = { disconnect: true };
        data.customerNameAtQuotation = "";
      } else {
        const customer = await loadActiveCustomer(tx, input.businessId, input.customerId);
        data.customer = { connect: { id: customer.id } };
        data.customerNameAtQuotation = customer.name; // snapshot refrozen (§12)
      }
    }
    if (input.reference !== undefined) data.reference = input.reference;
    if (input.quotationDate !== undefined) {
      data.quotationDate = new Date(`${input.quotationDate}T12:00:00.000Z`);
      quotationDate = input.quotationDate;
    }
    if (input.validUntilDate !== undefined) {
      data.validUntilDate = new Date(`${input.validUntilDate}T12:00:00.000Z`);
      validUntilDate = input.validUntilDate;
    }
    // §9 — the validity ORDERING holds against the PATCHED pair (a partial
    // patch can never dodge the law).
    if (!isQuotationDateRangeValid(quotationDate, validUntilDate)) {
      throw new ApiError(
        422,
        SALES_QUOTATION_ERROR_CODES.INVALID_DATE_RANGE,
        "The validity date cannot be earlier than the quotation date.",
      );
    }
    if (input.expectedDeliveryDate !== undefined) {
      data.expectedDeliveryDate =
        input.expectedDeliveryDate === null
          ? null
          : new Date(`${input.expectedDeliveryDate}T12:00:00.000Z`);
    }
    if (input.customerNotes !== undefined) data.customerNotes = input.customerNotes;
    if (input.internalNotes !== undefined) data.internalNotes = input.internalNotes;

    if (input.discountMinor !== undefined) {
      // §11 — discount law against the CURRENT canonical subtotal.
      const subtotalMinor = await currentSubtotalMinor(tx, header.id, cap);
      try {
        validateQuotationDiscount(input.discountMinor, subtotalMinor);
      } catch {
        throw new ApiError(
          422,
          SALES_QUOTATION_ERROR_CODES.INVALID_DISCOUNT,
          "Discount cannot exceed the quotation subtotal.",
        );
      }
      data.discountMinor = input.discountMinor;
    }

    try {
      const updated = await tx.salesQuotation.update({
        where: { id: header.id },
        data,
        select: { id: true, reference: true, status: true },
      });

      await audit(
        auditInput(
          input.businessId,
          input.userId,
          "sales_quotation.update",
          header.id,
          updated.reference,
          {
            changed: {
              ...(input.customerId !== undefined ? { customerId: { changed: true } } : {}),
              ...(input.reference !== undefined
                ? { reference: { from: header.reference, to: updated.reference } }
                : {}),
              ...(input.quotationDate !== undefined ? { quotationDate: { changed: true } } : {}),
              ...(input.validUntilDate !== undefined ? { validUntilDate: { changed: true } } : {}),
              ...(input.expectedDeliveryDate !== undefined
                ? { expectedDeliveryDate: { changed: true } }
                : {}),
              ...(input.discountMinor !== undefined
                ? { discountMinor: { from: header.discountMinor, to: input.discountMinor } }
                : {}),
              // Notes: CHANGED-FLAG ONLY — the contents never enter the
              // audit trail (§10/§22).
              ...(input.customerNotes !== undefined ? { customerNotes: { changed: true } } : {}),
              ...(input.internalNotes !== undefined ? { internalNotes: { changed: true } } : {}),
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
          SALES_QUOTATION_ERROR_CODES.DUPLICATE_REFERENCE,
          "A sales quotation with this reference already exists.",
        );
      }
      throw error;
    }
  });
}

/* ------------------------------- line writes ------------------------------ */

export async function addSalesQuotationLine(input: {
  businessId: string;
  userId: string;
  id: string;
  productId: string;
  qty: number;
  unitPriceMinor?: number;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const cap = salesQuotationLineCap(process.env.SALES_QUOTATION_MAX_LINES);
    const header = await loadQuotationHeader(tx, input.businessId, input.id);
    if (header.status !== "DRAFT") {
      throw new ApiError(
        409,
        SALES_QUOTATION_ERROR_CODES.IMMUTABLE,
        "Only DRAFT sales quotations can be changed.",
      );
    }

    // §6 — eligible products only: same tenant, exists, not soft-deleted,
    // active. A foreign product is indistinguishable from unknown (404).
    const product = await tx.product.findFirst({
      where: { id: input.productId, businessId: input.businessId, deletedAt: null },
      select: { id: true, name: true, sku: true, unit: true, salePriceMinor: true, isActive: true },
    });
    if (!product || !product.isActive) {
      throw new ApiError(
        404,
        SALES_QUOTATION_ERROR_CODES.PRODUCT_NOT_FOUND,
        "Product not found.",
      );
    }

    await assertLineCap(tx, header.id, cap); // defensive count

    // §6/§12 — the offered price: client-supplied or the CURRENT product
    // sale price as the default; persisted ONCE and never re-derived later
    // (a later price change never silently reprices the offer §12).
    const unitPriceMinor = input.unitPriceMinor ?? product.salePriceMinor;
    if (!isValidQuotationPrice(unitPriceMinor)) {
      throw new ApiError(
        422,
        SALES_QUOTATION_ERROR_CODES.TOTAL_OVERFLOW,
        "Unit price is outside the allowed range.",
      );
    }
    // §11 — the line total must be exact BEFORE anything persists.
    try {
      computeQuotationLineTotalMinor(input.qty, unitPriceMinor);
    } catch (error) {
      if (error instanceof Error && error.name === "SalesQuotationTotalOverflowError") {
        throw new ApiError(
          422,
          SALES_QUOTATION_ERROR_CODES.TOTAL_OVERFLOW,
          "The requested quantity × price exceeds the supported total range.",
        );
      }
      throw error;
    }

    try {
      const line = await tx.salesQuotationLine.create({
        data: {
          salesQuotationId: header.id,
          productId: product.id,
          qty: input.qty,
          unitPriceMinor,
          // §6/§12 — snapshots copied from the tenant-scoped Product at
          // add time, then frozen; the client never authors them.
          productNameAtQuotation: product.name,
          skuAtQuotation: product.sku,
          unitAtQuotation: product.unit,
        },
        select: { id: true },
      });

      // §11 — the stored discount must still satisfy the law against the
      // NEW subtotal (a line change can shrink the subtotal below it).
      const subtotalMinor = await lineWriteSubtotalMinor(tx, header.id, cap);
      if (header.discountMinor > subtotalMinor) {
        throw new ApiError(
          422,
          SALES_QUOTATION_ERROR_CODES.INVALID_DISCOUNT,
          "Discount cannot exceed the quotation subtotal.",
        );
      }

      await audit(
        auditInput(
          input.businessId,
          input.userId,
          "sales_quotation.line_add",
          header.id,
          header.reference,
          {
            lineId: line.id,
            productId: product.id,
            productNameAtQuotation: product.name,
            qty: input.qty,
            unitPriceMinor,
          },
        ),
        tx,
      );

      return { id: line.id };
    } catch (error) {
      // DB uniqueness is authoritative for duplicate lines (§6).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ApiError(
          409,
          SALES_QUOTATION_ERROR_CODES.DUPLICATE_PRODUCT,
          "This product is already on the quotation.",
        );
      }
      throw error;
    }
  });
}

export async function updateSalesQuotationLine(input: {
  businessId: string;
  userId: string;
  id: string;
  lineId: string;
  qty?: number;
  unitPriceMinor?: number;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const cap = salesQuotationLineCap(process.env.SALES_QUOTATION_MAX_LINES);
    const header = await loadQuotationHeader(tx, input.businessId, input.id);
    if (header.status !== "DRAFT") {
      throw new ApiError(
        409,
        SALES_QUOTATION_ERROR_CODES.IMMUTABLE,
        "Only DRAFT sales quotations can be changed.",
      );
    }

    const line = await tx.salesQuotationLine.findFirst({
      where: { id: input.lineId, salesQuotationId: header.id }, // scoped via parent
      select: { id: true, qty: true, unitPriceMinor: true },
    });
    if (!line) {
      throw new ApiError(404, SALES_QUOTATION_ERROR_CODES.LINE_NOT_FOUND, "Quotation line not found.");
    }

    const qty = input.qty ?? line.qty;
    const unitPriceMinor = input.unitPriceMinor ?? line.unitPriceMinor;

    // §11 — the new line total must be exact.
    try {
      computeQuotationLineTotalMinor(qty, unitPriceMinor);
    } catch (error) {
      if (error instanceof Error && error.name === "SalesQuotationTotalOverflowError") {
        throw new ApiError(
          422,
          SALES_QUOTATION_ERROR_CODES.TOTAL_OVERFLOW,
          "The requested quantity × price exceeds the supported total range.",
        );
      }
      throw error;
    }

    const updated = await tx.salesQuotationLine.update({
      where: { id: line.id },
      data: { qty, unitPriceMinor },
      select: {
        id: true,
        productId: true,
        productNameAtQuotation: true,
        skuAtQuotation: true,
        unitAtQuotation: true,
        qty: true,
        unitPriceMinor: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // §11 — discount law re-check against the new subtotal.
    const subtotalMinor = await lineWriteSubtotalMinor(tx, header.id, cap);
    if (header.discountMinor > subtotalMinor) {
      throw new ApiError(
        422,
        SALES_QUOTATION_ERROR_CODES.INVALID_DISCOUNT,
        "Discount cannot exceed the quotation subtotal.",
      );
    }

    await audit(
      auditInput(
        input.businessId,
        input.userId,
        "sales_quotation.line_update",
        header.id,
        header.reference,
        {
          lineId: line.id,
          qty: { from: line.qty, to: updated.qty },
          unitPriceMinor: { from: line.unitPriceMinor, to: updated.unitPriceMinor },
        },
      ),
      tx,
    );

    return { id: updated.id };
  });
}

export async function removeSalesQuotationLine(input: {
  businessId: string;
  userId: string;
  id: string;
  lineId: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const cap = salesQuotationLineCap(process.env.SALES_QUOTATION_MAX_LINES);
    const header = await loadQuotationHeader(tx, input.businessId, input.id);
    if (header.status !== "DRAFT") {
      throw new ApiError(
        409,
        SALES_QUOTATION_ERROR_CODES.IMMUTABLE,
        "Only DRAFT sales quotations can be changed.",
      );
    }

    const line = await tx.salesQuotationLine.findFirst({
      where: { id: input.lineId, salesQuotationId: header.id },
      select: { id: true, productId: true, qty: true },
    });
    if (!line) {
      throw new ApiError(404, SALES_QUOTATION_ERROR_CODES.LINE_NOT_FOUND, "Quotation line not found.");
    }

    await tx.salesQuotationLine.delete({ where: { id: line.id } });
    const lineCount = await tx.salesQuotationLine.count({ where: { salesQuotationId: header.id } });

    // §11 — discount law re-check (the subtotal may now be below it).
    if (lineCount > 0) {
      const subtotalMinor = await lineWriteSubtotalMinor(tx, header.id, cap);
      if (header.discountMinor > subtotalMinor) {
        throw new ApiError(
          422,
          SALES_QUOTATION_ERROR_CODES.INVALID_DISCOUNT,
          "Discount cannot exceed the quotation subtotal.",
        );
      }
    }

    await audit(
      auditInput(
        input.businessId,
        input.userId,
        "sales_quotation.line_remove",
        header.id,
        header.reference,
        { lineId: line.id, productId: line.productId, qty: line.qty, lineCount },
      ),
      tx,
    );

    return { removed: true, lineCount };
  });
}

/* ------------------------------ lifecycle transitions --------------------- */

/**
 * The shared in-transaction lifecycle gate (§8): reload + canonical matrix
 * + optional validity precondition. Every transition endpoint funnels
 * through here so the law lives in exactly ONE place.
 */
async function gateTransition(
  tx: Tx,
  input: { businessId: string; id: string; timezone: string },
  to: SalesQuotationStatus,
): Promise<{
  header: Awaited<ReturnType<typeof loadQuotationHeader>>;
  lines: Awaited<ReturnType<typeof loadCompleteLines>>;
}> {
  const cap = salesQuotationLineCap(process.env.SALES_QUOTATION_MAX_LINES);
  // Reload INSIDE the transaction; never trust an earlier GET (§8).
  const header = await loadQuotationHeader(tx, input.businessId, input.id);
  if (!canTransitionSalesQuotation(header.status, to)) {
    throw new ApiError(
      409,
      SALES_QUOTATION_ERROR_CODES.INVALID_TRANSITION,
      `Cannot move a sales quotation from ${header.status} to ${to}.`,
    );
  }
  const lines = await loadCompleteLines(tx, header.id, cap);
  return { header, lines };
}

/**
 * §10/§D — mark a DRAFT quotation SENT. Requires at least one line (an
 * empty offer can never be sent §10). sentAt is SERVER-generated inside
 * the transaction. This records an internal user's declaration that the
 * offer was sent OUTSIDE the application — the application does NOT
 * deliver email (§2.7) and the audit/UI never claims it did. After send,
 * the terms are immutable (§8).
 */
export async function markSalesQuotationSent(input: {
  businessId: string;
  userId: string;
  id: string;
  timezone: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const { header, lines } = await gateTransition(tx, input, "SENT");
    if (lines.length === 0) {
      throw new ApiError(
        422,
        SALES_QUOTATION_ERROR_CODES.EMPTY,
        "Add at least one line before marking this quotation sent.",
      );
    }
    // §11 — the canonical total must be exact and the discount lawful
    // before the terms freeze. The lines are already-persisted data: an
    // overflow here is the integrity path, never a user error.
    let totals;
    try {
      totals = computeQuotationSubtotalMinor(lines);
    } catch (error) {
      mapPureSalesQuotationDomainError(error);
    }
    try {
      validateQuotationDiscount(header.discountMinor, totals.subtotalMinor);
    } catch {
      mapPureSalesQuotationDomainError(
        new SalesQuotationIntegrityError(
          `${SALES_QUOTATION_ERROR_CODES.CORRUPT_HISTORY}: discount exceeds subtotal`,
        ),
      );
    }
    computeQuotationTotalMinor(totals.subtotalMinor, header.discountMinor);

    const sentAt = new Date();
    const updated = await tx.salesQuotation.update({
      where: { id: header.id },
      data: { status: "SENT", sentAt },
      select: { id: true, reference: true, status: true, sentAt: true },
    });

    await audit(
      auditInput(input.businessId, input.userId, "sales_quotation.mark_sent", header.id, header.reference, {
        lineCount: lines.length,
        subtotalMinor: totals.subtotalMinor,
        discountMinor: header.discountMinor,
        previousStatus: header.status,
        newStatus: updated.status,
        sentAt: updated.sentAt?.toISOString() ?? null,
        deliveryChannel: "outside_application", // §2.7 — honest semantics
      }),
      tx,
    );

    return {
      id: updated.id,
      reference: updated.reference,
      status: updated.status,
      sentAt: updated.sentAt,
    };
  });
}

/**
 * §8/§E — record customer acceptance of a SENT quotation. Allowed only
 * while the offer is still WITHIN its validity period in the
 * authenticated business timezone (server clock §9). acceptedAt is
 * SERVER-generated. This is an authorized internal user's declaration —
 * NOT a verified portal signature (§2.7). NO SalesOrder is created until
 * the explicit conversion operation (§13).
 */
export async function acceptSalesQuotation(input: {
  businessId: string;
  userId: string;
  id: string;
  timezone: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const { header } = await gateTransition(tx, input, "ACCEPTED");
    // §9 — the validity re-check runs INSIDE the write transaction (the
    // boundary may cross while the request is in flight).
    if (isQuotationExpiredInBusinessTz(header.validUntilDate, new Date(), input.timezone)) {
      throw new ApiError(
        409,
        SALES_QUOTATION_ERROR_CODES.EXPIRED,
        "This quotation is past its validity date and can no longer be accepted.",
      );
    }
    const acceptedAt = new Date();
    const updated = await tx.salesQuotation.update({
      where: { id: header.id },
      data: { status: "ACCEPTED", acceptedAt },
      select: { id: true, reference: true, status: true, acceptedAt: true },
    });

    await audit(
      auditInput(input.businessId, input.userId, "sales_quotation.accept", header.id, header.reference, {
        previousStatus: header.status,
        newStatus: updated.status,
        acceptedAt: updated.acceptedAt?.toISOString() ?? null,
        recordedBy: "authorized_internal_user", // §2.7 — honest semantics
      }),
      tx,
    );

    return {
      id: updated.id,
      reference: updated.reference,
      status: updated.status,
      acceptedAt: updated.acceptedAt,
    };
  });
}

/**
 * §8/§F — record the customer's rejection of a SENT quotation. Allowed
 * only while the offer is still within its validity period (§8). The
 * rejected offer is terminal and immutable.
 */
export async function rejectSalesQuotation(input: {
  businessId: string;
  userId: string;
  id: string;
  timezone: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const { header } = await gateTransition(tx, input, "REJECTED");
    if (isQuotationExpiredInBusinessTz(header.validUntilDate, new Date(), input.timezone)) {
      throw new ApiError(
        409,
        SALES_QUOTATION_ERROR_CODES.EXPIRED,
        "This quotation is past its validity date and can no longer be rejected.",
      );
    }
    const rejectedAt = new Date();
    const updated = await tx.salesQuotation.update({
      where: { id: header.id },
      data: { status: "REJECTED", rejectedAt },
      select: { id: true, reference: true, status: true, rejectedAt: true },
    });

    await audit(
      auditInput(input.businessId, input.userId, "sales_quotation.reject", header.id, header.reference, {
        previousStatus: header.status,
        newStatus: updated.status,
        rejectedAt: updated.rejectedAt?.toISOString() ?? null,
      }),
      tx,
    );

    return {
      id: updated.id,
      reference: updated.reference,
      status: updated.status,
      rejectedAt: updated.rejectedAt,
    };
  });
}

/**
 * §8 — cancel a DRAFT/SENT/ACCEPTED quotation (ACCEPTED cancellation is
 * the documented cancel-before-conversion policy and is legal only before
 * conversion — the transition matrix enforces that). Cancelling a
 * quotation NEVER touches inventory or finance (§1).
 */
export async function cancelSalesQuotation(input: {
  businessId: string;
  userId: string;
  id: string;
  timezone: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const { header } = await gateTransition(tx, input, "CANCELLED");
    const cancelledAt = new Date();
    const updated = await tx.salesQuotation.update({
      where: { id: header.id },
      data: { status: "CANCELLED", cancelledAt },
      select: { id: true, reference: true, status: true, cancelledAt: true },
    });

    await audit(
      auditInput(input.businessId, input.userId, "sales_quotation.cancel", header.id, header.reference, {
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

/**
 * §9 — the EXPLICIT expire transition for a SENT quotation that is past
 * its validity date. Legal ONLY when the offer has ACTUALLY expired in
 * the authenticated business timezone (a valid offer can never be
 * force-expired — the controlled 409 keeps the law honest). Atomic and
 * audited; the stored status becomes EXPIRED exactly once.
 */
export async function expireSalesQuotation(input: {
  businessId: string;
  userId: string;
  id: string;
  timezone: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const { header } = await gateTransition(tx, input, "EXPIRED");
    if (!isQuotationExpiredInBusinessTz(header.validUntilDate, new Date(), input.timezone)) {
      throw new ApiError(
        409,
        SALES_QUOTATION_ERROR_CODES.NOT_EXPIRED,
        "This quotation has not passed its validity date yet.",
      );
    }
    const updated = await tx.salesQuotation.update({
      where: { id: header.id },
      data: { status: "EXPIRED" },
      select: { id: true, reference: true, status: true },
    });

    await audit(
      auditInput(input.businessId, input.userId, "sales_quotation.expire", header.id, header.reference, {
        previousStatus: header.status,
        newStatus: updated.status,
        validUntilDate: header.validUntilDate.toISOString(),
      }),
      tx,
    );

    return {
      id: updated.id,
      reference: updated.reference,
      status: updated.status,
    };
  });
}

/* --------------------------- conversion (§13) ----------------------------- */

/**
 * §13 — THE conversion: an ACCEPTED quotation becomes exactly ONE
 * CONFIRMED SalesOrder. ONE atomic transaction:
 *   1. reload the quotation tenant-scoped;
 *   2. already-converted guard FIRST (the ONE stable conflict for every
 *      loser of any race — the P45 D-5 lesson), backed by the DB UNIQUE
 *      constraint on SalesOrder.sourceQuotationId (§7);
 *   3. persisted status law (ACCEPTED only — invalid → controlled 500,
 *      wrong-but-valid status → 409);
 *   4. complete, materially valid line set (§11);
 *   5. canonical totals recomputed from authoritative persisted lines;
 *   6. every snapshot validated (§12);
 *   7. ONE SalesOrder created CONFIRMED — customer snapshot, currency
 *      snapshot, expected date, discount copied EXACTLY; orderDate =
 *      current business-local date (established midnoon rule);
 *      internalNotes → SalesOrder.notes (staff-visible order notes —
 *      never the customer print view §16);
 *   8. ONE SalesOrderLine per quotation line — productId + frozen
 *      snapshots + exact qty/unitPriceMinor (NEVER re-priced from live
 *      Products §12/§13);
 *   9. order totals derived via the EXISTING SalesOrder domain functions;
 *  10. quotation → CONVERTED + convertedAt;
 *  11. audit ×2 (sales_order.create + sales_quotation.convert) in-tx;
 *  12. commit both documents together.
 *
 * NO Sale invoice, NO Payment, NO receivable, NO InventoryAdjustment, NO
 * stock reservation, NO Product.stockQty change (§13 invariants). NO
 * notification claims an invoice or payment occurred.
 */
export async function convertSalesQuotationToOrder(input: {
  businessId: string;
  userId: string;
  id: string;
  timezone: string;
  ip?: string | null;
  userAgent?: string | null;
}) {
  return withWriteTx(async (tx) => {
    const cap = salesQuotationLineCap(process.env.SALES_QUOTATION_MAX_LINES);
    // 1. tenant-scoped reload INSIDE the transaction (§13 step 1).
    const header = await loadQuotationHeader(tx, input.businessId, input.id);

    // 2. already-converted guard BEFORE the status gate (§13/D-5 lesson):
    //    every loser — including a retry after the winner committed —
    //    receives the ONE documented stable conflict code.
    const existingOrder = await tx.salesOrder.findFirst({
      where: { sourceQuotationId: header.id },
      select: { id: true, reference: true },
    });
    if (existingOrder) {
      throw new ApiError(
        409,
        SALES_QUOTATION_ERROR_CODES.ALREADY_CONVERTED,
        "This quotation has already been converted to a sales order.",
      );
    }

    // 3. persisted status law: an ACCEPTED quotation converts; a
    //    valid-but-wrong status is an ordinary conflict; a corrupted
    //    persisted status is the controlled integrity 500 (parseDbStatus).
    if (header.status !== "ACCEPTED") {
      if (
        header.status === "REJECTED" ||
        header.status === "EXPIRED" ||
        header.status === "CANCELLED"
      ) {
        throw new ApiError(
          409,
          SALES_QUOTATION_ERROR_CODES.NOT_ACCEPTED,
          "Only ACCEPTED sales quotations can be converted.",
        );
      }
      throw new ApiError(
        409,
        SALES_QUOTATION_ERROR_CODES.INVALID_STATUS,
        "Only ACCEPTED sales quotations can be converted.",
      );
    }
    // §9 — ACCEPTED never expires; conversion remains legal after the
    // original validity date passes because acceptance was already
    // recorded (documented §9 law).

    // 4–5. complete line set + canonical totals from persisted lines.
    const lines = await loadCompleteLines(tx, header.id, cap);
    if (lines.length === 0) {
      // An ACCEPTED quotation with zero lines is corruption (it could
      // never have passed mark-sent) — integrity, not a user error.
      mapPureSalesQuotationDomainError(
        new SalesQuotationIntegrityError(
          `${SALES_QUOTATION_ERROR_CODES.CORRUPT_HISTORY}: accepted quotation without lines`,
        ),
      );
    }
    // Persisted data: an accumulation overflow is the integrity path.
    let quotationTotals;
    try {
      quotationTotals = computeQuotationSubtotalMinor(lines);
    } catch (error) {
      mapPureSalesQuotationDomainError(error);
    }
    try {
      validateQuotationDiscount(header.discountMinor, quotationTotals.subtotalMinor);
    } catch {
      mapPureSalesQuotationDomainError(
        new SalesQuotationIntegrityError(
          `${SALES_QUOTATION_ERROR_CODES.CORRUPT_HISTORY}: discount exceeds subtotal`,
        ),
      );
    }
    const quotationTotalMinor = computeQuotationTotalMinor(
      quotationTotals.subtotalMinor,
      header.discountMinor,
    );

    // 6. every snapshot validated (§12/§13 step 6).
    validateHeaderSnapshots(header);

    // Order reference: the established SO generator, distinct sequence
    // domain (§10 — quotation and order references never share a sequence).
    let orderReference: string | undefined;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generateSalesOrderReference(new Date(), (max) => randomInt(max));
      const clash = await tx.salesOrder.findFirst({
        where: { businessId: input.businessId, reference: candidate },
        select: { id: true },
      });
      if (!clash) {
        orderReference = candidate;
        break;
      }
    }
    if (orderReference === undefined) {
      throw new ApiError(
        409,
        SALES_QUOTATION_ERROR_CODES.ALREADY_CONVERTED,
        "Could not generate a unique order reference. Please try again.",
      );
    }

    // §13 step 11 — orderDate is the CURRENT business-local date
    // normalized with the established UTC-midnoon rule (server clock).
    const orderDate = new Date(
      `${businessLocalCalendarDate(new Date(), input.timezone)}T12:00:00.000Z`,
    );
    const confirmedAt = new Date();

    // 7. ONE SalesOrder — CONFIRMED, source link established (§13 steps
    //    8–12/19/20). Customer/currency snapshots copied EXACTLY.
    let order;
    try {
      order = await tx.salesOrder.create({
        data: {
          businessId: input.businessId, // server-derived
          customerId: header.customerId,
          customerNameAtOrder: header.customerNameAtQuotation, // frozen §12
          reference: orderReference,
          status: "CONFIRMED", // acceptance = commercial commitment (§13)
          currencyCodeAtOrder: header.currencyCodeAtQuotation,
          currencySymbolAtOrder: header.currencySymbolAtQuotation,
          decimalPrecisionAtOrder: header.decimalPrecisionAtQuotation,
          orderDate,
          expectedDate: header.expectedDeliveryDate,
          discountMinor: header.discountMinor, // copied EXACTLY (§13 step 13)
          notes: header.internalNotes, // staff notes continuity (§13 step 14)
          createdByUserId: input.userId,
          confirmedAt, // §13 step 20 — server-side transaction time
          sourceQuotationId: header.id, // §13 step 23 — the ONE authority
        },
        select: { id: true, reference: true, status: true, confirmedAt: true },
      });
    } catch (error) {
      // The DB unique constraint is the FINAL race authority (§7/§13):
      // a concurrent winner (or an impossible prior conversion) surfaces
      // as the ONE stable conflict — never a second order.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ApiError(
          409,
          SALES_QUOTATION_ERROR_CODES.ALREADY_CONVERTED,
          "This quotation has already been converted to a sales order.",
        );
      }
      throw error;
    }

    // 8. ONE SalesOrderLine per quotation line — the FROZEN snapshots and
    //    exact agreed prices (§13 steps 15–17; never re-read/re-priced).
    //    The order subtotal is re-derived via the EXISTING order domain
    //    functions so both documents provably agree (§13 step 18).
    let orderSubtotalMinor = 0;
    try {
      for (const line of lines) {
        await tx.salesOrderLine.create({
          data: {
            salesOrderId: order.id,
            productId: line.productId,
            orderedQty: line.qty, // exact quantity (§13 step 17)
            unitPriceMinor: line.unitPriceMinor, // exact agreed price
            productNameAtOrder: line.productNameAtQuotation,
            skuAtOrder: line.skuAtQuotation,
            unitAtOrder: line.unitAtQuotation,
          },
          select: { id: true },
        });
        orderSubtotalMinor += computeQuotationLineTotalMinor(line.qty, line.unitPriceMinor);
      }
      if (!Number.isSafeInteger(orderSubtotalMinor)) {
        throw new SalesQuotationIntegrityError(
          `${SALES_QUOTATION_ERROR_CODES.TOTAL_OVERFLOW}: order subtotal overflow during conversion`,
        );
      }
      // §13 step 18 — derive the order totals via the EXISTING domain
      // functions; quotation and order totals MUST agree exactly.
      const orderTotals = computeOrderSubtotalMinor(
        lines.map((l) => ({ orderedQty: l.qty, unitPriceMinor: l.unitPriceMinor })),
      );
      if (orderTotals.subtotalMinor !== quotationTotals.subtotalMinor) {
        mapPureSalesQuotationDomainError(
          new SalesQuotationIntegrityError(
            `${SALES_QUOTATION_ERROR_CODES.CORRUPT_HISTORY}: quotation/order subtotal disagreement`,
          ),
        );
      }
    } catch (error) {
      // §13/H — a failure here aborts the WHOLE transaction: no partial
      // order, no partially copied lines, no CONVERTED quotation, no
      // stray audit (withWriteTx rolls back everything). Domain integrity
      // failures surface through the ONE stable mapping.
      mapPureSalesQuotationDomainError(error);
    }

    // 10. quotation → CONVERTED + convertedAt (§13 steps 21–22).
    const convertedAt = new Date();
    await tx.salesQuotation.update({
      where: { id: header.id },
      data: { status: "CONVERTED", convertedAt },
      select: { id: true },
    });

    // 11. audit ×2, SAME transaction (§13 step 24). Minimal safe payloads;
    //     never the notes contents.
    await audit(
      {
        businessId: input.businessId,
        actorId: input.userId,
        action: "sales_order.create",
        entityType: "SalesOrder",
        entityId: order.id,
        after: {
          reference: order.reference,
          sourceQuotationId: header.id,
          sourceQuotationReference: header.reference,
          status: order.status,
          lineCount: lines.length,
          subtotalMinor: quotationTotals.subtotalMinor,
          discountMinor: header.discountMinor,
          totalMinor: quotationTotalMinor,
        },
      },
      tx,
    );
    await audit(
      auditInput(input.businessId, input.userId, "sales_quotation.convert", header.id, header.reference, {
        salesOrderId: order.id,
        salesOrderReference: order.reference,
        lineCount: lines.length,
        subtotalMinor: quotationTotals.subtotalMinor,
        discountMinor: header.discountMinor,
        totalMinor: quotationTotalMinor,
        previousStatus: header.status,
        newStatus: "CONVERTED",
        convertedAt: convertedAt.toISOString(),
      }),
      tx,
    );

    // 12. both documents commit together (§13 step 25).
    return {
      quotationId: header.id,
      quotationReference: header.reference,
      salesOrder: order,
    };
  });
}

/* ---------------------- entity-detail integration (§19) ------------------- */

/**
 * §19 — bounded, read-only quotation history for the Customer 360 (≤10).
 * Snapshot statuses + effective status; convertedOrderReference ONLY when
 * the relation exists. Corrupted rows fail the whole bounded read safely.
 */
export async function recentQuotationsForCustomer(
  businessId: string,
  customerId: string,
  take = 10,
): Promise<CustomerRecentSalesQuotationDto[]> {
  const cap = salesQuotationLineCap(process.env.SALES_QUOTATION_MAX_LINES);
  const now = new Date();
  const rows = await db.salesQuotation.findMany({
    where: { businessId, customerId }, // tenant-scoped (§19)
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: {
      id: true,
      reference: true,
      status: true,
      quotationDate: true,
      validUntilDate: true,
      currencyCodeAtQuotation: true,
      currencySymbolAtQuotation: true,
      decimalPrecisionAtQuotation: true,
      discountMinor: true,
      createdAt: true,
      convertedSalesOrder: { select: { reference: true } },
      lines: { select: { qty: true, unitPriceMinor: true }, take: cap + 1 },
      _count: { select: { lines: true } },
    },
  });
  return rows.map((row) => {
    const persistedStatus = parseDbStatus(row.status);
    const effectiveStatus = effectiveQuotationStatus(persistedStatus, row.validUntilDate, now, null);
    assertSalesQuotationLineSetComplete(row.lines.length, row._count.lines, cap);
    const subtotalMinor = computeQuotationSubtotalMinor(row.lines).subtotalMinor;
    const totalMinor = computeQuotationTotalMinor(subtotalMinor, row.discountMinor);
    return customerRecentSalesQuotationDto({
      id: row.id,
      reference: row.reference,
      persistedStatus,
      effectiveStatus,
      quotationDate: row.quotationDate,
      currencyCodeAtQuotation: row.currencyCodeAtQuotation,
      currencySymbolAtQuotation: row.currencySymbolAtQuotation,
      decimalPrecisionAtQuotation: row.decimalPrecisionAtQuotation,
      totalMinor,
      totalQty: row.lines.reduce((acc, l) => acc + l.qty, 0),
      convertedOrderReference: row.convertedSalesOrder?.reference ?? null,
    });
  });
}

/**
 * §19 — bounded, read-only quotation history for the Product detail (≤10).
 * QUANTITIES ONLY — NO money on product surfaces (the established §72 law).
 */
export async function recentQuotationsForProduct(
  businessId: string,
  productId: string,
  take = 10,
): Promise<ProductRecentSalesQuotationDto[]> {
  const cap = salesQuotationLineCap(process.env.SALES_QUOTATION_MAX_LINES);
  const now = new Date();
  const rows = await db.salesQuotationLine.findMany({
    where: { productId, salesQuotation: { businessId } }, // tenant-scoped (§19)
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
    select: {
      qty: true,
      salesQuotation: {
        select: {
          id: true,
          reference: true,
          status: true,
          customerNameAtQuotation: true,
          quotationDate: true,
          validUntilDate: true,
        },
      },
    },
  });
  return rows.map((row) => {
    const persistedStatus = parseDbStatus(row.salesQuotation.status);
    const effectiveStatus = effectiveQuotationStatus(
      persistedStatus,
      row.salesQuotation.validUntilDate,
      now,
      null,
    );
    return productRecentSalesQuotationDto({
      id: row.salesQuotation.id,
      reference: row.salesQuotation.reference,
      customerNameAtQuotation: row.salesQuotation.customerNameAtQuotation,
      persistedStatus,
      effectiveStatus,
      quotationDate: row.salesQuotation.quotationDate,
      qty: row.qty,
    });
  });
}
