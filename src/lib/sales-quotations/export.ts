import "server-only";

/**
 * Prompt 47 — Sales Quotation CSV export (§15/§20).
 *
 * LAWS (inherited verbatim from the audited P42–P45 exports):
 *  - ONE source of truth: lines are validated through the SAME canonical
 *    helpers the detail API uses — historical snapshots, never live names.
 *  - The export covers ALL lines of the quotation, never one page. Bounded
 *    BY DESIGN: a quotation can never exceed SALES_QUOTATION_MAX_LINES, so
 *    a single cap+1 fetch is provably complete; over-cap persisted data
 *    returns the controlled integrity error rather than a partial CSV
 *    (§20 — never a truncated quote export as valid).
 *  - Every cell passes the shared csvCell() OWASP formula guard (inside
 *    toCsv) — injection-safe (=1+1, +cmd, @cmd, -tab).
 *  - EN CSV gets English headers, FA CSV Persian headers (no English
 *    fallback in FA).
 *  - Product/customer identity from snapshot columns ONLY.
 *  - A corrupted persisted status is a controlled 500 (the CSV never
 *    labels unknown DB state as Draft).
 *  - Money columns stay integer minor units (the agreed commercial offer).
 *  - NO internal notes column — internalNotes never leave the staff view
 *    (§10/§16/§20).
 */
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-helpers";
import { toCsv } from "@/lib/csv";
import { messagesFor } from "@/i18n/messages";
import {
  computeQuotationLineTotalMinor,
  computeQuotationSubtotalMinor,
  computeQuotationTotalMinor,
  isValidQuotationPrice,
  isValidPersistedQuotationQty,
  parseSalesQuotationStatus,
  salesQuotationLineCap,
  SalesQuotationIntegrityError,
  SALES_QUOTATION_ERROR_CODES,
  SALES_QUOTATION_LINE_CAP_INVARIANT,
} from "./types";
import { mapPureSalesQuotationDomainError } from "./integration";

export type SalesQuotationCsvResult = {
  csv: string;
  filename: string;
  reference: string;
  lineCount: number;
  truncated: boolean;
};

/** Business-facing, filesystem-safe reference slug (never raw user input). */
export function salesQuotationReferenceSlug(reference: string): string {
  const slug = reference
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "sales-quotation";
}

export async function buildSalesQuotationCsv(input: {
  businessId: string;
  id: string;
  locale: "en" | "fa";
}): Promise<SalesQuotationCsvResult> {
  const header = await db.salesQuotation.findFirst({
    where: { id: input.id, businessId: input.businessId }, // tenant scope
    select: {
      id: true,
      reference: true,
      status: true,
      customerNameAtQuotation: true,
      currencyCodeAtQuotation: true,
      quotationDate: true,
      validUntilDate: true,
      discountMinor: true,
    },
  });
  if (!header) throw new ApiError(404, SALES_QUOTATION_ERROR_CODES.NOT_FOUND, "Sales quotation not found.");

  // The export uses the ONE centralized status parser: a corrupted
  // persisted status is a controlled 500 integrity error — the CSV NEVER
  // labels unknown DB state as "Draft" (§8 applies to export too).
  let status;
  try {
    status = parseSalesQuotationStatus(header.status);
  } catch (error) {
    mapPureSalesQuotationDomainError(error);
  }

  const cap = salesQuotationLineCap(process.env.SALES_QUOTATION_MAX_LINES);
  // take: cap + 1 proves completeness — cap+1 rows would mean the
  // quotation exceeded its own line cap (impossible by the cap law), and
  // the export would fail with the integrity error instead of lying (§11).
  const lineRows = await db.salesQuotationLine.findMany({
    where: { salesQuotationId: header.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], // same deterministic order as detail
    take: cap + 1,
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

  const truncated = lineRows.length > cap;
  let lines;
  try {
    if (truncated) {
      // Persisted data exceeding the cap is corruption: the export
      // returns the controlled integrity error rather than a partial CSV.
      throw new SalesQuotationIntegrityError(
        `${SALES_QUOTATION_LINE_CAP_INVARIANT}: export rows exceed the document cap`,
      );
    }
    // Every persisted line is validated through the canonical laws
    // (§6/§11) before it can appear in an export.
    for (const line of lineRows) {
      if (!isValidPersistedQuotationQty(line.qty) || !isValidQuotationPrice(line.unitPriceMinor)) {
        throw new SalesQuotationIntegrityError(
          `${SALES_QUOTATION_ERROR_CODES.CORRUPT_HISTORY}: invalid persisted line`,
        );
      }
    }
    lines = lineRows.map((l) => ({
      productNameAtQuotation: l.productNameAtQuotation,
      skuAtQuotation: l.skuAtQuotation,
      unitAtQuotation: l.unitAtQuotation,
      qty: l.qty,
      unitPriceMinor: l.unitPriceMinor,
      lineTotalMinor: computeQuotationLineTotalMinor(l.qty, l.unitPriceMinor),
    }));
  } catch (error) {
    if (error instanceof SalesQuotationIntegrityError) {
      mapPureSalesQuotationDomainError(error);
    }
    throw error;
  }

  const totals = computeQuotationSubtotalMinor(lines);
  const totalMinor = computeQuotationTotalMinor(totals.subtotalMinor, header.discountMinor);

  const m = messagesFor(input.locale).salesQuotations;
  const statusLabel = m[`status_${status}`];

  // Flat extract: one row per line; document-level fields denormalized on
  // each row (snapshot fields verbatim; money exact minor units; NO
  // internal-notes column).
  const rows = lines.map((l) => [
    header.reference,
    statusLabel,
    header.customerNameAtQuotation,
    header.currencyCodeAtQuotation,
    header.quotationDate.toISOString().slice(0, 10),
    header.validUntilDate.toISOString().slice(0, 10),
    l.productNameAtQuotation,
    l.skuAtQuotation ?? "",
    l.unitAtQuotation ?? "",
    l.qty,
    l.unitPriceMinor,
    l.lineTotalMinor,
    header.discountMinor,
    totalMinor,
  ]);

  const csv = toCsv(
    [
      m.csvReference,
      m.csvStatus,
      m.csvCustomer,
      m.csvCurrency,
      m.csvQuotationDate,
      m.csvValidUntil,
      m.csvProduct,
      m.csvSku,
      m.csvUnit,
      m.csvQty,
      m.csvUnitPrice,
      m.csvLineTotal,
      m.csvDiscount,
      m.csvTotal,
    ],
    rows,
  );

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const filename = `sales-quotation-${salesQuotationReferenceSlug(header.reference)}-${stamp}.csv`;

  return { csv, filename, reference: header.reference, lineCount: lines.length, truncated };
}
