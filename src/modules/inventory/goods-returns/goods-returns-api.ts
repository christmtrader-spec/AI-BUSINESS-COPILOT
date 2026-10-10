"use client";

/**
 * Prompt 43 — client fetchers + query keys for the goods-returns module.
 *
 * KEY LAWS (§148): every key carries businessId (mandatory); the return id
 * is part of detail/line keys. INVALIDATION: post/cancel/line mutations
 * invalidate the return keys + the source receipt detail + PO detail +
 * product/inventory surfaces (stock quantity + adjustment feed change)
 * via the shared ["entities", businessId] family for Supplier 360 /
 * Product history. Nothing clears the whole QueryClient.
 *
 * REQUEST LAW (§57/§58/§59): the client submits ONLY authoritative inputs
 * (goodsReceiptId/goodsReceiptLineId/returnedQty/reasonCode/reference/
 * notes). It NEVER submits businessId, status, productId, snapshots or
 * postedAt.
 */
import { api } from "@/lib/api-client";
import type {
  GoodsReturnDetailDto,
  GoodsReturnListItemDto,
} from "@/lib/inventory/goods-return/dto";

export type GoodsReturnListPage = {
  items: GoodsReturnListItemDto[];
  total: number;
  page: number;
  pageSize: number;
};

/** goodsReturnKeys family; businessId is mandatory everywhere. */
export const goodsReturnKeys = {
  all: ["goods-returns"] as const,
  list: (
    businessId: string,
    filters: {
      q?: string;
      status?: string;
      goodsReceiptId?: string;
      page: number;
      pageSize: number;
    },
  ) => ["goods-returns", "list", businessId, filters] as const,
  detail: (businessId: string, id: string) =>
    ["goods-returns", "detail", businessId, id] as const,
};

const base = "/api/v1/inventory/goods-returns";

export async function fetchGoodsReturns(
  businessId: string,
  filters: {
    q?: string;
    status?: string;
    goodsReceiptId?: string;
    from?: string;
    to?: string;
    page: number;
    pageSize: number;
  },
): Promise<GoodsReturnListPage> {
  const params = new URLSearchParams({
    page: String(filters.page),
    pageSize: String(filters.pageSize),
  });
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.goodsReceiptId) params.set("goodsReceiptId", filters.goodsReceiptId);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  void businessId; // injected automatically via the api() provider
  return api<GoodsReturnListPage>(`${base}?${params.toString()}`);
}

export async function fetchGoodsReturn(
  businessId: string,
  id: string,
): Promise<GoodsReturnDetailDto> {
  void businessId;
  return api<GoodsReturnDetailDto>(`${base}/${id}`);
}

export async function createGoodsReturn(
  businessId: string,
  body: { goodsReceiptId: string; reference?: string; notes?: string | null },
): Promise<{ id: string; reference: string; status: string }> {
  void businessId;
  return api(`${base}`, { method: "POST", body: JSON.stringify(body) });
}

export async function updateGoodsReturnDraft(
  businessId: string,
  id: string,
  body: { reference?: string; notes?: string | null },
): Promise<void> {
  void businessId;
  await api(`${base}/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export async function addGoodsReturnLine(
  businessId: string,
  returnId: string,
  body: { goodsReceiptLineId: string; returnedQty: number; reasonCode: string },
): Promise<{ id: string }> {
  void businessId;
  return api(`${base}/${returnId}/lines`, { method: "POST", body: JSON.stringify(body) });
}

export async function updateGoodsReturnLine(
  businessId: string,
  returnId: string,
  lineId: string,
  body: { returnedQty: number; reasonCode: string },
): Promise<void> {
  void businessId;
  await api(`${base}/${returnId}/lines/${lineId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function removeGoodsReturnLine(
  businessId: string,
  returnId: string,
  lineId: string,
): Promise<void> {
  void businessId;
  await api(`${base}/${returnId}/lines/${lineId}`, { method: "DELETE" });
}

export async function postGoodsReturn(
  businessId: string,
  returnId: string,
): Promise<Record<string, unknown>> {
  void businessId;
  return api(`${base}/${returnId}/post`, { method: "POST" });
}

export async function cancelGoodsReturn(
  businessId: string,
  returnId: string,
): Promise<Record<string, unknown>> {
  void businessId;
  return api(`${base}/${returnId}/cancel`, { method: "POST" });
}

/**
 * §92/§93 — the create flow starts from a POSTED receipt. The picker
 * fetches bounded POSTED receipts over the EXISTING receipts API (page
 * size 10); choosing one opens the return draft (lines are picked from
 * the receipt detail's return facts — never a free product picker).
 */
export async function fetchPostedReceiptOptions(
  businessId: string,
  q: string,
  page: number,
): Promise<{
  items: Array<{ id: string; reference: string; supplierNameAtReceipt: string }>;
  total: number;
  page: number;
  pageSize: number;
}> {
  void businessId;
  const params = new URLSearchParams({
    q,
    page: String(page),
    pageSize: "10",
    status: "POSTED",
  });
  return api(`${base.replace("/goods-returns", "/goods-receipts")}?${params.toString()}`);
}
