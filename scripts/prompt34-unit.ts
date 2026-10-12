/**
 * scripts/prompt34-unit.ts — Prompt 34 §51/§91 unit tests.
 *
 * Pure-logic tests over the entity routing vocabulary, the 360 summary
 * math, the DTO mappers and the query-key isolation. No DB, no HTTP.
 * ≥ 40 meaningful assertions; a failure aborts with exit 1.
 *
 * Run: bun scripts/prompt34-unit.ts
 */
import {
  ENTITY_TYPES,
  ENTITY_ROUTES,
  ENTITY_ID_MAX_LENGTH,
  SEARCH_TYPE_TO_ENTITY,
  isEntityType,
  isValidEntityId,
  parseEntityRoute,
  entityToHash,
} from "../src/lib/entity-routes";
import {
  balanceOf,
  compute360Summary,
  computeSupplierSummary,
  dedupeProductSaleLines,
  stockStateOf,
  toStatusToken,
} from "../src/lib/entities/summary";
import { statusOf } from "../src/lib/money";
import { mapCustomerDetail } from "../src/lib/entities/customer";
import { mapSupplierDetail } from "../src/lib/entities/supplier";
import { mapProductDetail } from "../src/lib/entities/product";
import { mapSaleDetail } from "../src/lib/entities/sale";
import { mapExpenseDetail } from "../src/lib/entities/expense";
import { mapPaymentDetail } from "../src/lib/entities/payment";
import { entityKeys } from "../src/modules/entities/entity-keys";
import type { StatusBucketRow } from "../src/lib/entities/summary";

let passed = 0;
let failed = 0;
function ok(cond: boolean, name: string, info = "") {
  if (cond) {
    passed++;
    console.log(`✓ ${name}`);
  } else {
    failed++;
    console.log(`✗ ${name}${info ? ` — ${info}` : ""}`);
  }
}
function eq(actual: unknown, expected: unknown, name: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, name, a === e ? "" : `expected ${e}, got ${a}`);
}

/* 1 — closed entity vocabulary (§51.1) — Prompt 35 extends to 8 (§123) */
ok(ENTITY_TYPES.length === 8, "v1 vocabulary has exactly 8 entity types (6 + lead + opportunity)");
eq([...ENTITY_TYPES], ["customer", "supplier", "product", "sale", "expense", "payment", "lead", "opportunity"], "v1 vocabulary exact members");
for (const banned of ["user", "business", "audit", "security", "platform_operator", "platform_audit_log", "aicostrecord", "notification", "dataexportjob", "checkoutsession", "chatsession", "mfacredential", "usersession", "securityevent"]) {
  ok(!isEntityType(banned), `v1 "${banned}" NOT routable`);
}

/* 2 — entity route parser: valid routes (§51.2) */
for (const entity of ENTITY_TYPES) {
  const parsed = parseEntityRoute(`${ENTITY_ROUTES[entity].segment}/cmabc123`);
  ok(parsed !== null && parsed.entity === entity && parsed.id === "cmabc123", `v2 parse #/${ENTITY_ROUTES[entity].segment}/<id>`);
}

/* 3 — entity hash encoder + roundtrip (§51.3) */
for (const entity of ENTITY_TYPES) {
  const hash = entityToHash(entity, "cmX_9-z");
  ok(hash !== null && hash.startsWith(`#/${ENTITY_ROUTES[entity].segment}/`), `v3 hash for ${entity}`);
  const roundtrip = parseEntityRoute((hash as string).slice(2));
  ok(roundtrip !== null && roundtrip.entity === entity && roundtrip.id === "cmX_9-z", `v3 roundtrip ${entity}`);
}
eq(entityToHash("customer", "ab/c"), null, "v3 encoder rejects slash id");
eq(entityToHash("customer", ""), null, "v3 encoder rejects empty id");

/* 4 — malformed routes (§51.4) */
eq(parseEntityRoute("customers"), null, "v4 bare segment is NOT a detail route");
eq(parseEntityRoute("customers/"), null, "v4 trailing empty id rejected");
eq(parseEntityRoute("customers/a/b"), null, "v4 third segment rejected");
eq(parseEntityRoute("anything/whatever"), null, "v4 unknown first segment rejected");
eq(parseEntityRoute("users/abc"), null, "v4 user-like segment rejected");
eq(parseEntityRoute("platform/security"), null, "v4 platform path not an entity route");
eq(parseEntityRoute("%zz/customers"), null, "v4 malformed first segment rejected");
eq(parseEntityRoute("customers/%zz"), null, "v4 malformed percent-encoding rejected");

/* 5 — id length bounds (§51.5) */
eq(isValidEntityId("a".repeat(64)), true, "v5 64-char id accepted (hard max)");
eq(isValidEntityId("a".repeat(65)), false, "v5 65-char id rejected");
eq(parseEntityRoute(`customers/${"a".repeat(65)}`), null, "v5 over-long id route rejected");

/* 6 — forbidden characters (§51.6) */
for (const hostile of ["ab/cd", "ab?cd", "ab#cd", "ab cd", "ab%2Fcd-decoded", "ab\tcd", "ab\ncd", "äbc", "абcd", "<script>", "a'b"]) {
  eq(isValidEntityId(hostile), false, `v6 id "${hostile.slice(0, 12)}" rejected`);
}
eq(parseEntityRoute("customers/ab%2Fcd"), null, "v6 percent-encoded slash decodes to rejected id");
ok(isValidEntityId("ab%20cd") === false, "v6 raw percent id rejected (charset)");

/* 7 — entity destination map (§51.7) */
eq(ENTITY_ROUTES.customer, { segment: "customers", api: "/api/v1/customers", labelKey: "customers" }, "v7 customer route def");
eq(ENTITY_ROUTES.payment, { segment: "payments", api: "/api/v1/payments", labelKey: "payments" }, "v7 payment route def");
eq(ENTITY_TYPES.map((e) => ENTITY_ROUTES[e].api), ["/api/v1/customers", "/api/v1/suppliers", "/api/v1/products", "/api/v1/sales", "/api/v1/expenses", "/api/v1/payments", "/api/v1/crm/leads", "/api/v1/crm/opportunities"], "v7 all api bases (P35 extends to 8 — §123)");

/* 8 — customer 360 balance calculation (§51.8) */
{
  const rows: StatusBucketRow[] = [
    { status: "PAID", count: 1, totalMinor: 1000, paidMinor: 1000 },
    { status: "PARTIAL", count: 1, totalMinor: 2000, paidMinor: 1500 },
    { status: "UNPAID", count: 1, totalMinor: 3000, paidMinor: 0 },
  ];
  const s = compute360Summary(rows);
  eq(s.totalSalesMinor, 6000, "v8 totalSales");
  eq(s.paidSalesMinor, 2500, "v8 paid");
  eq(s.receivableMinor, 3500, "v8 receivable = Σ(total − paid)");
  eq(s.invoiceCount, 3, "v8 invoiceCount");
  eq(s.paidInvoiceCount, 1, "v8 paidInvoiceCount");
  eq(s.openInvoiceCount, 2, "v8 openInvoiceCount");
  // statusOf ↔ bucket consistency: the bucketed column is statusOf output
  eq(statusOf(2000, 1500), "PARTIAL", "v8 statusOf(PARTIAL) matches bucketing");
  eq(statusOf(2000, 2000), "PAID", "v8 statusOf(PAID) matches bucketing");
  eq(statusOf(2000, 0), "UNPAID", "v8 statusOf(UNPAID) matches bucketing");
}

/* 9 — supplier payable calculation (§51.9) */
{
  const rows: StatusBucketRow[] = [
    { status: "PAID", count: 2, totalMinor: 500, paidMinor: 500 },
    { status: "PARTIAL", count: 1, totalMinor: 1000, paidMinor: 250 },
  ];
  const s = computeSupplierSummary(rows);
  eq(s.payableMinor, 750, "v9 payable = Σ(amount − paid)");
  eq(s.totalExpensesMinor, 1500, "v9 totalExpenses");
  eq(s.paidExpensesMinor, 750, "v9 paidExpenses");
  eq(s.expenseCount, 3, "v9 expenseCount");
  eq(s.paidExpenseCount, 2, "v9 paidExpenseCount");
  eq(s.openExpenseCount, 1, "v9 openExpenseCount");
}

/* 10 — product stock state (§51.10) */
eq(stockStateOf(0, 5), "OUT_OF_STOCK", "v10 qty 0 → OUT");
eq(stockStateOf(-2, 5), "OUT_OF_STOCK", "v10 negative → OUT (defensive)");
eq(stockStateOf(5, 5), "LOW_STOCK", "v10 qty == threshold → LOW");
eq(stockStateOf(3, 5), "LOW_STOCK", "v10 qty < threshold → LOW");
eq(stockStateOf(6, 5), "HEALTHY", "v10 qty > threshold → HEALTHY");

/* 11 — sale balance calculation (§51.11) */
eq(balanceOf(1000, 400), 600, "v11 sale balance");
eq(balanceOf(1000, 1000), 0, "v11 settled balance is 0");
let threw = false;
try { balanceOf(1.5, 0); } catch { threw = true; }
ok(threw, "v11 non-integer minor units rejected (no floats)");

/* 12 — expense balance calculation (§51.12) */
eq(balanceOf(2500, 2500), 0, "v12 expense settled");
eq(balanceOf(2500, 1000), 1500, "v12 expense outstanding");
// integer money law: 0.1+0.2 style float traps can never enter the DTOs
eq(balanceOf(3, 1), 2, "v12 integer arithmetic only");

/* 13 — payment relationship resolution (§51.13) */
{
  const p = mapPaymentDetail(
    { id: "p1", direction: "IN", amountMinor: 500, method: "CASH", note: null, paidAt: new Date(0), createdAt: new Date(0) },
    { id: "s1", number: 7, customerId: "c1", customerName: "Alice", totalMinor: 1000, paidMinor: 500, status: "PARTIAL" },
    null,
  );
  ok(p.related.sale !== null && p.related.expense === null, "v13 sale payment resolves sale only");
  eq(p.related.sale?.formattedInvoiceNumber, "INV-0007", "v13 formatted invoice number via formatInvoiceNumber semantics");
  eq(p.related.sale?.balanceMinor, 500, "v13 related sale balance");

  const e = mapPaymentDetail(
    { id: "p2", direction: "OUT", amountMinor: 300, method: "BANK_TRANSFER", note: null, paidAt: new Date(0), createdAt: new Date(0) },
    null,
    { id: "e1", category: "Rent", supplierId: "sup1", supplierName: "Acme", amountMinor: 900, paidMinor: 300, status: "PARTIAL" },
  );
  ok(e.related.sale === null && e.related.expense !== null, "v13 expense payment resolves expense only");
}

/* 14 — DTO field allowlist (§51.14) */
{
  const base = new Date("2026-01-02T03:04:05.000Z");
  const cust = mapCustomerDetail(
    { id: "c1", name: "Alice", phone: "+98", email: "a@x.io", address: null, note: null, createdAt: base },
    compute360Summary([{ status: "PAID", count: 1, totalMinor: 10, paidMinor: 10 }]),
    [{ id: "s1", number: 1, issueDate: base, totalMinor: 10, paidMinor: 10, status: "PAID" }],
    [{ id: "p1", amountMinor: 10, method: "CASH", paidAt: base, note: null }],
  );
  // P44/P45/P47 — the DTO grew lawfully: dispatch history (P44), sales-order
  // history (P45 §71) and quotation history (P47 §19). Stale expectation
  // updated to the CURRENT canonical key set (was failing since P44).
  eq(Object.keys(cust), ["customer", "summary", "recentSales", "recentPayments", "recentGoodsDispatches", "recentSalesOrders", "recentSalesQuotations", "crm"], "v14 CustomerDetail top-level keys (P35 crm §123 + P44 dispatches + P45 orders + P47 quotations)");
  eq(Object.keys(cust.customer), ["id", "name", "phone", "email", "address", "note", "createdAt"], "v14 customer sub-object keys");
  eq(cust.customer.createdAt, "2026-01-02T03:04:05.000Z", "v14 dates serialized as ISO");

  const supp = mapSupplierDetail(
    { id: "s1", name: "Acme", phone: null, email: null, address: null, note: null, createdAt: base },
    computeSupplierSummary([]),
    [],
    [],
  );
  // Prompt 41 added the read-only `recentPurchaseOrders` section (≤10, bounded).
  // Prompt 42 (§121) added `recentGoodsReceipts`; Prompt 43 (§100) appends `recentGoodsReturns`.
  eq(Object.keys(supp), ["supplier", "summary", "recentExpenses", "recentPayments", "recentPurchaseOrders", "recentGoodsReceipts", "recentGoodsReturns"], "v14 SupplierDetail top-level keys (P43 §100 adds recentGoodsReturns)");

  const prod = mapProductDetail(
    { id: "pr1", name: "Widget", sku: "W1", unit: "pcs", salePriceMinor: 500, costPriceMinor: 300, stockQty: 9, lowStockAt: 5, isActive: true, createdAt: base, updatedAt: base },
    [{ id: "adj1", delta: 2, reason: "restock", createdAt: base }],
    [{ saleId: "sa1", qty: 1, lineTotalMinor: 500, number: 3, issueDate: base }],
    10,
  );
  // Prompt 41 added the read-only `recentPurchaseOrders` section (≤10, bounded).
  // Prompt 42 (§120) added `recentGoodsReceipts`; Prompt 43 (§99) appends `recentGoodsReturns`.
  // P44/P45/P47 — dispatch lines (P44), order lines (P45 §72) and
  // quotation lines (P47 §19) joined lawfully. Stale expectation updated
  // to the CURRENT canonical key set (was failing since P44).
  eq(Object.keys(prod), ["product", "inventory", "recentAdjustments", "recentSales", "recentStocktakes", "recentPurchaseOrders", "recentGoodsReceipts", "recentGoodsReturns", "recentGoodsDispatches", "recentSalesOrders", "recentSalesQuotations"], "v14 ProductDetail top-level keys (P43 returns + P44 dispatches + P45 orders + P47 quotations)");
  eq(Object.keys(prod.product), ["id", "name", "sku", "unit", "salePriceMinor", "costPriceMinor", "isActive", "createdAt", "updatedAt"], "v14 product sub-object keys");

  const sale = mapSaleDetail(
    { id: "sa1", number: 1, customerId: "c1", customerName: "Alice", issueDate: base, subtotalMinor: 10, discountMinor: 0, totalMinor: 10, paidMinor: 0, status: "UNPAID", note: null, createdAt: base },
    [{ id: "i1", productId: "pr1", name: "Widget", unit: "pcs", qty: 2, unitPriceMinor: 5, lineTotalMinor: 10 }],
    [],
  );
  eq(Object.keys(sale), ["sale", "items", "payments"], "v14 SaleDetail top-level keys");
  eq(sale.sale.balanceMinor, 10, "v14 sale balance derived server-side");

  const exp = mapExpenseDetail(
    { id: "e1", category: "Rent", amountMinor: 900, paidMinor: 0, status: "UNPAID", spentAt: base, dueDate: null, reference: null, note: null, supplierId: null, supplierName: null, createdAt: base },
    [{ id: "p1", amountMinor: 100, method: "CASH", paidAt: base, note: null, actorName: "Zed" }],
  );
  eq(Object.keys(exp), ["expense", "payments"], "v14 ExpenseDetail top-level keys");
}

/* 15 — DTO forbidden-field exclusion (§51.15) */
{
  const forbidden = ["passwordHash", "sessionVersion", "secret", "token", "providerSecret", "webhookSignature", "ip", "userAgent", "aiCost", "providerRate", "businessId", "deletedAt", "actorId", "actorIdHash"];
  const collectKeys = (v: unknown, acc: string[] = []): string[] => {
    if (Array.isArray(v)) { v.forEach((x) => collectKeys(x, acc)); return acc; }
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v)) { acc.push(k); collectKeys(val, acc); }
    }
    return acc;
  };
  const base = new Date(0);
  const everything = [
    collectKeys(mapCustomerDetail({ id: "x", name: "n", phone: null, email: null, address: null, note: null, createdAt: base }, compute360Summary([]), [], [])),
    collectKeys(mapSupplierDetail({ id: "x", name: "n", phone: null, email: null, address: null, note: null, createdAt: base }, computeSupplierSummary([]), [], [])),
    collectKeys(mapProductDetail({ id: "x", name: "n", sku: null, unit: null, salePriceMinor: 1, costPriceMinor: 1, stockQty: 0, lowStockAt: 0, isActive: true, createdAt: base, updatedAt: base }, [], [], 10)),
    collectKeys(mapSaleDetail({ id: "x", number: 1, customerId: null, customerName: null, issueDate: base, subtotalMinor: 0, discountMinor: 0, totalMinor: 0, paidMinor: 0, status: "UNPAID", note: null, createdAt: base }, [], [])),
    collectKeys(mapExpenseDetail({ id: "x", category: "c", amountMinor: 1, paidMinor: 0, status: "UNPAID", spentAt: base, dueDate: null, reference: null, note: null, supplierId: null, supplierName: null, createdAt: base }, [])),
    collectKeys(mapPaymentDetail({ id: "x", direction: "IN", amountMinor: 1, method: "CASH", note: null, paidAt: base, createdAt: base }, null, null)),
  ].flat();
  for (const tok of forbidden) {
    ok(!everything.includes(tok), `v15 forbidden field "${tok}" never in a DTO`);
  }
  ok(!everything.some((k) => k.toLowerCase().includes("business")), "v15 no business-scoping internals leak into DTOs");
}

/* 16 — related-link mapping (§51.16) */
eq(Object.keys(SEARCH_TYPE_TO_ENTITY).length, 8, "v16 search-type map covers 8 types (P35 — §123)");
eq([...ENTITY_TYPES], Object.values(SEARCH_TYPE_TO_ENTITY), "v16 search types map 1:1 onto entity vocabulary");
eq(SEARCH_TYPE_TO_ENTITY.CUSTOMER, "customer", "v16 CUSTOMER → customer");
eq(SEARCH_TYPE_TO_ENTITY.PAYMENT, "payment", "v16 PAYMENT → payment");

/* 17 — query-key business isolation (§51.17) */
{
  const a = entityKeys.one("bizA", "customer", "c1");
  const b = entityKeys.one("bizB", "customer", "c1");
  ok(a[0] !== b[0] || a[1] !== b[1], "v17 keys differ across businesses");
  eq(a, ["entities", "bizA", "customer", "c1"], "v17 key shape includes businessId");
  eq(entityKeys.one(null, "customer", "c1"), ["entities", "none", "customer", "c1"], "v17 null business isolated under 'none'");
}

/* 18 — query-key entity isolation (§51.18) */
{
  const c = entityKeys.one("bizA", "customer", "x1");
  const s = entityKeys.one("bizA", "supplier", "x1");
  ok(JSON.stringify(c) !== JSON.stringify(s), "v18 same id, different entity → different key");
  ok(entityKeys.one("bizA", "sale", "x1").some((k) => k === "sale"), "v18 entity token present in key");
}

/* 19 — deterministic ordering (§51.19) */
{
  const rows = [
    { saleId: "s3", qty: 1, lineTotalMinor: 100, number: 3, issueDate: new Date("2026-03-01") },
    { saleId: "s1", qty: 2, lineTotalMinor: 200, number: 1, issueDate: new Date("2026-01-01") },
    { saleId: "s1", qty: 1, lineTotalMinor: 50, number: 1, issueDate: new Date("2026-01-01") },
    { saleId: "s2", qty: 1, lineTotalMinor: 25, number: 2, issueDate: new Date("2026-02-01") },
  ];
  const out = dedupeProductSaleLines(rows, 10);
  eq(out.length, 3, "v19 duplicate sale collapsed");
  eq(out[0].saleId, "s3", "v19 input order preserved (most-recent-first)");
  eq(out[1].qty, 3, "v19 quantities accumulated per sale");
  eq(out[1].lineTotalMinor, 250, "v19 line totals accumulated (integer)");
  eq(dedupeProductSaleLines(rows, 2).length, 2, "v19 cap applied AFTER dedupe");
  // toStatusToken conservative mapping
  eq(toStatusToken("PARTIAL"), "PARTIAL", "v19 status token passthrough");
  eq(toStatusToken("whatever"), "UNPAID", "v19 unknown status → UNPAID fallback");
}

console.log(`\nprompt34-unit: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
