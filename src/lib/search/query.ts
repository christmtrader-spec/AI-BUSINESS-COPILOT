/**
 * Prompt 33 — PrismaSearchProvider (§6/§28).
 *
 * The ONLY database access point of the search subsystem. Bounded by design:
 *   - per-entity candidate cap: SEARCH_PER_ENTITY_TAKE (8) → ≤ 48 rows total
 *   - explicit `select` on every query — never full rows, never N+1
 *   - Promise.all across entity types
 *   - NO raw SQL, NO unbounded findMany/count, NO full-table scans
 *
 * TENANT ISOLATION (§3 — absolute): every WHERE clause contains
 * `businessId` derived server-side from getAuthContext. Soft-deleted rows
 * are excluded with `deletedAt: null` for Customer/Supplier/Product/Sale/
 * Expense/Lead/Opportunity (Payment has no soft delete). The inactive
 * product state is NOT deleted and stays searchable (§20: inactive ≠ deleted).
 */
import "server-only";
import { db } from "@/lib/db";
import { SEARCH_PER_ENTITY_TAKE } from "./schema";
import { purchaseOrderLineCap } from "@/lib/purchase-orders/types";
import { goodsReceiptLineCap } from "@/lib/inventory/goods-receipt/types";
import { goodsDispatchLineCap } from "@/lib/inventory/goods-dispatch/types";
import { salesOrderLineCap } from "@/lib/sales-orders/types";
import { salesQuotationLineCap } from "@/lib/sales-quotations/types";
import { goodsReturnLineCap } from "@/lib/inventory/goods-return/types";
import {
  customerCandidate,
  expenseCandidate,
  goodsReceiptCandidate,
  goodsReturnCandidate,
  goodsDispatchCandidate,
  salesOrderCandidate,
  salesQuotationCandidate,
  leadCandidate,
  opportunityCandidate,
  paymentCandidate,
  productCandidate,
  purchaseOrderCandidate,
  saleCandidate,
  supplierCandidate,
  type ExpenseRow,
  type OpportunityRow,
  type GoodsReceiptSearchRow,
  type GoodsReturnSearchRow,
  type GoodsDispatchSearchRow,
  type SalesOrderSearchRow,
  type SalesQuotationSearchRow,
  type PaymentRow,
  type PurchaseOrderSearchRow,
  type SaleRow,
} from "./dto";
import type { SearchCandidate, SearchEntityType } from "./types";

/** Contains-filter across fields × variants (canonical + Arabic compat). */
function containsAny(variants: string[]): { contains: string }[] {
  return variants.map((v) => ({ contains: v }));
}

async function searchCustomers(
  businessId: string,
  variants: string[],
): Promise<SearchCandidate[]> {
  const rows = await db.customer.findMany({
    where: {
      businessId, // §3 — server-derived tenant scope, never client input
      deletedAt: null,
      OR: [
        ...variants.map((v) => ({ name: { contains: v } })),
        ...variants.map((v) => ({ phone: { contains: v } })),
        ...variants.map((v) => ({ email: { contains: v } })),
      ],
    },
    select: { id: true, name: true, phone: true, email: true, createdAt: true },
    orderBy: { createdAt: "desc" as const },
    take: SEARCH_PER_ENTITY_TAKE,
  });
  return rows.map(customerCandidate);
}

async function searchSuppliers(
  businessId: string,
  variants: string[],
): Promise<SearchCandidate[]> {
  const rows = await db.supplier.findMany({
    where: {
      businessId,
      deletedAt: null,
      OR: [
        ...variants.map((v) => ({ name: { contains: v } })),
        ...variants.map((v) => ({ phone: { contains: v } })),
        ...variants.map((v) => ({ email: { contains: v } })),
      ],
    },
    select: { id: true, name: true, phone: true, email: true, createdAt: true },
    orderBy: { createdAt: "desc" as const },
    take: SEARCH_PER_ENTITY_TAKE,
  });
  return rows.map(supplierCandidate);
}

async function searchProducts(
  businessId: string,
  variants: string[],
): Promise<SearchCandidate[]> {
  const rows = await db.product.findMany({
    where: {
      businessId,
      deletedAt: null,
      // isActive deliberately NOT filtered (§20 — inactive ≠ deleted).
      OR: [
        ...variants.map((v) => ({ name: { contains: v } })),
        ...variants.map((v) => ({ sku: { contains: v } })),
      ],
    },
    select: {
      id: true,
      name: true,
      sku: true,
      isActive: true,
      createdAt: true,
      // §5.3 — costPriceMinor/salePriceMinor are NOT selected, ever.
    },
    orderBy: { createdAt: "desc" as const },
    take: SEARCH_PER_ENTITY_TAKE,
  });
  return rows.map(productCandidate);
}

async function searchSales(
  businessId: string,
  variants: string[],
  numericInvoice: number | null,
): Promise<SearchCandidate[]> {
  const rows = await db.sale.findMany({
    where: {
      businessId,
      deletedAt: null,
      ...(numericInvoice !== null || variants.length > 0
        ? {
            OR: [
              ...(numericInvoice !== null ? [{ number: numericInvoice }] : []),
              ...variants.map((v) => ({ note: { contains: v } })),
              ...variants.map((v) => ({ customer: { is: { name: { contains: v } } } })),
            ],
          }
        : {}),
    },
    select: {
      id: true,
      number: true,
      status: true,
      issueDate: true,
      note: true,
      createdAt: true,
      customer: { select: { name: true } },
      // No totals selected — amounts are out of the search DTO (§5.4).
    },
    orderBy: { createdAt: "desc" as const },
    take: SEARCH_PER_ENTITY_TAKE,
  });
  return rows.map((r) => saleCandidate(r as SaleRow));
}

async function searchExpenses(
  businessId: string,
  variants: string[],
): Promise<SearchCandidate[]> {
  const rows = await db.expense.findMany({
    where: {
      businessId,
      deletedAt: null,
      OR: [
        ...variants.map((v) => ({ category: { contains: v } })),
        ...variants.map((v) => ({ note: { contains: v } })),
        ...variants.map((v) => ({ supplier: { is: { name: { contains: v } } } })),
      ],
    },
    select: {
      id: true,
      category: true,
      status: true,
      spentAt: true,
      note: true,
      createdAt: true,
      supplier: { select: { name: true } },
      // amountMinor NOT selected (§5.5).
    },
    orderBy: { createdAt: "desc" as const },
    take: SEARCH_PER_ENTITY_TAKE,
  });
  return rows.map((r) => expenseCandidate(r as ExpenseRow));
}

async function searchPayments(
  businessId: string,
  variants: string[],
  numericInvoice: number | null,
  localizedLabel: string,
): Promise<SearchCandidate[]> {
  const rows = await db.payment.findMany({
    where: {
      businessId,
      // Payments have no soft delete (§3) — plain businessId scoping.
      OR: [
        ...variants.map((v) => ({ note: { contains: v } })),
        ...variants.map((v) => ({ method: { contains: v } })),
        ...(numericInvoice !== null
          ? [{ sale: { is: { number: numericInvoice } } }]
          : []),
        ...variants.map((v) => ({
          sale: { is: { customer: { is: { name: { contains: v } } } } },
        })),
        ...variants.map((v) => ({ expense: { is: { category: { contains: v } } } })),
        ...variants.map((v) => ({
          expense: { is: { supplier: { is: { name: { contains: v } } } } },
        })),
      ],
    },
    select: {
      id: true,
      direction: true,
      method: true,
      paidAt: true,
      note: true,
      createdAt: true,
      sale: { select: { number: true, customer: { select: { name: true } } } },
      expense: { select: { category: true, supplier: { select: { name: true } } } },
      // No provider/gateway/checkout fields exist on tenant Payment —
      // and nothing beyond the select above is reachable anyway (§42).
    },
    orderBy: { createdAt: "desc" as const },
    take: SEARCH_PER_ENTITY_TAKE,
  });
  return rows.map((r) => paymentCandidate(r as PaymentRow, localizedLabel));
}

/** Prompt 35 (§46) — lead prefilter (name/company/phone/email). */
async function searchLeads(
  businessId: string,
  variants: string[],
): Promise<SearchCandidate[]> {
  const rows = await db.crmLead.findMany({
    where: {
      businessId,
      deletedAt: null,
      OR: [
        ...variants.map((v) => ({ name: { contains: v } })),
        ...variants.map((v) => ({ companyName: { contains: v } })),
        ...variants.map((v) => ({ phone: { contains: v } })),
        ...variants.map((v) => ({ email: { contains: v } })),
        ...variants.map((v) => ({ sourceDetail: { contains: v } })),
      ],
    },
    select: {
      id: true,
      name: true,
      companyName: true,
      phone: true,
      email: true,
      status: true,
      createdAt: true,
      // note is deliberately NOT selected (search privacy policy §5.1/§90).
    },
    orderBy: { createdAt: "desc" as const },
    take: SEARCH_PER_ENTITY_TAKE,
  });
  return rows.map(leadCandidate);
}

/** Prompt 35 (§46) — opportunity prefilter (title/description/relations). */
async function searchOpportunities(
  businessId: string,
  variants: string[],
): Promise<SearchCandidate[]> {
  const rows = await db.crmOpportunity.findMany({
    where: {
      businessId,
      deletedAt: null,
      OR: [
        ...variants.map((v) => ({ title: { contains: v } })),
        ...variants.map((v) => ({ description: { contains: v } })),
        ...variants.map((v) => ({ customer: { is: { name: { contains: v } } } })),
        ...variants.map((v) => ({ lead: { is: { name: { contains: v } } } })),
      ],
    },
    select: {
      id: true,
      title: true,
      description: true,
      stage: true,
      createdAt: true,
      customer: { select: { name: true } },
      lead: { select: { name: true } },
      // expectedValueMinor is a forecast — never searched/selected (§5.5).
    },
    orderBy: { createdAt: "desc" as const },
    take: SEARCH_PER_ENTITY_TAKE,
  });
  return rows.map((r) => opportunityCandidate(r as OpportunityRow));
}

/**
 * Prompt 41 (§67/§68) — purchase-order prefilter: reference, supplier
 * snapshot AND live supplier name, product snapshot names/SKUs. Tenant
 * scope is absolute (§68 — businessId in every WHERE). NO money fields are
 * selected (§67) — search is discovery, never a financial surface.
 * Cancelled/closed orders stay searchable (documents, not state).
 */
async function searchPurchaseOrders(
  businessId: string,
  variants: string[],
): Promise<SearchCandidate[]> {
  const rows = await db.purchaseOrder.findMany({
    where: {
      businessId, // §68 — server-derived tenant scope, never client input
      OR: [
        ...variants.map((v) => ({ reference: { contains: v } })),
        ...variants.map((v) => ({ supplierNameAtOrder: { contains: v } })),
        ...variants.map((v) => ({ supplier: { is: { name: { contains: v } } } })),
        ...variants.map((v) => ({
          lines: {
            some: {
              OR: [
                { productNameAtOrder: { contains: v } },
                { skuAtOrder: { contains: v } },
              ],
            },
          },
        })),
      ],
    },
    select: {
      id: true,
      reference: true,
      status: true,
      supplierNameAtOrder: true,
      orderedAt: true,
      createdAt: true,
      supplier: { select: { name: true } },
      // §57 — line SNAPSHOT TEXT (name/SKU) feeds the ranker's match fields;
      // bounded by the SAME P41 line-cap law (never unbounded). No totals/
      // prices selected — procurement amounts are out of the search DTO
      // by design (§67).
      lines: {
        select: { productNameAtOrder: true, skuAtOrder: true },
        take: purchaseOrderLineCap(process.env.PURCHASE_ORDER_MAX_LINES),
      },
    },
    orderBy: { createdAt: "desc" as const },
    take: SEARCH_PER_ENTITY_TAKE,
  });
  return rows.map((r) => purchaseOrderCandidate(r as PurchaseOrderSearchRow));
}

/**
 * Prompt 42 (§122-§124) — goods-receipt prefilter: receipt reference, PO
 * reference snapshot, supplier snapshot AND product snapshot names/SKUs.
 * Tenant scope is absolute (§123 — businessId in every WHERE). NO money
 * exists in this domain and NO stock quantities are selected (§122).
 * Cancelled/draft receipts stay searchable (documents, not state).
 */
async function searchGoodsReceipts(
  businessId: string,
  variants: string[],
): Promise<SearchCandidate[]> {
  const rows = await db.goodsReceipt.findMany({
    where: {
      businessId, // §123 — server-derived tenant scope, never client input
      OR: [
        ...variants.map((v) => ({ reference: { contains: v } })),
        ...variants.map((v) => ({ purchaseOrderReferenceAtReceipt: { contains: v } })),
        ...variants.map((v) => ({ supplierNameAtReceipt: { contains: v } })),
        ...variants.map((v) => ({
          lines: {
            some: {
              OR: [
                { productNameAtReceipt: { contains: v } },
                { skuAtReceipt: { contains: v } },
              ],
            },
          },
        })),
      ],
    },
    select: {
      id: true,
      reference: true,
      status: true,
      supplierNameAtReceipt: true,
      purchaseOrderReferenceAtReceipt: true,
      createdAt: true,
      // §122 — line SNAPSHOT TEXT (name/SKU) feeds the ranker's match
      // fields; bounded by the SAME P42 line-cap law (never unbounded).
      // No quantities and no money selected.
      lines: {
        select: { productNameAtReceipt: true, skuAtReceipt: true },
        take: goodsReceiptLineCap(process.env.GOODS_RECEIPT_MAX_LINES),
      },
    },
    orderBy: { createdAt: "desc" as const },
    take: SEARCH_PER_ENTITY_TAKE,
  });
  return rows.map((r) => goodsReceiptCandidate(r as GoodsReceiptSearchRow));
}

/**
 * Prompt 43 (§101/§102) — goods-return prefilter: return reference, source
 * receipt reference snapshot, PO reference snapshot, supplier snapshot AND
 * product snapshot names/SKUs. Tenant scope is absolute (§102 — businessId
 * in every WHERE). NO money exists in this domain and NO stock quantities
 * are selected. Draft/cancelled returns stay searchable (documents, not
 * state).
 */
async function searchGoodsReturns(
  businessId: string,
  variants: string[],
): Promise<SearchCandidate[]> {
  const rows = await db.goodsReturn.findMany({
    where: {
      businessId, // §102 — server-derived tenant scope, never client input
      OR: [
        ...variants.map((v) => ({ reference: { contains: v } })),
        ...variants.map((v) => ({ goodsReceiptReferenceAtReturn: { contains: v } })),
        ...variants.map((v) => ({ purchaseOrderReferenceAtReturn: { contains: v } })),
        ...variants.map((v) => ({ supplierNameAtReturn: { contains: v } })),
        ...variants.map((v) => ({
          lines: {
            some: {
              OR: [
                { productNameAtReturn: { contains: v } },
                { skuAtReturn: { contains: v } },
              ],
            },
          },
        })),
      ],
    },
    select: {
      id: true,
      reference: true,
      status: true,
      supplierNameAtReturn: true,
      goodsReceiptReferenceAtReturn: true,
      purchaseOrderReferenceAtReturn: true,
      createdAt: true,
      // §101 — line SNAPSHOT TEXT (name/SKU) feeds the ranker's match
      // fields; bounded by the SAME P43 line-cap law (never unbounded).
      // No quantities and no money selected.
      lines: {
        select: { productNameAtReturn: true, skuAtReturn: true },
        take: goodsReturnLineCap(process.env.GOODS_RETURN_MAX_LINES),
      },
    },
    orderBy: { createdAt: "desc" as const },
    take: SEARCH_PER_ENTITY_TAKE,
  });
  return rows.map((r) => goodsReturnCandidate(r as GoodsReturnSearchRow));
}
/**
 * Prompt 44 — goods-dispatch search. Tenant-scoped at every level; the
 * line-cap law bounds the snapshot text fetch. NO money exists in this
 * domain and NO stock quantities are selected. Draft/cancelled dispatches
 * stay searchable (documents, not state).
 */
async function searchGoodsDispatches(
  businessId: string,
  variants: string[],
): Promise<SearchCandidate[]> {
  const rows = await db.goodsDispatch.findMany({
    where: {
      businessId, // server-derived tenant scope, never client input
      OR: [
        ...variants.map((v) => ({ reference: { contains: v } })),
        ...variants.map((v) => ({ customerNameAtDispatch: { contains: v } })),
        ...variants.map((v) => ({
          lines: {
            some: {
              OR: [
                { productNameAtDispatch: { contains: v } },
                { skuAtDispatch: { contains: v } },
              ],
            },
          },
        })),
      ],
    },
    select: {
      id: true,
      reference: true,
      status: true,
      customerNameAtDispatch: true,
      createdAt: true,
      // Line SNAPSHOT TEXT (name/SKU) feeds the ranker's match fields;
      // bounded by the SAME P44 line-cap law (never unbounded).
      // No quantities and no money selected.
      lines: {
        select: { productNameAtDispatch: true, skuAtDispatch: true },
        take: goodsDispatchLineCap(process.env.GOODS_DISPATCH_MAX_LINES),
      },
    },
    orderBy: { createdAt: "desc" as const },
    take: SEARCH_PER_ENTITY_TAKE,
  });
  return rows.map((r) => goodsDispatchCandidate(r as GoodsDispatchSearchRow));
}

/**
 * Prompt 45 (§70) — sales-order search. Tenant-scoped at every level; the
 * line-cap law bounds the snapshot text fetch. NO amounts and NO
 * fulfillment quantities are selected (discovery only — §70).
 * DRAFT/CANCELLED orders stay searchable (documents, not state).
 */
async function searchSalesOrders(
  businessId: string,
  variants: string[],
): Promise<SearchCandidate[]> {
  const rows = await db.salesOrder.findMany({
    where: {
      businessId, // server-derived tenant scope, never client input
      OR: [
        ...variants.map((v) => ({ reference: { contains: v } })),
        ...variants.map((v) => ({ customerNameAtOrder: { contains: v } })),
        ...variants.map((v) => ({
          lines: {
            some: {
              OR: [
                { productNameAtOrder: { contains: v } },
                { skuAtOrder: { contains: v } },
              ],
            },
          },
        })),
      ],
    },
    select: {
      id: true,
      reference: true,
      status: true,
      customerNameAtOrder: true,
      createdAt: true,
      // Line SNAPSHOT TEXT (name/SKU) feeds the ranker's match fields;
      // bounded by the SAME sales-order line-cap law (never unbounded).
      // No quantities and no money selected.
      lines: {
        select: { productNameAtOrder: true, skuAtOrder: true },
        take: salesOrderLineCap(process.env.SALES_ORDER_MAX_LINES),
      },
    },
    orderBy: { createdAt: "desc" as const },
    take: SEARCH_PER_ENTITY_TAKE,
  });
  return rows.map((r) => salesOrderCandidate(r as SalesOrderSearchRow));
}

/**
 * Prompt 47 — sales-quotation search. Tenant-scoped at every level; the
 * line-cap law bounds the snapshot text fetch. NO amounts and NO notes
 * are selected (discovery only — §18; customerNotes/internalNotes are
 * never indexed §10). All lifecycle states stay searchable (documents,
 * not state) — status tokens are safe-omitted when invalid.
 */
async function searchSalesQuotations(
  businessId: string,
  variants: string[],
): Promise<SearchCandidate[]> {
  const rows = await db.salesQuotation.findMany({
    where: {
      businessId, // server-derived tenant scope, never client input
      OR: [
        ...variants.map((v) => ({ reference: { contains: v } })),
        ...variants.map((v) => ({ customerNameAtQuotation: { contains: v } })),
        ...variants.map((v) => ({
          lines: {
            some: {
              OR: [
                { productNameAtQuotation: { contains: v } },
                { skuAtQuotation: { contains: v } },
              ],
            },
          },
        })),
      ],
    },
    select: {
      id: true,
      reference: true,
      status: true,
      customerNameAtQuotation: true,
      createdAt: true,
      // Line SNAPSHOT TEXT (name/SKU) feeds the ranker's match fields;
      // bounded by the SAME quotation line-cap law (never unbounded).
      // No quantities and no money selected.
      lines: {
        select: { productNameAtQuotation: true, skuAtQuotation: true },
        take: salesQuotationLineCap(process.env.SALES_QUOTATION_MAX_LINES),
      },
    },
    orderBy: { createdAt: "desc" as const },
    take: SEARCH_PER_ENTITY_TAKE,
  });
  return rows.map((r) => salesQuotationCandidate(r as SalesQuotationSearchRow));
}


/**
 * Run all requested entity searches concurrently (§6) and return the
 * combined candidate pool (pre-dedup, pre-rank). Bounded to
 * types.length × SEARCH_PER_ENTITY_TAKE rows.
 */
export async function fetchSearchCandidates(options: {
  businessId: string;
  types: SearchEntityType[];
  variants: string[];
  numericInvoice: number | null;
  paymentLabel: string;
}): Promise<SearchCandidate[]> {
  const { businessId, types, variants, numericInvoice, paymentLabel } = options;
  const tasks: Promise<SearchCandidate[]>[] = [];
  for (const type of types) {
    switch (type) {
      case "CUSTOMER":
        tasks.push(searchCustomers(businessId, variants));
        break;
      case "SUPPLIER":
        tasks.push(searchSuppliers(businessId, variants));
        break;
      case "PRODUCT":
        tasks.push(searchProducts(businessId, variants));
        break;
      case "SALE":
        tasks.push(searchSales(businessId, variants, numericInvoice));
        break;
      case "EXPENSE":
        tasks.push(searchExpenses(businessId, variants));
        break;
      case "PAYMENT":
        tasks.push(searchPayments(businessId, variants, numericInvoice, paymentLabel));
        break;
      case "LEAD":
        tasks.push(searchLeads(businessId, variants));
        break;
      case "OPPORTUNITY":
        tasks.push(searchOpportunities(businessId, variants));
        break;
      case "PURCHASE_ORDER":
        tasks.push(searchPurchaseOrders(businessId, variants));
        break;
      case "GOODS_RECEIPT":
        tasks.push(searchGoodsReceipts(businessId, variants));
        break;
      case "GOODS_RETURN":
        tasks.push(searchGoodsReturns(businessId, variants));
        break;
      case "GOODS_DISPATCH":
        tasks.push(searchGoodsDispatches(businessId, variants));
        break;
      case "SALES_ORDER":
        tasks.push(searchSalesOrders(businessId, variants));
        break;
      case "SALES_QUOTATION":
        tasks.push(searchSalesQuotations(businessId, variants));
        break;
    }
  }
  const settled = await Promise.all(tasks);
  return settled.flat();
}
