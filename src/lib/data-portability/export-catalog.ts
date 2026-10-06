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
  sales: ["id", "number", "customer_id", "subtotal", "discount", "total", "paid", "status", "issue_date", "note", "deleted_at", "created_at", "updated_at"],
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
  subscription_summary: ["plan_code", "plan_name", "status", "billing_period", "current_period_start", "current_period_end", "trial_start", "trial_end", "cancel_at_period_end", "canceled_at", "ended_at", "created_at"],
  usage_summary: ["metric", "used", "limit", "remaining", "percentage_used", "period_start", "period_end"],
};
