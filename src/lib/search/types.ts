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

/** Tenant-scoped entity types that participate in global search (§2). */
export const SEARCH_ENTITY_TYPES = [
  "CUSTOMER",
  "SUPPLIER",
  "PRODUCT",
  "SALE",
  "EXPENSE",
  "PAYMENT",
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
};

/** Closed status tokens (client localizes; server never renders HTML). */
export type SearchItemStatus =
  | "ACTIVE"
  | "INACTIVE"
  | "UNPAID"
  | "PARTIAL"
  | "PAID";

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
