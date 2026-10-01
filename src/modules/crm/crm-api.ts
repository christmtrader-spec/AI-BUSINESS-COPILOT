"use client";

/**
 * Prompt 35 — CRM client data access (§50/§51/§52).
 *
 * Law:
 * - EVERY query key carries the businessId (§50) — cached CRM data can
 *   never cross businesses.
 * - Mutations invalidate TARGETED keys only (§52): the relevant list, the
 *   summary, affected entity details, customer 360 and search — never a
 *   blind QueryClient clear.
 * - API paths are literal, audited strings (§7 discipline) — no server
 *   value ever builds a client URL.
 */

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, ApiClientError } from "@/lib/api-client";
import { useAppStore } from "@/store/app-store";
import { invalidateEntityDetail } from "../entities/entity-api";
import type {
  CrmSummary,
  LeadListResponse,
  OpportunityListResponse,
} from "@/lib/crm";

/** §50 — CRM query-key factory (pure, businessId-scoped). */
export const crmKeys = {
  all: ["crm"] as const,
  business: (businessId: string | null | undefined) => ["crm", businessId ?? "none"] as const,
  leads: (businessId: string | null | undefined) => ["crm", businessId ?? "none", "leads"] as const,
  opportunities: (businessId: string | null | undefined) =>
    ["crm", businessId ?? "none", "opportunities"] as const,
  summary: (businessId: string | null | undefined) =>
    ["crm", businessId ?? "none", "summary"] as const,
};

/** Invalidate the whole CRM domain for the active business (§51 — switch). */
export function invalidateCrmDomain(
  queryClient: QueryClient,
  businessId: string | null | undefined,
) {
  void queryClient.invalidateQueries({ queryKey: crmKeys.business(businessId) });
}

/** Targeted post-mutation invalidation (§52/§139). */
export function invalidateCrmAfterMutation(
  queryClient: QueryClient,
  businessId: string | null | undefined,
  opts: { customers?: boolean } = {},
) {
  void queryClient.invalidateQueries({ queryKey: crmKeys.leads(businessId) });
  void queryClient.invalidateQueries({ queryKey: crmKeys.opportunities(businessId) });
  void queryClient.invalidateQueries({ queryKey: crmKeys.summary(businessId) });
  void queryClient.invalidateQueries({ queryKey: ["search"] });
  if (opts.customers) {
    void queryClient.invalidateQueries({ queryKey: ["parties", "customer"] });
  }
}

export function useCrmSummary() {
  const businessId = useAppStore((s) => s.activeBusinessId);
  return useQuery({
    queryKey: crmKeys.summary(businessId),
    queryFn: () => api<CrmSummary>("/api/v1/crm/summary"),
    enabled: Boolean(businessId),
    staleTime: 15_000,
    retry: false,
  });
}

export function useCrmLeads(params: {
  q?: string;
  status?: string | null;
  page: number;
  pageSize: number;
}) {
  const businessId = useAppStore((s) => s.activeBusinessId);
  const search = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
  });
  if (params.q) search.set("q", params.q);
  if (params.status) search.set("status", params.status);
  return useQuery({
    queryKey: [
      ...crmKeys.leads(businessId),
      { q: params.q ?? "", status: params.status ?? "", page: params.page, pageSize: params.pageSize },
    ],
    queryFn: () => api<LeadListResponse>(`/api/v1/crm/leads?${search.toString()}`),
    enabled: Boolean(businessId),
    staleTime: 15_000,
    retry: false,
  });
}

export function useCrmOpportunities(params: {
  q?: string;
  stage?: string | null;
  customerId?: string | null;
  leadId?: string | null;
  page: number;
  pageSize: number;
}) {
  const businessId = useAppStore((s) => s.activeBusinessId);
  const search = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
  });
  if (params.q) search.set("q", params.q);
  if (params.stage) search.set("stage", params.stage);
  if (params.customerId) search.set("customerId", params.customerId);
  if (params.leadId) search.set("leadId", params.leadId);
  return useQuery({
    queryKey: [
      ...crmKeys.opportunities(businessId),
      {
        q: params.q ?? "",
        stage: params.stage ?? "",
        customerId: params.customerId ?? "",
        leadId: params.leadId ?? "",
        page: params.page,
        pageSize: params.pageSize,
      },
    ],
    queryFn: () =>
      api<OpportunityListResponse>(`/api/v1/crm/opportunities?${search.toString()}`),
    enabled: Boolean(businessId),
    staleTime: 15_000,
    retry: false,
  });
}

/** Opportunities for the Customer 360 CRM section (§44 — bounded pageSize 10). */
export function useCustomerOpportunities(customerId: string | null) {
  const businessId = useAppStore((s) => s.activeBusinessId);
  return useQuery({
    queryKey: [...crmKeys.opportunities(businessId), "customer", customerId],
    queryFn: () =>
      api<OpportunityListResponse>(
        `/api/v1/crm/opportunities?customerId=${encodeURIComponent(customerId ?? "")}&pageSize=10`,
      ),
    enabled: Boolean(businessId && customerId),
    staleTime: 15_000,
    retry: false,
  });
}

/** Member list (assignee selector) — same query the members page uses. */
export interface MemberItem {
  id: string;
  name: string | null;
  email: string;
  role: string;
}

export function useBusinessMembers() {
  const businessId = useAppStore((s) => s.activeBusinessId);
  return useQuery({
    queryKey: ["members", businessId],
    queryFn: () => api<MemberItem[]>(`/api/v1/businesses/${businessId}/members`),
    enabled: Boolean(businessId),
    staleTime: 60_000,
    retry: false,
  });
}

export function useLeadMutations() {
  const queryClient = useQueryClient();
  const businessId = useAppStore((s) => s.activeBusinessId);

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<unknown>("/api/v1/crm/leads", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => invalidateCrmAfterMutation(queryClient, businessId),
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api<unknown>(`/api/v1/crm/leads/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateCrmAfterMutation(queryClient, businessId),
  });

  const changeStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api<unknown>(`/api/v1/crm/leads/${encodeURIComponent(id)}/status`, {
        method: "POST",
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => invalidateCrmAfterMutation(queryClient, businessId),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      api<unknown>(`/api/v1/crm/leads/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => invalidateCrmAfterMutation(queryClient, businessId, { customers: true }),
  });

  return { create, update, changeStatus, remove };
}

export function useOpportunityMutations() {
  const queryClient = useQueryClient();
  const businessId = useAppStore((s) => s.activeBusinessId);

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<unknown>("/api/v1/crm/opportunities", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => invalidateCrmAfterMutation(queryClient, businessId, { customers: true }),
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api<unknown>(`/api/v1/crm/opportunities/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateCrmAfterMutation(queryClient, businessId, { customers: true }),
  });

  const changeStage = useMutation({
    mutationFn: ({
      id,
      stage,
      probabilityPct,
      lostReason,
    }: {
      id: string;
      stage: string;
      probabilityPct?: number;
      lostReason?: string | null;
    }) =>
      api<unknown>(`/api/v1/crm/opportunities/${encodeURIComponent(id)}/stage`, {
        method: "POST",
        body: JSON.stringify({
          stage,
          ...(probabilityPct !== undefined ? { probabilityPct } : {}),
          ...(lostReason ? { lostReason } : {}),
        }),
      }),
    onSuccess: () => invalidateCrmAfterMutation(queryClient, businessId, { customers: true }),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      api<unknown>(`/api/v1/crm/opportunities/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => invalidateCrmAfterMutation(queryClient, businessId, { customers: true }),
  });

  return { create, update, changeStage, remove };
}

/** Convert mutation (§23) — invalidates customer lists + CRM domain (§139). */
export function useConvertLead() {
  const queryClient = useQueryClient();
  const businessId = useAppStore((s) => s.activeBusinessId);
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api<unknown>(`/api/v1/crm/leads/${encodeURIComponent(id)}/convert`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (_data, variables) => {
      invalidateCrmAfterMutation(queryClient, businessId, { customers: true });
      if (variables.id) {
        invalidateEntityDetail(queryClient, businessId, "lead", variables.id);
      }
    },
  });
}

/** Open stages available in the opportunity CREATE form (§58). */
export const OPEN_STAGES_EXPORT = ["DISCOVERY", "QUALIFIED", "PROPOSAL", "NEGOTIATION"] as const;

/** Re-export for dialogs that surface server validation messages. */
export { ApiClientError };
