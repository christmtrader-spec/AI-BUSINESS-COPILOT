"use client";

/**
 * Prompt 44 — client fetchers + query keys for the goods-dispatches module.
 *
 * KEY LAWS: every key carries businessId (mandatory); the dispatch id is
 * part of detail/line keys. INVALIDATION: post/cancel/line mutations
 * invalidate the dispatch keys + product/inventory surfaces (stock
 * quantity + adjustment feed change) via the shared
 * ["entities", businessId] family for Customer 360 / Product history.
 * Nothing clears the whole QueryClient.
 *
 * REQUEST LAW: the client submits ONLY authoritative inputs
 * (customerId/qty/reasonCode/reference/notes). It NEVER submits
 * businessId, status, snapshots or postedAt.
 */
import { api } from "@/lib/api-client";
import type {
  GoodsDispatchDetailDto,
  GoodsDispatchListItemDto,
} from "@/lib/inventory/goods-dispatch/dto";

export type GoodsDispatchListPage = {
  items: GoodsDispatchListItemDto[];
  total: number;
  page: number;
  pageSize: number;
};

/** goodsDispatchKeys family; businessId is mandatory everywhere. */
export const goodsDispatchKeys = {
  all: ["goods-dispatches"] as const,
  list: (
    businessId: string,
    filters: {
      q?: string;
      status?: string;
      customerId?: string;
      page: number;
      pageSize: number;
    },
  ) => ["goods-dispatches", "list", businessId, filters] as const,
  detail: (businessId: string, id: string) =>
    ["goods-dispatches", "detail", businessId, id] as const,
};

const base = "/api/v1/inventory/goods-dispatches";

export async function fetchGoodsDispatches(
  businessId: string,
  filters: {
    q?: string;
    status?: string;
    customerId?: string;
    from?: string;
    to?: string;
    page: number;
    pageSize: number;
  },
): Promise<GoodsDispatchListPage> {
  const params = new URLSearchParams({
    page: String(filters.page),
    pageSize: String(filters.pageSize),
  });
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.customerId) params.set("customerId", filters.customerId);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  void businessId; // injected automatically via the api() provider
  return api<GoodsDispatchListPage>(`${base}?${params.toString()}`);
}

export async function fetchGoodsDispatch(
  businessId: string,
  id: string,
): Promise<GoodsDispatchDetailDto> {
  void businessId;
  return api<GoodsDispatchDetailDto>(`${base}/${id}`);
}

export async function createGoodsDispatch(
  businessId: string,
  body: { customerId?: string; reference?: string; notes?: string | null },
): Promise<{ id: string; reference: string; status: string }> {
  void businessId;
  return api(`${base}`, { method: "POST", body: JSON.stringify(body) });
}

export async function updateGoodsDispatchDraft(
  businessId: string,
  id: string,
  body: { reference?: string; notes?: string | null },
): Promise<void> {
  void businessId;
  await api(`${base}/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export async function addGoodsDispatchLine(
  businessId: string,
  dispatchId: string,
  body: { productId: string; qty: number; reasonCode: string },
): Promise<{ id: string }> {
  void businessId;
  return api(`${base}/${dispatchId}/lines`, { method: "POST", body: JSON.stringify(body) });
}

export async function updateGoodsDispatchLine(
  businessId: string,
  dispatchId: string,
  lineId: string,
  body: { qty: number; reasonCode: string },
): Promise<void> {
  void businessId;
  await api(`${base}/${dispatchId}/lines/${lineId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function removeGoodsDispatchLine(
  businessId: string,
  dispatchId: string,
  lineId: string,
): Promise<void> {
  void businessId;
  await api(`${base}/${dispatchId}/lines/${lineId}`, { method: "DELETE" });
}

export async function postGoodsDispatch(
  businessId: string,
  dispatchId: string,
): Promise<Record<string, unknown>> {
  void businessId;
  return api(`${base}/${dispatchId}/post`, { method: "POST" });
}

export async function cancelGoodsDispatch(
  businessId: string,
  dispatchId: string,
): Promise<Record<string, unknown>> {
  void businessId;
  return api(`${base}/${dispatchId}/cancel`, { method: "POST" });
}
