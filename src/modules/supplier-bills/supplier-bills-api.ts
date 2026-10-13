"use client";

/**
 * Prompt 48 — client fetchers + query keys for the supplier-bills module.
 *
 * KEY LAWS: every key carries businessId (mandatory); the bill id is part
 * of detail/line keys. INVALIDATION: post/cancel/line mutations invalidate
 * the bill keys + the purchaseOrder detail (billing summary changes) +
 * the ["entities", businessId] family (Supplier 360) + ["expenses"] and
 * ["payables"] (a posted bill creates a payable through the existing
 * Expense authority). Nothing clears the whole QueryClient.
 *
 * REQUEST LAW: the client submits ONLY authoritative inputs
 * (purchaseOrderId/purchaseOrderLineId/billedQty/unitPriceMinor/reference/
 * supplierInvoiceReference/billDate/dueDate/discountMinor/internalNotes).
 * It NEVER submits businessId, status, supplierId, snapshots, totals,
 * expenseId or postedAt.
 */
import { api } from "@/lib/api-client";
import type {
  SupplierBillDetailDto,
  SupplierBillListItemDto,
} from "@/lib/supplier-bills/dto";

export type SupplierBillListPage = {
  items: SupplierBillListItemDto[];
  total: number;
  page: number;
  pageSize: number;
};

/** Picker row over the PO's OWN lines with the three-way matching facts. */
export type PoBillableLine = {
  id: string;
  productId: string;
  productNameAtOrder: string;
  skuAtOrder: string | null;
  unitAtOrder: string | null;
  orderedQty: number;
  receivedQty: number;
  returnedQty: number;
  billedQty: number;
  availableQty: number;
  unitPriceMinor: number;
};

export type PoOption = {
  id: string;
  reference: string;
  supplierNameAtOrder: string;
  status: string;
  availableQty: number;
};

/** supplierBillKeys family; businessId is mandatory everywhere. */
export const supplierBillKeys = {
  all: ["supplier-bills"] as const,
  list: (
    businessId: string,
    filters: {
      q?: string;
      status?: string;
      supplierId?: string;
      purchaseOrderId?: string;
      page: number;
      pageSize: number;
    },
  ) => ["supplier-bills", "list", businessId, filters] as const,
  detail: (businessId: string, id: string) =>
    ["supplier-bills", "detail", businessId, id] as const,
};

const base = "/api/v1/supplier-bills";

export async function fetchSupplierBills(
  businessId: string,
  filters: {
    q?: string;
    status?: string;
    supplierId?: string;
    purchaseOrderId?: string;
    billDateFrom?: string;
    billDateTo?: string;
    dueDateFrom?: string;
    dueDateTo?: string;
    page: number;
    pageSize: number;
  },
): Promise<SupplierBillListPage> {
  const params = new URLSearchParams({
    page: String(filters.page),
    pageSize: String(filters.pageSize),
  });
  if (filters.q) params.set("q", filters.q);
  if (filters.status) params.set("status", filters.status);
  if (filters.supplierId) params.set("supplierId", filters.supplierId);
  if (filters.purchaseOrderId) params.set("purchaseOrderId", filters.purchaseOrderId);
  if (filters.billDateFrom) params.set("billDateFrom", filters.billDateFrom);
  if (filters.billDateTo) params.set("billDateTo", filters.billDateTo);
  if (filters.dueDateFrom) params.set("dueDateFrom", filters.dueDateFrom);
  if (filters.dueDateTo) params.set("dueDateTo", filters.dueDateTo);
  void businessId; // injected automatically via the api() provider
  return api<SupplierBillListPage>(`${base}?${params.toString()}`);
}

export async function fetchSupplierBill(
  businessId: string,
  id: string,
): Promise<SupplierBillDetailDto> {
  void businessId;
  return api<SupplierBillDetailDto>(`${base}/${id}`);
}

export async function createSupplierBill(
  businessId: string,
  body: {
    purchaseOrderId: string;
    reference?: string;
    supplierInvoiceReference?: string | null;
    billDate: string;
    dueDate?: string;
    discountMinor?: number;
    internalNotes?: string | null;
  },
): Promise<{ id: string; reference: string; status: string }> {
  void businessId;
  return api(`${base}`, { method: "POST", body: JSON.stringify(body) });
}

export async function updateSupplierBillDraft(
  businessId: string,
  id: string,
  body: {
    supplierInvoiceReference?: string | null;
    billDate?: string;
    dueDate?: string | null;
    discountMinor?: number;
    internalNotes?: string | null;
  },
): Promise<SupplierBillDetailDto> {
  void businessId;
  return api(`${base}/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export async function addSupplierBillLine(
  businessId: string,
  billId: string,
  body: { purchaseOrderLineId: string; billedQty: number; unitPriceMinor: number },
): Promise<SupplierBillDetailDto> {
  void businessId;
  return api(`${base}/${billId}/lines`, { method: "POST", body: JSON.stringify(body) });
}

export async function updateSupplierBillLine(
  businessId: string,
  billId: string,
  lineId: string,
  body: { billedQty?: number; unitPriceMinor?: number },
): Promise<SupplierBillDetailDto> {
  void businessId;
  return api(`${base}/${billId}/lines/${lineId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function removeSupplierBillLine(
  businessId: string,
  billId: string,
  lineId: string,
): Promise<SupplierBillDetailDto> {
  void businessId;
  return api(`${base}/${billId}/lines/${lineId}`, { method: "DELETE" });
}

export async function postSupplierBill(
  businessId: string,
  billId: string,
): Promise<Record<string, unknown>> {
  void businessId;
  return api(`${base}/${billId}/post`, { method: "POST" });
}

export async function cancelSupplierBill(
  businessId: string,
  billId: string,
): Promise<Record<string, unknown>> {
  void businessId;
  return api(`${base}/${billId}/cancel`, { method: "POST" });
}

/**
 * Bounded list of billable purchase orders (CONFIRMED or CLOSED, per the
 * documented billing gate) with remaining invoiceable quantities, over the
 * EXISTING purchase-orders API. The list DTO carries no billing summary,
 * so the picker reads each candidate's PO detail (bounded: 10 rows per
 * status page) — the same bounded-selector convention as P42.
 */
export async function fetchPoOptionsForBilling(
  businessId: string,
  q: string,
  page: number,
): Promise<{ items: PoOption[]; total: number; page: number; pageSize: number }> {
  void businessId;
  const mkParams = (status: string) =>
    new URLSearchParams({ q, page: String(page), pageSize: "10", status }).toString();
  const [confirmed, closed] = await Promise.all([
    api<{
      items: Array<{ id: string; reference: string; supplierNameAtOrder: string; status: string }>;
      total: number;
      page: number;
      pageSize: number;
    }>(`/api/v1/purchase-orders?${mkParams("CONFIRMED")}`),
    api<{
      items: Array<{ id: string; reference: string; supplierNameAtOrder: string; status: string }>;
      total: number;
      page: number;
      pageSize: number;
    }>(`/api/v1/purchase-orders?${mkParams("CLOSED")}`).catch(() => ({
      items: [] as Array<{ id: string; reference: string; supplierNameAtOrder: string; status: string }>,
      total: 0,
      page,
      pageSize: 10,
    })),
  ]);
  const candidates = [...confirmed.items, ...closed.items];
  const withBilling = await Promise.all(
    candidates.map(async (po) => {
      try {
        const detail = await api<{
          billing?: { totalAvailableQty: number };
        }>(`/api/v1/purchase-orders/${po.id}`);
        return {
          id: po.id,
          reference: po.reference,
          supplierNameAtOrder: po.supplierNameAtOrder,
          status: po.status,
          availableQty: detail.billing ? detail.billing.totalAvailableQty : 0,
        };
      } catch {
        return { ...po, availableQty: 0 };
      }
    }),
  );
  // Only orders that still have quantities to invoice.
  const items = withBilling.filter((po) => po.availableQty > 0);
  return { items, total: confirmed.total + closed.total, page, pageSize: 10 };
}

/** Billable lines for the line picker: PO detail with three-way facts. */
export async function fetchPoBillableLines(
  businessId: string,
  poId: string,
): Promise<PoBillableLine[]> {
  void businessId;
  const detail = await api<{
    lines: Array<{
      id: string;
      productId: string;
      productNameAtOrder: string;
      skuAtOrder: string | null;
      unitAtOrder: string | null;
      orderedQty: number;
      unitPriceMinor: number;
      receivedQty?: number;
      returnedQty?: number;
      billedQty?: number;
      availableQty?: number;
    }>;
  }>(`/api/v1/purchase-orders/${poId}`);
  // Only lines with available (received − returned − billed) > 0 are selectable.
  return detail.lines
    .map((l) => ({
      id: l.id,
      productId: l.productId,
      productNameAtOrder: l.productNameAtOrder,
      skuAtOrder: l.skuAtOrder,
      unitAtOrder: l.unitAtOrder,
      orderedQty: l.orderedQty,
      receivedQty: l.receivedQty ?? 0,
      returnedQty: l.returnedQty ?? 0,
      billedQty: l.billedQty ?? 0,
      availableQty: l.availableQty ?? 0,
      unitPriceMinor: l.unitPriceMinor,
    }))
    .filter((l) => l.availableQty > 0);
}
