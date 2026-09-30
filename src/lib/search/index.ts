/**
 * Prompt 33 — search subsystem public surface (§28).
 *
 * Server entry: searchBusiness (via the /api/v1/search route).
 * Pure helpers (types/normalize/schema/rank) are import-safe for unit tests
 * and for type-only client imports; query/service are server-only.
 */
export * from "./types";
export * from "./normalize";
export * from "./schema";
export * from "./rank";
export { searchBusiness, groupResults, type SearchLocale } from "./service";
