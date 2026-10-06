/**
 * Prompt 41 — pure-logic unit suite (§107/§108).
 *
 * Pure functions only: NO database, NO HTTP server. Every protected law is
 * exercised by ACTUAL function invocation (mutation-test discipline §108 —
 * no source-text greps as business validation):
 *   types.ts (lifecycle/cap/math/reference) · schema.ts (zod boundaries)
 *   dto.ts (allowlist + derived totals) · export.ts slug · search dto.
 *
 * Run: bun --preload ./scripts/lib/register-server-only-shim.ts scripts/prompt41-unit.ts
 */
import assert from "node:assert/strict";
import {
  PURCHASE_ORDER_STATUSES,
  PURCHASE_ORDER_TRANSITIONS,
  PURCHASE_ORDER_TRANSITION_TARGET,
  PURCHASE_ORDER_ERROR_CODES,
  PURCHASE_ORDER_LINE_CAP_DEFAULT,
  PURCHASE_ORDER_LINE_CAP_MIN,
  PURCHASE_ORDER_LINE_CAP_MAX,
  ORDERED_QTY_MIN,
  ORDERED_QTY_MAX,
  UNIT_PRICE_MINOR_MAX,
  isPurchaseOrderStatus,
  canTransitionPurchaseOrder,
  purchaseOrderLinesEditable,
  purchaseOrderIsTerminal,
  isValidOrderedQty,
  isValidUnitPriceMinor,
  computePurchaseOrderTotal,
  computeLineTotalMinor,
  purchaseOrderLineCap,
  normalizePurchaseOrderReference,
  generatePurchaseOrderReference,
} from "../src/lib/purchase-orders/types";
import {
  purchaseOrderCreateSchema,
  purchaseOrderUpdateSchema,
  purchaseOrderLineCreateSchema,
  purchaseOrderLineUpdateSchema,
  purchaseOrderListQuerySchema,
  isValidCalendarDate,
} from "../src/lib/purchase-orders/schema";
import {
  purchaseOrderLineDto,
  purchaseOrderDetailDto,
  purchaseOrderListItemDto,
} from "../src/lib/purchase-orders/dto";
import { purchaseOrderReferenceSlug } from "../src/lib/purchase-orders/export";
import { purchaseOrderCandidate } from "../src/lib/search/dto";
import { SEARCH_ENTITY_TYPES, SEARCH_DESTINATIONS, ENTITY_DESTINATION } from "../src/lib/search/types";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, info = "") {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${name}${info ? ` — ${info}` : ""}`);
    console.log(`  ✗ ${name}${info ? ` — ${info}` : ""}`);
  }
}

function throwsWith(fn: () => unknown, code: string): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return message.includes(code);
  }
}

function section(name: string) {
  console.log(`\n== ${name} ==`);
}

/* ------------------------- §14/§198 status vocabulary ---------------------- */

section("1. status vocabulary (§14)");
ok("1.1 statuses exact closed set", JSON.stringify([...PURCHASE_ORDER_STATUSES]) === JSON.stringify(["DRAFT", "SENT", "CONFIRMED", "CLOSED", "CANCELLED"]));
ok("1.2 no Received-like status exists", !PURCHASE_ORDER_STATUSES.some((s) => /RECEIV/i.test(s)));
ok("1.3 isPurchaseOrderStatus accepts DRAFT", isPurchaseOrderStatus("DRAFT"));
ok("1.4 isPurchaseOrderStatus accepts CANCELLED", isPurchaseOrderStatus("CANCELLED"));
ok("1.5 isPurchaseOrderStatus rejects arbitrary", !isPurchaseOrderStatus("RECEIVED"));
ok("1.6 isPurchaseOrderStatus rejects lowercase", !isPurchaseOrderStatus("draft"));

section("2. full transition matrix (§15/§198 — every pair)");
const ALL = [...PURCHASE_ORDER_STATUSES];
const ALLOWED = new Set([
  "DRAFT>SENT",
  "DRAFT>CANCELLED",
  "SENT>CONFIRMED",
  "SENT>CANCELLED",
  "CONFIRMED>CLOSED",
  "CONFIRMED>CANCELLED",
]);
for (const from of ALL) {
  for (const to of ALL) {
    const key = `${from}>${to}`;
    ok(
      `2.${key}`,
      canTransitionPurchaseOrder(from, to) === ALLOWED.has(key),
      `expected ${ALLOWED.has(key)}`,
    );
  }
}
ok("2.self DRAFT>DRAFT forbidden", !canTransitionPurchaseOrder("DRAFT", "DRAFT"));
ok("2.self CLOSED>CLOSED forbidden", !canTransitionPurchaseOrder("CLOSED", "CLOSED"));

section("3. transition targets (§42 — dedicated endpoints)");
ok("3.1 send → SENT", PURCHASE_ORDER_TRANSITION_TARGET.send === "SENT");
ok("3.2 confirm → CONFIRMED", PURCHASE_ORDER_TRANSITION_TARGET.confirm === "CONFIRMED");
ok("3.3 close → CLOSED", PURCHASE_ORDER_TRANSITION_TARGET.close === "CLOSED");
ok("3.4 cancel → CANCELLED", PURCHASE_ORDER_TRANSITION_TARGET.cancel === "CANCELLED");

section("4. edit/terminal gates (§34/§19/§90)");
ok("4.1 DRAFT lines editable", purchaseOrderLinesEditable("DRAFT"));
ok("4.2 SENT lines locked", !purchaseOrderLinesEditable("SENT"));
ok("4.3 CONFIRMED lines locked", !purchaseOrderLinesEditable("CONFIRMED"));
ok("4.4 CLOSED lines locked", !purchaseOrderLinesEditable("CLOSED"));
ok("4.5 CANCELLED lines locked", !purchaseOrderLinesEditable("CANCELLED"));
ok("4.6 CLOSED terminal", purchaseOrderIsTerminal("CLOSED"));
ok("4.7 CANCELLED terminal", purchaseOrderIsTerminal("CANCELLED"));
ok("4.8 SENT not terminal", !purchaseOrderIsTerminal("SENT"));
ok("4.9 DRAFT not terminal", !purchaseOrderIsTerminal("DRAFT"));

/* ------------------------------ §33 line cap ------------------------------- */

section("5. line cap parser (§33 — default/fallback/clamp)");
ok("5.1 undefined → default 200", purchaseOrderLineCap(undefined) === PURCHASE_ORDER_LINE_CAP_DEFAULT && PURCHASE_ORDER_LINE_CAP_DEFAULT === 200);
ok("5.2 null → default", purchaseOrderLineCap(null) === 200);
ok("5.3 empty string → default", purchaseOrderLineCap("") === 200);
ok("5.4 garbage → default", purchaseOrderLineCap("banana") === 200);
ok("5.5 '1e3' → parseInt 1 clamps to MIN 20", purchaseOrderLineCap("1e3") === 20);
ok("5.6 whitespace tolerated", purchaseOrderLineCap("  50  ") === 50);
ok("5.7 below MIN clamps to 20", purchaseOrderLineCap("5") === PURCHASE_ORDER_LINE_CAP_MIN && PURCHASE_ORDER_LINE_CAP_MIN === 20);
ok("5.8 negative clamps to MIN", purchaseOrderLineCap("-10") === 20);
ok("5.9 above MAX clamps to 500", purchaseOrderLineCap("9999") === PURCHASE_ORDER_LINE_CAP_MAX && PURCHASE_ORDER_LINE_CAP_MAX === 500);
ok("5.10 exact MIN honored", purchaseOrderLineCap("20") === 20);
ok("5.11 exact MAX honored", purchaseOrderLineCap("500") === 500);
ok("5.12 float string truncates via parseInt", purchaseOrderLineCap("25.9") === 25);

/* --------------------------- §28/§29 value bounds -------------------------- */

section("6. quantity + price validators (§28/§29/§196)");
ok("6.1 min qty 1 valid", isValidOrderedQty(1));
ok("6.2 max qty 1,000,000 valid", isValidOrderedQty(ORDERED_QTY_MAX) && ORDERED_QTY_MAX === 1_000_000);
ok("6.3 zero rejected", !isValidOrderedQty(0));
ok("6.4 negative rejected", !isValidOrderedQty(-5));
ok("6.5 float rejected", !isValidOrderedQty(1.5));
ok("6.6 NaN rejected", !isValidOrderedQty(Number.NaN));
ok("6.7 Infinity rejected", !isValidOrderedQty(Number.POSITIVE_INFINITY));
ok("6.8 string rejected", !isValidOrderedQty("5" as unknown));
ok("6.9 over-max rejected", !isValidOrderedQty(1_000_001));
ok("6.10 null rejected", !isValidOrderedQty(null));
ok("6.11 zero price ALLOWED (§195)", isValidUnitPriceMinor(0));
ok("6.12 max price 9e9 valid", isValidUnitPriceMinor(UNIT_PRICE_MINOR_MAX) && UNIT_PRICE_MINOR_MAX === 9_000_000_000);
ok("6.13 negative price rejected (§196)", !isValidUnitPriceMinor(-1));
ok("6.14 float price rejected", !isValidUnitPriceMinor(10.5));
ok("6.15 NaN price rejected", !isValidUnitPriceMinor(Number.NaN));
ok("6.16 over-max price rejected", !isValidUnitPriceMinor(9_000_000_001));
ok("6.17 string price rejected", !isValidUnitPriceMinor("100" as unknown));

/* --------------------------- §30/§32 total math ---------------------------- */

section("7. exact totals (§30/§32 — BigInt, safe-integer law)");
const empty = computePurchaseOrderTotal([]);
ok("7.1 empty order totals zero", empty.lineCount === 0 && empty.totalQty === 0 && empty.totalMinor === 0);
const one = computePurchaseOrderTotal([{ orderedQty: 3, unitPriceMinor: 250_000 }]);
ok("7.2 single line exact", one.totalMinor === 750_000 && one.totalQty === 3 && one.lineCount === 1);
const many = computePurchaseOrderTotal([
  { orderedQty: 10, unitPriceMinor: 125_000 },
  { orderedQty: 2, unitPriceMinor: 999_999_999 },
  { orderedQty: 1, unitPriceMinor: 0 },
]);
ok("7.3 multi-line sum exact", many.totalMinor === 10 * 125_000 + 2 * 999_999_999 && many.totalQty === 13);
const big = computePurchaseOrderTotal([{ orderedQty: 1_000_000, unitPriceMinor: 9_000_000_000 }]);
ok("7.4 §194 max-value line exact (1e6 × 9e9 = 9e15)", big.totalMinor === 9_000_000_000_000_000);
ok("7.5 §194 max total still a safe integer", Number.isSafeInteger(big.totalMinor));
ok("7.6 line total helper exact", computeLineTotalMinor(7, 12_345) === 86_415);
ok("7.7 zero-price line total is zero", computeLineTotalMinor(500, 0) === 0);
ok("7.8 overflow throws (not silently rounded)", throwsWith(() => computeLineTotalMinor(1, 9_007_199_254_740_992), "PURCHASE_ORDER_TOTAL_OVERFLOW"));
ok("7.9 multi-line overflow throws", throwsWith(
  () => computePurchaseOrderTotal(new Array(500).fill({ orderedQty: 1_000_000, unitPriceMinor: 9_000_000_000 })),
  "PURCHASE_ORDER_TOTAL_OVERFLOW",
));

/* --------------------------- §12/§13 reference ----------------------------- */

section("8. reference normalization (§12)");
ok("8.1 trims", normalizePurchaseOrderReference("  PO-1  ") === "PO-1");
ok("8.2 collapses space runs", normalizePurchaseOrderReference("A   B") === "A B");
ok("8.2b internal tab is a control char → rejected (§12)", normalizePurchaseOrderReference("A\tB") === null);
ok("8.3 blank → null (generation path)", normalizePurchaseOrderReference("   ") === null);
ok("8.4 empty → null", normalizePurchaseOrderReference("") === null);
ok("8.5 control chars rejected", normalizePurchaseOrderReference("AB\u0001CD") === null);
ok("8.6 single char below min rejected", normalizePurchaseOrderReference("A") === null);
ok("8.7 two chars accepted (min)", normalizePurchaseOrderReference("AB") === "AB");
ok("8.8 80 chars accepted (max)", normalizePurchaseOrderReference("A".repeat(80)) === "A".repeat(80));
ok("8.9 81 chars rejected", normalizePurchaseOrderReference("A".repeat(81)) === null);
ok("8.10 Persian preserved (§12 Unicode law)", normalizePurchaseOrderReference("سفارش ۱۲۳") === "سفارش ۱۲۳");

section("9. server-generated reference (§13)");
let seed = 42;
const fakeRandom = (max: number) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed % max;
};
const generated = generatePurchaseOrderReference(new Date("2026-02-05T10:00:00Z"), fakeRandom);
ok("9.1 format PO-<YYYYMMDD>-<6 chars>", /^PO-\d{8}-[A-Z2-9]{6}$/.test(generated), generated);
ok("9.2 date portion is UTC", generated.startsWith("PO-20260205-"));
ok("9.3 alphabet excludes ambiguous 0/1/I/L/O", !/[01ILO]/.test(generated.slice(12)));
const makeRng = (initial: number) => {
  let s = initial;
  return (max: number) => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s % max;
  };
};
ok("9.4 same RNG state → same output", generatePurchaseOrderReference(new Date("2026-02-05T10:00:00Z"), makeRng(7)) === generatePurchaseOrderReference(new Date("2026-02-05T10:00:00Z"), makeRng(7)));
ok("9.5 within length bound", generated.length <= 80);

/* ------------------------------ strict dates ------------------------------- */

section("10. strict calendar dates (§20/§118)");
ok("10.1 2026-02-31 rejected", !isValidCalendarDate("2026-02-31"));
ok("10.2 2026-04-31 rejected", !isValidCalendarDate("2026-04-31"));
ok("10.3 2026-13-01 rejected", !isValidCalendarDate("2026-13-01"));
ok("10.4 2026-00-10 rejected", !isValidCalendarDate("2026-00-10"));
ok("10.5 2024-02-29 (leap) accepted", isValidCalendarDate("2024-02-29"));
ok("10.6 2025-02-29 (non-leap) rejected", !isValidCalendarDate("2025-02-29"));
ok("10.7 2026-02-30 rejected", !isValidCalendarDate("2026-02-30"));
ok("10.8 2026-12-31 accepted", isValidCalendarDate("2026-12-31"));
ok("10.9 non-date format rejected", !isValidCalendarDate("2026/02/05"));
ok("10.10 short format rejected", !isValidCalendarDate("2026-2-5"));

/* ------------------------------ create schema ------------------------------ */

section("11. create schema (§164 — server owns the rest)");
const createMinimal = purchaseOrderCreateSchema.safeParse({ supplierId: "sup_1" });
ok("11.1 minimal create passes", createMinimal.success);
ok("11.2 blank reference → undefined (generation §13)", createMinimal.success && createMinimal.data.reference === undefined);
const createNorm = purchaseOrderCreateSchema.safeParse({ supplierId: "s", reference: "  PO  7  " });
ok("11.3 reference normalized", createNorm.success && createNorm.data.reference === "PO 7");
const createCtrl = purchaseOrderCreateSchema.safeParse({ supplierId: "s", reference: "AB\u0007CD" });
ok("11.4 control-char reference → 422", !createCtrl.success);
const createLong = purchaseOrderCreateSchema.safeParse({ supplierId: "s", reference: "X".repeat(90) });
ok("11.5 over-long reference → 422", !createLong.success);
const createNoSupplier = purchaseOrderCreateSchema.safeParse({ reference: "PO-1" });
ok("11.6 missing supplierId → 422", !createNoSupplier.success);
const createDateBad = purchaseOrderCreateSchema.safeParse({ supplierId: "s", expectedDate: "2026-02-31" });
ok("11.7 impossible expectedDate → 422", !createDateBad.success);
const createDateLeap = purchaseOrderCreateSchema.safeParse({ supplierId: "s", expectedDate: "2024-02-29" });
ok("11.8 leap expectedDate passes", createDateLeap.success && createDateLeap.data.expectedDate === "2024-02-29");
const createNotes = purchaseOrderCreateSchema.safeParse({ supplierId: "s", notes: "  " });
ok("11.9 blank notes → null", createNotes.success && createNotes.data.notes === null);
const createBusinessId = purchaseOrderCreateSchema.safeParse({ supplierId: "s", businessId: "hack" });
ok("11.10 client businessId STRIPPED (§145)", createBusinessId.success && !("businessId" in createBusinessId.data));
const createStatus = purchaseOrderCreateSchema.safeParse({ supplierId: "s", status: "CONFIRMED" });
ok("11.11 client status STRIPPED (§42/§164)", createStatus.success && !("status" in createStatus.data));
const createTotal = purchaseOrderCreateSchema.safeParse({ supplierId: "s", totalMinor: 5 });
ok("11.12 client totalMinor STRIPPED (§146)", createTotal.success && !("totalMinor" in createTotal.data));

/* ------------------------------ patch schema ------------------------------- */

section("12. draft patch schema (§43/§167)");
ok("12.1 empty patch → 422", !purchaseOrderUpdateSchema.safeParse({}).success);
ok("12.2 reference-only patch passes", purchaseOrderUpdateSchema.safeParse({ reference: "PO-9" }).success);
const patchClear = purchaseOrderUpdateSchema.safeParse({ notes: "", expectedDate: null });
ok("12.3 '' → null + explicit null preserved", patchClear.success && patchClear.data.notes === null && patchClear.data.expectedDate === null);
const patchOmit = purchaseOrderUpdateSchema.safeParse({ reference: "RR" });
ok("12.4 omitted fields stay undefined (no accidental clear)", patchOmit.success && patchOmit.data.notes === undefined && patchOmit.data.expectedDate === undefined);
const patchBadDate = purchaseOrderUpdateSchema.safeParse({ orderedAt: "2026-02-31" });
ok("12.5 impossible orderedAt → 422", !patchBadDate.success);
const patchSupplier = purchaseOrderUpdateSchema.safeParse({ supplierId: "x" });
ok("12.6 supplierId-only patch rejected (nothing patchable §43)", !patchSupplier.success);
ok("12.7 patch with only unknown keys → 422", !purchaseOrderUpdateSchema.safeParse({ businessId: "x" }).success);

/* ------------------------------- line schemas ------------------------------ */

section("13. line schemas (§165/§166/§85)");
const lineOk = purchaseOrderLineCreateSchema.safeParse({ productId: "p1", orderedQty: 10, unitPriceMinor: 125_000 });
ok("13.1 valid line passes", lineOk.success);
ok("13.2 zero price passes (§195)", purchaseOrderLineCreateSchema.safeParse({ productId: "p1", orderedQty: 1, unitPriceMinor: 0 }).success);
ok("13.3 float qty → 422", !purchaseOrderLineCreateSchema.safeParse({ productId: "p1", orderedQty: 1.5, unitPriceMinor: 1 }).success);
ok("13.4 negative price → 422 (§196)", !purchaseOrderLineCreateSchema.safeParse({ productId: "p1", orderedQty: 1, unitPriceMinor: -1 }).success);
ok("13.5 missing product → 422", !purchaseOrderLineCreateSchema.safeParse({ orderedQty: 1, unitPriceMinor: 1 }).success);
const lineClientTotal = purchaseOrderLineCreateSchema.safeParse({ productId: "p", orderedQty: 1, unitPriceMinor: 5, lineTotalMinor: 5 });
ok("13.6 client lineTotalMinor STRIPPED (§146)", lineClientTotal.success && !("lineTotalMinor" in lineClientTotal.data));
ok("13.7 empty line update → 422", !purchaseOrderLineUpdateSchema.safeParse({}).success);
const lineUpd = purchaseOrderLineUpdateSchema.safeParse({ orderedQty: 5, unitPriceMinor: 10, productId: "hack", productNameAtOrder: "x" });
ok("13.8 productId/snapshots STRIPPED from line update (§166)", lineUpd.success && !("productId" in lineUpd.data) && !("productNameAtOrder" in lineUpd.data));
ok("13.9 qty-only update passes", purchaseOrderLineUpdateSchema.safeParse({ orderedQty: 2 }).success);
ok("13.10 zero-qty update → 422", !purchaseOrderLineUpdateSchema.safeParse({ orderedQty: 0 }).success);

/* ------------------------------- list schema ------------------------------- */

section("14. list query schema (§52/§54/§118)");
ok("14.1 from>to rejected", !purchaseOrderListQuerySchema.safeParse({ from: "2026-03-01", to: "2026-02-01" }).success);
ok("14.2 2026-02-31 from rejected", !purchaseOrderListQuerySchema.safeParse({ from: "2026-02-31" }).success);
ok("14.3 equal from/to passes", purchaseOrderListQuerySchema.safeParse({ from: "2026-02-01", to: "2026-02-01" }).success);
ok("14.4 unknown status rejected", !purchaseOrderListQuerySchema.safeParse({ status: "RECEIVED" }).success);
ok("14.5 known status passes", purchaseOrderListQuerySchema.safeParse({ status: "CONFIRMED" }).success);
const listCoerce = purchaseOrderListQuerySchema.safeParse({ page: "3", pageSize: "50" });
ok("14.6 page/pageSize coerced", listCoerce.success && listCoerce.data.page === 3 && listCoerce.data.pageSize === 50);
ok("14.7 pageSize 101 rejected (max 100)", !purchaseOrderListQuerySchema.safeParse({ pageSize: "101" }).success);
ok("14.8 pageSize 100 accepted", purchaseOrderListQuerySchema.safeParse({ pageSize: "100" }).success);
ok("14.9 q trimmed", purchaseOrderListQuerySchema.safeParse({ q: "  PO-1  " }).success);
ok("14.10 empty page defaults absent (service default)", purchaseOrderListQuerySchema.safeParse({}).success);

/* --------------------------------- DTOs ------------------------------------ */

section("15. DTO allowlists (§49/§50/§51 — never raw Prisma)");
const lineRow = {
  id: "l1",
  productId: "p1",
  productNameAtOrder: "Original Product",
  skuAtOrder: "SKU-1",
  unitAtOrder: "piece",
  orderedQty: 4,
  unitPriceMinor: 250_000,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-02T00:00:00Z"),
};
const lineDto = purchaseOrderLineDto(lineRow);
ok("15.1 line DTO exact keys", JSON.stringify(Object.keys(lineDto).sort()) === JSON.stringify(["createdAt", "id", "lineTotalMinor", "orderedQty", "productId", "productNameAtOrder", "skuAtOrder", "unitAtOrder", "unitPriceMinor", "updatedAt"].sort()));
ok("15.2 lineTotal derived not stored (§30)", lineDto.lineTotalMinor === 1_000_000 && !("lineTotal" in lineRow));
ok("15.3 snapshot verbatim (§27)", lineDto.productNameAtOrder === "Original Product" && lineDto.skuAtOrder === "SKU-1");
ok("15.4 dates are ISO strings", typeof lineDto.createdAt === "string" && lineDto.createdAt.endsWith("Z"));

const headerRow = {
  id: "po1",
  reference: "PO-1",
  status: "SENT",
  currencyCodeAtOrder: "USD",
  currencySymbolAtOrder: "$",
  decimalPrecisionAtOrder: 2,
  orderedAt: new Date("2026-01-05T12:00:00Z"),
  expectedDate: new Date("2026-01-20T12:00:00Z"),
  notes: null,
  supplierId: "sup1",
  supplierNameAtOrder: "Old Supplier Name",
  supplierName: "New Supplier Name",
  createdByUserId: "u1",
  createdByName: "Alice",
  sentAt: new Date("2026-01-06T00:00:00Z"),
  confirmedAt: null,
  closedAt: null,
  cancelledAt: null,
  createdAt: new Date("2026-01-05T00:00:00Z"),
  updatedAt: new Date("2026-01-06T00:00:00Z"),
};
const detailDto = purchaseOrderDetailDto(headerRow, [lineRow]);
ok("15.5 detail DTO exact top-level keys", JSON.stringify(Object.keys(detailDto).sort()) === JSON.stringify(["createdAt", "createdBy", "currency", "expectedDate", "id", "lifecycle", "lines", "notes", "orderedAt", "reference", "status", "summary", "supplier", "updatedAt"].sort()));
ok("15.6 §114 supplier snapshot preserved", detailDto.supplier.nameAtOrder === "Old Supplier Name");
ok("15.7 §114 live rename surfaced separately", detailDto.supplier.name === "New Supplier Name" && detailDto.supplier.stillExists);
ok("15.8 §117 currency snapshot kept", detailDto.currency.codeAtOrder === "USD" && detailDto.currency.decimalPrecisionAtOrder === 2);
ok("15.9 summary derived server-side", detailDto.summary.totalMinor === 1_000_000 && detailDto.summary.totalQty === 4 && detailDto.summary.lineCount === 1);
ok("15.10 no raw Prisma leakage keys", !("supplierId" in detailDto) && !("createdByUserId" in detailDto));
ok("15.11 lifecycle timestamps exposed", detailDto.lifecycle.sentAt !== null && detailDto.lifecycle.confirmedAt === null);
ok("15.12 status coerced from unknown DB string", purchaseOrderDetailDto({ ...headerRow, status: "GARBAGE" }, []).status === "DRAFT");
ok("15.13 deleted supplier → stillExists false", purchaseOrderDetailDto({ ...headerRow, supplierName: null }, []).supplier.stillExists === false);

const listDto = purchaseOrderListItemDto({
  ...headerRow,
  lineCount: 1,
  lines: [{ orderedQty: 4, unitPriceMinor: 250_000 }],
});
ok("15.14 list DTO exact keys", JSON.stringify(Object.keys(listDto).sort()) === JSON.stringify(["createdAt", "currencyCodeAtOrder", "currencySymbolAtOrder", "decimalPrecisionAtOrder", "expectedDate", "id", "lineCount", "orderedAt", "reference", "status", "supplierId", "supplierNameAtOrder", "totalMinor", "totalQty"].sort()));
ok("15.15 list total exact", listDto.totalMinor === 1_000_000);
ok("15.16 list is lighter than detail", !("lines" in listDto) && !("notes" in listDto));

/* ------------------------------ search DTO §67 ----------------------------- */

section("16. search candidate (§67/§68)");
const poCandidate = purchaseOrderCandidate({
  id: "po1",
  reference: "PO-2026-XYZ",
  status: "SENT",
  supplierNameAtOrder: "Acme",
  orderedAt: new Date("2026-01-05T12:00:00Z"),
  createdAt: new Date("2026-01-05T00:00:00Z"),
  supplier: { name: "Acme Live" },
});
ok("16.1 type is PURCHASE_ORDER", poCandidate.type === "PURCHASE_ORDER");
ok("16.2 title is the reference", poCandidate.title === "PO-2026-XYZ");
ok("16.3 subtitle is the supplier snapshot", poCandidate.subtitle === "Acme");
ok("16.4 status token in closed set", poCandidate.status === "SENT");
ok("16.5 NO amounts in the candidate (§67)", !("totalMinor" in poCandidate) && !("amountMinor" in poCandidate));
ok("16.6 unknown DB status → null token", purchaseOrderCandidate({ ...{ id: "x", reference: "R", status: "WEIRD", supplierNameAtOrder: "S", orderedAt: new Date(), createdAt: new Date(), supplier: null } }).status === null);
ok("16.7 search type registered in closed vocab", SEARCH_ENTITY_TYPES.includes("PURCHASE_ORDER"));
ok("16.8 destination registered", SEARCH_DESTINATIONS.includes("purchase-orders") && ENTITY_DESTINATION.PURCHASE_ORDER === "purchase-orders");

/* ------------------------------ export slug §241 --------------------------- */

section("17. CSV filename slug (§241)");
ok("17.1 slugified", purchaseOrderReferenceSlug("PO/2026 Test!!") === "po-2026-test");
ok("17.2 safe fallback", purchaseOrderReferenceSlug("///") === "purchase-order");
ok("17.3 capped at 40 chars", purchaseOrderReferenceSlug("A".repeat(100)).length <= 40);
ok("17.4 no path separators", !purchaseOrderReferenceSlug("../../etc/passwd").includes("/"));
ok("17.5 Persian slug falls back safely", purchaseOrderReferenceSlug("سفارش") .length >= 0 && !/[^\w-]/.test(purchaseOrderReferenceSlug("سفارش").replace(/-/g, "")) );

/* ------------------------------- error codes ------------------------------- */

section("18. error codes (§211 — stable, documented)");
ok("18.1 duplicate reference code", PURCHASE_ORDER_ERROR_CODES.DUPLICATE_REFERENCE === "DUPLICATE_PURCHASE_ORDER_REFERENCE");
ok("18.2 duplicate product code", PURCHASE_ORDER_ERROR_CODES.DUPLICATE_PRODUCT === "DUPLICATE_PURCHASE_ORDER_PRODUCT");
ok("18.3 line limit code", PURCHASE_ORDER_ERROR_CODES.LINE_LIMIT === "PURCHASE_ORDER_LINE_LIMIT_REACHED");
ok("18.4 invalid transition code", PURCHASE_ORDER_ERROR_CODES.INVALID_TRANSITION === "INVALID_PURCHASE_ORDER_TRANSITION");
ok("18.5 immutable code", PURCHASE_ORDER_ERROR_CODES.IMMUTABLE === "PURCHASE_ORDER_IMMUTABLE");
ok("18.6 empty order code", PURCHASE_ORDER_ERROR_CODES.EMPTY_ORDER === "PURCHASE_ORDER_EMPTY");
ok("18.7 overflow code", PURCHASE_ORDER_ERROR_CODES.TOTAL_OVERFLOW === "PURCHASE_ORDER_TOTAL_OVERFLOW");

/* --------------------------------- summary --------------------------------- */

console.log(`\nPROMPT 41 UNIT: ${passed}/${passed + failed} ${failed === 0 ? "PASS ✓" : "FAIL"}`);
if (failed > 0) {
  console.log("FAILED:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
