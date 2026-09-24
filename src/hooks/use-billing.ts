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
  /** Prompt 22 — settlement currency of the server price catalog (EUR). */
  settlementCurrency: string;
  plans: Array<{
    code: string;
    name: string;
    description: string;
    sortOrder: number;
    /** false for customizable plans (ENTERPRISE) — excluded from switching. */
    selfService: boolean;
    /** Server-authoritative pricing (null for FREE / ENTERPRISE). */
    pricing: { monthlyMinor: number; yearlyMinor: number; currency: string } | null;
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
  usage: ["billing", "usage"] as const,
};

/** Invalidate everything billing touched (§60: no stale premium state). */
export function useInvalidateBilling() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: BILLING_KEYS.subscription });
    void queryClient.invalidateQueries({ queryKey: BILLING_KEYS.entitlements });
    void queryClient.invalidateQueries({ queryKey: BILLING_KEYS.plans });
    void queryClient.invalidateQueries({ queryKey: BILLING_KEYS.events });
    void queryClient.invalidateQueries({ queryKey: BILLING_KEYS.usage });
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

// ---------------------------------------------------------------------------
// Prompt 21 — usage metering UI hooks (§52/§94). INFORMATIONAL ONLY: the
// server re-verifies every quota server-side on each AI request; these
// numbers never authorize anything (§3/§26).
// ---------------------------------------------------------------------------

export type UsageMetricPayload = {
  metric: string;
  used: number;
  limit: number | null;
  remaining: number | null;
  percentageUsed: number | null;
  level: "ok" | "warning" | "critical" | "reached";
};

export type UsagePayload = {
  planCode: string;
  entitled: boolean;
  status: string;
  period: { start: string; end: string | null };
  metrics: {
    AI_REQUESTS: UsageMetricPayload;
    AI_MESSAGES: UsageMetricPayload;
    AI_TOKENS: UsageMetricPayload;
  };
};

export function useUsage(enabled = true) {
  return useQuery<UsagePayload>({
    queryKey: BILLING_KEYS.usage,
    queryFn: () => api("/api/v1/billing/usage"),
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

// ---------------------------------------------------------------------------
// Prompt 22 — payment provider abstraction (sandbox checkout). The UI never
// supplies amounts: it sends { planCode, billingPeriod } and everything
// else (price, provider, state) comes from the server (§23/§24).
// ---------------------------------------------------------------------------

export type CheckoutSessionDto = {
  id: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "EXPIRED" | "CANCELED" | "RECONCILIATION_REQUIRED";
  planCode: string;
  billingPeriod: "MONTHLY" | "YEARLY";
  provider: string;
  amountMinor: number;
  currency: string;
  expiresAt: string;
  completedAt: string | null;
  fulfilledAt: string | null;
  createdAt: string;
  redirectUrl: string | null;
  /** Prompt 23 §45 — set only on RECONCILIATION_REQUIRED sessions. */
  reconciliationReason: string | null;
  /** Prompt 23 §13 — catalog edition that priced this intent. */
  pricingVersion: string | null;
  /** Prompt 23 §110 — the business being charged. */
  businessName: string;
};

export type CheckoutSessionPayload = { checkoutSession: CheckoutSessionDto };

export type PaymentsPayload = {
  items: Array<{
    id: string;
    checkoutSessionId: string;
    provider: string;
    status: string;
    planCode: string;
    billingPeriod: "MONTHLY" | "YEARLY";
    amountMinor: number;
    currency: string;
    processedAt: string;
  }>;
  total: number;
};

export const CHECKOUT_KEYS = {
  payments: ["billing", "payments"] as const,
};

export function useCreateCheckout() {
  const invalidate = useInvalidateBilling();
  return useMutation<CheckoutSessionPayload, Error, { planCode: string; billingPeriod: string }>({
    mutationFn: (input) =>
      api("/api/v1/billing/checkout", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => invalidate(),
  });
}

/** Poll the checkout session while the sandbox dialog is open (3s). */
export function useCheckoutSession(id: string | null, active = true) {
  return useQuery<CheckoutSessionPayload>({
    queryKey: ["billing", "checkout", id],
    queryFn: () => api(`/api/v1/billing/checkout/${id}`),
    enabled: !!id && active,
    refetchInterval: (query) => {
      const st = query.state.data?.checkoutSession.status;
      return st === "PENDING" ? 3000 : false;
    },
  });
}

/**
 * Prompt 23 §20/§68 — deliberate, user-driven server-side verification
 * (bounded: 10/min server-side; the browser NEVER decides the outcome).
 */
export function useVerifyCheckout() {
  const invalidate = useInvalidateBilling();
  return useMutation<
    { session: CheckoutSessionPayload["checkoutSession"] | null; verification: string },
    Error,
    { id: string }
  >({
    mutationFn: ({ id }) =>
      api(`/api/v1/billing/checkout/${id}/verify`, { method: "POST" }),
    onSuccess: () => invalidate(),
  });
}

export function useSimulateCheckout() {
  const invalidate = useInvalidateBilling();
  return useMutation<CheckoutSessionPayload, Error, { id: string; outcome: "succeeded" | "failed" }>({
    mutationFn: ({ id, outcome }) =>
      api(`/api/v1/billing/checkout/${id}/simulate`, {
        method: "POST",
        body: JSON.stringify({ outcome }),
      }),
    onSuccess: () => invalidate(),
  });
}

export function usePayments(enabled = true) {
  return useQuery<PaymentsPayload>({
    queryKey: CHECKOUT_KEYS.payments,
    queryFn: () => api("/api/v1/billing/payments?take=20"),
    enabled,
    staleTime: 15_000,
  });
}

/** Download the payments CSV (blob → object URL → anchor click). */
export async function downloadPaymentsCsv(businessId?: string | null): Promise<number> {
  const res = await fetch("/api/v1/billing/payments?format=csv", {
    credentials: "same-origin",
    headers: businessId ? { "x-business-id": businessId } : undefined,
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      /* keep status fallback */
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const disp = res.headers.get("content-disposition") ?? "";
  a.download = /filename="?([^"]+)"?/.exec(disp)?.[1] ?? "payments.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  // The honest row count: header line + data lines in the blob text.
  const text = await blob.text();
  const lines = text.split(/\r\n/).filter((l) => l.length > 0);
  return Math.max(0, lines.length - 1);
}
