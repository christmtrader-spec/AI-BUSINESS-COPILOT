/**
 * Prompt 33 — explicit DTO/candidate mappers (§9/§21).
 *
 * Full Prisma rows are NEVER serialized. Every entity maps through an
 * explicit builder with an explicit `select` upstream in query.ts.
 * Data-minimization rules applied here:
 *   - no addresses/notes as TITLES (notes only as secondary match fields §5.1)
 *   - no prices (cost/sale) anywhere (§5.3)
 *   - no amounts (§5.5)
 *   - no provider/gateway/checkout/platform data (§5.6/§42)
 */
import { formatInvoiceNumber } from "@/lib/finance";
import { normalizeSearchText } from "./normalize";
import type { SearchCandidate, SearchItemMethod, SearchItemStatus } from "./types";

/** Status whitelist guard — unknown DB strings never leave the server. */
function saleStatus(status: string): SearchItemStatus | null {
  return status === "UNPAID" || status === "PARTIAL" || status === "PAID"
    ? status
    : null;
}

function paymentMethod(method: string): SearchItemMethod | null {
  return method === "CASH" ||
    method === "BANK_TRANSFER" ||
    method === "CARD" ||
    method === "OTHER"
    ? method
    : null;
}

// ---------------------------------------------------------------------------
// Row shapes — structural (kept Prisma-free so pure units can import this)
// ---------------------------------------------------------------------------

export type CustomerRow = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  createdAt: Date;
};

export type SupplierRow = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  createdAt: Date;
};

export type ProductRow = {
  id: string;
  name: string;
  sku: string | null;
  isActive: boolean;
  createdAt: Date;
};

export type SaleRow = {
  id: string;
  number: number;
  status: string;
  issueDate: Date;
  note: string | null;
  createdAt: Date;
  customer: { name: string } | null;
};

export type ExpenseRow = {
  id: string;
  category: string;
  status: string;
  spentAt: Date;
  note: string | null;
  createdAt: Date;
  supplier: { name: string } | null;
};

export type PaymentRow = {
  id: string;
  direction: string;
  method: string;
  paidAt: Date;
  note: string | null;
  createdAt: Date;
  sale: { number: number; customer: { name: string } | null } | null;
  expense: { category: string; supplier: { name: string } | null } | null;
};

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function customerCandidate(row: CustomerRow): SearchCandidate {
  const subtitle = row.phone ?? row.email;
  return {
    id: row.id,
    type: "CUSTOMER",
    title: row.name,
    titleNorm: normalizeSearchText(row.name),
    subtitle,
    identifierNorm: null,
    identifierExtras: [],
    numericIdentifier: null,
    secondaryNorms: [row.phone, row.email]
      .filter((v): v is string => Boolean(v))
      .map(normalizeSearchText),
    createdAt: row.createdAt,
    status: null,
    date: null,
    direction: null,
    method: null,
  };
}

export function supplierCandidate(row: SupplierRow): SearchCandidate {
  const subtitle = row.phone ?? row.email;
  return {
    id: row.id,
    type: "SUPPLIER",
    title: row.name,
    titleNorm: normalizeSearchText(row.name),
    subtitle,
    identifierNorm: null,
    identifierExtras: [],
    numericIdentifier: null,
    secondaryNorms: [row.phone, row.email]
      .filter((v): v is string => Boolean(v))
      .map(normalizeSearchText),
    createdAt: row.createdAt,
    status: null,
    date: null,
    direction: null,
    method: null,
  };
}

export function productCandidate(row: ProductRow): SearchCandidate {
  return {
    id: row.id,
    type: "PRODUCT",
    title: row.name,
    titleNorm: normalizeSearchText(row.name),
    subtitle: row.sku,
    identifierNorm: row.sku ? normalizeSearchText(row.sku) : null,
    identifierExtras: [],
    numericIdentifier: null,
    secondaryNorms: row.sku ? [normalizeSearchText(row.sku)] : [],
    createdAt: row.createdAt,
    // §20 — inactive ≠ deleted: inactive products stay searchable and are
    // marked INACTIVE so the UI can distinguish state without hiding them.
    status: row.isActive ? "ACTIVE" : "INACTIVE",
    date: null,
    direction: null,
    method: null,
  };
}

export function saleCandidate(row: SaleRow): SearchCandidate {
  // Reuses the EXISTING invoice formatter — never duplicated (§5.4).
  const invoice = formatInvoiceNumber(row.number);
  return {
    id: row.id,
    type: "SALE",
    title: invoice,
    titleNorm: normalizeSearchText(invoice),
    subtitle: row.customer?.name ?? null,
    identifierNorm: normalizeSearchText(invoice),
    identifierExtras: [String(row.number)],
    numericIdentifier: row.number,
    secondaryNorms: [row.customer?.name, row.note]
      .filter((v): v is string => Boolean(v))
      .map(normalizeSearchText),
    createdAt: row.createdAt,
    status: saleStatus(row.status),
    date: row.issueDate.toISOString(),
    direction: null,
    method: null,
  };
}

export function expenseCandidate(row: ExpenseRow): SearchCandidate {
  return {
    id: row.id,
    type: "EXPENSE",
    title: row.category,
    titleNorm: normalizeSearchText(row.category),
    subtitle: row.supplier?.name ?? null,
    identifierNorm: null,
    identifierExtras: [],
    numericIdentifier: null,
    secondaryNorms: [row.supplier?.name, row.note]
      .filter((v): v is string => Boolean(v))
      .map(normalizeSearchText),
    createdAt: row.createdAt,
    status: saleStatus(row.status),
    date: row.spentAt.toISOString(),
    direction: null,
    method: null,
  };
}

export function paymentCandidate(
  row: PaymentRow,
  localizedLabel: string,
): SearchCandidate {
  const relatedInvoice = row.sale ? formatInvoiceNumber(row.sale.number) : null;
  const relatedName =
    row.sale?.customer?.name ?? row.expense?.supplier?.name ?? null;
  const relatedCategory = row.expense?.category ?? null;
  return {
    id: row.id,
    type: "PAYMENT",
    title: localizedLabel,
    titleNorm: normalizeSearchText(localizedLabel),
    subtitle: relatedInvoice ?? relatedCategory ?? relatedName,
    identifierNorm: relatedInvoice ? normalizeSearchText(relatedInvoice) : null,
    identifierExtras: row.sale ? [String(row.sale.number)] : [],
    numericIdentifier: row.sale ? row.sale.number : null,
    // §5.6 — method IS a searchable payment field ("cash" → CASH; SQLite
    // LIKE is case-insensitive for ASCII, and normalization lands here so
    // the JS verification pass agrees with the DB prefilter).
    secondaryNorms: [relatedName, relatedCategory, row.note, row.method]
      .filter((v): v is string => Boolean(v))
      .map(normalizeSearchText),
    createdAt: row.createdAt,
    status: null,
    date: row.paidAt.toISOString(),
    // §42 — direction/method are CLOSED tenant tokens; method validation
    // keeps unknown DB values from ever leaving the server.
    direction: row.direction === "IN" || row.direction === "OUT" ? row.direction : null,
    method: paymentMethod(row.method),
  };
}
