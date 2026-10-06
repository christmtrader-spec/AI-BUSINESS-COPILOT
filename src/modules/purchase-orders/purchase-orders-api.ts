"use client";

/**
 * Prompt 41 — client fetchers + query keys for the purchase-orders module.
 *
 * KEY LAWS (§168 precedent): every key carries businessId (mandatory); the
 * order id is part of detail/line keys. INVALIDATION: mutations invalidate
 * the targeted purchase-order keys; line/lifecycle changes also refresh
 * entity-detail surfaces (Supplier 360 / Product history) via the shared
 * ["entities", businessId] family. Nothing clears the whole QueryClient.
 *
 * REQUEST LAW (§85/§146/§165/§166): the client submits ONLY authoritative
 * inputs (productId/orderedQty/unitPriceMinor/header fields). It NEVER
 * submits businessId, status, snapshots or totals.
 */
import { api } from "@/lib/api-client";
import type {
  PurchaseOrderDetailDto,
  PurchaseOrderListItemDto,
} from "@/lib/purchase-orders/dto";

export type PurchaseOrderListPage = {
  items: PurchaseOrderListItemDto[];
  total: number;
  page: number;
  pageSize: number;
};

export type SupplierOption = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
};

export type ProductOption = {
  id: string;
  name: string;
  sku: string | null;
  unit: string | null;
};

/** §119-analog — purchaseOrderKeys family; businessId is mandatory. */
export const purchaseOrderKeys = {
  all: ["purchase-orders"] as const,
  list: (
    businessId: string,
    filters: { q?: string; status?: string; from?: string; to?: string; page: number; pageSize: number },
  ) => ["purchase-orders", "list", businessId, filters] as const,
  detail: (businessId: string, id: string) =>
    ["purchase-orders", "detail", businessId, id] as const,
};

const base = "/api/v1/purchase-orders";

export async function fetchPurchaseOrders(
  businessId: string,
  filters: { q?: string; status?: string; from?: string; to?: string; page: number; pageSize: number },
): Promise<PurchaseOrderListPage> {
  const params = new URLSearchParams({
    page: String(filters.page),
    pageSize: String(filters.pageSize),
  });
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  void businessId; // injected automatically via the api() provider
  return api<PurchaseOrderListPage>(`${base}?${params.toString()}`);
}

export async function fetchPurchaseOrder(
  businessId: string,
  id: string,
): Promise<PurchaseOrderDetailDto> {
  void businessId;
  return api<PurchaseOrderDetailDto>(`${base}/${id}`);
}

export async function createPurchaseOrder(
  businessId: string,
  body: {
    supplierId: string;
    reference?: string;
    orderedAt?: string;
    expectedDate?: string | null;
    notes?: string | null;
  },
): Promise<{ id: string; reference: string; status: string }> {
  void businessId;
  return api(`${base}`, { method: "POST", body: JSON.stringify(body) });
}

export async function updatePurchaseOrderDraft(
  businessId: string,
  id: string,
  body: {
    reference?: string;
    orderedAt?: string;
    expectedDate?: string | null;
    notes?: string | null;
  },
): Promise<void> {
  void businessId;
  await api(`${base}/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export async function addPurchaseOrderLine(
  businessId: string,
  orderId: string,
  body: { productId: string; orderedQty: number; unitPriceMinor: number },
): Promise<{ id: string }> {
  void businessId;
  return api(`${base}/${orderId}/lines`, { method: "POST", body: JSON.stringify(body) });
}

export async function updatePurchaseOrderLine(
  businessId: string,
  orderId: string,
  lineId: string,
  body: { orderedQty?: number; unitPriceMinor?: number },
): Promise<void> {
  void businessId;
  await api(`${base}/${orderId}/lines/${lineId}`, { method: "PATCH", body: JSON.stringify(body) });
}

export async function removePurchaseOrderLine(
  businessId: string,
  orderId: string,
  lineId: string,
): Promise<void> {
  void businessId;
  await api(`${base}/${orderId}/lines/${lineId}`, { method: "DELETE" });
}

export async function transitionPurchaseOrder(
  businessId: string,
  orderId: string,
  action: "send" | "confirm" | "close" | "cancel",
): Promise<Record<string, unknown>> {
  void businessId;
  return api(`${base}/${orderId}/${action}`, { method: "POST" });
}

/** §78 — bounded product selector over the EXISTING products API (page 10). */
export async function fetchProductOptions(
  businessId: string,
  q: string,
  page: number,
): Promise<{ items: ProductOption[]; total: number; page: number; pageSize: number }> {
  void businessId;
  const params = new URLSearchParams({ q, page: String(page), pageSize: "10" });
  return api<{ items: ProductOption[]; total: number; page: number; pageSize: number }>(
    `/api/v1/products?${params.toString()}`,
  );
}

/** §77 — bounded supplier selector over the EXISTING suppliers API (page 10). */
export async function fetchSupplierOptions(
  businessId: string,
  q: string,
  page: number,
): Promise<{ items: SupplierOption[]; total: number; page: number; pageSize: number }> {
  void businessId;
  const params = new URLSearchParams({ q, page: String(page), pageSize: "10" });
  const res = await api<{ items: SupplierOption[]; total: number; page: number; pageSize: number }>(
    `/api/v1/suppliers?${params.toString()}`,
  );
  return res;
}
