"use client";

/**
 * Prompt 45 — client fetchers + query keys for the sales-orders module.
 *
 * KEY LAWS: every key carries businessId (mandatory); the order id is part
 * of detail/line keys. INVALIDATION: confirm/cancel/dispatch/invoice
 * mutations invalidate the order keys + product/inventory surfaces (stock
 * changes only through POSTED dispatches) + sales surfaces (the linked
 * invoice) via the shared ["entities", businessId] family for the
 * Customer 360 / Product history. Nothing clears the whole QueryClient.
 *
 * REQUEST LAW: the client submits ONLY authoritative inputs
 * (customerId/reference/orderDate/expectedDate/discountMinor/notes/
 * productId/orderedQty/unitPriceMinor/salesOrderLineId/qty). It NEVER
 * submits businessId, status, snapshots, totals, dispatchedQty or
 * remainingToDispatchQty (§112).
 */
import { api } from "@/lib/api-client";
import type { SalesOrderDetailDto } from "@/lib/sales-orders/dto";

export type SalesOrderListItem = {
  id: string;
  reference: string;
  status: "DRAFT" | "CONFIRMED" | "COMPLETED" | "CANCELLED";
  customerId: string | null;
  customerNameAtOrder: string;
  orderDate: string;
  expectedDate: string | null;
  lineCount: number;
  totalQty: number;
  totalMinor: number;
  dispatchedQty: number;
  remainingToDispatchQty: number;
  invoiceNumber: number | null;
  invoiceStatus: string | null;
  createdAt: string;
};

export type SalesOrderListPage = {
  items: SalesOrderListItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type SalesOrderDetail = SalesOrderDetailDto & {
  recentDispatches: Array<{
    id: string;
    reference: string;
    status: string;
    postedAt: string | null;
    totalDispatchedQty: number;
  }>;
};

/** salesOrderKeys family; businessId is mandatory everywhere. */
export const salesOrderKeys = {
  all: ["sales-orders"] as const,
  list: (
    businessId: string,
    filters: {
      q?: string;
      status?: string;
      customerId?: string;
      page: number;
      pageSize: number;
    },
  ) => ["sales-orders", "list", businessId, filters] as const,
  detail: (businessId: string, id: string) =>
    ["sales-orders", "detail", businessId, id] as const,
};

const base = "/api/v1/sales-orders";

export async function fetchSalesOrders(
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
): Promise<SalesOrderListPage> {
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
  return api<SalesOrderListPage>(`${base}?${params.toString()}`);
}

export async function fetchSalesOrder(
  businessId: string,
  id: string,
): Promise<SalesOrderDetail> {
  void businessId;
  return api<SalesOrderDetail>(`${base}/${id}`);
}

export async function createSalesOrder(
  businessId: string,
  body: {
    customerId?: string;
    reference?: string;
    orderDate?: string;
    expectedDate?: string;
    notes?: string | null;
  },
): Promise<{ id: string; reference: string; status: string }> {
  void businessId;
  return api(`${base}`, { method: "POST", body: JSON.stringify(body) });
}

export async function updateSalesOrderDraft(
  businessId: string,
  id: string,
  body: {
    customerId?: string | null;
    reference?: string;
    orderDate?: string;
    expectedDate?: string | null;
    discountMinor?: number;
    notes?: string | null;
  },
): Promise<void> {
  void businessId;
  await api(`${base}/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export async function addSalesOrderLine(
  businessId: string,
  orderId: string,
  body: { productId: string; orderedQty: number; unitPriceMinor?: number },
): Promise<{ id: string }> {
  void businessId;
  return api(`${base}/${orderId}/lines`, { method: "POST", body: JSON.stringify(body) });
}

export async function updateSalesOrderLine(
  businessId: string,
  orderId: string,
  lineId: string,
  body: { orderedQty?: number; unitPriceMinor?: number },
): Promise<void> {
  void businessId;
  await api(`${base}/${orderId}/lines/${lineId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function removeSalesOrderLine(
  businessId: string,
  orderId: string,
  lineId: string,
): Promise<void> {
  void businessId;
  await api(`${base}/${orderId}/lines/${lineId}`, { method: "DELETE" });
}

export async function confirmSalesOrder(
  businessId: string,
  orderId: string,
): Promise<Record<string, unknown>> {
  void businessId;
  return api(`${base}/${orderId}/confirm`, { method: "POST" });
}

export async function cancelSalesOrder(
  businessId: string,
  orderId: string,
): Promise<Record<string, unknown>> {
  void businessId;
  return api(`${base}/${orderId}/cancel`, { method: "POST" });
}

export async function createLinkedDispatch(
  businessId: string,
  orderId: string,
  body: { notes?: string | null },
): Promise<{ id: string; reference: string; status: string }> {
  void businessId;
  return api(`${base}/${orderId}/dispatches`, { method: "POST", body: JSON.stringify(body) });
}

export async function issueOrderInvoice(
  businessId: string,
  orderId: string,
): Promise<{ saleId: string; invoiceNumber: number; invoiceDisplay: string; totalMinor: number; orderStatus: string }> {
  void businessId;
  return api(`${base}/${orderId}/invoice`, { method: "POST" });
}

/** The EXISTING P44 dispatch line/post endpoints power fulfillment. */
export async function addLinkedDispatchLine(
  businessId: string,
  dispatchId: string,
  body: { salesOrderLineId: string; qty: number },
): Promise<{ id: string }> {
  void businessId;
  return api(`/api/v1/inventory/goods-dispatches/${dispatchId}/lines`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function postLinkedDispatch(
  businessId: string,
  dispatchId: string,
): Promise<Record<string, unknown>> {
  void businessId;
  return api(`/api/v1/inventory/goods-dispatches/${dispatchId}/post`, { method: "POST" });
}
