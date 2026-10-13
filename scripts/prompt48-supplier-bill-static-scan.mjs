#!/usr/bin/env node
/**
 * Prompt 48 — supplier-bill static security scan.
 *
 * Dependency-free source scan over the P48 Supplier Bills & Accounts Payable
 * surface (domain service, CSV export, zod schemas, 7 API routes, search
 * integration, export catalog, import allowlist, backup/restore probes,
 * shell/sidebar/palette wiring, PO + supplier detail integrations, i18n,
 * entity router, prisma schema + migration, env-repair baseline). Rule
 * classes:
 *   write-transaction serialization law (create/update/lines/post/cancel) ·
 *   strict posting audits (auditStrict: bill.post + expense.create) ·
 *   POSTING PURITY (§11: posting touches nothing else — no stock, no
 *   InventoryAdjustment, no Payment, no Sale) · tenant scope (every
 *   supplier-bill read is businessId-scoped) · NO-CLAMP matching law
 *   (CORRUPT_HISTORY surfaced, never clamped) · Expense exact-equality law
 *   (amountMinor === totals.totalMinor, paidMinor 0, UNPAID) · CSV export
 *   security stack (cap+1 completeness, toCsv OWASP guard, NO internal
 *   notes) · route presence + RBAC + isValidEntityId precheck · strict
 *   client schemas (authority fields structurally absent) · search
 *   closed-vocabulary integration (no notes in snippets) · export catalog
 *   datasets + CSV columns · import remains closed · backup round-trip +
 *   restore drill · shell/sidebar/palette/detail/i18n/entity-router wiring ·
 *   prisma schema + migration (unique expenseId, SET NULL) · env-repair
 *   baseline.
 *
 * Run: node scripts/prompt48-supplier-bill-static-scan.mjs
 */
import { readFileSync, existsSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p) => {
  try {
    return readFileSync(`${ROOT}${p}`, "utf8");
  } catch {
    return "";
  }
};
const exists = (p) => existsSync(`${ROOT}${p}`);

const SERVICE = read("src/lib/supplier-bills/service.ts");
const SCHEMA = read("src/lib/supplier-bills/schema.ts");
const EXPORT = read("src/lib/supplier-bills/export.ts");
const ROUTE_LIST = read("src/app/api/v1/supplier-bills/route.ts");
const ROUTE_ID = read("src/app/api/v1/supplier-bills/[id]/route.ts");
const ROUTE_LINES = read("src/app/api/v1/supplier-bills/[id]/lines/route.ts");
const ROUTE_LINE_ID = read("src/app/api/v1/supplier-bills/[id]/lines/[lineId]/route.ts");
const ROUTE_POST = read("src/app/api/v1/supplier-bills/[id]/post/route.ts");
const ROUTE_CANCEL = read("src/app/api/v1/supplier-bills/[id]/cancel/route.ts");
const ROUTE_EXPORT = read("src/app/api/v1/supplier-bills/[id]/export/route.ts");
const ALL_ROUTES = [ROUTE_LIST, ROUTE_ID, ROUTE_LINES, ROUTE_LINE_ID, ROUTE_POST, ROUTE_CANCEL, ROUTE_EXPORT];
const SEARCH_TYPES = read("src/lib/search/types.ts");
const SEARCH_QUERY = read("src/lib/search/query.ts");
const SEARCH_DTO = read("src/lib/search/dto.ts");
const EXPORT_CATALOG = read("src/lib/data-portability/export-catalog.ts");
const IMPORT_FIELDS = read("src/lib/data-portability/import-fields.ts");
const BACKUP_SCHEMA = read("src/lib/backup-schema.ts");
const RESTORE = read("scripts/restore-drill.mjs");
const SHELL = read("src/modules/shell/app-shell.tsx");
const SIDEBAR = read("src/modules/shell/app-sidebar.tsx");
const PALETTE = read("src/modules/shell/command-palette.tsx");
const SUPPLIER_DETAIL = read("src/modules/entities/supplier-detail-view.tsx");
const PO_DETAIL = read("src/modules/purchase-orders/purchase-order-detail-view.tsx");
const PO_DTO = read("src/lib/purchase-orders/dto.ts");
const ENTITY_ROUTE = read("src/modules/entities/entity-route.ts");
const SEARCH_ICONS = read("src/modules/search/search-icons.ts");
const EN = read("src/i18n/messages/en.ts");
const FA = read("src/i18n/messages/fa.ts");
const PRISMA = read("prisma/schema.prisma");
const MIGRATION = read("prisma/migrations/20261013090000_prompt48_supplier_bills/migration.sql");
const ENV_REPAIR = read("scripts/env-repair.mjs");

/** Strip comments so documentation cannot false-positive code checks. */
const stripComments = (src) => src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

let pass = 0;
let fail = 0;
const failures = [];
function record(name, cond, info = "") {
  if (cond) pass++;
  else fail++, failures.push(`${name}${info ? ` — ${info}` : ""}`);
  console.log(`${cond ? "✓" : "✗"} ${name}`);
}

/* ----------------- 1. write-transaction serialization law ----------------- */
record("1. every mutation flow (create/update/lines×3/post/cancel) runs inside withWriteTx", (() => {
  // The service defines the alias `const withWriteTx = withWriteTransaction`
  // and wraps ALL SEVEN mutation flows (lines are three separate flows).
  const flows = ["createSupplierBill", "updateSupplierBill", "addSupplierBillLine", "updateSupplierBillLine", "removeSupplierBillLine", "postSupplierBill", "cancelSupplierBill"];
  const fnBlock = (name) => SERVICE.split(`export async function ${name}`)[1]?.split("export async function")[0] ?? "";
  return SERVICE.includes("withWriteTransaction") &&
    (SERVICE.match(/withWriteTx\(/g) ?? []).length >= 7 &&
    flows.every((f) => fnBlock(f).includes("withWriteTx("));
})());

/* ----------------------- 2. strict posting audits -------------------------- */
record("2. posting audits are STRICT (bill.post + expense.create) and non-posting flows use audit()", (() => {
  const post = SERVICE.split("export async function postSupplierBill")[1]?.split("export async function")[0] ?? "";
  const strictCount = (SERVICE.match(/auditStrict\(/g) ?? []).length;
  const plainAuditCount = (SERVICE.match(/audit\(/g) ?? []).length;
  return strictCount === 2 && (post.match(/auditStrict\(/g) ?? []).length === 2 && plainAuditCount >= 4;
})());

/* --------------------- 3. posting touches nothing else --------------------- */
record("3. posting NEVER mutates stock/inventory/Payment/Sale/Product (§11 purity)", !stripComments(SERVICE).includes("product.update") && !stripComments(SERVICE).includes("stockQty") && !stripComments(SERVICE).includes("inventoryAdjustment") && !stripComments(SERVICE).includes("payment.create") && !stripComments(SERVICE).includes("sale.create"));

/* ------------------------------ 4. tenant scope ---------------------------- */
record("4. every supplier-bill read is tenant-scoped by businessId (never client input)", (() => {
  // The ONE shared in-tx loader + the entry-point loader both carry the
  // { id, businessId } scope; every supplierBill.findFirst carries businessId.
  const parts = SERVICE.split(/supplierBill\.findFirst\(\{/);
  const allScoped = parts.slice(1).every((p) => {
    const head = p.slice(0, 300);
    const whereEnd = head.indexOf("select");
    return (whereEnd === -1 ? head : head.slice(0, whereEnd)).includes("businessId");
  });
  return SERVICE.includes("where: { id, businessId }") &&
    SERVICE.includes("where: { id: input.id, businessId: input.businessId }") &&
    allScoped &&
    (SERVICE.match(/businessId/g) ?? []).length >= 40;
})());

/* ------------------------- 5. NO-CLAMP matching law ------------------------ */
record("5. three-way matching NEVER clamps: CORRUPT_HISTORY is surfaced instead (§7)", !SERVICE.includes("availableQty = Math.max") && !SERVICE.includes("Math.max(0,") && SERVICE.includes("CORRUPT_HISTORY"));

/* --------------------- 6. Expense exact-equality law ----------------------- */
record("6. posting creates EXACTLY ONE Expense payable with exact-equality fields (§11)", (() => {
  const post = SERVICE.split("export async function postSupplierBill")[1]?.split("export async function")[0] ?? "";
  const createCall = post.split(".expense.create({")[1]?.split("});")[0] ?? "";
  return (post.match(/\.expense\.create\(/g) ?? []).length === 1 &&
    createCall.includes("amountMinor: totals.totalMinor") &&
    createCall.includes("paidMinor: 0") &&
    createCall.includes('status: "UNPAID"') &&
    createCall.includes("supplierId: header.supplierId");
})());

/* --------------------------- 7. CSV export stack --------------------------- */
record("7. export: cap+1 completeness, LINE_CAP_INVARIANT 500, shared toCsv, NO internalNotes", (() => {
  return EXPORT.includes("take: cap + 1") &&
    EXPORT.includes("LINE_CAP_INVARIANT") &&
    EXPORT.includes("toCsv") &&
    !stripComments(EXPORT).includes("internalNotes");
})());

/* ------------------------- 8. route surface + RBAC ------------------------- */
record("8. all 7 API routes exist and every one uses getAuthContext + requirePermission(ctx", ALL_ROUTES.every((r) => r.length > 0) && ALL_ROUTES.every((r) => r.includes("requirePermission(ctx") && r.includes("getAuthContext")));

/* ----------------------- 9. id precheck (no leak) -------------------------- */
record("9. detail/lines/line/post/cancel/export routes guard malformed ids to 404", [ROUTE_ID, ROUTE_LINES, ROUTE_LINE_ID, ROUTE_POST, ROUTE_CANCEL, ROUTE_EXPORT].every((r) => r.includes("isValidEntityId")));

/* ----------------------- 10. strict client schemas ------------------------- */
record("10. create/update/line schemas are .strict() and structurally exclude authority fields", (() => {
  const code = stripComments(SCHEMA);
  const block = (a, b) => code.split(a)[1]?.split(b)[0] ?? "";
  const create = block("export const supplierBillCreateSchema", "export const supplierBillUpdateSchema");
  const update = block("export const supplierBillUpdateSchema", "export const supplierBillLineAddSchema");
  const lineAdd = block("export const supplierBillLineAddSchema", "export const supplierBillLineUpdateSchema");
  const lineUpdate = block("export const supplierBillLineUpdateSchema", "export const supplierBillListQuerySchema");
  const clean = (b) => !b.includes("status:") && !b.includes("totalMinor") && !b.includes("expenseId");
  return (code.match(/\.strict\(/g) ?? []).length >= 4 &&
    !code.includes("expenseId: z") &&
    !code.includes("totalMinor: z") &&
    [create, update, lineAdd, lineUpdate].every(clean);
})());

/* ---------------------------- 11. search integration ----------------------- */
record("11. SUPPLIER_BILL joins the closed search vocabulary with NO notes in snippets (§16)", (() => {
  const queryBlock = SEARCH_QUERY.split("async function searchSupplierBills")[1]?.split("\n/**")[0] ?? "";
  return SEARCH_TYPES.includes('"SUPPLIER_BILL"') &&
    SEARCH_TYPES.includes('"supplier-bills"') &&
    /SUPPLIER_BILL:\s*"supplier-bills"/.test(SEARCH_TYPES) &&
    SEARCH_QUERY.includes("searchSupplierBills") &&
    !queryBlock.includes("internalNotes") &&
    SEARCH_DTO.includes("supplierBillCandidate") &&
    !SEARCH_DTO.includes("internalNotes");
})());

/* ------------------------ 12. export catalog datasets ---------------------- */
record("12. export catalog carries supplier_bills + supplier_bill_lines datasets and CSV columns (no internal notes)", (() => {
  const columns = EXPORT_CATALOG.split("DATASET_CSV_COLUMNS")[1] ?? "";
  const billCols = columns.split("supplier_bills: [")[1]?.split("]")[0] ?? "";
  return (EXPORT_CATALOG.match(/supplier_bills/g) ?? []).length >= 2 &&
    (EXPORT_CATALOG.match(/supplier_bill_lines/g) ?? []).length >= 2 &&
    columns.includes("supplier_bills: [") &&
    columns.includes("supplier_bill_lines: [") &&
    !billCols.includes("internal_notes");
})());

/* -------------------------- 13. import remains closed ---------------------- */
record("13. import allowlist stays EXACTLY [customers, suppliers, products] — bills rejected", (() => {
  const literal = (IMPORT_FIELDS.match(/IMPORT_DATASET_KEYS\s*=\s*\[\s*"customers"\s*,\s*"suppliers"\s*,\s*"products"\s*\]\s*as const/) ?? []).length === 1;
  return literal && !IMPORT_FIELDS.includes("supplier_bill");
})());

/* ----------------------- 14. backup + restore probes ----------------------- */
record("14. backup schema round-trips supplierBills/supplierBillLines (accepted, NOT imported) and restore-drill probes them", (() => {
  return /supplierBills:\s*z\.array\(supplierBillRowSchema\)\.max\([\d_]+\)\.optional\(\)/.test(BACKUP_SCHEMA) &&
    /supplierBillLines:\s*z\.array\(supplierBillLineRowSchema\)\.max\([\d_]+\)\.optional\(\)/.test(BACKUP_SCHEMA) &&
    BACKUP_SCHEMA.includes("supplierBillRowSchema") &&
    BACKUP_SCHEMA.includes("supplierBillLineRowSchema") &&
    RESTORE.includes("SupplierBill") &&
    RESTORE.includes("SupplierBillLine");
})());

/* ------------------------ 15. shell/nav/palette wiring --------------------- */
record("15. shell renders both supplier-bill views; sidebar + command palette expose the module", (() => {
  return SHELL.includes('view.kind === "supplier-bills"') &&
    SHELL.includes('view.kind === "supplier-bill"') &&
    SHELL.includes("SupplierBillsView") &&
    SHELL.includes("SupplierBillDetailView") &&
    SIDEBAR.includes('{ view: { kind: "supplier-bills" }') &&
    SIDEBAR.includes('labelKey: "supplierBills"') &&
    PALETTE.includes('{ view: { kind: "supplier-bills" }') &&
    PALETTE.includes('"supplierBills"');
})());

/* --------------------------- 16. detail integrations ----------------------- */
record("16. supplier 360 + PO detail integrate bills (recentSupplierBills, billing summary, billable facts)", (() => {
  return SUPPLIER_DETAIL.includes("recentSupplierBills") &&
    SUPPLIER_DETAIL.includes('navigate({ kind: "supplier-bill"') &&
    PO_DETAIL.includes("po-billing-summary") &&
    PO_DETAIL.includes("po-recent-bills") &&
    PO_DTO.includes("previouslyBilledQty") &&
    PO_DTO.includes("availableBillableQty");
})());

/* ------------------------------- 17. i18n ---------------------------------- */
record("17. EN/FA both define the supplierBills section, search group and nav label", EN.includes("supplierBills: {") && FA.includes("supplierBills: {") && EN.includes("SUPPLIER_BILL:") && FA.includes("SUPPLIER_BILL:") && EN.includes('supplierBills: "') && FA.includes('supplierBills: "'));

/* ---------------------- 18. entity-router closedness ----------------------- */
record("18. entity deep-link router + search icon cover SUPPLIER_BILL (closed vocabularies)", ENTITY_ROUTE.includes('item.type === "SUPPLIER_BILL"') && ENTITY_ROUTE.includes('"supplier-bill"') && SEARCH_ICONS.includes("SUPPLIER_BILL: ReceiptText"));

/* -------------------------- 19. prisma + migration ------------------------- */
record("19. prisma declares both models; migration creates them with unique expenseId + SET NULL FK", (() => {
  const stripPrisma = stripComments(PRISMA);
  const billModel = stripPrisma.split("model SupplierBill {")[1]?.split("\n}")[0] ?? "";
  return PRISMA.includes("model SupplierBill {") &&
    PRISMA.includes("model SupplierBillLine {") &&
    billModel.includes("expenseId") &&
    MIGRATION.includes("SupplierBill_expenseId_key") &&
    MIGRATION.includes('CREATE TABLE "SupplierBill"') &&
    MIGRATION.includes('CREATE TABLE "SupplierBillLine"') &&
    /SupplierBill_expenseId_fkey"\s+FOREIGN KEY\s+\("expenseId"\)\s+REFERENCES\s+"Expense"\s+\("id"\)\s+ON DELETE SET NULL/.test(MIGRATION);
})());

/* --------------------------- 20. env-repair baseline ----------------------- */
record("20. env-repair baselines the P48 supplier-bills migration", ENV_REPAIR.includes("20261013090000_prompt48_supplier_bills"));

console.log(`\nprompt48-supplier-bill-static-scan: ${pass}/${pass + fail} rules passed`);
if (fail > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
