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

// ---------------------------------------------------------------------------
// Prompt 35 (§46) — CRM candidates. Notes/descriptions are SECONDARY match
// fields only (§5.1 convention); forecast amounts are NEVER selected (§5.5).
// ---------------------------------------------------------------------------

export type LeadRow = {
  id: string;
  name: string;
  companyName: string | null;
  phone: string | null;
  email: string | null;
  status: string;
  createdAt: Date;
};

export type OpportunityRow = {
  id: string;
  title: string;
  description: string | null;
  stage: string;
  createdAt: Date;
  customer: { name: string } | null;
  lead: { name: string } | null;
};

/** Closed-token guard for lead statuses (§4.1 — nothing raw leaves). */
function leadStatusToken(status: string): SearchItemStatus | null {
  return status === "NEW" ||
    status === "CONTACTED" ||
    status === "QUALIFIED" ||
    status === "DISQUALIFIED" ||
    status === "CONVERTED"
    ? status
    : null;
}

/** Closed-token guard for opportunity stages (§4.1). */
function stageToken(stage: string): SearchItemStatus | null {
  return stage === "DISCOVERY" ||
    stage === "QUALIFIED" ||
    stage === "PROPOSAL" ||
    stage === "NEGOTIATION" ||
    stage === "WON" ||
    stage === "LOST"
    ? stage
    : null;
}

export function leadCandidate(row: LeadRow): SearchCandidate {
  const subtitle = row.companyName ?? row.phone ?? row.email;
  return {
    id: row.id,
    type: "LEAD",
    title: row.name,
    titleNorm: normalizeSearchText(row.name),
    subtitle,
    identifierNorm: null,
    identifierExtras: [],
    numericIdentifier: null,
    secondaryNorms: [row.companyName, row.phone, row.email]
      .filter((v): v is string => Boolean(v))
      .map(normalizeSearchText),
    createdAt: row.createdAt,
    status: leadStatusToken(row.status),
    date: null,
    direction: null,
    method: null,
  };
}

export function opportunityCandidate(row: OpportunityRow): SearchCandidate {
  const subtitle = row.customer?.name ?? row.lead?.name ?? null;
  return {
    id: row.id,
    type: "OPPORTUNITY",
    title: row.title,
    titleNorm: normalizeSearchText(row.title),
    subtitle,
    identifierNorm: null,
    identifierExtras: [],
    numericIdentifier: null,
    secondaryNorms: [row.customer?.name, row.lead?.name, row.description]
      .filter((v): v is string => Boolean(v))
      .map(normalizeSearchText),
    createdAt: row.createdAt,
    status: stageToken(row.stage),
    date: null,
    direction: null,
    method: null,
  };
}

// ---------------------------------------------------------------------------
// Prompt 41 (§67) — purchase-order candidate. Search fields: reference,
// supplier snapshot/live name, product snapshot names/SKUs. NO amounts are
// selected or carried (§67/§5.5 analog) — the total is procurement data the
// search UX never displays.
// ---------------------------------------------------------------------------

export type PurchaseOrderSearchRow = {
  id: string;
  reference: string;
  status: string;
  supplierNameAtOrder: string;
  orderedAt: Date;
  createdAt: Date;
  supplier: { name: string } | null;
  /** §57 — line snapshot TEXT (never money) that feeds the ranker norms. */
  lines?: ReadonlyArray<{ productNameAtOrder: string; skuAtOrder: string | null }>;
};

/** Closed-token guard for the PO lifecycle (§4.1 — nothing raw leaves). */
function purchaseOrderStatusToken(status: string): SearchItemStatus | null {
  return status === "DRAFT" ||
    status === "SENT" ||
    status === "CONFIRMED" ||
    status === "CLOSED" ||
    status === "CANCELLED"
    ? status
    : null;
}

export function purchaseOrderCandidate(row: PurchaseOrderSearchRow): SearchCandidate {
  const subtitle = row.supplierNameAtOrder || row.supplier?.name || null;
  // §57 — product snapshot names + SKUs are REAL match fields. They feed the
  // ranker norms ONLY — they are never rendered (subtitle stays the supplier
  // snapshot) and no amounts ever enter the candidate (§67).
  const productNorms = (row.lines ?? [])
    .flatMap((l) => [l.productNameAtOrder, l.skuAtOrder])
    .filter((v): v is string => Boolean(v))
    .map(normalizeSearchText);
  const skuNorms = (row.lines ?? [])
    .map((l) => l.skuAtOrder)
    .filter((v): v is string => Boolean(v))
    .map(normalizeSearchText);
  return {
    id: row.id,
    type: "PURCHASE_ORDER",
    title: row.reference,
    titleNorm: normalizeSearchText(row.reference),
    subtitle,
    identifierNorm: normalizeSearchText(row.reference),
    identifierExtras: skuNorms,
    numericIdentifier: null,
    secondaryNorms: [row.supplierNameAtOrder, row.supplier?.name, ...productNorms]
      .filter((v): v is string => Boolean(v))
      .map(normalizeSearchText),
    createdAt: row.createdAt,
    status: purchaseOrderStatusToken(row.status),
    date: row.orderedAt.toISOString(),
    direction: null,
    method: null,
  };
}

// ---------------------------------------------------------------------------
// Prompt 42 (§122-§124) — goods-receipt candidate. Search fields: receipt
// reference, PO reference snapshot, supplier snapshot, product snapshot
// names/SKUs. NO money exists in this domain (§37) and NO stock quantities
// are carried in the candidate (§122).
// ---------------------------------------------------------------------------

export type GoodsReceiptSearchRow = {
  id: string;
  reference: string;
  status: string;
  supplierNameAtReceipt: string;
  purchaseOrderReferenceAtReceipt: string;
  createdAt: Date;
  /** §122 — line snapshot TEXT (never money/stock qty) feeds the ranker. */
  lines?: ReadonlyArray<{ productNameAtReceipt: string; skuAtReceipt: string | null }>;
};

/**
 * §124 — closed-token guard for the receipt lifecycle. An invalid
 * persisted status is NOT mapped to Draft: the status token is omitted
 * (null) and the document still renders under its reference — the same
 * safe-omission policy as the P41 search candidate.
 */
function goodsReceiptStatusToken(status: string): SearchItemStatus | null {
  return status === "DRAFT" || status === "POSTED" || status === "CANCELLED"
    ? status
    : null;
}

export function goodsReceiptCandidate(row: GoodsReceiptSearchRow): SearchCandidate {
  const skuNorms = (row.lines ?? [])
    .map((l) => l.skuAtReceipt)
    .filter((v): v is string => Boolean(v))
    .map(normalizeSearchText);
  const productNorms = (row.lines ?? [])
    .flatMap((l) => [l.productNameAtReceipt, l.skuAtReceipt])
    .filter((v): v is string => Boolean(v))
    .map(normalizeSearchText);
  return {
    id: row.id,
    type: "GOODS_RECEIPT",
    title: row.reference,
    titleNorm: normalizeSearchText(row.reference),
    subtitle: row.supplierNameAtReceipt || null,
    identifierNorm: normalizeSearchText(row.reference),
    identifierExtras: [...skuNorms, normalizeSearchText(row.purchaseOrderReferenceAtReceipt)],
    numericIdentifier: null,
    secondaryNorms: [row.supplierNameAtReceipt, row.purchaseOrderReferenceAtReceipt, ...productNorms]
      .filter((v): v is string => Boolean(v))
      .map(normalizeSearchText),
    createdAt: row.createdAt,
    status: goodsReceiptStatusToken(row.status),
    date: row.createdAt.toISOString(),
    direction: null,
    method: null,
  };
}

// ---------------------------------------------------------------------------
// Prompt 43 (§101) — goods-return candidate. Search fields: return
// reference, source receipt reference snapshot, PO reference snapshot,
// supplier snapshot, product snapshot names/SKUs. NO money exists in this
// domain (§4/§7) and NO stock quantities are carried in the candidate.
// ---------------------------------------------------------------------------

export type GoodsReturnSearchRow = {
  id: string;
  reference: string;
  status: string;
  supplierNameAtReturn: string;
  goodsReceiptReferenceAtReturn: string;
  purchaseOrderReferenceAtReturn: string;
  createdAt: Date;
  /** §101 — line snapshot TEXT (never money/stock qty) feeds the ranker. */
  lines?: ReadonlyArray<{ productNameAtReturn: string; skuAtReturn: string | null }>;
};

/**
 * §101 — closed-token guard for the return lifecycle (same safe-omission
 * policy as the receipt candidate): an invalid persisted status is NOT
 * mapped to Draft — the status token is omitted (null) and the document
 * still renders under its reference.
 */
function goodsReturnStatusToken(status: string): SearchItemStatus | null {
  return status === "DRAFT" || status === "POSTED" || status === "CANCELLED"
    ? status
    : null;
}

export function goodsReturnCandidate(row: GoodsReturnSearchRow): SearchCandidate {
  const skuNorms = (row.lines ?? [])
    .map((l) => l.skuAtReturn)
    .filter((v): v is string => Boolean(v))
    .map(normalizeSearchText);
  const productNorms = (row.lines ?? [])
    .flatMap((l) => [l.productNameAtReturn, l.skuAtReturn])
    .filter((v): v is string => Boolean(v))
    .map(normalizeSearchText);
  return {
    id: row.id,
    type: "GOODS_RETURN",
    title: row.reference,
    titleNorm: normalizeSearchText(row.reference),
    subtitle: row.supplierNameAtReturn || null,
    identifierNorm: normalizeSearchText(row.reference),
    identifierExtras: [
      ...skuNorms,
      normalizeSearchText(row.goodsReceiptReferenceAtReturn),
      normalizeSearchText(row.purchaseOrderReferenceAtReturn),
    ],
    numericIdentifier: null,
    secondaryNorms: [
      row.supplierNameAtReturn,
      row.goodsReceiptReferenceAtReturn,
      row.purchaseOrderReferenceAtReturn,
      ...productNorms,
    ]
      .filter((v): v is string => Boolean(v))
      .map(normalizeSearchText),
    createdAt: row.createdAt,
    status: goodsReturnStatusToken(row.status),
    date: row.createdAt.toISOString(),
    direction: null,
    method: null,
  };
}
// ---------------------------------------------------------------------------
// Prompt 44 — goods-dispatch candidate. Search fields: dispatch reference,
// customer snapshot, product snapshot names/SKUs. NO money exists in this
// domain and NO stock quantities are carried in the candidate.
// ---------------------------------------------------------------------------

export type GoodsDispatchSearchRow = {
  id: string;
  reference: string;
  status: string;
  customerNameAtDispatch: string;
  createdAt: Date;
  /** Line snapshot TEXT (never money/stock qty) feeds the ranker. */
  lines?: ReadonlyArray<{ productNameAtDispatch: string; skuAtDispatch: string | null }>;
};

/**
 * Closed-token guard for the dispatch lifecycle (same safe-omission policy
 * as the receipt/return candidates): an invalid persisted status is NOT
 * mapped to Draft — the status token is omitted (null) and the document
 * still renders under its reference.
 */
function goodsDispatchStatusToken(status: string): SearchItemStatus | null {
  return status === "DRAFT" || status === "POSTED" || status === "CANCELLED"
    ? status
    : null;
}

export function goodsDispatchCandidate(row: GoodsDispatchSearchRow): SearchCandidate {
  const skuNorms = (row.lines ?? [])
    .map((l) => l.skuAtDispatch)
    .filter((v): v is string => Boolean(v))
    .map(normalizeSearchText);
  const productNorms = (row.lines ?? [])
    .flatMap((l) => [l.productNameAtDispatch, l.skuAtDispatch])
    .filter((v): v is string => Boolean(v))
    .map(normalizeSearchText);
  return {
    id: row.id,
    type: "GOODS_DISPATCH",
    title: row.reference,
    titleNorm: normalizeSearchText(row.reference),
    subtitle: row.customerNameAtDispatch || null,
    identifierNorm: normalizeSearchText(row.reference),
    identifierExtras: skuNorms,
    numericIdentifier: null,
    secondaryNorms: [row.customerNameAtDispatch, ...productNorms]
      .filter((v): v is string => Boolean(v))
      .map(normalizeSearchText),
    createdAt: row.createdAt,
    status: goodsDispatchStatusToken(row.status),
    date: row.createdAt.toISOString(),
    direction: null,
    method: null,
  };
}


// ---------------------------------------------------------------------------
// Prompt 45 (§70) — sales-order candidate. Search fields: order reference,
// customer snapshot, product snapshot names/SKUs. NO amounts and NO
// fulfillment quantities are carried in the candidate (the established
// search contract — discovery only, never financial disclosure).
// ---------------------------------------------------------------------------

export type SalesOrderSearchRow = {
  id: string;
  reference: string;
  status: string;
  customerNameAtOrder: string;
  createdAt: Date;
  /** Line snapshot TEXT (never money/quantities) feeds the ranker. */
  lines?: ReadonlyArray<{ productNameAtOrder: string; skuAtOrder: string | null }>;
};

/**
 * Closed-token guard for the sales-order lifecycle: an invalid persisted
 * status is NOT mapped to Draft — the status token is omitted (null) and
 * the order still renders under its reference (same safe-omission policy
 * as the receipt/return/dispatch candidates).
 */
function salesOrderStatusToken(status: string): SearchItemStatus | null {
  return status === "DRAFT" ||
    status === "CONFIRMED" ||
    status === "COMPLETED" ||
    status === "CANCELLED"
    ? status
    : null;
}

export function salesOrderCandidate(row: SalesOrderSearchRow): SearchCandidate {
  const skuNorms = (row.lines ?? [])
    .map((l) => l.skuAtOrder)
    .filter((v): v is string => Boolean(v))
    .map(normalizeSearchText);
  const productNorms = (row.lines ?? [])
    .map((l) => l.productNameAtOrder)
    .filter((v): v is string => Boolean(v));
  return {
    id: row.id,
    type: "SALES_ORDER",
    title: row.reference,
    titleNorm: normalizeSearchText(row.reference),
    subtitle: row.customerNameAtOrder || null,
    identifierNorm: normalizeSearchText(row.reference),
    identifierExtras: skuNorms,
    numericIdentifier: null,
    secondaryNorms: [row.customerNameAtOrder, ...productNorms]
      .filter((v): v is string => Boolean(v))
      .map(normalizeSearchText),
    createdAt: row.createdAt,
    status: salesOrderStatusToken(row.status),
    date: row.createdAt.toISOString(),
    direction: null,
    method: null,
  };
}

/* ------------------------ Sales quotation (Prompt 47) --------------------- */

export type SalesQuotationSearchRow = {
  id: string;
  reference: string;
  status: string;
  customerNameAtQuotation: string;
  createdAt: Date;
  /** Line snapshot TEXT (never money/notes) feeds the ranker. */
  lines?: ReadonlyArray<{ productNameAtQuotation: string; skuAtQuotation: string | null }>;
};

/**
 * Closed-token guard for the quotation lifecycle: an invalid persisted
 * status is NOT mapped to Draft — the status token is omitted (null) and
 * the quotation still renders under its reference (same safe-omission
 * policy as the order/receipt/return/dispatch candidates).
 */
function salesQuotationStatusToken(status: string): SearchItemStatus | null {
  return status === "DRAFT" ||
    status === "SENT" ||
    status === "ACCEPTED" ||
    status === "REJECTED" ||
    status === "EXPIRED" ||
    status === "CANCELLED" ||
    status === "CONVERTED"
    ? status
    : null;
}

export function salesQuotationCandidate(row: SalesQuotationSearchRow): SearchCandidate {
  const skuNorms = (row.lines ?? [])
    .map((l) => l.skuAtQuotation)
    .filter((v): v is string => Boolean(v))
    .map(normalizeSearchText);
  const productNorms = (row.lines ?? [])
    .map((l) => l.productNameAtQuotation)
    .filter((v): v is string => Boolean(v));
  return {
    id: row.id,
    type: "SALES_QUOTATION",
    title: row.reference,
    titleNorm: normalizeSearchText(row.reference),
    subtitle: row.customerNameAtQuotation || null,
    identifierNorm: normalizeSearchText(row.reference),
    identifierExtras: skuNorms,
    numericIdentifier: null,
    secondaryNorms: [row.customerNameAtQuotation, ...productNorms]
      .filter((v): v is string => Boolean(v))
      .map(normalizeSearchText),
    createdAt: row.createdAt,
    status: salesQuotationStatusToken(row.status),
    date: row.createdAt.toISOString(),
    direction: null,
    method: null,
  };
}
