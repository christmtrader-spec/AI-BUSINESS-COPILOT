"use client";

/**
 * Prompt 47 — client fetchers + query keys for the sales-quotations module.
 *
 * KEY LAWS: every key carries businessId (mandatory); the quotation id is
 * part of detail/line keys. INVALIDATION: lifecycle/line mutations
 * invalidate the quotation keys + the shared ["entities", businessId]
 * family (Customer 360 / Product quotation history §19). Conversion ALSO
 * invalidates sales-orders surfaces (the new linked order) via the shared
 * ["sales-orders", ...] family. Nothing clears the whole QueryClient.
 *
 * REQUEST LAW: the client submits ONLY authoritative inputs
 * (customerId/reference/quotationDate/validUntilDate/expectedDeliveryDate/
 * discountMinor/customerNotes/internalNotes/productId/qty/unitPriceMinor).
 * It NEVER submits businessId, status, snapshots, totals, lifecycle
 * timestamps or converted-order links (§15).
 */
import { api } from "@/lib/api-client";
import type { SalesQuotationDetailDto } from "@/lib/sales-quotations/dto";

export type SalesQuotationListItem = {
  id: string;
  reference: string;
  persistedStatus: "DRAFT" | "SENT" | "ACCEPTED" | "REJECTED" | "EXPIRED" | "CANCELLED" | "CONVERTED";
  effectiveStatus: "DRAFT" | "SENT" | "ACCEPTED" | "REJECTED" | "EXPIRED" | "CANCELLED" | "CONVERTED";
  customerId: string | null;
  customerNameAtQuotation: string;
  quotationDate: string;
  validUntilDate: string;
  lineCount: number;
  totalQty: number;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  convertedOrderReference: string | null;
  createdAt: string;
};

export type SalesQuotationListPage = {
  items: SalesQuotationListItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type SalesQuotationDetail = SalesQuotationDetailDto;

export type SalesQuotationPrint = {
  reference: string;
  quotationDate: string;
  validUntilDate: string;
  customerNameAtQuotation: string;
  currencyCodeAtQuotation: string;
  currencySymbolAtQuotation: string;
  decimalPrecisionAtQuotation: number;
  expectedDeliveryDate: string | null;
  customerNotes: string | null;
  lines: Array<{
    productNameAtQuotation: string;
    skuAtQuotation: string | null;
    unitAtQuotation: string | null;
    qty: number;
    unitPriceMinor: number;
    lineTotalMinor: number;
  }>;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
};

/** salesQuotationKeys family; businessId is mandatory everywhere. */
export const salesQuotationKeys = {
  all: ["sales-quotations"] as const,
  list: (
    businessId: string,
    filters: {
      q?: string;
      status?: string;
      customerId?: string;
      page: number;
      pageSize: number;
    },
  ) => ["sales-quotations", "list", businessId, filters] as const,
  detail: (businessId: string, id: string) =>
    ["sales-quotations", "detail", businessId, id] as const,
  print: (businessId: string, id: string) =>
    ["sales-quotations", "print", businessId, id] as const,
};

const base = "/api/v1/sales-quotations";

export async function fetchSalesQuotations(
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
): Promise<SalesQuotationListPage> {
  const qs = new URLSearchParams({ page: String(filters.page), pageSize: String(filters.pageSize) });
  if (filters.q) qs.set("q", filters.q);
  if (filters.status) qs.set("status", filters.status);
  if (filters.customerId) qs.set("customerId", filters.customerId);
  if (filters.from) qs.set("from", filters.from);
  if (filters.to) qs.set("to", filters.to);
  void businessId; // injected automatically via the api() provider
  return api<SalesQuotationListPage>(`${base}?${qs.toString()}`);
}

export async function fetchSalesQuotation(
  businessId: string,
  id: string,
): Promise<SalesQuotationDetail> {
  void businessId;
  return api<SalesQuotationDetail>(`${base}/${id}`);
}

export async function fetchSalesQuotationPrint(
  businessId: string,
  id: string,
): Promise<SalesQuotationPrint> {
  void businessId;
  return api<SalesQuotationPrint>(`${base}/${id}/print`);
}

export type CreateSalesQuotationInput = {
  customerId?: string;
  reference?: string;
  quotationDate?: string;
  validUntilDate: string;
  expectedDeliveryDate?: string;
  customerNotes?: string | null;
  internalNotes?: string | null;
};

export async function createSalesQuotation(
  businessId: string,
  input: CreateSalesQuotationInput,
): Promise<{ id: string; reference: string; status: string }> {
  void businessId;
  return api<{ id: string; reference: string; status: string }>(base, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export type UpdateSalesQuotationInput = {
  customerId?: string | null;
  reference?: string;
  quotationDate?: string;
  validUntilDate?: string;
  expectedDeliveryDate?: string | null;
  discountMinor?: number;
  customerNotes?: string | null;
  internalNotes?: string | null;
};

export async function updateSalesQuotationDraft(
  businessId: string,
  id: string,
  input: UpdateSalesQuotationInput,
): Promise<{ id: string; reference: string; status: string }> {
  void businessId;
  return api<{ id: string; reference: string; status: string }>(`${base}/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function addSalesQuotationLine(
  businessId: string,
  id: string,
  input: { productId: string; qty: number; unitPriceMinor?: number },
): Promise<{ id: string }> {
  void businessId;
  return api<{ id: string }>(`${base}/${id}/lines`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateSalesQuotationLine(
  businessId: string,
  id: string,
  lineId: string,
  input: { qty?: number; unitPriceMinor?: number },
): Promise<{ id: string }> {
  void businessId;
  return api<{ id: string }>(`${base}/${id}/lines/${lineId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function removeSalesQuotationLine(
  businessId: string,
  id: string,
  lineId: string,
): Promise<{ removed: boolean; lineCount: number }> {
  void businessId;
  return api<{ removed: boolean; lineCount: number }>(`${base}/${id}/lines/${lineId}`, {
    method: "DELETE",
  });
}

export type QuotationTransitionResult = {
  id: string;
  reference: string;
  status: string;
  sentAt?: string | null;
  acceptedAt?: string | null;
  rejectedAt?: string | null;
  cancelledAt?: string | null;
};

export async function markSalesQuotationSent(
  businessId: string,
  id: string,
): Promise<QuotationTransitionResult> {
  void businessId;
  return api<QuotationTransitionResult>(`${base}/${id}/mark-sent`, {
    method: "POST",
  });
}

export async function acceptSalesQuotation(
  businessId: string,
  id: string,
): Promise<QuotationTransitionResult> {
  void businessId;
  return api<QuotationTransitionResult>(`${base}/${id}/accept`, {
    method: "POST",
  });
}

export async function rejectSalesQuotation(
  businessId: string,
  id: string,
): Promise<QuotationTransitionResult> {
  void businessId;
  return api<QuotationTransitionResult>(`${base}/${id}/reject`, {
    method: "POST",
  });
}

export async function cancelSalesQuotation(
  businessId: string,
  id: string,
): Promise<QuotationTransitionResult> {
  void businessId;
  return api<QuotationTransitionResult>(`${base}/${id}/cancel`, {
    method: "POST",
  });
}

export async function expireSalesQuotation(
  businessId: string,
  id: string,
): Promise<QuotationTransitionResult> {
  void businessId;
  return api<QuotationTransitionResult>(`${base}/${id}/expire`, {
    method: "POST",
  });
}

export type ConvertQuotationResult = {
  quotationId: string;
  quotationReference: string;
  salesOrder: { id: string; reference: string; status: string; confirmedAt: string | null };
};

export async function convertSalesQuotation(
  businessId: string,
  id: string,
): Promise<ConvertQuotationResult> {
  void businessId;
  return api<ConvertQuotationResult>(`${base}/${id}/convert`, {
    method: "POST",
  });
}

/** Per-quotation CSV download through the authorized, rate-limited route. */
export function salesQuotationCsvUrl(businessId: string, id: string, locale: "en" | "fa"): string {
  const qs = new URLSearchParams({ locale });
  return `${base}/${id}/export?${qs.toString()}`;
}
