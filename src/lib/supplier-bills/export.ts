import "server-only";

/**
 * Prompt 48 — Supplier Bill CSV export (§15/§20).
 *
 * LAWS (inherited verbatim from the audited P42–P47 exports):
 *  - ONE source of truth: lines are validated through the SAME canonical
 *    helpers the detail API uses — historical snapshots, never live names.
 *  - The export covers ALL lines of the bill, never one page. Bounded BY
 *    DESIGN: a bill can never exceed SUPPLIER_BILL_MAX_LINES, so a single
 *    cap+1 fetch is provably complete; over-cap persisted data returns the
 *    controlled integrity error rather than a partial CSV (§20 — never a
 *    truncated bill export looking valid).
 *  - Every cell passes the shared csvCell() OWASP formula guard (inside
 *    toCsv) — injection-safe (=1+1, +cmd, @cmd, -tab).
 *  - EN CSV gets English headers, FA CSV Persian headers (no English
 *    fallback in FA).
 *  - Supplier/PO/product identity from snapshot columns ONLY.
 *  - A corrupted persisted status is a controlled 500 (the CSV never
 *    labels unknown DB state as Draft).
 *  - Money columns stay integer minor units EXACTLY as stored; the price
 *    comparison snapshot (PO unit price) is exported alongside the invoiced
 *    unit price (§20 — variance evidence survives export).
 *  - NO internal notes column — internalNotes never leave the staff view
 *    (§16/§20).
 */
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-helpers";
import { toCsv } from "@/lib/csv";
import { messagesFor } from "@/i18n/messages";
import {
  parseSupplierBillStatus,
  supplierBillLineCap,
  SUPPLIER_BILL_ERROR_CODES,
} from "./types";
import { mapPureSupplierBillDomainError } from "./service";

export type SupplierBillCsvResult = {
  csv: string;
  filename: string;
  reference: string;
  lineCount: number;
  truncated: boolean;
};

/** Business-facing, filesystem-safe reference slug (never raw user input). */
export function supplierBillReferenceSlug(reference: string): string {
  const slug = reference
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "supplier-bill";
}

export async function buildSupplierBillCsv(input: {
  businessId: string;
  id: string;
  locale: "en" | "fa";
}): Promise<SupplierBillCsvResult> {
  const header = await db.supplierBill.findFirst({
    where: { id: input.id, businessId: input.businessId }, // tenant scope
    select: {
      id: true,
      reference: true,
      status: true,
      supplierInvoiceReference: true,
      supplierNameAtBill: true,
      purchaseOrderReferenceAtBill: true,
      currencyCodeAtBill: true,
      billDate: true,
      dueDate: true,
      subtotalMinor: true,
      discountMinor: true,
      totalMinor: true,
    },
  });
  if (!header) throw new ApiError(404, SUPPLIER_BILL_ERROR_CODES.NOT_FOUND, "Supplier bill not found.");

  // The export uses the ONE centralized status parser: a corrupted
  // persisted status is a controlled 500 integrity error — the CSV NEVER
  // labels unknown DB state as "Draft".
  let status;
  try {
    status = parseSupplierBillStatus(header.status);
  } catch (error) {
    mapPureSupplierBillDomainError(error);
  }

  const cap = supplierBillLineCap(process.env.SUPPLIER_BILL_MAX_LINES);
  // take: cap + 1 proves completeness — cap+1 rows would mean the bill
  // exceeded its own line cap (impossible by the cap law), and the export
  // would fail with the integrity error instead of lying.
  const lineRows = await db.supplierBillLine.findMany({
    where: { supplierBillId: header.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], // same deterministic order as detail
    take: cap + 1,
    select: {
      billedQty: true,
      unitPriceMinor: true,
      lineTotalMinor: true,
      productNameAtBill: true,
      skuAtBill: true,
      unitAtBill: true,
      purchaseOrderUnitPriceMinor: true,
    },
  });
  const truncated = lineRows.length > cap;
  if (truncated) {
    // Over-cap persisted data is corruption — never export a partial
    // document as if it were complete (§20 completeness law).
    throw new ApiError(
      500,
      SUPPLIER_BILL_ERROR_CODES.LINE_CAP_INVARIANT,
      "Stored document data exceeds its configured line cap. Please contact support.",
    );
  }

  const m = messagesFor(input.locale).supplierBills;
  const filename = `${m.csvFilenamePrefix}-${supplierBillReferenceSlug(header.reference)}.csv`;

  // Exact stored integer minor units — no float formatting anywhere.
  const rows = lineRows.map((line) => [
    line.productNameAtBill,
    line.skuAtBill ?? "",
    line.unitAtBill ?? "",
    String(line.billedQty),
    String(line.unitPriceMinor),
    String(line.purchaseOrderUnitPriceMinor),
    String(line.unitPriceMinor - line.purchaseOrderUnitPriceMinor),
    String(line.lineTotalMinor),
  ]);

  const csv = toCsv(
    [
      m.csvProduct,
      m.csvSku,
      m.csvUnit,
      m.csvBilledQty,
      m.csvInvoicedUnitPrice,
      m.csvPoUnitPrice,
      m.csvPriceVariance,
      m.csvLineTotal,
    ],
    rows,
  );

  return {
    csv,
    filename,
    reference: header.reference,
    lineCount: lineRows.length,
    truncated: false,
  };
}
