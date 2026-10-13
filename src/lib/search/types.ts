/**
 * Prompt 33 — Universal Global Search: closed type vocabulary (§4.1).
 *
 * The search system is a DISCOVERY layer over the active business only.
 * It is never an authority layer: it never mutates data, never bypasses
 * tenant isolation / RBAC, and never exposes platform, security-secret,
 * AI-cost or payment-processor internals (§1/§21/§42/§43).
 *
 * Both vocabularies below are CLOSED: the browser can never introduce a
 * new entity type or a new destination route (§4.1/§14).
 */

/** Tenant-scoped entity types that participate in global search (§2).
 *  Prompt 35 (§46): LEAD + OPPORTUNITY join the six Prompt 33 types.
 *  Prompt 41 (§67): PURCHASE_ORDER joins — discovery over procurement
 *  documents (reference + supplier + product snapshots; NO amounts §67).
 *  Prompt 42 (§122): GOODS_RECEIPT joins — discovery over receiving
 *  documents (reference + PO reference + supplier/product snapshots;
 *  NO money, NO stock quantities in snippets §122).
 *  Prompt 43 (§101): GOODS_RETURN joins — discovery over return documents
 *  (return reference + source receipt reference + PO reference snapshot +
 *  supplier/product snapshots; NO money, NO quantities in snippets).
 *  Prompt 44: GOODS_DISPATCH joins — discovery over outbound documents
 *  (dispatch reference + customer snapshot + product snapshots; NO money,
 *  NO stock quantities in snippets).
 *  Prompt 45 (§70): SALES_ORDER joins — discovery over commercial customer
 *  orders (order reference + customer snapshot + product/SKU snapshots;
 *  NO amounts, NO fulfillment quantities in snippets).
 *  Prompt 48 (§5): SUPPLIER_BILL joins — discovery over supplier invoice
 *  documents (bill reference + supplier invoice reference + supplier/PO
 *  snapshots + product/SKU snapshots; NO amounts, NO notes in snippets). */
export const SEARCH_ENTITY_TYPES = [
  "CUSTOMER",
  "SUPPLIER",
  "PRODUCT",
  "SALE",
  "EXPENSE",
  "PAYMENT",
  "LEAD",
  "OPPORTUNITY",
  "PURCHASE_ORDER",
  "GOODS_RECEIPT",
  "GOODS_RETURN",
  "GOODS_DISPATCH",
  "SALES_ORDER",
  // Prompt 47 — SALES_QUOTATION joins: discovery over commercial price
  // offers (quotation reference + customer/product/SKU snapshots; NO
  // amounts, NO notes in snippets §18/§10).
  "SALES_QUOTATION",
  // Prompt 48 (§5) — SUPPLIER_BILL joins.
  "SUPPLIER_BILL",
] as const;

export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

/** Allowlisted destinations — mapped 1:1 onto AppView modules client-side. */
export const SEARCH_DESTINATIONS = [
  "customers",
  "suppliers",
  "products",
  "sales",
  "expenses",
  "payments",
  "leads",
  "opportunities",
  "purchase-orders",
  "goods-receipts",
  "goods-returns",
  "goods-dispatches",
  "sales-orders",
  "sales-quotations",
  "supplier-bills",
] as const;

export type SearchDestination = (typeof SEARCH_DESTINATIONS)[number];

/** Single allowlisted entity → destination map (§14). Never arbitrary URLs. */
export const ENTITY_DESTINATION: Record<SearchEntityType, SearchDestination> = {
  CUSTOMER: "customers",
  SUPPLIER: "suppliers",
  PRODUCT: "products",
  SALE: "sales",
  EXPENSE: "expenses",
  PAYMENT: "payments",
  LEAD: "leads",
  OPPORTUNITY: "opportunities",
  PURCHASE_ORDER: "purchase-orders",
  GOODS_RECEIPT: "goods-receipts",
  GOODS_RETURN: "goods-returns",
  GOODS_DISPATCH: "goods-dispatches",
  SALES_ORDER: "sales-orders",
  SALES_QUOTATION: "sales-quotations",
  SUPPLIER_BILL: "supplier-bills",
};

/** Closed status tokens (client localizes; server never renders HTML).
 *  Prompt 35 (§46): CRM lead statuses + opportunity stages join.
 *  Prompt 41 (§67): the purchase-order lifecycle vocabulary joins.
 *  Prompt 42 (§122): POSTED joins for the goods-receipt lifecycle.
 *  Prompt 43 (§101): the goods-return lifecycle reuses DRAFT/POSTED/
 *  CANCELLED — no new tokens.
 *  Prompt 45 (§70): the sales-order lifecycle joins DRAFT/CONFIRMED/
 *  CANCELLED and adds COMPLETED (a commercial-order token, distinct from
 *  the Sale payment statuses). */
export type SearchItemStatus =
  | "ACTIVE"
  | "INACTIVE"
  | "UNPAID"
  | "PARTIAL"
  | "PAID"
  | "NEW"
  | "CONTACTED"
  | "QUALIFIED"
  | "DISQUALIFIED"
  | "CONVERTED"
  | "DISCOVERY"
  | "PROPOSAL"
  | "NEGOTIATION"
  | "WON"
  | "LOST"
  | "DRAFT"
  | "SENT"
  | "CONFIRMED"
  | "CLOSED"
  | "CANCELLED"
  | "POSTED"
  | "COMPLETED"
  // Prompt 47 — the sales-quotation lifecycle joins (ACCEPTED/REJECTED/
  // EXPIRED are new closed tokens; DRAFT/SENT/CANCELLED/CONVERTED reuse
  // existing tokens).
  | "ACCEPTED"
  | "REJECTED"
  | "EXPIRED";

/** Closed payment direction tokens (tenant Payment domain only — §42). */
export type SearchItemDirection = "IN" | "OUT";

/** Closed tenant payment method tokens (never gateway/provider data — §42). */
export type SearchItemMethod = "CASH" | "BANK_TRANSFER" | "CARD" | "OTHER";

/**
 * One search result row (§9). Data-minimal by design:
 * - no amounts/prices (§5.3/§5.5)
 * - no raw provider/gateway/checkout data (§5.4/§5.6/§42)
 * - only closed tokens + ISO dates, rendered as text client-side (§16).
 */
export type SearchResultItem = {
  id: string;
  type: SearchEntityType;
  title: string;
  subtitle: string | null;
  destination: SearchDestination;
  status: SearchItemStatus | null;
  /** ISO-8601 date of the most relevant timestamp (issue/spent/paid). */
  date: string | null;
  direction: SearchItemDirection | null;
  method: SearchItemMethod | null;
};

export type SearchResultGroup = {
  type: SearchEntityType;
  count: number;
  items: SearchResultItem[];
};

export type SearchResponseData = {
  query: string;
  groups: SearchResultGroup[];
  total: number;
  truncated: boolean;
};

/** Validated search input (see schema.ts). */
export type SearchInput = {
  q: string;
  types: SearchEntityType[];
  limit: number;
};

/**
 * Internal candidate used by rank.ts — server-side only. Carries the
 * normalized fields used for deterministic ranking plus the display fields
 * copied into the DTO. Never serialized to the client (§9/§21).
 */
export type SearchCandidate = {
  id: string;
  type: SearchEntityType;
  /** Display title (formatted invoice number, name, category, "Payment"). */
  title: string;
  /** Normalized title for ranking (normalizeSearchText applied). */
  titleNorm: string;
  subtitle: string | null;
  /** Primary identifier, normalized: SKU or "inv-0042". */
  identifierNorm: string | null;
  /** Additional identifier forms: numeric invoice digits / padded form. */
  identifierExtras: string[];
  /** Exact numeric invoice number (Sales only). */
  numericIdentifier: number | null;
  /** Normalized secondary fields (email/phone/note/customer/supplier). */
  secondaryNorms: string[];
  /** Stable deterministic tie-break source (§7). */
  createdAt: Date;
  // Display-only payload fields:
  status: SearchItemStatus | null;
  date: string | null;
  direction: SearchItemDirection | null;
  method: SearchItemMethod | null;
};
