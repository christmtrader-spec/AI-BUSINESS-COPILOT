/**
 * Prompt 48 — client-safe Supplier Bill DTOs + pure mappers.
 *
 * DTO LAWS (inherited from the audited P41–P47 pattern):
 *  - explicit allowlist — a raw Prisma object is NEVER serialized;
 *  - every date is an ISO-8601 UTC string; date-only business semantics
 *    (billDate/dueDate) additionally expose their canonical YYYY-MM-DD
 *    form (UTC-midnoon law, Prompt-35 §84);
 *  - the persistedStatus is exposed explicitly and MUST be a closed
 *    vocabulary member — an unknown persisted value throws the controlled
 *    integrity error (never silently DRAFT);
 *  - supplier/PO/product identity comes from the SNAPSHOT columns —
 *    historical values are never replaced with live names;
 *  - money is integer minor units; quantities are exact integers; the
 *    price variance is DERIVED (invoiced − PO) at display time, never
 *    stored as a second mutable truth;
 *  - the linked payable (Expense) DTO appears ONLY when the relation is
 *    actually present — a DRAFT bill never fabricates a payable (§10);
 *  - internalNotes NEVER appear in list/search DTOs; the detail DTO
 *    exposes them to authorized staff views only;
 *  - no database ids of OTHER rows leak beyond the explicit relation ids
 *    the UI needs for deep links.
 */
import { parseSupplierBillStatus, type SupplierBillStatus } from "./types";

/* -------------------------------- types ---------------------------------- */

/** Bounded, lighter-than-detail list row (§16). */
export type SupplierBillListItemDto = {
  id: string;
  reference: string;
  supplierInvoiceReference: string | null;
  supplierId: string;
  supplierNameAtBill: string;
  purchaseOrderId: string;
  purchaseOrderReferenceAtBill: string;
  status: SupplierBillStatus;
  billDate: string;
  dueDate: string | null;
  currencyCodeAtBill: string;
  currencySymbolAtBill: string;
  decimalPrecisionAtBill: number;
  lineCount: number;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  /** Linked payable state — present ONLY for POSTED bills (§10/§16). */
  payable: {
    expenseId: string;
    amountMinor: number;
    paidMinor: number;
    outstandingMinor: number;
    status: string;
  } | null;
  createdAt: string;
};

/** Draft line — editable, server-derived total, PO price for variance. */
export type SupplierBillLineDto = {
  id: string;
  purchaseOrderLineId: string;
  productId: string;
  billedQty: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  productNameAtBill: string;
  skuAtBill: string | null;
  unitAtBill: string | null;
  purchaseOrderUnitPriceMinor: number;
  createdAt: string;
  updatedAt: string;
};

/** Linked payable detail — ALWAYS read from the live Expense (§12/§18). */
export type SupplierBillPayableDto = {
  expenseId: string;
  amountMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  status: string;
  spentAt: string;
  dueDate: string | null;
  reference: string | null;
  category: string;
};

/** A payment recorded through the EXISTING Payment workflow (§12). */
export type SupplierBillPaymentDto = {
  id: string;
  amountMinor: number;
  method: string;
  paidAt: string;
  note: string | null;
  actorName: string | null;
};

/** Detail document (bill + lines + linked payable + payments) (§16). */
export type SupplierBillDetailDto = {
  id: string;
  reference: string;
  supplierInvoiceReference: string | null;
  supplierId: string;
  supplierNameAtBill: string;
  purchaseOrderId: string;
  purchaseOrderReferenceAtBill: string;
  status: SupplierBillStatus;
  billDate: string;
  dueDate: string | null;
  currencyCodeAtBill: string;
  currencySymbolAtBill: string;
  decimalPrecisionAtBill: number;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  lineCount: number;
  internalNotes: string | null;
  createdBy: { id: string; name: string | null; email: string | null } | null;
  postedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  lines: SupplierBillLineDto[];
  payable: SupplierBillPayableDto | null;
  payments: SupplierBillPaymentDto[];
};

/* ------------------------------- mappers ---------------------------------- */

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/** Calendar-day display form of a stored UTC-midnoon instant. */
function dayOf(date: Date | null | undefined): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

/** List row mapper — the payable block appears ONLY when a real FK exists. */
export function mapSupplierBillListItem(row: {
  id: string;
  reference: string;
  supplierInvoiceReference: string | null;
  supplierId: string;
  supplierNameAtBill: string;
  purchaseOrderId: string;
  purchaseOrderReferenceAtBill: string;
  status: string;
  billDate: Date;
  dueDate: Date | null;
  currencyCodeAtBill: string;
  currencySymbolAtBill: string;
  decimalPrecisionAtBill: number;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  createdAt: Date;
  _count?: { lines: number } | undefined;
  expense?: {
    id: string;
    amountMinor: number;
    paidMinor: number;
    status: string;
  } | null;
}): SupplierBillListItemDto {
  const status = parseSupplierBillStatus(row.status);
  const paidMinor = row.expense?.paidMinor ?? 0;
  return {
    id: row.id,
    reference: row.reference,
    supplierInvoiceReference: row.supplierInvoiceReference,
    supplierId: row.supplierId,
    supplierNameAtBill: row.supplierNameAtBill,
    purchaseOrderId: row.purchaseOrderId,
    purchaseOrderReferenceAtBill: row.purchaseOrderReferenceAtBill,
    status,
    billDate: row.billDate.toISOString(),
    dueDate: iso(row.dueDate),
    currencyCodeAtBill: row.currencyCodeAtBill,
    currencySymbolAtBill: row.currencySymbolAtBill,
    decimalPrecisionAtBill: row.decimalPrecisionAtBill,
    lineCount: row._count?.lines ?? 0,
    subtotalMinor: row.subtotalMinor,
    discountMinor: row.discountMinor,
    totalMinor: row.totalMinor,
    payable: row.expense
      ? {
          expenseId: row.expense.id,
          amountMinor: row.expense.amountMinor,
          paidMinor,
          outstandingMinor: row.expense.amountMinor - paidMinor,
          status: row.expense.status,
        }
      : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Line mapper — arrives from the server which owns all math. */
export function mapSupplierBillLine(row: {
  id: string;
  purchaseOrderLineId: string;
  productId: string;
  billedQty: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  productNameAtBill: string;
  skuAtBill: string | null;
  unitAtBill: string | null;
  purchaseOrderUnitPriceMinor: number;
  createdAt: Date;
  updatedAt: Date;
}): SupplierBillLineDto {
  return {
    id: row.id,
    purchaseOrderLineId: row.purchaseOrderLineId,
    productId: row.productId,
    billedQty: row.billedQty,
    unitPriceMinor: row.unitPriceMinor,
    lineTotalMinor: row.lineTotalMinor,
    productNameAtBill: row.productNameAtBill,
    skuAtBill: row.skuAtBill,
    unitAtBill: row.unitAtBill,
    purchaseOrderUnitPriceMinor: row.purchaseOrderUnitPriceMinor,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Detail mapper — payable read from the LIVE linked Expense (§12). */
export function mapSupplierBillDetail(
  row: {
    id: string;
    reference: string;
    supplierInvoiceReference: string | null;
    supplierId: string;
    supplierNameAtBill: string;
    purchaseOrderId: string;
    purchaseOrderReferenceAtBill: string;
    status: string;
    billDate: Date;
    dueDate: Date | null;
    currencyCodeAtBill: string;
    currencySymbolAtBill: string;
    decimalPrecisionAtBill: number;
    subtotalMinor: number;
    discountMinor: number;
    totalMinor: number;
    internalNotes: string | null;
    postedAt: Date | null;
    cancelledAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    createdByUser?: { id: string; name: string | null; email: string | null } | null;
  },
  lines: SupplierBillLineDto[],
  payable: SupplierBillPayableDto | null,
  payments: SupplierBillPaymentDto[],
): SupplierBillDetailDto {
  return {
    id: row.id,
    reference: row.reference,
    supplierInvoiceReference: row.supplierInvoiceReference,
    supplierId: row.supplierId,
    supplierNameAtBill: row.supplierNameAtBill,
    purchaseOrderId: row.purchaseOrderId,
    purchaseOrderReferenceAtBill: row.purchaseOrderReferenceAtBill,
    status: parseSupplierBillStatus(row.status),
    billDate: row.billDate.toISOString(),
    dueDate: iso(row.dueDate),
    currencyCodeAtBill: row.currencyCodeAtBill,
    currencySymbolAtBill: row.currencySymbolAtBill,
    decimalPrecisionAtBill: row.decimalPrecisionAtBill,
    subtotalMinor: row.subtotalMinor,
    discountMinor: row.discountMinor,
    totalMinor: row.totalMinor,
    lineCount: lines.length,
    internalNotes: row.internalNotes,
    createdBy: row.createdByUser
      ? {
          id: row.createdByUser.id,
          name: row.createdByUser.name,
          email: row.createdByUser.email,
        }
      : null,
    postedAt: iso(row.postedAt),
    cancelledAt: iso(row.cancelledAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lines,
    payable,
    payments,
  };
}

export { dayOf as supplierBillDayOf };
