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
  "subscription_summary",
  "usage_summary",
] as const satisfies readonly ExportDatasetKey[];

/** `sales` always carries its line items (§46 — never flatten relationships). */
export const DATASET_IMPLICATIONS: Partial<Record<ExportDatasetKey, ExportDatasetKey[]>> = {
  sales: ["sale_items"],
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
  subscription_summary: ["plan_code", "plan_name", "status", "billing_period", "current_period_start", "current_period_end", "trial_start", "trial_end", "cancel_at_period_end", "canceled_at", "ended_at", "created_at"],
  usage_summary: ["metric", "used", "limit", "remaining", "percentage_used", "period_start", "period_end"],
};
