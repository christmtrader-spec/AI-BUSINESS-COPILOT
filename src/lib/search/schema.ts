/**
 * Prompt 33 — search request validation (§4.2/§16).
 *
 * The search input is UNTRUSTED. Only three parameters exist:
 *   q      required · trimmed · 2–64 Unicode characters (code points)
 *   types  optional · comma-separated · allowlisted · deduplicated
 *   limit  optional · clamped into [6, 30] (project convention: clamp)
 *
 * No arbitrary Prisma field names, no businessId/userId/tenantId/ownerId,
 * no other query params are ever read (§3). Pure module — throws
 * SearchValidationError which the route maps to the standard 422 envelope.
 */
import {
  SEARCH_ENTITY_TYPES,
  type SearchEntityType,
  type SearchInput,
} from "./types";

export const SEARCH_Q_MIN = 2;
export const SEARCH_Q_MAX = 64;
export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MIN = 6;
export const SEARCH_LIMIT_MAX = 30;

/** Bounded per-entity candidate cap (§6): 8 entities × 8 ≤ 64 candidate rows. */
export const SEARCH_PER_ENTITY_TAKE = 8;

export class SearchValidationError extends Error {
  constructor(
    public field: "q" | "types" | "limit",
    message: string,
  ) {
    super(message);
    this.name = "SearchValidationError";
  }
}

function codePoints(value: string): number {
  // Unicode-aware length (§4.2) — Persian characters count as one each.
  let n = 0;
  for (const _ of value) n += 1;
  return n;
}

function clampCodePoints(value: string, max: number): string {
  if (codePoints(value) <= max) return value;
  return Array.from(value).slice(0, max).join("");
}

function parseTypes(raw: string | null): SearchEntityType[] {
  if (raw === null || raw.trim() === "") {
    return [...SEARCH_ENTITY_TYPES];
  }
  const parts = raw
    .split(",")
    .map((p) => p.trim().toUpperCase())
    .filter((p) => p !== "");
  if (parts.length === 0) return [...SEARCH_ENTITY_TYPES];
  const seen = new Set<string>();
  for (const part of parts) {
    // §4.2 — unknown values are REJECTED, never silently ignored (an
    // allowlist that ignores unknowns would hide client/server drift).
    if (!(SEARCH_ENTITY_TYPES as readonly string[]).includes(part)) {
      throw new SearchValidationError(
        "types",
        `Unknown search type: ${part.slice(0, 32)}`,
      );
    }
    seen.add(part);
  }
  return [...seen] as SearchEntityType[];
}

function parseLimit(raw: string | null): number {
  if (raw === null || raw.trim() === "") return SEARCH_LIMIT_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return SEARCH_LIMIT_DEFAULT;
  const floored = Math.floor(n);
  return Math.min(SEARCH_LIMIT_MAX, Math.max(SEARCH_LIMIT_MIN, floored));
}

/** Parse + validate search params from a URLSearchParams instance. */
export function parseSearchParams(params: URLSearchParams): SearchInput {
  const rawQ = params.get("q");
  if (rawQ === null) {
    throw new SearchValidationError("q", "A search query is required.");
  }
  // §16 hygiene: strip control chars/null bytes, collapse whitespace.
  const q = clampCodePoints(
    rawQ.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ""),
    SEARCH_Q_MAX,
  )
    .trim()
    .replace(/\s+/g, " ");
  if (codePoints(q) < SEARCH_Q_MIN) {
    throw new SearchValidationError(
      "q",
      `Enter at least ${SEARCH_Q_MIN} characters.`,
    );
  }
  return {
    q,
    types: parseTypes(params.get("types")),
    limit: parseLimit(params.get("limit")),
  };
}
