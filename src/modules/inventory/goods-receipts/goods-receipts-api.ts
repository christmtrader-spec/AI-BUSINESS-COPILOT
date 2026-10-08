"use client";

/**
 * Prompt 42 — client fetchers + query keys for the goods-receipts module.
 *
 * KEY LAWS (§199): every key carries businessId (mandatory); the receipt id
 * is part of detail/line keys. INVALIDATION: post/cancel/line mutations
 * invalidate the receipt keys + the purchaseOrder detail + product/inventory
 * surfaces (stock quantity + adjustment feed change, §198) via the shared
 * ["entities", businessId] family for Supplier 360 / Product history.
 * Nothing clears the whole QueryClient.
 *
 * REQUEST LAW (§36/§63/§89): the client submits ONLY authoritative inputs
 * (purchaseOrderId/purchaseOrderLineId/receivedQty/reference/notes). It
 * NEVER submits businessId, status, productId, snapshots or postedAt.
 */
import { api } from "@/lib/api-client";
import type {
  GoodsReceiptDetailDto,
  GoodsReceiptListItemDto,
} from "@/lib/inventory/goods-receipt/dto";

export type GoodsReceiptListPage = {
  items: GoodsReceiptListItemDto[];
  total: number;
  page: number;
  pageSize: number;
};

/** §110/§111 — picker row over the PO's OWN lines (no product picker). */
export type PoReceivableLine = {
  id: string;
  productId: string;
  productNameAtOrder: string;
  skuAtOrder: string | null;
  unitAtOrder: string | null;
  orderedQty: number;
  receivedQty: number; // from the PO detail receiving data (§98)
  remainingQty: number;
};

export type PoOption = {
  id: string;
  reference: string;
  supplierNameAtOrder: string;
  status: string;
  remainingQty: number;
};

/** goodsReceiptKeys family; businessId is mandatory everywhere. */
export const goodsReceiptKeys = {
  all: ["goods-receipts"] as const,
  list: (
    businessId: string,
    filters: {
      q?: string;
      status?: string;
      purchaseOrderId?: string;
      page: number;
      pageSize: number;
    },
  ) => ["goods-receipts", "list", businessId, filters] as const,
  detail: (businessId: string, id: string) =>
    ["goods-receipts", "detail", businessId, id] as const,
};

const base = "/api/v1/inventory/goods-receipts";

export async function fetchGoodsReceipts(
  businessId: string,
  filters: {
    q?: string;
    status?: string;
    purchaseOrderId?: string;
    from?: string;
    to?: string;
    page: number;
    pageSize: number;
  },
): Promise<GoodsReceiptListPage> {
  const params = new URLSearchParams({
    page: String(filters.page),
    pageSize: String(filters.pageSize),
  });
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.purchaseOrderId) params.set("purchaseOrderId", filters.purchaseOrderId);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  void businessId; // injected automatically via the api() provider
  return api<GoodsReceiptListPage>(`${base}?${params.toString()}`);
}

export async function fetchGoodsReceipt(
  businessId: string,
  id: string,
): Promise<GoodsReceiptDetailDto> {
  void businessId;
  return api<GoodsReceiptDetailDto>(`${base}/${id}`);
}

export async function createGoodsReceipt(
  businessId: string,
  body: { purchaseOrderId: string; reference?: string; notes?: string | null },
): Promise<{ id: string; reference: string; status: string }> {
  void businessId;
  return api(`${base}`, { method: "POST", body: JSON.stringify(body) });
}

export async function updateGoodsReceiptDraft(
  businessId: string,
  id: string,
  body: { reference?: string; notes?: string | null },
): Promise<void> {
  void businessId;
  await api(`${base}/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export async function addGoodsReceiptLine(
  businessId: string,
  receiptId: string,
  body: { purchaseOrderLineId: string; receivedQty: number },
): Promise<{ id: string }> {
  void businessId;
  return api(`${base}/${receiptId}/lines`, { method: "POST", body: JSON.stringify(body) });
}

export async function updateGoodsReceiptLine(
  businessId: string,
  receiptId: string,
  lineId: string,
  body: { receivedQty: number },
): Promise<void> {
  void businessId;
  await api(`${base}/${receiptId}/lines/${lineId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function removeGoodsReceiptLine(
  businessId: string,
  receiptId: string,
  lineId: string,
): Promise<void> {
  void businessId;
  await api(`${base}/${receiptId}/lines/${lineId}`, { method: "DELETE" });
}

export async function postGoodsReceipt(
  businessId: string,
  receiptId: string,
): Promise<Record<string, unknown>> {
  void businessId;
  return api(`${base}/${receiptId}/post`, { method: "POST" });
}

export async function cancelGoodsReceipt(
  businessId: string,
  receiptId: string,
): Promise<Record<string, unknown>> {
  void businessId;
  return api(`${base}/${receiptId}/cancel`, { method: "POST" });
}

/**
 * §103 — bounded list of CONFIRMED purchase orders with remaining
 * quantities, over the EXISTING purchase-orders API (page 10). The PO
 * list DTO carries no receiving summary, so the picker fetches the
 * detail of each candidate page row (bounded: 10 rows max per page) —
 * the same bounded-selector convention as P40/P41.
 */
export async function fetchPoOptions(
  businessId: string,
  q: string,
  page: number,
): Promise<{ items: PoOption[]; total: number; page: number; pageSize: number }> {
  void businessId;
  const params = new URLSearchParams({
    q,
    page: String(page),
    pageSize: "10",
    status: "CONFIRMED",
  });
  const res = await api<{
    items: Array<{ id: string; reference: string; supplierNameAtOrder: string; status: string }>;
    total: number;
    page: number;
    pageSize: number;
  }>(`/api/v1/purchase-orders?${params.toString()}`);
  const withReceiving = await Promise.all(
    res.items.map(async (po) => {
      try {
        const detail = await api<{
          receiving?: { remainingQty: number };
        }>(`/api/v1/purchase-orders/${po.id}`);
        return {
          id: po.id,
          reference: po.reference,
          supplierNameAtOrder: po.supplierNameAtOrder,
          status: po.status,
          remainingQty: detail.receiving ? detail.receiving.remainingQty : Number.POSITIVE_INFINITY,
        };
      } catch {
        return { id: po.id, reference: po.reference, supplierNameAtOrder: po.supplierNameAtOrder, status: po.status, remainingQty: 0 };
      }
    }),
  );
  // §103 — only orders that still have quantities to receive.
  const items = withReceiving.filter((po) => po.remainingQty > 0);
  return { items, total: res.total, page: res.page, pageSize: res.pageSize };
}

/** §112 — receipt detail fetch is the picker's source for line remaining. */
export async function fetchPoReceivableLines(
  businessId: string,
  poId: string,
): Promise<PoReceivableLine[]> {
  void businessId;
  const detail = await api<{
    lines: Array<{
      id: string;
      productId: string;
      productNameAtOrder: string;
      skuAtOrder: string | null;
      unitAtOrder: string | null;
      orderedQty: number;
      receivedQty?: number;
      remainingQty?: number;
    }>;
  }>(`/api/v1/purchase-orders/${poId}`);
  // §110 — only lines with remainingQty > 0 are selectable.
  return detail.lines
    .map((l) => ({
      id: l.id,
      productId: l.productId,
      productNameAtOrder: l.productNameAtOrder,
      skuAtOrder: l.skuAtOrder,
      unitAtOrder: l.unitAtOrder,
      orderedQty: l.orderedQty,
      receivedQty: l.receivedQty ?? 0,
      remainingQty: l.remainingQty ?? Math.max(l.orderedQty - (l.receivedQty ?? 0), 0),
    }))
    .filter((l) => l.remainingQty > 0);
}
