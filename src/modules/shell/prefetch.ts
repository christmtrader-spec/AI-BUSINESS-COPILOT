"use client";

import type { QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { fetchBalancesData } from "../balances/balances-data";

/**
 * Prefetch warming (Phase 06 hardening) — the heavy deterministic
 * aggregates (reports/summary) and balance lists are computed
 * server-side and take the longest; warming them on sidebar hover /
 * idle makes deep links into Reports and Balances feel instant.
 *
 * Query keys MUST mirror the ones used by the views exactly, AND the cached
 * value must have the SAME SHAPE the view's queryFn produces — otherwise a
 * warmed entry is served to the view and crashes it (r8 QA: raw receivables
 * response cached under ["receivables"] hit `byParty[0]` in BalancesView).
 * Views with a transform share their fetch function:
 *   - balances-data.ts → fetchBalancesData(kind)  (mapped BalancesData)
 *   - reports/dashboard call api() raw, so prefetch calls api() raw too.
 * `api()` injects the active business header via the registered provider.
 */

type PrefetchSpec = {
  queryKey: readonly unknown[];
  load: () => Promise<unknown>;
};

/** Idle-warm targets, in cost order (heaviest first). */
const WARM_MODULES = ["reports", "receivables", "payables"] as const;

export function prefetchSpecsFor(module: string): PrefetchSpec[] {
  switch (module) {
    case "reports":
    case "dashboard":
      return [
        {
          queryKey: ["reports", "summary", "30"],
          load: () => api("/api/v1/reports/summary?days=30"),
        },
      ];
    case "receivables":
      return [
        {
          queryKey: ["receivables"],
          load: () => fetchBalancesData("receivables"),
        },
      ];
    case "payables":
      return [
        { queryKey: ["payables"], load: () => fetchBalancesData("payables") },
      ];
    default:
      return [];
  }
}

/** Prefetch every spec for a module. Fire-and-forget, deduped by TanStack. */
export function prefetchModuleData(queryClient: QueryClient, module: string) {
  for (const spec of prefetchSpecsFor(module)) {
    void queryClient.prefetchQuery({
      queryKey: spec.queryKey,
      queryFn: spec.load,
      staleTime: 20_000,
    });
  }
}

/** Warm the heaviest queries once per active business (idle callback). */
export function warmHeavyQueries(queryClient: QueryClient) {
  for (const m of WARM_MODULES) prefetchModuleData(queryClient, m);
}

/** requestIdleCallback with a setTimeout fallback (Safari <16). */
export function onIdle(cb: () => void, timeoutMs = 2000): () => void {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
  };
  if (typeof w.requestIdleCallback === "function") {
    const id = w.requestIdleCallback(cb, { timeout: timeoutMs });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(cb, Math.min(1200, timeoutMs));
  return () => window.clearTimeout(id);
}
