/**
 * Backup file schema — restore/import side of the backup story (Phase 06).
 *
 * The export endpoint (`/api/v1/businesses/[id]/export`) emits
 * `ai-business-copilot/backup@1`. This module is the single source of truth
 * for validating such a file before anything touches the database.
 *
 * Law notes:
 * - A08: every `*Minor` field is an integer minor unit — floats rejected.
 * - The envelope is validated strictly; rows are validated field-by-field
 *   with hard caps to bound memory/abuse.
 * - `members` and `auditTrail` are accepted but IGNORED on import (identity
 *   and history are not portable across businesses).
 */
import { z } from "zod";
import { statusOf } from "@/lib/money";

export const BACKUP_SCHEMA_ID = "ai-business-copilot/backup@1";

export const IMPORT_ENTITIES = [
  "customers",
  "suppliers",
  "products",
  "inventoryAdjustments",
  "sales",
  "expenses",
  "payments",
] as const;

export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

export const IMPORT_CONFLICT_REASONS = [
  "DUPLICATE_ID",
  "ID_OCCUPIED",
  "NUMBER_COLLISION",
  "MISSING_REFERENCE",
  "LINE_TOTAL_MISMATCH",
] as const;

export type ImportConflictReason = (typeof IMPORT_CONFLICT_REASONS)[number];

export type ImportConflict = {
  entity: ImportEntity;
  reason: ImportConflictReason;
  /** Short human-readable reference, e.g. `sale INV-0007` or customer name. */
  ref: string;
};

export type EntityReport = {
  total: number;
  toCreate: number;
  existing: number;
  invalid: number;
};

export type ImportReport = {
  mode: "dry_run" | "merge";
  businessMatch: boolean;
  businessName: string;
  exportedAt: string | null;
  currencyMatch: boolean;
  entities: Record<ImportEntity, EntityReport>;
  conflicts: ImportConflict[];
  wouldCreate: number;
  created: number;
};

/** ISO-ish date string that JS can parse. */
const isoDate = z
  .string()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), "invalid date")
  .nullable()
  .optional();

const nullableText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => v ?? null);

const moneyInt = z.number().int().min(0).max(9_000_000_000);

const partyRow = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(160),
  phone: nullableText(40),
  email: nullableText(120),
  address: nullableText(300),
  note: nullableText(1000),
  deletedAt: isoDate,
});

export const customerRowSchema = partyRow;
export const supplierRowSchema = partyRow;

export const productRowSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(160),
  sku: nullableText(60),
  unit: nullableText(20),
  salePriceMinor: moneyInt,
  costPriceMinor: moneyInt,
  stockQty: z.number().int().min(0).max(1_000_000_000),
  lowStockAt: z.number().int().min(0).max(1_000_000),
  isActive: z.boolean(),
  deletedAt: isoDate,
});

export const adjustmentRowSchema = z.object({
  id: z.string().min(1).max(64),
  productId: z.string().min(1).max(64),
  delta: z.number().int().refine((v) => v !== 0, "delta must be non-zero"),
  reason: z.string().trim().min(1).max(200),
  createdAt: isoDate,
});

export const saleItemRowSchema = z.object({
  name: z.string().trim().min(1).max(160),
  unit: nullableText(20),
  qty: z.number().int().min(1).max(1_000_000),
  unitPriceMinor: moneyInt,
  lineTotalMinor: moneyInt,
  productId: nullableText(64),
}).refine((item) => item.lineTotalMinor === item.qty * item.unitPriceMinor, {
  message: "lineTotalMinor must equal qty × unitPriceMinor (A08 integer math)",
});

export const saleRowSchema = z.object({
  id: z.string().min(1).max(64),
  number: z.number().int().min(1).max(2_000_000_000),
  customerId: nullableText(64),
  subtotalMinor: moneyInt,
  discountMinor: moneyInt,
  totalMinor: moneyInt,
  paidMinor: moneyInt,
  // R90 — DRAFT joins the lifecycle: a draft round-trips with a NULL issue
  // day and ZERO payments (draft money is a lie — rejected below).
  status: z.enum(["DRAFT", "UNPAID", "PARTIAL", "PAID"]),
  issueDate: isoDate.nullable(),
  note: nullableText(1000),
  deletedAt: isoDate,
  items: z.array(saleItemRowSchema).max(200),
})
  .refine((s) => s.totalMinor === s.subtotalMinor - s.discountMinor, {
    message: "totalMinor must equal subtotalMinor − discountMinor",
  })
  .refine((s) => s.paidMinor <= s.totalMinor, {
    message: "paidMinor cannot exceed totalMinor (no overpayment)",
  })
  // R90 — the DRAFT money law: pre-issuance = no issue day + no payments.
  .refine((s) => s.status !== "DRAFT" || (s.issueDate === null && s.paidMinor === 0), {
    message: "a DRAFT is pre-issuance money: null issueDate and zero paidMinor",
  })
  .refine(
    (s) => s.status === "DRAFT" || (s.issueDate !== null && s.status === statusOf(s.totalMinor, s.paidMinor)),
    {
      message: "status must match statusOf(totalMinor, paidMinor)",
    },
  );

export const expenseRowSchema = z.object({
  id: z.string().min(1).max(64),
  supplierId: nullableText(64),
  category: z.string().trim().min(1).max(80),
  amountMinor: moneyInt,
  paidMinor: moneyInt,
  status: z.enum(["UNPAID", "PARTIAL", "PAID"]),
  spentAt: isoDate,
  // Supplier-bill terms (payables-aging round) — must round-trip so backups
  // never silently drop recorded data.
  dueDate: isoDate,
  reference: nullableText(80),
  note: nullableText(1000),
  deletedAt: isoDate,
})
  .refine((e) => e.paidMinor <= e.amountMinor, {
    message: "paidMinor cannot exceed amountMinor (no overpayment)",
  })
  .refine((e) => e.status === statusOf(e.amountMinor, e.paidMinor), {
    message: "status must match statusOf(amountMinor, paidMinor)",
  });

export const paymentRowSchema = z
  .object({
    id: z.string().min(1).max(64),
    saleId: nullableText(64),
    expenseId: nullableText(64),
    direction: z.enum(["IN", "OUT"]),
    amountMinor: moneyInt,
    method: z.enum(["CASH", "BANK_TRANSFER", "CARD", "OTHER"]),
    note: nullableText(1000),
    paidAt: isoDate,
  })
  .refine((p) => (p.saleId === null) !== (p.expenseId === null), {
    message: "exactly one of saleId / expenseId is required",
  })
  .refine((p) => p.amountMinor > 0, {
    message: "payment amountMinor must be positive",
  });

/* --------------------- Prompt 48 (§7) — supplier bills ---------------------
 * Supplier-bill DOCUMENTS round-trip in the backup file for fidelity, but
 * they are NEVER re-imported: the only sanctioned way a SupplierBill comes
 * to exist is the posting transaction (which must also create exactly one
 * linked Expense inside the same transaction — a bulk restore cannot
 * reproduce that invariant without fabricating payables). The linked
 * Expense itself round-trips through the existing `expenses` section (the
 * sole payable authority); `expenseId` / `purchaseOrderId` are exported as
 * stable relationship identifiers so the drill can verify the links.
 * internalNotes are deliberately absent (staff-only, §16).
 */
export const supplierBillRowSchema = z.object({
  id: z.string().min(1).max(64),
  reference: z.string().min(1).max(80),
  supplierInvoiceReference: nullableText(80),
  supplierId: z.string().min(1).max(64),
  supplierNameAtBill: z.string().min(1).max(160),
  purchaseOrderId: z.string().min(1).max(64),
  purchaseOrderReferenceAtBill: z.string().min(1).max(80),
  status: z.enum(["DRAFT", "POSTED", "CANCELLED"]),
  billDate: isoDate,
  dueDate: isoDate,
  currencyCodeAtBill: z.string().min(3).max(3),
  currencySymbolAtBill: z.string().min(1).max(8),
  decimalPrecisionAtBill: z.number().int().min(0).max(4),
  subtotalMinor: moneyInt,
  discountMinor: moneyInt,
  totalMinor: moneyInt,
  createdByUserId: z.string().min(1).max(64),
  postedAt: isoDate,
  cancelledAt: isoDate,
  expenseId: nullableText(64),
  createdAt: isoDate,
  updatedAt: isoDate,
})
  .refine((b) => b.totalMinor === b.subtotalMinor - b.discountMinor, {
    message: "totalMinor must equal subtotalMinor − discountMinor",
  })
  .refine(
    (b) =>
      (b.status === "POSTED") === (b.expenseId !== null) &&
      (b.status === "POSTED") === (b.postedAt !== null) &&
      (b.status === "CANCELLED") === (b.cancelledAt !== null),
    {
      message:
        "status must agree with the lifecycle fields (POSTED ⇔ expenseId+postedAt; CANCELLED ⇔ cancelledAt)",
    },
  );

export const supplierBillLineRowSchema = z.object({
  id: z.string().min(1).max(64),
  supplierBillId: z.string().min(1).max(64),
  purchaseOrderLineId: z.string().min(1).max(64),
  productId: z.string().min(1).max(64),
  productNameAtBill: z.string().min(1).max(160),
  skuAtBill: nullableText(60),
  unitAtBill: nullableText(20),
  billedQty: z.number().int().min(1).max(1_000_000),
  unitPriceMinor: moneyInt,
  purchaseOrderUnitPriceMinor: moneyInt,
  lineTotalMinor: moneyInt,
  createdAt: isoDate,
  updatedAt: isoDate,
}).refine((l) => l.lineTotalMinor === l.billedQty * l.unitPriceMinor, {
  message: "lineTotalMinor must equal billedQty × unitPriceMinor (A08 integer math)",
});

export const backupV1Schema = z
  .object({
    $schema: z.literal(BACKUP_SCHEMA_ID),
    exportedAt: z.string().max(40),
    business: z.object({
      id: z.string().min(1).max(64),
      name: z.string().min(1).max(160),
      slug: z.string().min(1).max(80),
      currencyCode: z.string().min(3).max(3),
      currencySymbol: z.string().min(1).max(8),
      decimalPrecision: z.number().int().min(0).max(4),
      locale: z.string().min(2).max(5),
      timezone: z.string().min(1).max(64),
    }),
    // Accepted for round-trip fidelity but NOT imported.
    members: z.array(z.unknown()).max(500).optional(),
    auditTrail: z.array(z.unknown()).max(50_000).optional(),
    customers: z.array(customerRowSchema).max(5_000),
    suppliers: z.array(supplierRowSchema).max(5_000),
    products: z.array(productRowSchema).max(5_000),
    inventoryAdjustments: z.array(adjustmentRowSchema).max(20_000),
    sales: z.array(saleRowSchema).max(20_000),
    expenses: z.array(expenseRowSchema).max(20_000),
    payments: z.array(paymentRowSchema).max(50_000),
    // Prompt 48 (§7) — bill documents validate for round-trip fidelity but
    // are NEVER imported (see supplierBillRowSchema note above).
    supplierBills: z.array(supplierBillRowSchema).max(20_000).optional(),
    supplierBillLines: z.array(supplierBillLineRowSchema).max(50_000).optional(),
  })
  .passthrough();

export type BackupV1 = z.infer<typeof backupV1Schema>;
export type CustomerRow = z.infer<typeof customerRowSchema>;
export type SupplierRow = z.infer<typeof supplierRowSchema>;
export type ProductRow = z.infer<typeof productRowSchema>;
export type AdjustmentRow = z.infer<typeof adjustmentRowSchema>;
export type SaleRow = z.infer<typeof saleRowSchema>;
export type ExpenseRow = z.infer<typeof expenseRowSchema>;
export type PaymentRow = z.infer<typeof paymentRowSchema>;
export type SupplierBillRow = z.infer<typeof supplierBillRowSchema>;
export type SupplierBillLineRow = z.infer<typeof supplierBillLineRowSchema>;

export function emptyEntityReport(): Record<ImportEntity, EntityReport> {
  return {
    customers: { total: 0, toCreate: 0, existing: 0, invalid: 0 },
    suppliers: { total: 0, toCreate: 0, existing: 0, invalid: 0 },
    products: { total: 0, toCreate: 0, existing: 0, invalid: 0 },
    inventoryAdjustments: { total: 0, toCreate: 0, existing: 0, invalid: 0 },
    sales: { total: 0, toCreate: 0, existing: 0, invalid: 0 },
    expenses: { total: 0, toCreate: 0, existing: 0, invalid: 0 },
    payments: { total: 0, toCreate: 0, existing: 0, invalid: 0 },
  };
}
