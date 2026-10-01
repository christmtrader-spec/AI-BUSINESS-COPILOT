/**
 * Prompt 34 — Entity routes: the SINGLE SOURCE OF TRUTH for the closed
 * entity vocabulary and its hash/API routing (§3/§5/§7).
 *
 * Law (§6/§39/§64):
 * - The entity vocabulary is CLOSED: exactly six tenant entity types. User,
 *   business, audit, security, platform, AI-cost, notification, portability
 *   and payment-processor concepts are intentionally NOT routable entities.
 * - The first hash segment must be on the allowlist; the id segment must be
 *   non-empty, bounded and charset-safe. Anything else is NOT an entity
 *   route (it never "falls through" to an arbitrary interpretation).
 * - Route data is never executed, never injected into HTML and never used
 *   to construct arbitrary redirect URLs. Links are built ONLY through
 *   `entityToHash` from a closed entity + a validated id.
 * - Parsing lives here ONCE (§6: "Do not duplicate entity parsing rules").
 *   Both `hashToView` and deep-link producers go through this file.
 */

/** Closed tenant entity vocabulary (§3/§4) — lowercase client tokens. */
export const ENTITY_TYPES = [
  "customer",
  "supplier",
  "product",
  "sale",
  "expense",
  "payment",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export function isEntityType(value: string): value is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * Entity destination map (§7): entity → list route segment, detail route
 * template, API path template and display label key. The hash segment is
 * deliberately identical to the existing list-module segment so
 * `#/customers` stays the list and `#/customers/<id>` becomes the detail.
 */
export type EntityRouteDef = {
  /** Hash/list segment (e.g. "customers"). */
  segment: string;
  /** API base path on the server (the `:id` is appended by callers). */
  api: string;
  /** nav.* label key of the owning list module (breadcrumb/back label). */
  labelKey: string;
};

export const ENTITY_ROUTES: Record<EntityType, EntityRouteDef> = {
  customer: { segment: "customers", api: "/api/v1/customers", labelKey: "customers" },
  supplier: { segment: "suppliers", api: "/api/v1/suppliers", labelKey: "suppliers" },
  product: { segment: "products", api: "/api/v1/products", labelKey: "products" },
  sale: { segment: "sales", api: "/api/v1/sales", labelKey: "sales" },
  expense: { segment: "expenses", api: "/api/v1/expenses", labelKey: "expenses" },
  payment: { segment: "payments", api: "/api/v1/payments", labelKey: "payments" },
};

/** Reverse map: hash segment → entity. Built ONCE from ENTITY_ROUTES. */
const SEGMENT_TO_ENTITY: Record<string, EntityType> = Object.fromEntries(
  ENTITY_TYPES.map((entity) => [ENTITY_ROUTES[entity].segment, entity]),
) as Record<string, EntityType>;

/**
 * Prompt 33 search types → Prompt 34 entities. One closed map — search
 * results never build URLs client-side from server strings (§33/§64);
 * they resolve type+id through this vocabulary.
 */
export const SEARCH_TYPE_TO_ENTITY = {
  CUSTOMER: "customer",
  SUPPLIER: "supplier",
  PRODUCT: "product",
  SALE: "sale",
  EXPENSE: "expense",
  PAYMENT: "payment",
} as const satisfies Record<string, EntityType>;

/**
 * Hard id bounds (§6.3): cuids are 25 chars; the cap is deliberately
 * generous but FINITE so hostile fragments can never be huge payloads.
 */
export const ENTITY_ID_MAX_LENGTH = 64;

/**
 * Id charset (§6.4): the app generates cuid-style ids, so this accepts
 * ASCII letters/digits plus `-` and `_`. It therefore REJECTS `/`, `?`,
 * `#`, `%`, whitespace, control characters, and any non-ASCII payload —
 * stricter than the spec's minimum (§6.4) and immune to encoding tricks.
 */
const ENTITY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidEntityId(raw: string): boolean {
  return raw.length <= ENTITY_ID_MAX_LENGTH && ENTITY_ID_PATTERN.test(raw);
}

/**
 * Safe percent-decoding (§6.5): `decodeURIComponent` throws on malformed
 * sequences (`%/`, `%zz`) — a malformed fragment must degrade to "not an
 * entity route", never surface an exception.
 */
function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

/**
 * Parse a path remainder (the hash path WITHOUT the leading `#/`, e.g.
 * `"customers/cmid123"`) into an entity route view payload (§6).
 *
 * Rules:
 * 1. exactly two segments (first must be an allowlisted entity segment);
 * 2. the id decodes safely and passes `isValidEntityId`;
 * 3. no query string is accepted here (callers strip `?…` first);
 * 4. ANY deviation → `null` (callers fall back to the dashboard/list).
 */
export function parseEntityRoute(path: string): { entity: EntityType; id: string } | null {
  const slash = path.indexOf("/");
  if (slash === -1) return null;
  const first = path.slice(0, slash);
  const second = path.slice(slash + 1);
  // A third segment (a second "/") is not an entity route.
  if (second.includes("/")) return null;
  const entity = SEGMENT_TO_ENTITY[first];
  if (!entity) return null;
  if (second.length === 0) return null;
  const id = safeDecode(second);
  if (!isValidEntityId(id)) return null;
  return { entity, id };
}

/**
 * Build the deep-link hash for an entity (§5/§39). Returns `null` for any
 * input that would not survive `parseEntityRoute` round-trip — encoding
 * and parsing are guaranteed to agree because both live here.
 */
export function entityToHash(entity: EntityType, id: string): string | null {
  if (!isEntityType(entity)) return null;
  if (!isValidEntityId(id)) return null;
  return `#/${ENTITY_ROUTES[entity].segment}/${encodeURIComponent(id)}`;
}
