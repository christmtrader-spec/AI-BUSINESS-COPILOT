"use client";

/**
 * Billing client hooks — Prompt 20 (§59/§60).
 *
 * UI CONVENIENCE LAYERS ONLY. The data they surface is informational:
 * the server re-verifies every entitlement on every request (§24 — client
 * state never authorizes premium access, and localStorage is never a
 * billing authority).
 *
 * Cache invalidation (§60): plan mutations invalidate the subscription,
 * entitlements, plans and reports queries via TanStack Query keys.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { ResolvedEntitlement, SubscriptionDto } from "@/lib/billing";

export type SubscriptionPayload = {
  subscription: SubscriptionDto;
  entitlements: ResolvedEntitlement[];
};

export type EntitlementsPayload = {
  planCode: string;
  entitled: boolean;
  status: string;
  entitlements: ResolvedEntitlement[];
  usage: Record<string, { used: number; limit: number | null }> | null;
};

export type PlanCatalogPayload = {
  definitions: Array<{
    code: string;
    type: "LIMIT" | "BOOLEAN";
    unit: string | null;
    description: string;
  }>;
  plans: Array<{
    code: string;
    name: string;
    description: string;
    sortOrder: number;
    /** false for customizable plans (ENTERPRISE) — excluded from switching. */
    selfService: boolean;
    entitlements: Record<string, number | null | boolean>;
  }>;
};

export type SubscriptionEventPayload = {
  items: Array<{
    id: string;
    type: string;
    fromStatus: string | null;
    toStatus: string | null;
    fromPlanCode: string | null;
    toPlanCode: string | null;
    data: unknown;
    actor: { name: string | null; email: string } | null;
    createdAt: string;
  }>;
  total: number;
  page: number;
  pageSize: number;
};

export const BILLING_KEYS = {
  subscription: ["billing", "subscription"] as const,
  entitlements: ["billing", "entitlements"] as const,
  plans: ["billing", "plans"] as const,
  events: ["billing", "events"] as const,
};

/** Invalidate everything billing touched (§60: no stale premium state). */
export function useInvalidateBilling() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: BILLING_KEYS.subscription });
    void queryClient.invalidateQueries({ queryKey: BILLING_KEYS.entitlements });
    void queryClient.invalidateQueries({ queryKey: BILLING_KEYS.plans });
    void queryClient.invalidateQueries({ queryKey: BILLING_KEYS.events });
    // Reports embed the gated advanced block; balances show usage banners.
    void queryClient.invalidateQueries({ queryKey: ["reports"] });
  };
}

export function useSubscription(enabled = true) {
  return useQuery<SubscriptionPayload>({
    queryKey: BILLING_KEYS.subscription,
    queryFn: () => api("/api/v1/billing/subscription"),
    enabled,
    staleTime: 15_000,
  });
}

export function useEntitlements(enabled = true) {
  return useQuery<EntitlementsPayload>({
    queryKey: BILLING_KEYS.entitlements,
    queryFn: () => api("/api/v1/billing/entitlements?usage=1"),
    enabled,
    staleTime: 15_000,
  });
}

export function usePlanCatalog(enabled = true) {
  return useQuery<PlanCatalogPayload>({
    queryKey: BILLING_KEYS.plans,
    queryFn: () => api("/api/v1/billing/plans"),
    enabled,
    staleTime: 60_000,
  });
}

export function useSubscriptionEvents(enabled = true) {
  return useQuery<SubscriptionEventPayload>({
    queryKey: BILLING_KEYS.events,
    queryFn: () => api("/api/v1/billing/events?pageSize=20"),
    enabled,
    staleTime: 15_000,
  });
}

export type BillingMutationResult = {
  subscription: SubscriptionDto;
  changed: boolean;
};

export function useChangePlan() {
  const invalidate = useInvalidateBilling();
  return useMutation<BillingMutationResult, Error, { planCode: string }>({
    mutationFn: (input) =>
      api("/api/v1/billing/change-plan", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => invalidate(),
  });
}

export function useCancelSubscription() {
  const invalidate = useInvalidateBilling();
  return useMutation<BillingMutationResult, Error, void>({
    mutationFn: () =>
      api("/api/v1/billing/cancel", { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => invalidate(),
  });
}

export function useReactivateSubscription() {
  const invalidate = useInvalidateBilling();
  return useMutation<BillingMutationResult, Error, void>({
    mutationFn: () =>
      api("/api/v1/billing/reactivate", { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => invalidate(),
  });
}
