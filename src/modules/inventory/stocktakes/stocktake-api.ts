"use client";

/**
 * Prompt 40 — client fetchers + query keys for the stocktake module.
 *
 * KEY LAWS (§119): every key carries businessId (mandatory); the stocktake
 * id is part of detail/line keys. Type separation is inherent in the key
 * prefixes.
 * INVALIDATION (§120/§121): mutations invalidate the targeted stocktake
 * keys + inventory surfaces; finalize also invalidates product detail /
 * product lists / adjustment history (stock quantity + history change).
 * Nothing clears the whole QueryClient.
 */
import { api } from "@/lib/api-client";
import type {
  StocktakeDetailDto,
  StocktakeListItemDto,
} from "@/lib/inventory/stocktake/dto";

export type StocktakeListPage = {
  items: StocktakeListItemDto[];
  total: number;
  page: number;
  pageSize: number;
};

export type StocktakeProductsPage = {
  items: Array<{
    id: string;
    name: string;
    sku: string | null;
    unit: string | null;
    stockQty: number;
  }>;
  total: number;
  page: number;
  pageSize: number;
};

/** §119 — inventoryKeys family; businessId is mandatory everywhere. */
export const inventoryKeys = {
  all: ["inventory"] as const,
  stocktakes: (
    businessId: string,
    filters: { q?: string; status?: string; page: number; pageSize: number },
  ) => ["inventory", "stocktakes", businessId, filters] as const,
  stocktake: (businessId: string, id: string) =>
    ["inventory", "stocktakes", businessId, "detail", id] as const,
  stocktakeLines: (businessId: string, id: string, page: number, pageSize: number) =>
    ["inventory", "stocktakes", businessId, "detail", id, "lines", page, pageSize] as const,
  /** Reused legacy surfaces (kept compatible with existing inventory keys). */
  adjustments: ["adjustments"] as const,
  products: (q: string, page: number) => ["products", q, page] as const,
};

const base = "/api/v1/inventory/stocktakes";

export async function fetchStocktakes(
  businessId: string,
  filters: { q?: string; status?: string; from?: string; to?: string; page: number; pageSize: number },
): Promise<StocktakeListPage> {
  const params = new URLSearchParams({ page: String(filters.page), pageSize: String(filters.pageSize) });
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  void businessId; // injected automatically via the api() provider
  return api<StocktakeListPage>(`${base}?${params.toString()}`);
}

export async function fetchStocktake(
  businessId: string,
  id: string,
  page = 1,
  pageSize = 50,
): Promise<StocktakeDetailDto> {
  void businessId;
  return api<StocktakeDetailDto>(`${base}/${id}?page=${page}&pageSize=${pageSize}`);
}

export async function createStocktake(
  businessId: string,
  body: { reference: string; notes: string | null },
): Promise<{ id: string; reference: string; status: string }> {
  void businessId;
  return api(`${base}`, { method: "POST", body: JSON.stringify(body) });
}

export async function addStocktakeLine(
  businessId: string,
  stocktakeId: string,
  productId: string,
): Promise<{ id: string; productId: string }> {
  void businessId;
  return api(`${base}/${stocktakeId}/lines`, { method: "POST", body: JSON.stringify({ productId }) });
}

export async function removeStocktakeLine(
  businessId: string,
  stocktakeId: string,
  lineId: string,
): Promise<void> {
  void businessId;
  await api(`${base}/${stocktakeId}/lines/${lineId}`, { method: "DELETE" });
}

export async function countStocktakeLine(
  businessId: string,
  stocktakeId: string,
  lineId: string,
  countedQty: number,
): Promise<{ id: string; systemQtyAtCount: number; countedQty: number; varianceQty: number }> {
  void businessId;
  return api(`${base}/${stocktakeId}/lines/${lineId}/count`, { method: "POST", body: JSON.stringify({ countedQty }) });
}

export async function transitionStocktake(
  businessId: string,
  stocktakeId: string,
  action: "start" | "review" | "reopen" | "finalize" | "cancel",
): Promise<Record<string, unknown>> {
  void businessId;
  return api(`${base}/${stocktakeId}/${action}`, { method: "POST" });
}

export async function updateStocktakeDraft(
  businessId: string,
  stocktakeId: string,
  body: { reference?: string; notes?: string | null },
): Promise<void> {
  void businessId;
  await api(`${base}/${stocktakeId}`, { method: "PATCH", body: JSON.stringify(body) });
}

/** §62 — bounded product selector over the EXISTING products API. */
export async function fetchProductOptions(
  businessId: string,
  q: string,
  page: number,
): Promise<StocktakeProductsPage> {
  void businessId;
  const params = new URLSearchParams({ q, page: String(page), pageSize: "10" });
  return api(`/api/v1/products?${params.toString()}`);
}
