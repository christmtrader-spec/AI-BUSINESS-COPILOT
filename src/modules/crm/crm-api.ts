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
} from "@/lib/crm/types";
import type { ActivityListResponse } from "@/lib/crm/activity-dto";
import type { TaskListResponse } from "@/lib/crm/task-dto";
import type { WorkQueueResponse } from "@/lib/crm/work-queue-types";
import type { TimelineResponse } from "@/lib/crm/timeline-types";

/** §50 — CRM query-key factory (pure, businessId-scoped). */
export const crmKeys = {
  all: ["crm"] as const,
  business: (businessId: string | null | undefined) => ["crm", businessId ?? "none"] as const,
  leads: (businessId: string | null | undefined) => ["crm", businessId ?? "none", "leads"] as const,
  opportunities: (businessId: string | null | undefined) =>
    ["crm", businessId ?? "none", "opportunities"] as const,
  summary: (businessId: string | null | undefined) =>
    ["crm", businessId ?? "none", "summary"] as const,
  // Prompt 36 (§55) — every key carries businessId; context ids where relevant.
  activities: (businessId: string | null | undefined) =>
    ["crm", businessId ?? "none", "activities"] as const,
  tasks: (businessId: string | null | undefined) =>
    ["crm", businessId ?? "none", "tasks"] as const,
  workQueue: (businessId: string | null | undefined) =>
    ["crm", businessId ?? "none", "workQueue"] as const,
  timeline: (businessId: string | null | undefined) =>
    ["crm", businessId ?? "none", "timeline"] as const,
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
  void queryClient.invalidateQueries({ queryKey: crmKeys.activities(businessId) });
  void queryClient.invalidateQueries({ queryKey: crmKeys.tasks(businessId) });
  void queryClient.invalidateQueries({ queryKey: crmKeys.workQueue(businessId) });
  void queryClient.invalidateQueries({ queryKey: crmKeys.timeline(businessId) });
  void queryClient.invalidateQueries({ queryKey: ["search"] });
  if (opts.customers) {
    void queryClient.invalidateQueries({ queryKey: ["parties", "customer"] });
  }
}

/**
 * Prompt 36 (§56) — invalidate ONLY the timeline/activity/task caches plus
 * the owning entity's detail (and the customer 360 for CUSTOMER contexts).
 * Never a whole-QueryClient clear.
 */
export function invalidateCrmContextCaches(
  queryClient: QueryClient,
  businessId: string | null | undefined,
  context: { type: "CUSTOMER" | "LEAD" | "OPPORTUNITY"; id: string } | null,
) {
  void queryClient.invalidateQueries({ queryKey: crmKeys.activities(businessId) });
  void queryClient.invalidateQueries({ queryKey: crmKeys.tasks(businessId) });
  void queryClient.invalidateQueries({ queryKey: crmKeys.workQueue(businessId) });
  void queryClient.invalidateQueries({ queryKey: crmKeys.timeline(businessId) });
  if (context?.id) {
    const entity =
      context.type === "CUSTOMER" ? "customer" : context.type === "LEAD" ? "lead" : "opportunity";
    invalidateEntityDetail(queryClient, businessId, entity, context.id);
    if (context.type === "CUSTOMER") {
      void queryClient.invalidateQueries({ queryKey: ["parties", "customer"] });
    }
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

/* ========================================================================== */
/* Prompt 36 — Activities / Tasks / Work Queue / Timeline (§55/§56/§116)      */
/* ========================================================================== */

export type CrmContextInput = { type: "CUSTOMER" | "LEAD" | "OPPORTUNITY"; id: string };

/** Build the query suffix for a context filter pair (contextId is a value, not a URL builder). */
function contextQuery(ctx: CrmContextInput): string {
  return `contextType=${encodeURIComponent(ctx.type)}&contextId=${encodeURIComponent(ctx.id)}`;
}

/** Activities for one context (timeline/detail pages) — bounded page size. */
export function useCrmActivities(
  ctx: CrmContextInput | null,
  params: { q?: string; page?: number; pageSize?: number } = {},
) {
  const businessId = useAppStore((s) => s.activeBusinessId);
  const search = new URLSearchParams({
    page: String(params.page ?? 1),
    pageSize: String(params.pageSize ?? 25),
  });
  if (params.q) search.set("q", params.q);
  if (ctx) {
    search.set("contextType", ctx.type);
    search.set("contextId", ctx.id);
  }
  return useQuery({
    queryKey: [
      ...crmKeys.activities(businessId),
      ctx ? `${ctx.type}:${ctx.id}` : "all",
      { q: params.q ?? "", page: params.page ?? 1, pageSize: params.pageSize ?? 25 },
    ],
    queryFn: () => api<ActivityListResponse>(`/api/v1/crm/activities?${search.toString()}`),
    enabled: Boolean(businessId && (ctx ? ctx.id : true)),
    staleTime: 15_000,
    retry: false,
  });
}

/** Tasks list with filters (context view + active-task cards). */
export function useCrmTasks(
  params: {
    q?: string;
    status?: string | null;
    priority?: string | null;
    assignedToUserId?: string | null;
    ctx?: CrmContextInput | null;
    page?: number;
    pageSize?: number;
  },
) {
  const businessId = useAppStore((s) => s.activeBusinessId);
  const search = new URLSearchParams({
    page: String(params.page ?? 1),
    pageSize: String(params.pageSize ?? 25),
  });
  if (params.q) search.set("q", params.q);
  if (params.status) search.set("status", params.status);
  if (params.priority) search.set("priority", params.priority);
  if (params.assignedToUserId) search.set("assignedToUserId", params.assignedToUserId);
  if (params.ctx) {
    search.set("contextType", params.ctx.type);
    search.set("contextId", params.ctx.id);
  }
  return useQuery({
    queryKey: [
      ...crmKeys.tasks(businessId),
      {
        q: params.q ?? "",
        status: params.status ?? "",
        priority: params.priority ?? "",
        assignedToUserId: params.assignedToUserId ?? "",
        ctx: params.ctx ? `${params.ctx.type}:${params.ctx.id}` : "",
        page: params.page ?? 1,
        pageSize: params.pageSize ?? 25,
      },
    ],
    queryFn: () => api<TaskListResponse>(`/api/v1/crm/tasks?${search.toString()}`),
    enabled: Boolean(businessId),
    staleTime: 15_000,
    retry: false,
  });
}

/**
 * Server-driven work queue (§118): buckets + counts arrive classified —
 * the client only renders. `mine=false` + assignee shows that member's queue.
 */
export function useCrmWorkQueue(params: { assignedToUserId?: string | null; enabled?: boolean } = {}) {
  const businessId = useAppStore((s) => s.activeBusinessId);
  const search = new URLSearchParams();
  if (params.assignedToUserId) search.set("assignedToUserId", params.assignedToUserId);
  return useQuery({
    queryKey: [
      ...crmKeys.workQueue(businessId),
      { assignedToUserId: params.assignedToUserId ?? "" },
    ],
    queryFn: () =>
      api<WorkQueueResponse>(
        search.toString() ? `/api/v1/crm/tasks/work-queue?${search.toString()}` : "/api/v1/crm/tasks/work-queue",
      ),
    enabled: Boolean(businessId) && (params.enabled ?? true),
    staleTime: 10_000,
    retry: false,
  });
}

/** Unified timeline for one context (§34) — server-merged + bounded. */
export function useCrmTimeline(
  ctx: CrmContextInput | null,
  params: { page?: number; pageSize?: number } = {},
) {
  const businessId = useAppStore((s) => s.activeBusinessId);
  return useQuery({
    queryKey: [
      ...crmKeys.timeline(businessId),
      ctx ? `${ctx.type}:${ctx.id}` : "none",
      { page: params.page ?? 1, pageSize: params.pageSize ?? 25 },
    ],
    queryFn: () => {
      const search = new URLSearchParams({
        contextType: ctx!.type,
        contextId: ctx!.id,
        page: String(params.page ?? 1),
        pageSize: String(params.pageSize ?? 25),
      });
      return api<TimelineResponse>(`/api/v1/crm/timeline?${search.toString()}`);
    },
    enabled: Boolean(businessId && ctx?.id),
    staleTime: 15_000,
    retry: false,
  });
}

/** Activity mutations (§56) — targeted timeline + entity-detail invalidation. */
export function useActivityMutations() {
  const queryClient = useQueryClient();
  const businessId = useAppStore((s) => s.activeBusinessId);

  const after = (ctx: CrmContextInput | null) => {
    invalidateCrmContextCaches(queryClient, businessId, ctx);
    // Customer/lead/opportunity 360s embed the timeline — refresh their keys.
    if (ctx?.type === "CUSTOMER") {
      void queryClient.invalidateQueries({ queryKey: ["parties", "customer"] });
    }
  };

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<unknown>("/api/v1/crm/activities", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (_d, variables) => after(contextFromBody(variables)),
  });

  const update = useMutation({
    mutationFn: ({ id, body, ctx }: { id: string; body: Record<string, unknown>; ctx: CrmContextInput | null }) =>
      api<unknown>(`/api/v1/crm/activities/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: (_d, variables) => after(variables.ctx),
  });

  const remove = useMutation({
    mutationFn: ({ id, ctx }: { id: string; ctx: CrmContextInput | null }) =>
      api<unknown>(`/api/v1/crm/activities/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: (_d, variables) => after(variables.ctx),
  });

  return { create, update, remove };
}

function contextFromBody(body: Record<string, unknown>): CrmContextInput | null {
  if (typeof body.customerId === "string" && body.customerId) return { type: "CUSTOMER", id: body.customerId };
  if (typeof body.leadId === "string" && body.leadId) return { type: "LEAD", id: body.leadId };
  if (typeof body.opportunityId === "string" && body.opportunityId) return { type: "OPPORTUNITY", id: body.opportunityId };
  return null;
}

/** Task mutations (§56) — list + workQueue + timeline + context detail. */
export function useTaskMutations() {
  const queryClient = useQueryClient();
  const businessId = useAppStore((s) => s.activeBusinessId);

  const after = (ctx: CrmContextInput | null) => invalidateCrmContextCaches(queryClient, businessId, ctx);

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<unknown>("/api/v1/crm/tasks", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (_d, variables) => after(contextFromBody(variables)),
  });

  const update = useMutation({
    mutationFn: ({ id, body, ctx }: { id: string; body: Record<string, unknown>; ctx: CrmContextInput | null }) =>
      api<unknown>(`/api/v1/crm/tasks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: (_d, variables) => after(variables.ctx),
  });

  const changeStatus = useMutation({
    mutationFn: ({ id, status, ctx }: { id: string; status: string; ctx: CrmContextInput | null }) =>
      api<unknown>(`/api/v1/crm/tasks/${encodeURIComponent(id)}/status`, {
        method: "POST",
        body: JSON.stringify({ status }),
      }),
    onSuccess: (_d, variables) => after(variables.ctx),
  });

  const remove = useMutation({
    mutationFn: ({ id, ctx }: { id: string; ctx: CrmContextInput | null }) =>
      api<unknown>(`/api/v1/crm/tasks/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: (_d, variables) => after(variables.ctx),
  });

  return { create, update, changeStatus, remove };
}
