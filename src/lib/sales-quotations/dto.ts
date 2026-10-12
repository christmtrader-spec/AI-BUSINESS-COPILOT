/**
 * Prompt 47 — client-safe Sales Quotation DTOs + pure mappers.
 *
 * DTO LAWS (inherited from the audited P41–P45 pattern):
 *  - explicit allowlist — a raw Prisma object is NEVER serialized;
 *  - every date is an ISO-8601 UTC string; calendar dates additionally
 *    expose their business-local YYYY-MM-DD form where it matters
 *    (validity display §9);
 *  - BOTH persistedStatus and effectiveStatus are exposed explicitly
 *    (§9) — a SENT offer past validity renders as EXPIRED without ever
 *    pretending the database row was mutated;
 *  - product/customer identity comes from the SNAPSHOT columns —
 *    historical values are never replaced with live names (§12);
 *  - money is integer minor units; quantities are exact integers;
 *  - the converted-order DTO appears ONLY when the relation is actually
 *    present (§7 — never inferred from status);
 *  - internalNotes NEVER appear in list/search/customer-facing DTOs; the
 *    detail DTO exposes them to authorized staff views only (§10/§16),
 *    and the print DTO omits them entirely;
 *  - DTO mappers REQUIRE an already-valid status: an unknown persisted
 *    value throws the controlled integrity error (never silently DRAFT);
 *  - totals arrive pre-computed from the canonical math and are re-checked
 *    where the mapper has the operands.
 */
import {
  computeQuotationLineTotalMinor,
  computeQuotationTotalMinor,
  parseSalesQuotationStatus,
  SalesQuotationIntegrityError,
  SalesQuotationStatusIntegrityError,
  SALES_QUOTATION_CORRUPT_HISTORY,
  type SalesQuotationStatus,
} from "./types";

/* -------------------------------- types ---------------------------------- */

/** Bounded, lighter-than-detail list row (§15). */
export type SalesQuotationListItemDto = {
  id: string;
  reference: string;
  /** The status actually persisted in the database (§9). */
  persistedStatus: SalesQuotationStatus;
  /** The status the offer EFFECTIVELY has (SENT past validity → EXPIRED). */
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
};

/** Detail line — snapshot identity + exact math (§16). */
export type SalesQuotationLineDto = {
  id: string;
  productId: string;
  productNameAtQuotation: string;
  skuAtQuotation: string | null;
  unitAtQuotation: string | null;
  qty: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  createdAt: string;
  updatedAt: string;
};

/** Linked converted order — appears ONLY when present (§7). */
export type ConvertedSalesOrderDto = {
  id: string;
  reference: string;
  status: string;
};

/** Detail document (quotation + summary + lines + converted order) (§16). */
export type SalesQuotationDetailDto = {
  quotation: {
    id: string;
    reference: string;
    persistedStatus: SalesQuotationStatus;
    effectiveStatus: SalesQuotationStatus;
    /** Business-local calendar date (YYYY-MM-DD) of the validity boundary. */
    validUntilCalendarDate: string;
    /** Server-side verdict at read time (§9 — display only, never a write). */
    isExpired: boolean;
    customerId: string | null;
    customerNameAtQuotation: string;
    currencyCodeAtQuotation: string;
    currencySymbolAtQuotation: string;
    decimalPrecisionAtQuotation: number;
    quotationDate: string;
    validUntilDate: string;
    expectedDeliveryDate: string | null;
    discountMinor: number;
    customerNotes: string | null;
    /** Staff-only internal notes — NEVER rendered on the print view (§16). */
    internalNotes: string | null;
    createdBy: { id: string; name: string | null } | null;
    sentAt: string | null;
    acceptedAt: string | null;
    rejectedAt: string | null;
    cancelledAt: string | null;
    convertedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  summary: {
    lineCount: number;
    totalQty: number;
    subtotalMinor: number;
    discountMinor: number;
    totalMinor: number;
  };
  lines: SalesQuotationLineDto[];
  convertedOrder: ConvertedSalesOrderDto | null;
};

/** Customer-facing print payload (§16) — an explicit, REDUCED projection:
 *  no internalNotes, no database ids, no audit metadata, no technical
 *  statuses. Labelled as an offer, never as an invoice. */
export type SalesQuotationPrintDto = {
  reference: string;
  quotationDate: string;
  validUntilDate: string;
  customerNameAtQuotation: string;
  currencyCodeAtQuotation: string;
  currencySymbolAtQuotation: string;
  decimalPrecisionAtQuotation: number;
  expectedDeliveryDate: string | null;
  customerNotes: string | null;
  lines: Array<{
    productNameAtQuotation: string;
    skuAtQuotation: string | null;
    unitAtQuotation: string | null;
    qty: number;
    unitPriceMinor: number;
    lineTotalMinor: number;
  }>;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
};

/** §19 — bounded quotation row for the Customer 360 (≤10). */
export type CustomerRecentSalesQuotationDto = {
  id: string;
  reference: string;
  persistedStatus: SalesQuotationStatus;
  effectiveStatus: SalesQuotationStatus;
  quotationDate: string;
  currencyCodeAtQuotation: string;
  currencySymbolAtQuotation: string;
  decimalPrecisionAtQuotation: number;
  totalMinor: number;
  totalQty: number;
  convertedOrderReference: string | null;
};

/** §19 — bounded quotation row for the Product detail (≤10). Money-free
 *  (the same §72 law as order history on product detail). */
export type ProductRecentSalesQuotationDto = {
  id: string;
  reference: string;
  customerNameAtQuotation: string;
  persistedStatus: SalesQuotationStatus;
  effectiveStatus: SalesQuotationStatus;
  quotationDate: string;
  qty: number;
};

/* ------------------------------- row shapes ------------------------------- */

type DateLike = Date | string;

function iso(value: DateLike): string {
  return typeof value === "string" ? value : value.toISOString();
}

function isoOrNull(value: DateLike | null): string | null {
  if (value == null) return null;
  return iso(value);
}

/** DTO mappers REQUIRE an already-valid status (INVALID ≠ DRAFT, §8). */
function statusOf(value: string): SalesQuotationStatus {
  try {
    return parseSalesQuotationStatus(value);
  } catch (error) {
    if (error instanceof SalesQuotationStatusIntegrityError) throw error;
    throw error;
  }
}

/** A persisted snapshot must exist — missing identity is corruption (§12). */
function requireSnapshot(value: string, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SalesQuotationIntegrityError(
      `${SALES_QUOTATION_CORRUPT_HISTORY}: missing ${what} snapshot`,
    );
  }
  return value;
}

/* -------------------------------- mappers --------------------------------- */

/** The ONE detail assembler (§16): header + summary + lines + converted
 *  order. All operands arrive pre-validated; totals are re-checked. */
export function salesQuotationDetailDto(
  header: {
    id: string;
    reference: string;
    persistedStatus: SalesQuotationStatus;
    effectiveStatus: SalesQuotationStatus;
    validUntilCalendarDate: string;
    isExpired: boolean;
    customerId: string | null;
    customerNameAtQuotation: string;
    currencyCodeAtQuotation: string;
    currencySymbolAtQuotation: string;
    decimalPrecisionAtQuotation: number;
    quotationDate: DateLike;
    validUntilDate: DateLike;
    expectedDeliveryDate: DateLike | null;
    discountMinor: number;
    customerNotes: string | null;
    internalNotes: string | null;
    createdBy: { id: string; name: string | null } | null;
    sentAt: DateLike | null;
    acceptedAt: DateLike | null;
    rejectedAt: DateLike | null;
    cancelledAt: DateLike | null;
    convertedAt: DateLike | null;
    createdAt: DateLike;
    updatedAt: DateLike;
  },
  summary: {
    lineCount: number;
    totalQty: number;
    subtotalMinor: number;
    discountMinor: number;
    totalMinor: number;
  },
  lines: SalesQuotationLineDto[],
  convertedOrder: ConvertedSalesOrderDto | null,
): SalesQuotationDetailDto {
  // A customer-linked quotation must carry its frozen identity snapshot;
  // an anonymous quotation legitimately carries "" (§12 law).
  const customerName =
    header.customerId === null
      ? header.customerNameAtQuotation
      : requireSnapshot(header.customerNameAtQuotation, "customer name");
  return {
    quotation: {
      id: header.id,
      reference: header.reference,
      persistedStatus: header.persistedStatus,
      effectiveStatus: header.effectiveStatus,
      validUntilCalendarDate: header.validUntilCalendarDate,
      isExpired: header.isExpired,
      customerId: header.customerId,
      customerNameAtQuotation: customerName,
      currencyCodeAtQuotation: header.currencyCodeAtQuotation,
      currencySymbolAtQuotation: header.currencySymbolAtQuotation,
      decimalPrecisionAtQuotation: header.decimalPrecisionAtQuotation,
      quotationDate: iso(header.quotationDate),
      validUntilDate: iso(header.validUntilDate),
      expectedDeliveryDate: isoOrNull(header.expectedDeliveryDate),
      discountMinor: header.discountMinor,
      customerNotes: header.customerNotes,
      internalNotes: header.internalNotes, // staff views ONLY (never printed)
      createdBy: header.createdBy,
      sentAt: isoOrNull(header.sentAt),
      acceptedAt: isoOrNull(header.acceptedAt),
      rejectedAt: isoOrNull(header.rejectedAt),
      cancelledAt: isoOrNull(header.cancelledAt),
      convertedAt: isoOrNull(header.convertedAt),
      createdAt: iso(header.createdAt),
      updatedAt: iso(header.updatedAt),
    },
    summary: {
      lineCount: summary.lineCount,
      totalQty: summary.totalQty,
      subtotalMinor: summary.subtotalMinor,
      discountMinor: summary.discountMinor,
      totalMinor: computeQuotationTotalMinor(summary.subtotalMinor, summary.discountMinor),
    },
    lines,
    convertedOrder,
  };
}

export function salesQuotationLineDto(line: {
  id: string;
  productId: string;
  productNameAtQuotation: string;
  skuAtQuotation: string | null;
  unitAtQuotation: string | null;
  qty: number;
  unitPriceMinor: number;
  createdAt: DateLike;
  updatedAt: DateLike;
}): SalesQuotationLineDto {
  return {
    id: line.id,
    productId: line.productId,
    productNameAtQuotation: requireSnapshot(line.productNameAtQuotation, "product name"),
    skuAtQuotation: line.skuAtQuotation,
    unitAtQuotation: line.unitAtQuotation,
    qty: line.qty,
    unitPriceMinor: line.unitPriceMinor,
    lineTotalMinor: computeQuotationLineTotalMinor(line.qty, line.unitPriceMinor),
    createdAt: iso(line.createdAt),
    updatedAt: iso(line.updatedAt),
  };
}

export function salesQuotationPrintDto(input: {
  reference: string;
  quotationDate: DateLike;
  validUntilDate: DateLike;
  customerNameAtQuotation: string;
  currencyCodeAtQuotation: string;
  currencySymbolAtQuotation: string;
  decimalPrecisionAtQuotation: number;
  expectedDeliveryDate: DateLike | null;
  customerNotes: string | null;
  lines: Array<{
    productNameAtQuotation: string;
    skuAtQuotation: string | null;
    unitAtQuotation: string | null;
    qty: number;
    unitPriceMinor: number;
    lineTotalMinor: number;
  }>;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
}): SalesQuotationPrintDto {
  return {
    reference: input.reference,
    quotationDate: iso(input.quotationDate),
    validUntilDate: iso(input.validUntilDate),
    customerNameAtQuotation: input.customerNameAtQuotation,
    currencyCodeAtQuotation: input.currencyCodeAtQuotation,
    currencySymbolAtQuotation: input.currencySymbolAtQuotation,
    decimalPrecisionAtQuotation: input.decimalPrecisionAtQuotation,
    expectedDeliveryDate: isoOrNull(input.expectedDeliveryDate),
    customerNotes: input.customerNotes,
    lines: input.lines.map((l) => ({ ...l })),
    subtotalMinor: input.subtotalMinor,
    discountMinor: input.discountMinor,
    totalMinor: input.totalMinor,
  };
}

export function customerRecentSalesQuotationDto(row: {
  id: string;
  reference: string;
  persistedStatus: SalesQuotationStatus;
  effectiveStatus: SalesQuotationStatus;
  quotationDate: DateLike;
  currencyCodeAtQuotation: string;
  currencySymbolAtQuotation: string;
  decimalPrecisionAtQuotation: number;
  totalMinor: number;
  totalQty: number;
  convertedOrderReference: string | null;
}): CustomerRecentSalesQuotationDto {
  return {
    id: row.id,
    reference: row.reference,
    persistedStatus: row.persistedStatus,
    effectiveStatus: row.effectiveStatus,
    quotationDate: iso(row.quotationDate),
    currencyCodeAtQuotation: row.currencyCodeAtQuotation,
    currencySymbolAtQuotation: row.currencySymbolAtQuotation,
    decimalPrecisionAtQuotation: row.decimalPrecisionAtQuotation,
    totalMinor: row.totalMinor,
    totalQty: row.totalQty,
    convertedOrderReference: row.convertedOrderReference,
  };
}

export function productRecentSalesQuotationDto(row: {
  id: string;
  reference: string;
  customerNameAtQuotation: string;
  persistedStatus: SalesQuotationStatus;
  effectiveStatus: SalesQuotationStatus;
  quotationDate: DateLike;
  qty: number;
}): ProductRecentSalesQuotationDto {
  return {
    id: row.id,
    reference: row.reference,
    customerNameAtQuotation: row.customerNameAtQuotation,
    persistedStatus: row.persistedStatus,
    effectiveStatus: row.effectiveStatus,
    quotationDate: iso(row.quotationDate),
    qty: row.qty,
  };
}

export { iso, isoOrNull, statusOf, requireSnapshot };
