"use client";

/**
 * Prompt 33 — client search data layer (§30).
 *
 * TanStack Query keys ALWAYS include businessId + query + types so cached
 * results can never cross a business switch boundary (§18). The server
 * remains authoritative; client caching is a very short UI lifetime only.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { useAppStore } from "@/store/app-store";
import type {
  SearchEntityType,
  SearchResponseData,
} from "@/lib/search/types";

/** Palette/center shared debounce window (§12.6 — 200–300 ms). */
export const SEARCH_DEBOUNCE_MS = 250;

/** Very short UI cache lifetime (§11/§30) — the server is authoritative. */
export const SEARCH_STALE_TIME_MS = 15_000;

export const SEARCH_Q_MIN = 2;

/** Closed query-key factory (§30) — never keys on objects/arrays. */
export const searchKeys = {
  all: ["search"] as const,
  query: (
    businessId: string | null,
    q: string,
    types: SearchEntityType[] | null,
  ) =>
    [
      ...searchKeys.all,
      businessId ?? "none",
      q,
      types && types.length > 0 ? types.join(",") : "ALL",
    ] as const,
};

export async function fetchSearch(
  q: string,
  types: SearchEntityType[] | null,
  signal?: AbortSignal,
): Promise<SearchResponseData> {
  const sp = new URLSearchParams();
  sp.set("q", q);
  if (types && types.length > 0 && types.length < 6) {
    sp.set("types", types.join(","));
  }
  return api<SearchResponseData>(`/api/v1/search?${sp.toString()}`, { signal });
}

/**
 * Shared search query for the Command Palette AND the Search Center.
 * `enabled` gates the palette (open && q ≥ 2) vs the center (q ≥ 2).
 * Stale-response protection (§12.8): results are keyed by the exact query,
 * so an older response can never render for a newer query.
 */
export function useSearchQuery(options: {
  q: string;
  types?: SearchEntityType[] | null;
  enabled: boolean;
}): UseQueryResult<SearchResponseData> {
  const { q, types = null, enabled } = options;
  const activeBusinessId = useAppStore((s) => s.activeBusinessId);
  const trimmed = q.trim();
  return useQuery({
    queryKey: searchKeys.query(activeBusinessId, trimmed, types),
    queryFn: ({ signal }) => fetchSearch(trimmed, types, signal),
    enabled: enabled && trimmed.length >= SEARCH_Q_MIN,
    staleTime: SEARCH_STALE_TIME_MS,
    gcTime: 60_000,
    retry: 1,
  });
}
