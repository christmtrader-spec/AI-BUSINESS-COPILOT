/**
 * Prompt 34 — Entity detail DTO types (§4/§22/§88).
 *
 * These are the EXACT response shapes of the six detail GET endpoints.
 * Every field is explicitly mapped in `./<entity>.ts` — no Prisma object
 * is ever spread into a response. All money values are INTEGER minor
 * units (A08) and all timestamps are ISO-8601 strings.
 */

import type { EntityType } from "@/lib/entity-routes";

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
  /**
   * Prompt 35 (§44/§45) — CRM PIPELINE section, kept STRICTLY separate
   * from the financial summary above. Bounded ≤ 10. Forecast values only —
   * never mixed into receivable/sales math.
   */
  crm: CustomerCrmSection;
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
