/**
 * Prompt 33 — pure result grouping (§9).
 *
 * Canonical vocabulary order, non-empty groups only. Kept free of
 * server-only imports so it is unit-testable and mirrors the exact
 * production behavior used by the service.
 */
import {
  SEARCH_ENTITY_TYPES,
  type SearchEntityType,
  type SearchResultGroup,
  type SearchResultItem,
} from "./types";

/** Group result items by entity type in canonical order (deterministic). */
export function groupResults(items: SearchResultItem[]): SearchResultGroup[] {
  const byType = new Map<SearchEntityType, SearchResultItem[]>();
  for (const item of items) {
    const list = byType.get(item.type) ?? [];
    list.push(item);
    byType.set(item.type, list);
  }
  const groups: SearchResultGroup[] = [];
  for (const type of SEARCH_ENTITY_TYPES) {
    const list = byType.get(type);
    if (!list || list.length === 0) continue;
    groups.push({ type, count: list.length, items: list });
  }
  return groups;
}
