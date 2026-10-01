"use client";

/**
 * Prompt 34 — client entity API access (§35/§36/§37).
 *
 * Law:
 * - The BUSINESS ID is part of every query key (§35) so cached detail data
 *   can never cross businesses.
 * - After mutations, invalidation is TARGETED (§37) — never a blind
 *   QueryClient clear.
 * - The API path is built ONLY from the closed ENTITY_ROUTES map
 *   (lib/entity-routes) — never from arbitrary strings (§7/§64).
 */

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { ENTITY_ROUTES, type EntityType } from "@/lib/entity-routes";
import { useAppStore } from "@/store/app-store";
import { entityKeys } from "./entity-keys";

export { entityKeys };

/** Full API path for an entity detail — closed map only (§7). */
export function entityApiPath(entity: EntityType, id: string): string {
  const def = ENTITY_ROUTES[entity];
  if (!def) throw new Error("Unknown entity type");
  // The id is charset-validated at every production call site
  // (parseEntityRoute / entityView); encode again as defense-in-depth.
  return `${def.api}/${encodeURIComponent(id)}`;
}

/** Targeted entity-detail invalidation (§37) — one entity, or one id. */
export function invalidateEntityDetail(
  queryClient: QueryClient,
  businessId: string | null | undefined,
  entity: EntityType,
  id?: string,
) {
  if (id) {
    void queryClient.invalidateQueries({
      queryKey: entityKeys.one(businessId, entity, id),
    });
  } else {
    void queryClient.invalidateQueries({
      queryKey: entityKeys.business(businessId ?? "none"),
    });
  }
}

/**
 * Detail-query hook (§35/§36). The businessId is read from the store and
 * is part of the key: switching businesses re-resolves the view against
 * the new tenant (404 → not-found) and can never render stale tenant data.
 */
export function useEntityQuery<T>(entity: EntityType, id: string) {
  const businessId = useAppStore((s) => s.activeBusinessId);
  return useQuery<T>({
    queryKey: entityKeys.one(businessId, entity, id),
    queryFn: () => api<T>(entityApiPath(entity, id)),
    enabled: Boolean(businessId && id),
    // Details are read-mostly; a short stale window keeps revisits snappy
    // while still converging to server state after mutations (§63).
    staleTime: 15_000,
    retry: false,
  });
}

/** Convenience: queryClient bound to the active business for invalidations. */
export function useEntityInvalidator() {
  const queryClient = useQueryClient();
  const businessId = useAppStore((s) => s.activeBusinessId);
  return (entity: EntityType, id?: string) =>
    invalidateEntityDetail(queryClient, businessId, entity, id);
}
