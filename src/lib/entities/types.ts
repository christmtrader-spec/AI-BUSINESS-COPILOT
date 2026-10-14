/**
 * Prompt 34 — Entity detail DTO types (§4/§22/§88).
 *
 * These are the EXACT response shapes of the six detail GET endpoints.
 * Every field is explicitly mapped in `./<entity>.ts` — no Prisma object
 * is ever spread into a response. All money values are INTEGER minor
 * units (A08) and all timestamps are ISO-8601 strings.
 */

import type { EntityType } from "@/lib/entity-routes";
import type { AgingBucketKey } from "@/lib/aging";

/** Closed status token (mirrors lib/money statusOf output). */
export type PaymentStatusToken = "UNPAID" | "PARTIAL" | "PAID";

/** Closed tenant payment method token (never gateway/provider data). */
export type PaymentMethodToken = "CASH" | "BANK_TRANSFER" | "CARD" | "OTHER";

/** Closed tenant payment direction token (tenant domain only — §19/§69). */
export type PaymentDirectionToken = "IN" | "OUT";

/** Closed product stock state (§15/§73 — mirrors the existing UI logic). */
export type StockState = "OUT_OF_STOCK" | "LOW_STOCK" | "HEALTHY";

/** Related-record reference used by the detail UI (§34/§78). */
export type RelatedRecordRef = {
  entity: EntityType;
  id: string;
};

/* ------------------------------------------------------------------ */
/* Customer 360 (§11/§12)                                              */
/* ------------------------------------------------------------------ */

export type CustomerSummary = {
  /** Σ sale.totalMinor (same business, non-deleted, this customer). */
  totalSalesMinor: number;
  /** Σ sale.paidMinor. */
  paidSalesMinor: number;
  /** Σ (totalMinor − paidMinor) — integer arithmetic only (§43). */
  receivableMinor: number;
  invoiceCount: number;
  paidInvoiceCount: number;
  openInvoiceCount: number;
};

export type CustomerRecentSale = {
  id: string;
  number: number;
  issueDate: string;
  totalMinor: number;
  paidMinor: number;
  balanceMinor: number;
  status: PaymentStatusToken;
};

export type RecentPaymentRow = {
  id: string;
  amountMinor: number;
  method: PaymentMethodToken;
  paidAt: string;
  note: string | null;
};

/** Prompt 35 (§44) — bounded CRM slice of the Customer 360. */
export type CustomerCrmSection = {
  openOpportunityCount: number;
  recentOpportunities: CustomerOpportunityRef[];
  /** The lead this customer converted from, when one exists (§44). */
  leadOrigin: { id: string; name: string; convertedAt: string | null } | null;
};

export type CustomerOpportunityRef = {
  id: string;
  title: string;
  stage: "DISCOVERY" | "QUALIFIED" | "PROPOSAL" | "NEGOTIATION" | "WON" | "LOST";
  probabilityPct: number;
  expectedValueMinor: number;
  expectedCloseDate: string | null;
};

export type CustomerDetail = {
  customer: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    address: string | null;
    note: string | null;
    createdAt: string;
  };
  summary: CustomerSummary;
  /** Bounded: ≤ 10 (§12/§85). */
  recentSales: CustomerRecentSale[];
  /** Bounded: ≤ 10 (§12/§85). */
  recentPayments: RecentPaymentRow[];
  /** Prompt 44 — ≤ 10 recent goods-dispatch rows (NO money). */
  recentGoodsDispatches?: CustomerRecentDispatch[];
  /** Prompt 45 (§71) — ≤ 10 recent sales orders (order-currency totals;
   *  commitment data — never added to receivables §92). */
  recentSalesOrders?: CustomerRecentSalesOrder[];
  /** Prompt 47 (§19) — ≤10 recent quotations for this customer (bounded,
   *  snapshot statuses; commercial offers — never financial records). */
  recentSalesQuotations?: CustomerRecentSalesQuotation[];
  /**
   * Prompt 35 (§44/§45) — CRM PIPELINE section, kept STRICTLY separate
   * from the financial summary above. Bounded ≤ 10. Forecast values only —
   * never mixed into receivable/sales math.
   */
  crm: CustomerCrmSection;
  /**
   * Prompt 49 (§17) — READ-ONLY receivables-aging panel data for this
   * exact customer, derived from the canonical aging engine over the
   * customer's open Sale invoices. SalesOrders/Quotations can never appear
   * (separate tables). Additive optional field.
   */
  receivablesAging?: PartyAgingSummary;
};

/**
 * Prompt 49 (§17) — party-scoped aging overview shared by the Customer 360
 * and Supplier 360 panels. All money is exact integer minor units; ages and
 * buckets come from the canonical aging engine in the business timezone.
 */
export type PartyAgingSummary = {
  asOf: string;
  timezone: string;
  totalOutstandingMinor: number;
  openItemCount: number;
  buckets: Array<{ key: AgingBucketKey; minor: number; count: number }>;
  oldestDays: number;
  /**
   * Payables ONLY (aggregate-aging vocabulary: the slice is PRESENT when the
   * side has the stated-due-date law, ABSENT otherwise — never a fake null
   * money value). Receivables carry no due-date semantics (§9).
   */
  pastDueMinor?: number;
  pastDueCount?: number;
  truncated: boolean;
};

/* ------------------------------------------------------------------ */
/* Supplier 360 (§13/§14)                                              */
/* ------------------------------------------------------------------ */

export type SupplierSummary = {
  totalExpensesMinor: number;
  paidExpensesMinor: number;
  /** Σ (amountMinor − paidMinor) — never platform subscription data. */
  payableMinor: number;
  expenseCount: number;
  paidExpenseCount: number;
  openExpenseCount: number;
};

export type SupplierRecentExpense = {
  id: string;
  category: string;
  spentAt: string;
  amountMinor: number;
  paidMinor: number;
  balanceMinor: number;
  status: PaymentStatusToken;
};

/** Prompt 41 (§65) — bounded procurement history for Supplier 360. */
export type SupplierRecentGoodsReceipt = {
  id: string;
  reference: string;
  status: string;
  postedAt: string | null;
  /** Total received units across the receipt (§121 — NO money). */
  totalReceivedQty: number;
};

export type SupplierRecentPurchaseOrder = {
  id: string;
  reference: string;
  status: string;
  orderedAt: string;
  currencyCodeAtOrder: string;
  currencySymbolAtOrder: string;
  decimalPrecisionAtOrder: number;
  totalQty: number;
  /** Procurement document total (§151) — never a payable/expense value. */
  totalMinor: number;
};

export type SupplierDetail = {
  supplier: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    address: string | null;
    note: string | null;
    createdAt: string;
  };
  summary: SupplierSummary;
  /** Bounded: ≤ 10 (§41/§85). */
  recentExpenses: SupplierRecentExpense[];
  /** Bounded: ≤ 10 (§41/§85). */
  recentPayments: RecentPaymentRow[];
  /** Prompt 41 (§65) — bounded: ≤ 10 procurement documents. */
  recentPurchaseOrders: SupplierRecentPurchaseOrder[];
  /** Prompt 42 (§121) — bounded: ≤ 10 goods receipts (snapshot identity). */
  recentGoodsReceipts?: SupplierRecentGoodsReceipt[];
  /** Prompt 43 (§100) — bounded: ≤ 10 goods returns (snapshot identity). */
  recentGoodsReturns?: SupplierRecentReturn[];
  /**
   * Prompt 48 (§8) — bounded: ≤ 10 supplier bills (snapshot identity).
   * READ-ONLY document history: never a payable movement — the payable
   * state shown per posted row comes from the LIVE linked Expense
   * (paidMinor/status), never a copied bill balance.
   */
  recentSupplierBills?: SupplierRecentBill[];
  /**
   * Prompt 49 (§17) — READ-ONLY payables-aging panel data for this exact
   * supplier, derived from the canonical aging engine over the supplier's
   * open Expense payables (the SOLE payable authority — a SupplierBill is
   * never a second balance). Additive optional field.
   */
  payablesAging?: PartyAgingSummary;
};

/** Prompt 48 (§8) — bounded supplier-bill row for Supplier 360. */
export type SupplierRecentBill = {
  id: string;
  reference: string;
  supplierInvoiceReference: string | null;
  purchaseOrderReferenceAtBill: string;
  status: string;
  billDate: string;
  dueDate: string | null;
  totalMinor: number;
  currencySymbolAtBill: string;
  decimalPrecisionAtBill: number;
  /** Live linked-Expense payment state (null for DRAFT/CANCELLED §10). */
  payableStatus: string | null;
  paidMinor: number | null;
};

/** Prompt 43 (§100) — bounded goods-return row for Supplier 360. */
export type SupplierRecentReturn = {
  id: string;
  reference: string;
  status: string;
  supplierNameAtReturn: string;
  goodsReceiptReferenceAtReturn: string;
  postedAt: string | null;
  totalReturnedQty: number;
};

/* ------------------------------------------------------------------ */
/* Product detail (§15/§16)                                            */
/* ------------------------------------------------------------------ */

export type ProductInventory = {
  stockQty: number;
  lowStockAt: number;
  state: StockState;
};

export type ProductRecentAdjustment = {
  id: string;
  delta: number;
  reason: string;
  createdAt: string;
};

export type ProductRecentStocktake = {
  stocktakeId: string;
  reference: string;
  status: string;
  varianceQty: number;
  countedAt: string;
};

/** Prompt 41 (§66) — bounded procurement history for Product detail. */
export type ProductRecentGoodsReceipt = {
  id: string;
  reference: string;
  status: string;
  postedAt: string | null;
  /** Units received on THIS line (§120 — NO money). */
  receivedQty: number;
};

export type ProductRecentPurchaseOrder = {
  purchaseOrderId: string;
  reference: string;
  status: string;
  supplierNameAtOrder: string;
  orderedAt: string;
  orderedQty: number;
  unitPriceMinor: number;
  currencyCodeAtOrder: string;
  currencySymbolAtOrder: string;
  decimalPrecisionAtOrder: number;
};

export type ProductRecentSale = {
  saleId: string;
  number: number;
  issueDate: string;
  /** Combined quantity of THIS product across the sale's lines. */
  qty: number;
  /** Combined line total (minor units) of THIS product in the sale. */
  lineTotalMinor: number;
};

export type ProductDetail = {
  product: {
    id: string;
    name: string;
    sku: string | null;
    unit: string | null;
    salePriceMinor: number;
    costPriceMinor: number;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
  };
  inventory: ProductInventory;
  /** Bounded: ≤ 10 (§42/§85). */
  recentAdjustments: ProductRecentAdjustment[];
  /** Bounded: ≤ 10 unique sale records (§15/§42/§85). */
  recentSales: ProductRecentSale[];
  /** Prompt 40 (§90) — ≤ 10 recent physical-count lines for this product. */
  recentStocktakes: ProductRecentStocktake[];
  /** Prompt 41 (§66) — ≤ 10 recent procurement lines for this product. */
  recentPurchaseOrders: ProductRecentPurchaseOrder[];
  /** Prompt 42 (§120) — ≤ 10 recent goods-receipt lines (NO money). */
  recentGoodsReceipts?: ProductRecentGoodsReceipt[];
  /** Prompt 43 (§99) — ≤ 10 recent goods-return lines (NO money). */
  recentGoodsReturns?: ProductRecentReturn[];
  /** Prompt 44 — ≤ 10 recent goods-dispatch lines (NO money). */
  recentGoodsDispatches?: ProductRecentDispatch[];
  /** Prompt 45 (§72) — ≤ 10 recent sales-order lines (NO money). */
  recentSalesOrders?: ProductRecentSalesOrder[];
  /** Prompt 47 (§19) — ≤10 recent quotation lines (NO money — commercial
   *  offers, never inventory or financial events). */
  recentSalesQuotations?: ProductRecentSalesQuotation[];
};

/** Prompt 43 (§99) — bounded goods-return row for Product detail. */
export type ProductRecentReturn = {
  id: string;
  reference: string;
  status: string;
  goodsReceiptReferenceAtReturn: string;
  returnedQty: number;
  reasonCode: string;
  postedAt: string | null;
};

/** Prompt 44 — bounded goods-dispatch row for Customer 360. */
export type CustomerRecentDispatch = {
  id: string;
  reference: string;
  status: string;
  customerNameAtDispatch: string;
  postedAt: string | null;
  totalDispatchedQty: number;
};

/** Prompt 44 — bounded goods-dispatch row for Product detail. */
export type ProductRecentDispatch = {
  id: string;
  reference: string;
  status: string;
  customerNameAtDispatch: string;
  qty: number;
  reasonCode: string;
  postedAt: string | null;
};

/** Prompt 45 (§71) — bounded sales-order row for the Customer 360 (≤10).
 *  Historical snapshots stay authoritative; the order total uses the
 *  order's OWN currency snapshot (never mixed into receivable math §92). */
export type CustomerRecentSalesOrder = {
  id: string;
  reference: string;
  status: "DRAFT" | "CONFIRMED" | "COMPLETED" | "CANCELLED";
  orderDate: string;
  currencyCodeAtOrder: string;
  currencySymbolAtOrder: string;
  decimalPrecisionAtOrder: number;
  totalMinor: number;
  orderedQty: number;
  dispatchedQty: number;
  invoiceNumber: number | null;
  invoiceStatus: string | null;
};

/** Prompt 47 (§19) — bounded quotation row for Product detail. Quantities
 *  only — NO money on product surfaces (the established §72 law). */
export type ProductRecentSalesQuotation = {
  id: string;
  reference: string;
  customerNameAtQuotation: string;
  status: "DRAFT" | "SENT" | "ACCEPTED" | "REJECTED" | "EXPIRED" | "CANCELLED" | "CONVERTED";
  effectiveStatus: "DRAFT" | "SENT" | "ACCEPTED" | "REJECTED" | "EXPIRED" | "CANCELLED" | "CONVERTED";
  quotationDate: string;
  qty: number;
};

/** Prompt 47 (§19) — bounded quotation row for the Customer 360. */
export type CustomerRecentSalesQuotation = {
  id: string;
  reference: string;
  /** Persisted status (§9) — never silently normalized. */
  status: "DRAFT" | "SENT" | "ACCEPTED" | "REJECTED" | "EXPIRED" | "CANCELLED" | "CONVERTED";
  /** Effective status (§9) — SENT past validity renders EXPIRED. */
  effectiveStatus: "DRAFT" | "SENT" | "ACCEPTED" | "REJECTED" | "EXPIRED" | "CANCELLED" | "CONVERTED";
  quotationDate: string;
  currencyCodeAtQuotation: string;
  currencySymbolAtQuotation: string;
  decimalPrecisionAtQuotation: number;
  totalMinor: number;
  totalQty: number;
  convertedOrderReference: string | null;
};

/** Prompt 45 (§72) — bounded sales-order row for the Product detail (≤10). */
export type ProductRecentSalesOrder = {
  id: string;
  reference: string;
  customerNameAtOrder: string;
  status: "DRAFT" | "CONFIRMED" | "COMPLETED" | "CANCELLED";
  orderDate: string;
  orderedQty: number;
  dispatchedQty: number;
  remainingToDispatchQty: number;
};

/* ------------------------------------------------------------------ */
/* Sale detail (§17)                                                   */
/* ------------------------------------------------------------------ */

export type SaleItemLine = {
  id: string;
  productId: string | null;
  name: string;
  unit: string | null;
  qty: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
};

export type SalePaymentRow = {
  id: string;
  amountMinor: number;
  method: PaymentMethodToken;
  note: string | null;
  paidAt: string;
  actorName: string | null;
};

export type SaleDetail = {
  sale: {
    id: string;
    number: number;
    customerId: string | null;
    customerName: string | null;
    issueDate: string;
    subtotalMinor: number;
    discountMinor: number;
    totalMinor: number;
    paidMinor: number;
    balanceMinor: number;
    status: PaymentStatusToken;
    note: string | null;
    createdAt: string;
  };
  items: SaleItemLine[];
  payments: SalePaymentRow[];
};

/* ------------------------------------------------------------------ */
/* Expense detail (§18)                                                */
/* ------------------------------------------------------------------ */

export type ExpensePaymentRow = {
  id: string;
  amountMinor: number;
  method: PaymentMethodToken;
  paidAt: string;
  note: string | null;
  actorName: string | null;
};

export type ExpenseDetail = {
  expense: {
    id: string;
    category: string;
    amountMinor: number;
    paidMinor: number;
    balanceMinor: number;
    status: PaymentStatusToken;
    spentAt: string;
    /** Supplier-bill due date (§84 date-only) — null when no terms stated. */
    dueDate: string | null;
    /** Free-text supplier bill/invoice reference (≤ 80). */
    reference: string | null;
    note: string | null;
    supplierId: string | null;
    supplierName: string | null;
    createdAt: string;
  };
  /** Bounded: ≤ 20 (§18/§85). */
  payments: ExpensePaymentRow[];
};

/* ------------------------------------------------------------------ */
/* Payment detail (§19)                                                */
/* ------------------------------------------------------------------ */

export type PaymentRelatedSale = {
  id: string;
  /** Server-formatted via formatInvoiceNumber() — never re-invented (§17). */
  formattedInvoiceNumber: string;
  customerId: string | null;
  customerName: string | null;
  totalMinor: number;
  paidMinor: number;
  balanceMinor: number;
  status: PaymentStatusToken;
};

export type PaymentRelatedExpense = {
  id: string;
  category: string;
  supplierId: string | null;
  supplierName: string | null;
  amountMinor: number;
  paidMinor: number;
  balanceMinor: number;
  status: PaymentStatusToken;
};

export type PaymentDetail = {
  payment: {
    id: string;
    direction: PaymentDirectionToken;
    amountMinor: number;
    method: PaymentMethodToken;
    note: string | null;
    paidAt: string;
    createdAt: string;
  };
  /** Exactly one of the two is non-null for a valid tenant payment. */
  related: {
    sale: PaymentRelatedSale | null;
    expense: PaymentRelatedExpense | null;
  };
};
