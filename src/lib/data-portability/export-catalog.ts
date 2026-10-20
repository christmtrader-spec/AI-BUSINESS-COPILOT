import "server-only";

/**
 * Export dataset catalog — Prompt 31 §5/§6/§41-§54.
 *
 * LAWS:
 *  - EXPLICIT allowlist: a dataset key that is not in this catalog can
 *    never be exported (§39/§239 — unknown dataset rejected).
 *  - Every dataset is classified (§6): PUBLIC_BUSINESS / CONFIDENTIAL /
 *    HIGHLY_SENSITIVE. No dataset below contains authentication or
 *    security secrets (§9/§12-§19 — enforced again by the static scanner).
 *  - Tenant-owned only: fetchers filter by businessId unconditionally
 *    (§32); the caller's ctx.businessId is the ONLY business key used.
 *  - Per-row businessId is deliberately EXCLUDED (§10 — the manifest
 *    carries the business identity; per-row copies are unnecessary).
 *  - Financial export is READ-ONLY representation of the same records the
 *    UI already shows (§222/§223) — amounts as exact integer minor units
 *    in JSON, exact decimal strings in CSV (§226/§227).
 *  - NOT exported (explicit Prompt 31 decisions, documented):
 *      · AI chat transcripts (user-personal, out of portability scope §53)
 *      · tenant audit trail (actor identities + history, not in catalog §5)
 *      · receivables/payables (DERIVED views of sales/expenses — the same
 *        facts are already inside those datasets)
 *      · anything platform: subscriptions internals, provider costs, AI
 *        rates, platform audit, operators (§9/§51/§52/§189).
 */

import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { formatMinorToDecimal } from "./money-csv";

export type ExportSensitivity = "PUBLIC_BUSINESS" | "CONFIDENTIAL" | "HIGHLY_SENSITIVE";

export type ExportDatasetKey =
  | "business"
  | "members"
  | "customers"
  | "suppliers"
  | "products"
  | "inventory"
  | "sales"
  | "sale_items"
  | "expenses"
  | "payments"
  | "crm_leads"
  | "crm_opportunities"
  | "crm_activities"
  | "crm_tasks"
  | "inventory_stocktakes"
  | "inventory_stocktake_lines"
  | "purchase_orders"
  | "purchase_order_lines"
  | "inventory_goods_receipts"
  | "inventory_goods_receipt_lines"
  | "inventory_goods_returns"
  | "inventory_goods_return_lines"
  | "inventory_goods_dispatches"
  | "inventory_goods_dispatch_lines"
  | "sales_orders"
  | "sales_order_lines"
  // Prompt 47 (§20) — quotation datasets: export-only (import blocked).
  | "sales_quotations"
  | "sales_quotation_lines"
  // Prompt 48 (§6) — supplier-bill datasets: export-only (import blocked).
  | "supplier_bills"
  | "supplier_bill_lines"
  | "subscription_summary"
  | "usage_summary";

export const EXPORT_DATASET_KEYS = [
  "business",
  "members",
  "customers",
  "suppliers",
  "products",
  "inventory",
  "sales",
  "sale_items",
  "expenses",
  "payments",
  "crm_leads",
  "crm_opportunities",
  "crm_activities",
  "crm_tasks",
  "inventory_stocktakes",
  "inventory_stocktake_lines",
  "purchase_orders",
  "purchase_order_lines",
  "inventory_goods_receipts",
  "inventory_goods_receipt_lines",
  "inventory_goods_returns",
  "inventory_goods_return_lines",
  "inventory_goods_dispatches",
  "inventory_goods_dispatch_lines",
  "sales_orders",
  "sales_order_lines",
  "sales_quotations",
  "sales_quotation_lines",
  "supplier_bills",
  "supplier_bill_lines",
  "subscription_summary",
  "usage_summary",
] as const satisfies readonly ExportDatasetKey[];

/** `sales` always carries its line items (§46 — never flatten relationships). */
export const DATASET_IMPLICATIONS: Partial<Record<ExportDatasetKey, ExportDatasetKey[]>> = {
  sales: ["sale_items"],
  // Prompt 40 (§107) — stocktakes always carry their count lines.
  inventory_stocktakes: ["inventory_stocktake_lines"],
  // Prompt 41 (§95) — purchase orders always carry their lines.
  purchase_orders: ["purchase_order_lines"],
  // Prompt 42 (§137) — goods receipts always carry their receipt lines.
  inventory_goods_receipts: ["inventory_goods_receipt_lines"],
  // Prompt 43 (§113) — goods returns always carry their return lines.
  inventory_goods_returns: ["inventory_goods_return_lines"],
  // Prompt 44 — goods dispatches always carry their dispatch lines.
  inventory_goods_dispatches: ["inventory_goods_dispatch_lines"],
  // Prompt 45 (§116) — sales orders always carry their order lines.
  sales_orders: ["sales_order_lines"],
  // Prompt 47 (§20) — quotations always carry their offer lines.
  sales_quotations: ["sales_quotation_lines"],
  // Prompt 48 (§6) — supplier bills always carry their invoice lines.
  supplier_bills: ["supplier_bill_lines"],
};

export type DatasetMeta = {
  key: ExportDatasetKey;
  sensitivity: ExportSensitivity;
  /** CSV table file name (machine header names stay stable, §193). */
  csvFile: string;
  /** i18n key under portability.datasets. */
  labelKey: string;
};

export const EXPORT_CATALOG: Record<ExportDatasetKey, DatasetMeta> = {
  business: { key: "business", sensitivity: "PUBLIC_BUSINESS", csvFile: "business.csv", labelKey: "business" },
  members: { key: "members", sensitivity: "CONFIDENTIAL", csvFile: "members.csv", labelKey: "members" },
  customers: { key: "customers", sensitivity: "CONFIDENTIAL", csvFile: "customers.csv", labelKey: "customers" },
  suppliers: { key: "suppliers", sensitivity: "CONFIDENTIAL", csvFile: "suppliers.csv", labelKey: "suppliers" },
  products: { key: "products", sensitivity: "CONFIDENTIAL", csvFile: "products.csv", labelKey: "products" },
  inventory: { key: "inventory", sensitivity: "CONFIDENTIAL", csvFile: "inventory.csv", labelKey: "inventory" },
  sales: { key: "sales", sensitivity: "CONFIDENTIAL", csvFile: "sales.csv", labelKey: "sales" },
  sale_items: { key: "sale_items", sensitivity: "CONFIDENTIAL", csvFile: "sale_items.csv", labelKey: "saleItems" },
  expenses: { key: "expenses", sensitivity: "CONFIDENTIAL", csvFile: "expenses.csv", labelKey: "expenses" },
  payments: { key: "payments", sensitivity: "CONFIDENTIAL", csvFile: "payments.csv", labelKey: "payments" },
  // Prompt 35 (§86) — CRM datasets: CONFIDENTIAL (personal contact data);
  // relationships carried as stable ids; forecast values exported as minor
  // integers; never any platform/AI-cost/security data.
  crm_leads: { key: "crm_leads", sensitivity: "CONFIDENTIAL", csvFile: "crm_leads.csv", labelKey: "crmLeads" },
  crm_opportunities: { key: "crm_opportunities", sensitivity: "CONFIDENTIAL", csvFile: "crm_opportunities.csv", labelKey: "crmOpportunities" },
  // Prompt 36 (§62/§111) — CRM activities/tasks: CONFIDENTIAL BUSINESS DATA
  // (notes/descriptions may contain personal contact details). Relationships
  // as stable ids; no platform/AI-cost/notification internals.
  crm_activities: { key: "crm_activities", sensitivity: "CONFIDENTIAL", csvFile: "crm_activities.csv", labelKey: "crmActivities" },
  crm_tasks: { key: "crm_tasks", sensitivity: "CONFIDENTIAL", csvFile: "crm_tasks.csv", labelKey: "crmTasks" },
  // Prompt 40 (§107/§109) — physical count sessions: CONFIDENTIAL BUSINESS
  // DATA. Count lines always accompany their stocktake (implication above);
  // snapshots (productName/SKU/unit) are exported as recorded — never any
  // platform/AI-cost/security data.
  inventory_stocktakes: { key: "inventory_stocktakes", sensitivity: "CONFIDENTIAL", csvFile: "inventory_stocktakes.csv", labelKey: "stocktakes" },
  inventory_stocktake_lines: { key: "inventory_stocktake_lines", sensitivity: "CONFIDENTIAL", csvFile: "inventory_stocktake_lines.csv", labelKey: "stocktakeLines" },
  // Prompt 41 (§95) — procurement documents are business operational data
  // (CONFIDENTIAL): snapshots + document totals, never provider/secret data.
  purchase_orders: { key: "purchase_orders", sensitivity: "CONFIDENTIAL", csvFile: "purchase_orders.csv", labelKey: "purchaseOrders" },
  purchase_order_lines: { key: "purchase_order_lines", sensitivity: "CONFIDENTIAL", csvFile: "purchase_order_lines.csv", labelKey: "purchaseOrderLines" },
  // Prompt 42 (§136) — receiving documents: CONFIDENTIAL (tenant inventory
  // evidence). Export-ONLY (§138/§252) — import is intentionally blocked.
  inventory_goods_receipts: { key: "inventory_goods_receipts", sensitivity: "CONFIDENTIAL", csvFile: "inventory_goods_receipts.csv", labelKey: "inventoryGoodsReceipts" },
  inventory_goods_receipt_lines: { key: "inventory_goods_receipt_lines", sensitivity: "CONFIDENTIAL", csvFile: "inventory_goods_receipt_lines.csv", labelKey: "inventoryGoodsReceiptLines" },
  // Prompt 43 (§112) — return documents: CONFIDENTIAL (tenant inventory
  // evidence). Export-ONLY (§114) — import is intentionally blocked (§115):
  // a generic import could replay stock decrements and duplicate negative
  // inventory movements.
  inventory_goods_returns: { key: "inventory_goods_returns", sensitivity: "CONFIDENTIAL", csvFile: "inventory_goods_returns.csv", labelKey: "inventoryGoodsReturns" },
  inventory_goods_return_lines: { key: "inventory_goods_return_lines", sensitivity: "CONFIDENTIAL", csvFile: "inventory_goods_return_lines.csv", labelKey: "inventoryGoodsReturnLines" },
  // Prompt 44 — dispatch documents: CONFIDENTIAL (tenant inventory
  // evidence). Export-ONLY — import is intentionally blocked: a generic
  // import could replay stock decrements and duplicate negative inventory
  // movements (the same law as P42/P43).
  inventory_goods_dispatches: { key: "inventory_goods_dispatches", sensitivity: "CONFIDENTIAL", csvFile: "inventory_goods_dispatches.csv", labelKey: "inventoryGoodsDispatches" },
  inventory_goods_dispatch_lines: { key: "inventory_goods_dispatch_lines", sensitivity: "CONFIDENTIAL", csvFile: "inventory_goods_dispatch_lines.csv", labelKey: "inventoryGoodsDispatchLines" },
  // Prompt 45 (§116) — sales orders + lines: CONFIDENTIAL BUSINESS DATA
  // (commercial agreements with customer identity + agreed prices).
  // Export-ONLY — import is intentionally blocked (§117): importing
  // confirmed/completed operational orders could create dispatch
  // eligibility or invoice/fulfillment inconsistencies.
  sales_orders: { key: "sales_orders", sensitivity: "CONFIDENTIAL", csvFile: "sales_orders.csv", labelKey: "salesOrders" },
  sales_order_lines: { key: "sales_order_lines", sensitivity: "CONFIDENTIAL", csvFile: "sales_order_lines.csv", labelKey: "salesOrderLines" },
  // Prompt 47 (§20) — quotations + lines: CONFIDENTIAL BUSINESS DATA
  // (commercial offers with customer identity + offered prices).
  // Export-ONLY — import is intentionally blocked (§20): replaying offers
  // through a generic importer would fabricate commercial history.
  sales_quotations: { key: "sales_quotations", sensitivity: "CONFIDENTIAL", csvFile: "sales_quotations.csv", labelKey: "salesQuotations" },
  sales_quotation_lines: { key: "sales_quotation_lines", sensitivity: "CONFIDENTIAL", csvFile: "sales_quotation_lines.csv", labelKey: "salesQuotationLines" },
  // Prompt 48 (§6) — supplier bills + lines: CONFIDENTIAL BUSINESS DATA
  // (supplier invoice documents with supplier identity + invoiced prices).
  // Export-ONLY — import is intentionally blocked (§6.1): replaying bills
  // through a generic importer would fabricate payable history or claim
  // SupplierBill↔Expense relations outside the posting transaction.
  supplier_bills: { key: "supplier_bills", sensitivity: "CONFIDENTIAL", csvFile: "supplier_bills.csv", labelKey: "supplierBills" },
  supplier_bill_lines: { key: "supplier_bill_lines", sensitivity: "CONFIDENTIAL", csvFile: "supplier_bill_lines.csv", labelKey: "supplierBillLines" },
  subscription_summary: { key: "subscription_summary", sensitivity: "CONFIDENTIAL", csvFile: "subscription.csv", labelKey: "subscriptionSummary" },
  usage_summary: { key: "usage_summary", sensitivity: "CONFIDENTIAL", csvFile: "usage.csv", labelKey: "usageSummary" },
};

/* ------------------------------ row building ------------------------------- */

export type ExportRow = {
  /** JSON row — IDs + relationships preserved, money as minor integers (§54/§226). */
  json: Record<string, unknown>;
  /** CSV row — exact decimal strings for money, ISO-8601 UTC dates (§227/§231). */
  csv: Array<string | number | null>;
};

export type DatasetFetchResult = {
  rows: ExportRow[];
  /** True when the dataset hit the export record cap (job must FAIL, §26). */
  truncated: boolean;
};

export type DatasetFetchCtx = {
  businessId: string;
  /** Business decimal precision for money → CSV decimal strings. */
  decimalPrecision: number;
  /** Hard cap applied per fetch — caller passes EXPORT_MAX_RECORDS headroom. */
  maxRecords: number;
};

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/* ------------------------------- fetchers ---------------------------------- */
/* Every fetcher takes rows in ascending createdAt order for deterministic
   output, and never reads beyond the tenant scope. */

type Customer = Prisma.CustomerGetPayload<object>;

function customerRow(c: Customer, precision: number): ExportRow {
  void precision; // customers carry no money fields
  return {
    json: {
      id: c.id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      address: c.address,
      note: c.note,
      deletedAt: iso(c.deletedAt),
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    },
    csv: [c.id, c.name, c.phone, c.email, c.address, c.note, iso(c.deletedAt), c.createdAt.toISOString(), c.updatedAt.toISOString()],
  };
}

function supplierRow(s: Prisma.SupplierGetPayload<object>, precision: number): ExportRow {
  void precision;
  return {
    json: {
      id: s.id,
      name: s.name,
      phone: s.phone,
      email: s.email,
      address: s.address,
      note: s.note,
      deletedAt: iso(s.deletedAt),
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    },
    csv: [s.id, s.name, s.phone, s.email, s.address, s.note, iso(s.deletedAt), s.createdAt.toISOString(), s.updatedAt.toISOString()],
  };
}

function productRow(p: Prisma.ProductGetPayload<object>, precision: number): ExportRow {
  return {
    json: {
      id: p.id,
      name: p.name,
      sku: p.sku,
      unit: p.unit,
      salePriceMinor: p.salePriceMinor,
      costPriceMinor: p.costPriceMinor,
      stockQty: p.stockQty,
      lowStockAt: p.lowStockAt,
      isActive: p.isActive,
      deletedAt: iso(p.deletedAt),
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    },
    csv: [
      p.id,
      p.name,
      p.sku,
      p.unit,
      formatMinorToDecimal(p.salePriceMinor, precision),
      formatMinorToDecimal(p.costPriceMinor, precision),
      p.stockQty,
      p.lowStockAt,
      p.isActive ? "true" : "false",
      iso(p.deletedAt),
      p.createdAt.toISOString(),
      p.updatedAt.toISOString(),
    ],
  };
}

async function fetchWithCap<T>(
  cap: number,
  query: (take: number) => Promise<T[]>,
): Promise<{ items: T[]; truncated: boolean }> {
  // Fetch one row beyond the cap so truncation is DETECTABLE, never silent.
  const items = await query(cap + 1);
  return { items: items.slice(0, cap), truncated: items.length > cap };
}

export type DatasetFetcher = (ctx: DatasetFetchCtx) => Promise<DatasetFetchResult>;

export const DATASET_FETCHERS: Record<ExportDatasetKey, DatasetFetcher> = {
  business: async (ctx) => {
    const b = await db.business.findUnique({
      where: { id: ctx.businessId },
      select: {
        name: true,
        slug: true,
        currencyCode: true,
        currencySymbol: true,
        decimalPrecision: true,
        locale: true,
        timezone: true,
        createdAt: true,
      },
    });
    if (!b) return { rows: [], truncated: false };
    return {
      rows: [
        {
          json: { ...b, createdAt: b.createdAt.toISOString() },
          csv: [b.name, b.slug, b.currencyCode, b.currencySymbol, b.decimalPrecision, b.locale, b.timezone, b.createdAt.toISOString()],
        },
      ],
      truncated: false,
    };
  },

  members: async (ctx) => {
    // §41 — business-portability identity (email), role, status, joinedAt.
    // NEVER: password/MFA/session/security data (none is even selected).
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.businessMember.findMany({
        where: { businessId: ctx.businessId },
        orderBy: { createdAt: "asc" },
        take,
        select: {
          role: true,
          createdAt: true,
          user: { select: { email: true, name: true } },
        },
      }),
    );
    return {
      rows: items.map((m) => ({
        json: {
          email: m.user.email,
          name: m.user.name,
          role: m.role,
          status: "ACTIVE",
          joinedAt: m.createdAt.toISOString(),
        },
        csv: [m.user.email, m.user.name, m.role, "ACTIVE", m.createdAt.toISOString()],
      })),
      truncated,
    };
  },

  customers: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.customer.findMany({
        where: { businessId: ctx.businessId },
        orderBy: { createdAt: "asc" },
        take,
      }),
    );
    return { rows: items.map((c) => customerRow(c, ctx.decimalPrecision)), truncated };
  },

  suppliers: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.supplier.findMany({
        where: { businessId: ctx.businessId },
        orderBy: { createdAt: "asc" },
        take,
      }),
    );
    return { rows: items.map((s) => supplierRow(s, ctx.decimalPrecision)), truncated };
  },

  products: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.product.findMany({
        where: { businessId: ctx.businessId },
        orderBy: { createdAt: "asc" },
        take,
      }),
    );
    return { rows: items.map((p) => productRow(p, ctx.decimalPrecision)), truncated };
  },

  inventory: async (ctx) => {
    // §45 — preserve ACTUAL recorded adjustments; no inferred stock history.
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.inventoryAdjustment.findMany({
        where: { businessId: ctx.businessId },
        orderBy: { createdAt: "asc" },
        take,
        select: { id: true, productId: true, delta: true, reason: true, createdAt: true },
      }),
    );
    return {
      rows: items.map((a) => ({
        json: {
          id: a.id,
          productId: a.productId,
          delta: a.delta,
          reason: a.reason,
          createdAt: a.createdAt.toISOString(),
        },
        csv: [a.id, a.productId, a.delta, a.reason, a.createdAt.toISOString()],
      })),
      truncated,
    };
  },

  sales: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.sale.findMany({
        where: { businessId: ctx.businessId },
        orderBy: { createdAt: "asc" },
        take,
        select: {
          id: true,
          number: true,
          customerId: true,
          subtotalMinor: true,
          discountMinor: true,
          taxRateBp: true,
          taxMinor: true,
          totalMinor: true,
          paidMinor: true,
          status: true,
          issueDate: true,
          note: true,
          deletedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    return {
      rows: items.map((s) => ({
        json: {
          id: s.id,
          number: s.number,
          customerId: s.customerId,
          subtotalMinor: s.subtotalMinor,
          discountMinor: s.discountMinor,
          taxRateBp: s.taxRateBp,
          taxMinor: s.taxMinor,
          totalMinor: s.totalMinor,
          paidMinor: s.paidMinor,
          status: s.status,
          issueDate: s.issueDate.toISOString(),
          note: s.note,
          deletedAt: iso(s.deletedAt),
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
        },
        csv: [
          s.id,
          s.number,
          s.customerId,
          formatMinorToDecimal(s.subtotalMinor, ctx.decimalPrecision),
          formatMinorToDecimal(s.discountMinor, ctx.decimalPrecision),
          formatMinorToDecimal(s.taxMinor, ctx.decimalPrecision),
          formatMinorToDecimal(s.totalMinor, ctx.decimalPrecision),
          formatMinorToDecimal(s.paidMinor, ctx.decimalPrecision),
          s.status,
          s.issueDate.toISOString(),
          s.note,
          iso(s.deletedAt),
          s.createdAt.toISOString(),
          s.updatedAt.toISOString(),
        ],
      })),
      truncated,
    };
  },

  sale_items: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.saleItem.findMany({
        where: { sale: { businessId: ctx.businessId } },
        orderBy: { id: "asc" },
        take,
        select: {
          id: true,
          saleId: true,
          productId: true,
          name: true,
          unit: true,
          qty: true,
          unitPriceMinor: true,
          lineTotalMinor: true,
        },
      }),
    );
    return {
      rows: items.map((i) => ({
        json: {
          id: i.id,
          saleId: i.saleId,
          productId: i.productId,
          name: i.name,
          unit: i.unit,
          qty: i.qty,
          unitPriceMinor: i.unitPriceMinor,
          lineTotalMinor: i.lineTotalMinor,
        },
        csv: [
          i.id,
          i.saleId,
          i.productId,
          i.name,
          i.unit,
          i.qty,
          formatMinorToDecimal(i.unitPriceMinor, ctx.decimalPrecision),
          formatMinorToDecimal(i.lineTotalMinor, ctx.decimalPrecision),
        ],
      })),
      truncated,
    };
  },

  expenses: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.expense.findMany({
        where: { businessId: ctx.businessId },
        orderBy: { createdAt: "asc" },
        take,
        select: {
          id: true,
          supplierId: true,
          category: true,
          amountMinor: true,
          paidMinor: true,
          status: true,
          spentAt: true,
          note: true,
          deletedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    return {
      rows: items.map((e) => ({
        json: {
          id: e.id,
          supplierId: e.supplierId,
          category: e.category,
          amountMinor: e.amountMinor,
          paidMinor: e.paidMinor,
          status: e.status,
          spentAt: e.spentAt.toISOString(),
          note: e.note,
          deletedAt: iso(e.deletedAt),
          createdAt: e.createdAt.toISOString(),
          updatedAt: e.updatedAt.toISOString(),
        },
        csv: [
          e.id,
          e.supplierId,
          e.category,
          formatMinorToDecimal(e.amountMinor, ctx.decimalPrecision),
          formatMinorToDecimal(e.paidMinor, ctx.decimalPrecision),
          e.status,
          e.spentAt.toISOString(),
          e.note,
          iso(e.deletedAt),
          e.createdAt.toISOString(),
          e.updatedAt.toISOString(),
        ],
      })),
      truncated,
    };
  },

  // Prompt 35 (§86) — CRM leads export (soft-deleted included: portability
  // mirrors the tenant lifecycle; §105/§106 policy analog).
  crm_leads: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.crmLead.findMany({
        where: { businessId: ctx.businessId },
        orderBy: { createdAt: "asc" },
        take,
        select: {
          id: true,
          name: true,
          companyName: true,
          phone: true,
          email: true,
          source: true,
          sourceDetail: true,
          status: true,
          note: true,
          assignedToUserId: true,
          customerId: true,
          convertedAt: true,
          deletedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    return {
      rows: items.map((l) => ({
        json: {
          id: l.id,
          name: l.name,
          companyName: l.companyName,
          phone: l.phone,
          email: l.email,
          source: l.source,
          sourceDetail: l.sourceDetail,
          status: l.status,
          note: l.note,
          assignedToUserId: l.assignedToUserId,
          customerId: l.customerId,
          convertedAt: iso(l.convertedAt),
          deletedAt: iso(l.deletedAt),
          createdAt: l.createdAt.toISOString(),
          updatedAt: l.updatedAt.toISOString(),
        },
        csv: [l.id, l.name, l.companyName, l.phone, l.email, l.source, l.sourceDetail, l.status, l.note, l.assignedToUserId, l.customerId, iso(l.convertedAt), iso(l.deletedAt), l.createdAt.toISOString(), l.updatedAt.toISOString()],
      })),
      truncated,
    };
  },

  crm_opportunities: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.crmOpportunity.findMany({
        where: { businessId: ctx.businessId },
        orderBy: { createdAt: "asc" },
        take,
        select: {
          id: true,
          title: true,
          description: true,
          leadId: true,
          customerId: true,
          stage: true,
          probabilityPct: true,
          expectedValueMinor: true,
          currencyCode: true,
          expectedCloseDate: true,
          assignedToUserId: true,
          lostReason: true,
          wonAt: true,
          lostAt: true,
          deletedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    return {
      rows: items.map((o) => ({
        json: {
          id: o.id,
          title: o.title,
          description: o.description,
          leadId: o.leadId,
          customerId: o.customerId,
          stage: o.stage,
          probabilityPct: o.probabilityPct,
          expectedValueMinor: o.expectedValueMinor,
          currencyCode: o.currencyCode,
          expectedCloseDate: iso(o.expectedCloseDate),
          assignedToUserId: o.assignedToUserId,
          lostReason: o.lostReason,
          wonAt: iso(o.wonAt),
          lostAt: iso(o.lostAt),
          deletedAt: iso(o.deletedAt),
          createdAt: o.createdAt.toISOString(),
          updatedAt: o.updatedAt.toISOString(),
        },
        csv: [o.id, o.title, o.description, o.leadId, o.customerId, o.stage, o.probabilityPct, formatMinorToDecimal(o.expectedValueMinor, ctx.decimalPrecision), o.currencyCode, iso(o.expectedCloseDate), o.assignedToUserId, o.lostReason, iso(o.wonAt), iso(o.lostAt), iso(o.deletedAt), o.createdAt.toISOString(), o.updatedAt.toISOString()],
      })),
      truncated,
    };
  },

  // Prompt 36 (§62/§111) — CRM activities export (soft-deleted included:
  // portability mirrors the tenant lifecycle). No security/platform/AI data.
  crm_activities: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.crmActivity.findMany({
        where: { businessId: ctx.businessId },
        orderBy: { createdAt: "asc" },
        take,
        select: {
          id: true,
          type: true,
          title: true,
          description: true,
          occurredAt: true,
          durationMinutes: true,
          customerId: true,
          leadId: true,
          opportunityId: true,
          createdByUserId: true,
          deletedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    return {
      rows: items.map((a) => ({
        json: {
          id: a.id,
          type: a.type,
          title: a.title,
          description: a.description,
          occurredAt: iso(a.occurredAt),
          durationMinutes: a.durationMinutes,
          customerId: a.customerId,
          leadId: a.leadId,
          opportunityId: a.opportunityId,
          createdByUserId: a.createdByUserId,
          deletedAt: iso(a.deletedAt),
          createdAt: a.createdAt.toISOString(),
          updatedAt: a.updatedAt.toISOString(),
        },
        csv: [a.id, a.type, a.title, a.description, iso(a.occurredAt), a.durationMinutes, a.customerId, a.leadId, a.opportunityId, a.createdByUserId, iso(a.deletedAt), a.createdAt.toISOString(), a.updatedAt.toISOString()],
      })),
      truncated,
    };
  },

  // Prompt 36 (§62/§111) — CRM tasks export.
  crm_tasks: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.crmTask.findMany({
        where: { businessId: ctx.businessId },
        orderBy: { createdAt: "asc" },
        take,
        select: {
          id: true,
          title: true,
          description: true,
          status: true,
          priority: true,
          dueAt: true,
          completedAt: true,
          // Prompt 37 (§151) — reminder configuration is business data.
          reminderEnabled: true,
          reminderMinutesBefore: true,
          overdueAlertEnabled: true,
          customerId: true,
          leadId: true,
          opportunityId: true,
          assignedToUserId: true,
          createdByUserId: true,
          deletedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    return {
      rows: items.map((t) => ({
        json: {
          id: t.id,
          title: t.title,
          description: t.description,
          status: t.status,
          priority: t.priority,
          dueAt: iso(t.dueAt),
          completedAt: iso(t.completedAt),
          reminderEnabled: t.reminderEnabled,
          reminderMinutesBefore: t.reminderMinutesBefore,
          overdueAlertEnabled: t.overdueAlertEnabled,
          customerId: t.customerId,
          leadId: t.leadId,
          opportunityId: t.opportunityId,
          assignedToUserId: t.assignedToUserId,
          createdByUserId: t.createdByUserId,
          deletedAt: iso(t.deletedAt),
          createdAt: t.createdAt.toISOString(),
          updatedAt: t.updatedAt.toISOString(),
        },
        csv: [t.id, t.title, t.description, t.status, t.priority, iso(t.dueAt), iso(t.completedAt), String(t.reminderEnabled), t.reminderMinutesBefore, String(t.overdueAlertEnabled), t.customerId, t.leadId, t.opportunityId, t.assignedToUserId, t.createdByUserId, iso(t.deletedAt), t.createdAt.toISOString(), t.updatedAt.toISOString()],
      })),
      truncated,
    };
  },

  payments: async (ctx) => {
    // §48 — tenant FINANCE payments (sale/expense settlements). This is NOT
    // platform subscription billing; no provider/payment-transaction fields.
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.payment.findMany({
        where: { businessId: ctx.businessId },
        orderBy: { paidAt: "asc" },
        take,
        select: {
          id: true,
          saleId: true,
          expenseId: true,
          direction: true,
          amountMinor: true,
          method: true,
          note: true,
          paidAt: true,
          createdAt: true,
        },
      }),
    );
    return {
      rows: items.map((p) => ({
        json: {
          id: p.id,
          saleId: p.saleId,
          expenseId: p.expenseId,
          direction: p.direction,
          amountMinor: p.amountMinor,
          method: p.method,
          note: p.note,
          paidAt: p.paidAt.toISOString(),
          createdAt: p.createdAt.toISOString(),
        },
        csv: [
          p.id,
          p.saleId,
          p.expenseId,
          p.direction,
          formatMinorToDecimal(p.amountMinor, ctx.decimalPrecision),
          p.method,
          p.note,
          p.paidAt.toISOString(),
          p.createdAt.toISOString(),
        ],
      })),
      truncated,
    };
  },

    // Prompt 40 (§107/§108) — physical count sessions + lines. Explicit
  // selects (§67); ascending deterministic order; tenant-scoped fetch only.
  inventory_stocktakes: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.inventoryStocktake.findMany({
        where: { businessId: ctx.businessId },
        orderBy: { createdAt: "asc" },
        take,
        select: {
          id: true,
          reference: true,
          status: true,
          countType: true,
          notes: true,
          createdByUserId: true,
          startedAt: true,
          reviewedAt: true,
          finalizedAt: true,
          canceledAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    return {
      rows: items.map((st) => ({
        json: {
          id: st.id,
          reference: st.reference,
          status: st.status,
          countType: st.countType,
          notes: st.notes,
          createdByUserId: st.createdByUserId,
          startedAt: iso(st.startedAt),
          reviewedAt: iso(st.reviewedAt),
          finalizedAt: iso(st.finalizedAt),
          canceledAt: iso(st.canceledAt),
          createdAt: st.createdAt.toISOString(),
          updatedAt: st.updatedAt.toISOString(),
        },
        csv: [
          st.id, st.reference, st.status, st.countType, st.notes, st.createdByUserId,
          iso(st.startedAt), iso(st.reviewedAt), iso(st.finalizedAt), iso(st.canceledAt),
          st.createdAt.toISOString(), st.updatedAt.toISOString(),
        ],
      })),
      truncated,
    };
  },

  inventory_stocktake_lines: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.inventoryStocktakeLine.findMany({
        where: { stocktake: { businessId: ctx.businessId } },
        orderBy: [{ countedAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          stocktakeId: true,
          productId: true,
          productNameAtCount: true,
          skuAtCount: true,
          unitAtCount: true,
          systemQtyAtCount: true,
          countedQty: true,
          varianceQty: true,
          countedAt: true,
          countedByUserId: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    return {
      rows: items.map((l) => ({
        json: {
          id: l.id,
          stocktakeId: l.stocktakeId,
          productId: l.productId,
          productNameAtCount: l.productNameAtCount,
          skuAtCount: l.skuAtCount,
          unitAtCount: l.unitAtCount,
          systemQtyAtCount: l.systemQtyAtCount,
          countedQty: l.countedQty,
          varianceQty: l.varianceQty,
          countedAt: l.countedAt.toISOString(),
          countedByUserId: l.countedByUserId,
          createdAt: l.createdAt.toISOString(),
          updatedAt: l.updatedAt.toISOString(),
        },
        csv: [
          l.id, l.stocktakeId, l.productId, l.productNameAtCount, l.skuAtCount, l.unitAtCount,
          l.systemQtyAtCount, l.countedQty, l.varianceQty, l.countedAt.toISOString(),
          l.countedByUserId, l.createdAt.toISOString(), l.updatedAt.toISOString(),
        ],
      })),
      truncated,
    };
  },

  // Prompt 41 (§95/§96) — procurement documents + lines. Explicit selects
  // (§207); ascending deterministic order; tenant-scoped; snapshots verbatim
  // (§236 — never replaced with live supplier/product data). Money stays
  // integer minor units.
  purchase_orders: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.purchaseOrder.findMany({
        where: { businessId: ctx.businessId },
        orderBy: [{ orderedAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          reference: true,
          status: true,
          supplierId: true,
          supplierNameAtOrder: true,
          currencyCodeAtOrder: true,
          currencySymbolAtOrder: true,
          decimalPrecisionAtOrder: true,
          orderedAt: true,
          expectedDate: true,
          notes: true,
          createdByUserId: true,
          sentAt: true,
          confirmedAt: true,
          closedAt: true,
          cancelledAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    return {
      rows: items.map((po) => ({
        json: {
          id: po.id,
          reference: po.reference,
          status: po.status,
          supplierId: po.supplierId,
          supplierNameAtOrder: po.supplierNameAtOrder,
          currencyCodeAtOrder: po.currencyCodeAtOrder,
          currencySymbolAtOrder: po.currencySymbolAtOrder,
          decimalPrecisionAtOrder: po.decimalPrecisionAtOrder,
          orderedAt: po.orderedAt.toISOString(),
          expectedDate: iso(po.expectedDate),
          notes: po.notes,
          createdByUserId: po.createdByUserId,
          sentAt: iso(po.sentAt),
          confirmedAt: iso(po.confirmedAt),
          closedAt: iso(po.closedAt),
          cancelledAt: iso(po.cancelledAt),
          createdAt: po.createdAt.toISOString(),
          updatedAt: po.updatedAt.toISOString(),
        },
        csv: [
          po.id, po.reference, po.status, po.supplierId, po.supplierNameAtOrder,
          po.currencyCodeAtOrder, po.currencySymbolAtOrder, po.decimalPrecisionAtOrder,
          po.orderedAt.toISOString(), iso(po.expectedDate), po.notes, po.createdByUserId,
          iso(po.sentAt), iso(po.confirmedAt), iso(po.closedAt), iso(po.cancelledAt),
          po.createdAt.toISOString(), po.updatedAt.toISOString(),
        ],
      })),
      truncated,
    };
  },

  purchase_order_lines: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.purchaseOrderLine.findMany({
        where: { purchaseOrder: { businessId: ctx.businessId } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          purchaseOrderId: true,
          productId: true,
          productNameAtOrder: true,
          skuAtOrder: true,
          unitAtOrder: true,
          orderedQty: true,
          unitPriceMinor: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    return {
      rows: items.map((l) => ({
        json: {
          id: l.id,
          purchaseOrderId: l.purchaseOrderId,
          productId: l.productId,
          productNameAtOrder: l.productNameAtOrder,
          skuAtOrder: l.skuAtOrder,
          unitAtOrder: l.unitAtOrder,
          orderedQty: l.orderedQty,
          unitPriceMinor: l.unitPriceMinor,
          createdAt: l.createdAt.toISOString(),
          updatedAt: l.updatedAt.toISOString(),
        },
        csv: [
          l.id, l.purchaseOrderId, l.productId, l.productNameAtOrder, l.skuAtOrder, l.unitAtOrder,
          l.orderedQty, l.unitPriceMinor, l.createdAt.toISOString(), l.updatedAt.toISOString(),
        ],
      })),
      truncated,
    };
  },

  // Prompt 42 (§136/§252) — goods-receipt datasets: export-ONLY. Rows carry
  // historical snapshots verbatim (§127); there is NO money in this domain
  // (§37) so no minor-unit conversion applies anywhere below.
  inventory_goods_receipts: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.goodsReceipt.findMany({
        where: { businessId: ctx.businessId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          reference: true,
          status: true,
          purchaseOrderId: true,
          purchaseOrderReferenceAtReceipt: true,
          supplierNameAtReceipt: true,
          notes: true,
          createdByUserId: true,
          postedAt: true,
          cancelledAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    return {
      rows: items.map((gr) => ({
        json: {
          id: gr.id,
          reference: gr.reference,
          status: gr.status,
          purchaseOrderId: gr.purchaseOrderId,
          purchaseOrderReferenceAtReceipt: gr.purchaseOrderReferenceAtReceipt,
          supplierNameAtReceipt: gr.supplierNameAtReceipt,
          notes: gr.notes,
          createdByUserId: gr.createdByUserId,
          postedAt: iso(gr.postedAt),
          cancelledAt: iso(gr.cancelledAt),
          createdAt: gr.createdAt.toISOString(),
          updatedAt: gr.updatedAt.toISOString(),
        },
        csv: [
          gr.id, gr.reference, gr.status, gr.purchaseOrderId, gr.purchaseOrderReferenceAtReceipt,
          gr.supplierNameAtReceipt, gr.notes, gr.createdByUserId,
          iso(gr.postedAt), iso(gr.cancelledAt), gr.createdAt.toISOString(), gr.updatedAt.toISOString(),
        ],
      })),
      truncated,
    };
  },

  inventory_goods_receipt_lines: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.goodsReceiptLine.findMany({
        where: { goodsReceipt: { businessId: ctx.businessId } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          goodsReceiptId: true,
          purchaseOrderLineId: true,
          productId: true,
          productNameAtReceipt: true,
          skuAtReceipt: true,
          unitAtReceipt: true,
          receivedQty: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    return {
      rows: items.map((l) => ({
        json: {
          id: l.id,
          goodsReceiptId: l.goodsReceiptId,
          purchaseOrderLineId: l.purchaseOrderLineId,
          productId: l.productId,
          productNameAtReceipt: l.productNameAtReceipt,
          skuAtReceipt: l.skuAtReceipt,
          unitAtReceipt: l.unitAtReceipt,
          receivedQty: l.receivedQty,
          createdAt: l.createdAt.toISOString(),
          updatedAt: l.updatedAt.toISOString(),
        },
        csv: [
          l.id, l.goodsReceiptId, l.purchaseOrderLineId, l.productId, l.productNameAtReceipt,
          l.skuAtReceipt, l.unitAtReceipt, l.receivedQty, l.createdAt.toISOString(), l.updatedAt.toISOString(),
        ],
      })),
      truncated,
    };
  },

  // Prompt 43 (§112/§179) — goods-return datasets: export-ONLY (§114/§180 —
  // a generic import could replay negative inventory movements and
  // duplicate stock decrements). Rows carry historical snapshots verbatim
  // (§30/§64); there is NO money in this domain (§7) so no minor-unit
  // conversion applies anywhere below.
  inventory_goods_returns: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.goodsReturn.findMany({
        where: { businessId: ctx.businessId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          reference: true,
          status: true,
          goodsReceiptId: true,
          goodsReceiptReferenceAtReturn: true,
          purchaseOrderReferenceAtReturn: true,
          supplierNameAtReturn: true,
          notes: true,
          createdByUserId: true,
          postedAt: true,
          cancelledAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    return {
      rows: items.map((gr) => ({
        json: {
          id: gr.id,
          reference: gr.reference,
          status: gr.status,
          goodsReceiptId: gr.goodsReceiptId,
          goodsReceiptReferenceAtReturn: gr.goodsReceiptReferenceAtReturn,
          purchaseOrderReferenceAtReturn: gr.purchaseOrderReferenceAtReturn,
          supplierNameAtReturn: gr.supplierNameAtReturn,
          notes: gr.notes,
          createdByUserId: gr.createdByUserId,
          postedAt: iso(gr.postedAt),
          cancelledAt: iso(gr.cancelledAt),
          createdAt: gr.createdAt.toISOString(),
          updatedAt: gr.updatedAt.toISOString(),
        },
        csv: [
          gr.id, gr.reference, gr.status, gr.goodsReceiptId, gr.goodsReceiptReferenceAtReturn,
          gr.purchaseOrderReferenceAtReturn, gr.supplierNameAtReturn, gr.notes, gr.createdByUserId,
          iso(gr.postedAt), iso(gr.cancelledAt), gr.createdAt.toISOString(), gr.updatedAt.toISOString(),
        ],
      })),
      truncated,
    };
  },

  inventory_goods_return_lines: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.goodsReturnLine.findMany({
        where: { goodsReturn: { businessId: ctx.businessId } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          goodsReturnId: true,
          goodsReceiptLineId: true,
          productId: true,
          productNameAtReturn: true,
          skuAtReturn: true,
          unitAtReturn: true,
          returnedQty: true,
          reasonCode: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    return {
      rows: items.map((l) => ({
        json: {
          id: l.id,
          goodsReturnId: l.goodsReturnId,
          goodsReceiptLineId: l.goodsReceiptLineId,
          productId: l.productId,
          productNameAtReturn: l.productNameAtReturn,
          skuAtReturn: l.skuAtReturn,
          unitAtReturn: l.unitAtReturn,
          returnedQty: l.returnedQty,
          reasonCode: l.reasonCode,
          createdAt: l.createdAt.toISOString(),
          updatedAt: l.updatedAt.toISOString(),
        },
        csv: [
          l.id, l.goodsReturnId, l.goodsReceiptLineId, l.productId, l.productNameAtReturn,
          l.skuAtReturn, l.unitAtReturn, l.returnedQty, l.reasonCode,
          l.createdAt.toISOString(), l.updatedAt.toISOString(),
        ],
      })),
      truncated,
    };
  },

  // Prompt 44 — goods-dispatch datasets: export-ONLY (a generic import
  // could replay negative inventory movements and duplicate stock
  // decrements). Rows carry historical snapshots verbatim; there is NO
  // money in this domain so no minor-unit conversion applies anywhere
  // below.
  inventory_goods_dispatches: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.goodsDispatch.findMany({
        where: { businessId: ctx.businessId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          reference: true,
          status: true,
          customerId: true,
          customerNameAtDispatch: true,
          notes: true,
          createdByUserId: true,
          postedAt: true,
          cancelledAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    return {
      rows: items.map((gd) => ({
        json: {
          id: gd.id,
          reference: gd.reference,
          status: gd.status,
          customerId: gd.customerId,
          customerNameAtDispatch: gd.customerNameAtDispatch,
          notes: gd.notes,
          createdByUserId: gd.createdByUserId,
          postedAt: iso(gd.postedAt),
          cancelledAt: iso(gd.cancelledAt),
          createdAt: gd.createdAt.toISOString(),
          updatedAt: gd.updatedAt.toISOString(),
        },
        csv: [
          gd.id, gd.reference, gd.status, gd.customerId, gd.customerNameAtDispatch, gd.notes,
          gd.createdByUserId, iso(gd.postedAt), iso(gd.cancelledAt),
          gd.createdAt.toISOString(), gd.updatedAt.toISOString(),
        ],
      })),
      truncated,
    };
  },

  inventory_goods_dispatch_lines: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.goodsDispatchLine.findMany({
        where: { goodsDispatch: { businessId: ctx.businessId } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          goodsDispatchId: true,
          productId: true,
          productNameAtDispatch: true,
          skuAtDispatch: true,
          unitAtDispatch: true,
          qty: true,
          reasonCode: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    return {
      rows: items.map((l) => ({
        json: {
          id: l.id,
          goodsDispatchId: l.goodsDispatchId,
          productId: l.productId,
          productNameAtDispatch: l.productNameAtDispatch,
          skuAtDispatch: l.skuAtDispatch,
          unitAtDispatch: l.unitAtDispatch,
          qty: l.qty,
          reasonCode: l.reasonCode,
          createdAt: l.createdAt.toISOString(),
          updatedAt: l.updatedAt.toISOString(),
        },
        csv: [
          l.id, l.goodsDispatchId, l.productId, l.productNameAtDispatch,
          l.skuAtDispatch, l.unitAtDispatch, l.qty, l.reasonCode,
          l.createdAt.toISOString(), l.updatedAt.toISOString(),
        ],
      })),
      truncated,
    };
  },

  sales_orders: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.salesOrder.findMany({
        where: { businessId: ctx.businessId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          reference: true,
          status: true,
          customerId: true,
          customerNameAtOrder: true,
          currencyCodeAtOrder: true,
          currencySymbolAtOrder: true,
          decimalPrecisionAtOrder: true,
          orderDate: true,
          expectedDate: true,
          discountMinor: true,
          notes: true,
          createdByUserId: true,
          confirmedAt: true,
          completedAt: true,
          cancelledAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    return {
      rows: items.map((so) => ({
        json: {
          id: so.id,
          reference: so.reference,
          status: so.status,
          customerId: so.customerId,
          customerNameAtOrder: so.customerNameAtOrder,
          currencyCodeAtOrder: so.currencyCodeAtOrder,
          currencySymbolAtOrder: so.currencySymbolAtOrder,
          decimalPrecisionAtOrder: so.decimalPrecisionAtOrder,
          orderDate: iso(so.orderDate),
          expectedDate: iso(so.expectedDate),
          discountMinor: so.discountMinor,
          notes: so.notes,
          createdByUserId: so.createdByUserId,
          confirmedAt: iso(so.confirmedAt),
          completedAt: iso(so.completedAt),
          cancelledAt: iso(so.cancelledAt),
          createdAt: so.createdAt.toISOString(),
          updatedAt: so.updatedAt.toISOString(),
        },
        csv: [
          so.id, so.reference, so.status, so.customerId, so.customerNameAtOrder,
          so.currencyCodeAtOrder, so.currencySymbolAtOrder, so.decimalPrecisionAtOrder,
          iso(so.orderDate), iso(so.expectedDate), so.discountMinor, so.notes,
          so.createdByUserId, iso(so.confirmedAt), iso(so.completedAt), iso(so.cancelledAt),
          so.createdAt.toISOString(), so.updatedAt.toISOString(),
        ],
      })),
      truncated,
    };
  },

  sales_order_lines: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.salesOrderLine.findMany({
        where: { salesOrder: { businessId: ctx.businessId } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          salesOrderId: true,
          productId: true,
          productNameAtOrder: true,
          skuAtOrder: true,
          unitAtOrder: true,
          orderedQty: true,
          unitPriceMinor: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    return {
      rows: items.map((l) => ({
        json: {
          id: l.id,
          salesOrderId: l.salesOrderId,
          productId: l.productId,
          productNameAtOrder: l.productNameAtOrder,
          skuAtOrder: l.skuAtOrder,
          unitAtOrder: l.unitAtOrder,
          orderedQty: l.orderedQty,
          unitPriceMinor: l.unitPriceMinor,
          createdAt: l.createdAt.toISOString(),
          updatedAt: l.updatedAt.toISOString(),
        },
        csv: [
          l.id, l.salesOrderId, l.productId, l.productNameAtOrder,
          l.skuAtOrder, l.unitAtOrder, l.orderedQty, l.unitPriceMinor,
          l.createdAt.toISOString(), l.updatedAt.toISOString(),
        ],
      })),
      truncated,
    };
  },

  sales_quotations: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.salesQuotation.findMany({
        where: { businessId: ctx.businessId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          reference: true,
          status: true,
          customerId: true,
          customerNameAtQuotation: true,
          currencyCodeAtQuotation: true,
          currencySymbolAtQuotation: true,
          decimalPrecisionAtQuotation: true,
          quotationDate: true,
          validUntilDate: true,
          expectedDeliveryDate: true,
          discountMinor: true,
          customerNotes: true,
          createdByUserId: true,
          sentAt: true,
          acceptedAt: true,
          rejectedAt: true,
          cancelledAt: true,
          convertedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    return {
      rows: items.map((qt) => ({
        json: {
          id: qt.id,
          reference: qt.reference,
          status: qt.status,
          customerId: qt.customerId,
          customerNameAtQuotation: qt.customerNameAtQuotation,
          currencyCodeAtQuotation: qt.currencyCodeAtQuotation,
          currencySymbolAtQuotation: qt.currencySymbolAtQuotation,
          decimalPrecisionAtQuotation: qt.decimalPrecisionAtQuotation,
          quotationDate: iso(qt.quotationDate),
          validUntilDate: iso(qt.validUntilDate),
          expectedDeliveryDate: iso(qt.expectedDeliveryDate),
          discountMinor: qt.discountMinor,
          customerNotes: qt.customerNotes,
          // internalNotes are deliberately NOT exported (staff-only §10/§20).
          createdByUserId: qt.createdByUserId,
          sentAt: iso(qt.sentAt),
          acceptedAt: iso(qt.acceptedAt),
          rejectedAt: iso(qt.rejectedAt),
          cancelledAt: iso(qt.cancelledAt),
          convertedAt: iso(qt.convertedAt),
          createdAt: qt.createdAt.toISOString(),
          updatedAt: qt.updatedAt.toISOString(),
        },
        csv: [
          qt.id, qt.reference, qt.status, qt.customerId, qt.customerNameAtQuotation,
          qt.currencyCodeAtQuotation, qt.currencySymbolAtQuotation, qt.decimalPrecisionAtQuotation,
          iso(qt.quotationDate), iso(qt.validUntilDate), iso(qt.expectedDeliveryDate),
          qt.discountMinor, qt.customerNotes, qt.createdByUserId,
          iso(qt.sentAt), iso(qt.acceptedAt), iso(qt.rejectedAt), iso(qt.cancelledAt), iso(qt.convertedAt),
          qt.createdAt.toISOString(), qt.updatedAt.toISOString(),
        ],
      })),
      truncated,
    };
  },

  sales_quotation_lines: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.salesQuotationLine.findMany({
        where: { salesQuotation: { businessId: ctx.businessId } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          salesQuotationId: true,
          productId: true,
          productNameAtQuotation: true,
          skuAtQuotation: true,
          unitAtQuotation: true,
          qty: true,
          unitPriceMinor: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    return {
      rows: items.map((l) => ({
        json: {
          id: l.id,
          salesQuotationId: l.salesQuotationId,
          productId: l.productId,
          productNameAtQuotation: l.productNameAtQuotation,
          skuAtQuotation: l.skuAtQuotation,
          unitAtQuotation: l.unitAtQuotation,
          qty: l.qty,
          unitPriceMinor: l.unitPriceMinor,
          createdAt: l.createdAt.toISOString(),
          updatedAt: l.updatedAt.toISOString(),
        },
        csv: [
          l.id, l.salesQuotationId, l.productId, l.productNameAtQuotation,
          l.skuAtQuotation, l.unitAtQuotation, l.qty, l.unitPriceMinor,
          l.createdAt.toISOString(), l.updatedAt.toISOString(),
        ],
      })),
      truncated,
    };
  },


  // Prompt 48 (§6) — supplier-bill datasets. Authoritative document data +
  // frozen snapshots + exact integer minor units; expenseId exported as the
  // allowed document relationship identifier (no duplicated balance fields
  // — paid/outstanding live ONLY in the authoritative expenses dataset).
  // internalNotes deliberately NOT exported (staff-only, §16/§6).
  supplier_bills: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.supplierBill.findMany({
        where: { businessId: ctx.businessId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          reference: true,
          supplierInvoiceReference: true,
          supplierId: true,
          supplierNameAtBill: true,
          purchaseOrderId: true,
          purchaseOrderReferenceAtBill: true,
          status: true,
          billDate: true,
          dueDate: true,
          currencyCodeAtBill: true,
          currencySymbolAtBill: true,
          decimalPrecisionAtBill: true,
          subtotalMinor: true,
          discountMinor: true,
          totalMinor: true,
          createdByUserId: true,
          postedAt: true,
          cancelledAt: true,
          expenseId: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    return {
      rows: items.map((b) => ({
        json: {
          id: b.id,
          reference: b.reference,
          supplierInvoiceReference: b.supplierInvoiceReference,
          supplierId: b.supplierId,
          supplierNameAtBill: b.supplierNameAtBill,
          purchaseOrderId: b.purchaseOrderId,
          purchaseOrderReferenceAtBill: b.purchaseOrderReferenceAtBill,
          status: b.status,
          billDate: iso(b.billDate),
          dueDate: iso(b.dueDate),
          currencyCodeAtBill: b.currencyCodeAtBill,
          currencySymbolAtBill: b.currencySymbolAtBill,
          decimalPrecisionAtBill: b.decimalPrecisionAtBill,
          subtotalMinor: b.subtotalMinor,
          discountMinor: b.discountMinor,
          totalMinor: b.totalMinor,
          createdByUserId: b.createdByUserId,
          postedAt: iso(b.postedAt),
          cancelledAt: iso(b.cancelledAt),
          expenseId: b.expenseId,
          createdAt: b.createdAt.toISOString(),
          updatedAt: b.updatedAt.toISOString(),
        },
        csv: [
          b.id, b.reference, b.supplierInvoiceReference, b.supplierId,
          b.supplierNameAtBill, b.purchaseOrderId, b.purchaseOrderReferenceAtBill,
          b.status, iso(b.billDate), iso(b.dueDate),
          b.currencyCodeAtBill, b.currencySymbolAtBill, b.decimalPrecisionAtBill,
          b.subtotalMinor, b.discountMinor, b.totalMinor,
          b.createdByUserId, iso(b.postedAt), iso(b.cancelledAt), b.expenseId,
          b.createdAt.toISOString(), b.updatedAt.toISOString(),
        ],
      })),
      truncated,
    };
  },

  supplier_bill_lines: async (ctx) => {
    const { items, truncated } = await fetchWithCap(ctx.maxRecords, (take) =>
      db.supplierBillLine.findMany({
        where: { supplierBill: { businessId: ctx.businessId } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          supplierBillId: true,
          purchaseOrderLineId: true,
          productId: true,
          productNameAtBill: true,
          skuAtBill: true,
          unitAtBill: true,
          billedQty: true,
          unitPriceMinor: true,
          purchaseOrderUnitPriceMinor: true,
          lineTotalMinor: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    );
    return {
      rows: items.map((l) => ({
        json: {
          id: l.id,
          supplierBillId: l.supplierBillId,
          purchaseOrderLineId: l.purchaseOrderLineId,
          productId: l.productId,
          productNameAtBill: l.productNameAtBill,
          skuAtBill: l.skuAtBill,
          unitAtBill: l.unitAtBill,
          billedQty: l.billedQty,
          unitPriceMinor: l.unitPriceMinor,
          purchaseOrderUnitPriceMinor: l.purchaseOrderUnitPriceMinor,
          lineTotalMinor: l.lineTotalMinor,
          createdAt: l.createdAt.toISOString(),
          updatedAt: l.updatedAt.toISOString(),
        },
        csv: [
          l.id, l.supplierBillId, l.purchaseOrderLineId, l.productId,
          l.productNameAtBill, l.skuAtBill, l.unitAtBill,
          l.billedQty, l.unitPriceMinor, l.purchaseOrderUnitPriceMinor,
          l.lineTotalMinor,
          l.createdAt.toISOString(), l.updatedAt.toISOString(),
        ],
      })),
      truncated,
    };
  },

subscription_summary: async (ctx) => {
    // §51 — customer-visible subscription state ONLY. Provider verification
    // internals, webhook signatures and merchant credentials do not exist here.
    const sub = await db.subscription.findUnique({
      where: { businessId: ctx.businessId },
      select: {
        plan: { select: { code: true, name: true } },
        status: true,
        billingPeriod: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        trialStart: true,
        trialEnd: true,
        cancelAtPeriodEnd: true,
        canceledAt: true,
        endedAt: true,
        createdAt: true,
      },
    });
    if (!sub) return { rows: [], truncated: false };
    return {
      rows: [
        {
          json: {
            planCode: sub.plan.code,
            planName: sub.plan.name,
            status: sub.status,
            billingPeriod: sub.billingPeriod,
            currentPeriodStart: iso(sub.currentPeriodStart),
            currentPeriodEnd: iso(sub.currentPeriodEnd),
            trialStart: iso(sub.trialStart),
            trialEnd: iso(sub.trialEnd),
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
            canceledAt: iso(sub.canceledAt),
            endedAt: iso(sub.endedAt),
            createdAt: sub.createdAt.toISOString(),
          },
          csv: [
            sub.plan.code,
            sub.plan.name,
            sub.status,
            sub.billingPeriod,
            iso(sub.currentPeriodStart),
            iso(sub.currentPeriodEnd),
            iso(sub.trialStart),
            iso(sub.trialEnd),
            sub.cancelAtPeriodEnd ? "true" : "false",
            iso(sub.canceledAt),
            iso(sub.endedAt),
            sub.createdAt.toISOString(),
          ],
        },
      ],
      truncated: false,
    };
  },

  usage_summary: async (ctx) => {
    // §52 — customer-facing usage facts (the same numbers the Usage page
    // shows). NO provider cost, NO AI rates, NO internal economics.
    const { getUsageSummary } = await import("@/lib/billing/usage");
    const summary = await getUsageSummary(ctx.businessId);
    const rows: ExportRow[] = Object.values(summary.metrics).map((m) => ({
      json: {
        metric: m.metric,
        used: m.used,
        limit: m.limit,
        remaining: m.remaining,
        percentageUsed: m.percentageUsed,
        periodStart: summary.period.start,
        periodEnd: summary.period.end,
      },
      csv: [m.metric, m.used, m.limit, m.remaining, m.percentageUsed, summary.period.start, summary.period.end],
    }));
    return { rows, truncated: false };
  },
};

/** Stable CSV column headers per dataset (machine names, §193). */
export const DATASET_CSV_COLUMNS: Record<ExportDatasetKey, string[]> = {
  business: ["name", "slug", "currency_code", "currency_symbol", "decimal_precision", "locale", "timezone", "created_at"],
  members: ["email", "name", "role", "status", "joined_at"],
  customers: ["id", "name", "phone", "email", "address", "note", "deleted_at", "created_at", "updated_at"],
  suppliers: ["id", "name", "phone", "email", "address", "note", "deleted_at", "created_at", "updated_at"],
  products: ["id", "name", "sku", "unit", "sale_price", "cost_price", "stock_qty", "low_stock_at", "is_active", "deleted_at", "created_at", "updated_at"],
  inventory: ["id", "product_id", "delta", "reason", "created_at"],
  sales: ["id", "number", "customer_id", "subtotal", "discount", "tax", "total", "paid", "status", "issue_date", "note", "deleted_at", "created_at", "updated_at"],
  sale_items: ["id", "sale_id", "product_id", "name", "unit", "qty", "unit_price", "line_total"],
  expenses: ["id", "supplier_id", "category", "amount", "paid", "status", "spent_at", "note", "deleted_at", "created_at", "updated_at"],
  payments: ["id", "sale_id", "expense_id", "direction", "amount", "method", "note", "paid_at", "created_at"],
  crm_leads: ["id", "name", "company_name", "phone", "email", "source", "source_detail", "status", "note", "assigned_to_user_id", "customer_id", "converted_at", "deleted_at", "created_at", "updated_at"],
  crm_opportunities: ["id", "title", "description", "lead_id", "customer_id", "stage", "probability_pct", "expected_value", "currency_code", "expected_close_date", "assigned_to_user_id", "lost_reason", "won_at", "lost_at", "deleted_at", "created_at", "updated_at"],
  crm_activities: ["id", "type", "title", "description", "occurred_at", "duration_minutes", "customer_id", "lead_id", "opportunity_id", "created_by_user_id", "deleted_at", "created_at", "updated_at"],
  crm_tasks: ["id", "title", "description", "status", "priority", "due_at", "completed_at", "reminder_enabled", "reminder_minutes_before", "overdue_alert_enabled", "customer_id", "lead_id", "opportunity_id", "assigned_to_user_id", "created_by_user_id", "deleted_at", "created_at", "updated_at"],
  inventory_stocktakes: ["id", "reference", "status", "count_type", "notes", "created_by_user_id", "started_at", "reviewed_at", "finalized_at", "canceled_at", "created_at", "updated_at"],
  inventory_stocktake_lines: ["id", "stocktake_id", "product_id", "product_name_at_count", "sku_at_count", "unit_at_count", "system_qty_at_count", "counted_qty", "variance_qty", "counted_at", "counted_by_user_id", "created_at", "updated_at"],
  // Prompt 41 (§96) — procurement document fields (snapshots verbatim §236).
  purchase_orders: ["id", "reference", "status", "supplier_id", "supplier_name_at_order", "currency_code_at_order", "currency_symbol_at_order", "decimal_precision_at_order", "ordered_at", "expected_date", "notes", "created_by_user_id", "sent_at", "confirmed_at", "closed_at", "cancelled_at", "created_at", "updated_at"],
  purchase_order_lines: ["id", "purchase_order_id", "product_id", "product_name_at_order", "sku_at_order", "unit_at_order", "ordered_qty", "unit_price_minor", "created_at", "updated_at"],
  inventory_goods_receipts: ["id", "reference", "status", "purchase_order_id", "purchase_order_reference_at_receipt", "supplier_name_at_receipt", "notes", "created_by_user_id", "posted_at", "cancelled_at", "created_at", "updated_at"],
  inventory_goods_receipt_lines: ["id", "goods_receipt_id", "purchase_order_line_id", "product_id", "product_name_at_receipt", "sku_at_receipt", "unit_at_receipt", "received_qty", "created_at", "updated_at"],
  // Prompt 43 (§112) — return datasets: snapshot fields verbatim, NO money
  // columns (a return records quantity only, §104).
  inventory_goods_returns: ["id", "reference", "status", "goods_receipt_id", "goods_receipt_reference_at_return", "purchase_order_reference_at_return", "supplier_name_at_return", "notes", "created_by_user_id", "posted_at", "cancelled_at", "created_at", "updated_at"],
  inventory_goods_return_lines: ["id", "goods_return_id", "goods_receipt_line_id", "product_id", "product_name_at_return", "sku_at_return", "unit_at_return", "returned_qty", "reason_code", "created_at", "updated_at"],
  // Prompt 44 — dispatch datasets: snapshot fields verbatim, NO money
  // columns (a dispatch records quantity only).
  inventory_goods_dispatches: ["id", "reference", "status", "customer_id", "customer_name_at_dispatch", "notes", "created_by_user_id", "posted_at", "cancelled_at", "created_at", "updated_at"],
  inventory_goods_dispatch_lines: ["id", "goods_dispatch_id", "product_id", "product_name_at_dispatch", "sku_at_dispatch", "unit_at_dispatch", "qty", "reason_code", "created_at", "updated_at"],
  // Prompt 45 (§116) — sales-order datasets: historical snapshots verbatim;
  // money columns stay integer minor units (the agreed commercial contract).
  sales_orders: ["id", "reference", "status", "customer_id", "customer_name_at_order", "currency_code_at_order", "currency_symbol_at_order", "decimal_precision_at_order", "order_date", "expected_date", "discount_minor", "notes", "created_by_user_id", "confirmed_at", "completed_at", "cancelled_at", "created_at", "updated_at"],
  sales_order_lines: ["id", "sales_order_id", "product_id", "product_name_at_order", "sku_at_order", "unit_at_order", "ordered_qty", "unit_price_minor", "created_at", "updated_at"],
  // Prompt 47 (§20) — quotation datasets: snapshot fields verbatim; money
  // columns stay integer minor units; NO internalNotes column ever.
  sales_quotations: ["id", "reference", "status", "customer_id", "customer_name_at_quotation", "currency_code_at_quotation", "currency_symbol_at_quotation", "decimal_precision_at_quotation", "quotation_date", "valid_until_date", "expected_delivery_date", "discount_minor", "customer_notes", "created_by_user_id", "sent_at", "accepted_at", "rejected_at", "cancelled_at", "converted_at", "created_at", "updated_at"],
  sales_quotation_lines: ["id", "sales_quotation_id", "product_id", "product_name_at_quotation", "sku_at_quotation", "unit_at_quotation", "qty", "unit_price_minor", "created_at", "updated_at"],
  supplier_bills: ["id", "reference", "supplier_invoice_reference", "supplier_id", "supplier_name_at_bill", "purchase_order_id", "purchase_order_reference_at_bill", "status", "bill_date", "due_date", "currency_code_at_bill", "currency_symbol_at_bill", "decimal_precision_at_bill", "subtotal_minor", "discount_minor", "total_minor", "created_by_user_id", "posted_at", "cancelled_at", "expense_id", "created_at", "updated_at"],
  supplier_bill_lines: ["id", "supplier_bill_id", "purchase_order_line_id", "product_id", "product_name_at_bill", "sku_at_bill", "unit_at_bill", "billed_qty", "unit_price_minor", "purchase_order_unit_price_minor", "line_total_minor", "created_at", "updated_at"],
  subscription_summary: ["plan_code", "plan_name", "status", "billing_period", "current_period_start", "current_period_end", "trial_start", "trial_end", "cancel_at_period_end", "canceled_at", "ended_at", "created_at"],
  usage_summary: ["metric", "used", "limit", "remaining", "percentage_used", "period_start", "period_end"],
};
