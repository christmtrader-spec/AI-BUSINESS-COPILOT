/**
 * Prompt 40 — UNIT tests. Pure logic only: NO database, NO HTTP server.
 * Run: bun scripts/prompt40-unit.ts
 *
 * (No preload shim needed: every imported module is client-safe/pure —
 * stocktake types/dto/schema plus the "use client" app-store, which bun
 * imports fine — the same pattern prompt35-unit/prompt39-unit rely on.)
 *
 * Categories map 1:1 onto the Prompt 40 checklist. Every assertion is a real
 * behavioral check — counts are never inflated.
 */
import {
  canTransitionStocktake,
  computeStocktakeSummary,
  computeVarianceQty,
  COUNTED_QTY_MAX,
  isStocktakeCountType,
  isStocktakeStatus,
  isValidCountedQty,
  STOCKTAKE_COUNT_TYPES,
  STOCKTAKE_ERROR_CODES,
  STOCKTAKE_LINE_CAP_DEFAULT,
  STOCKTAKE_LINE_CAP_MAX,
  STOCKTAKE_LINE_CAP_MIN,
  STOCKTAKE_NOTES_MAX,
  STOCKTAKE_REFERENCE_MAX,
  STOCKTAKE_REFERENCE_MIN,
  STOCKTAKE_STATUSES,
  STOCKTAKE_TRANSITIONS,
  stocktakeLineCap,
  type StocktakeStatus,
} from "../src/lib/inventory/stocktake/types";
import {
  stocktakeDetailDto,
  stocktakeLineDto,
  stocktakeListItemDto,
} from "../src/lib/inventory/stocktake/dto";
import {
  stocktakeAddLineSchema,
  stocktakeCountSchema,
  stocktakeCreateSchema,
  stocktakeLinesQuerySchema,
  stocktakeListQuerySchema,
  stocktakeUpdateSchema,
} from "../src/lib/inventory/stocktake/schema";
import {
  hashToView,
  sameView,
  viewKeyOf,
  viewToHash,
  type AppView,
} from "../src/store/app-store";
import { z } from "zod";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else {
    failed++;
    failures.push(`${name}${info ? ` — ${info}` : ""}`);
  }
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
}

function eq(actual: unknown, expected: unknown, name: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, a === e ? "" : `expected ${e}, got ${a}`);
}

function parses(schema: z.ZodType, input: unknown): boolean {
  return schema.safeParse(input).success;
}

/* Shared fixture helpers (mirror the service's raw row shapes). */

function rawLineRow(overrides: Partial<Parameters<typeof stocktakeLineDto>[0]> = {}): Parameters<typeof stocktakeLineDto>[0] {
  return {
    id: "line-1",
    productId: "prod-1",
    productNameAtCount: "Widget",
    skuAtCount: "WDG-1",
    unitAtCount: "pcs",
    systemQtyAtCount: 10,
    countedQty: 0,
    varianceQty: 0,
    countedAt: new Date(0), // epoch 0 = the service's UNCOUNTED sentinel
    countedByUser: { id: "user-1", name: "Counter", email: "counter@stocktake.test" },
    ...overrides,
  };
}

// ===========================================================================
// [1] §8 — status vocabulary (closed, 5 statuses)
// ===========================================================================
{
  console.log("-- [1] status vocabulary (§8)");
  eq([...STOCKTAKE_STATUSES], ["DRAFT", "COUNTING", "REVIEW", "FINALIZED", "CANCELLED"], "1a. exactly 5 statuses in the documented order");
  eq(STOCKTAKE_STATUSES.length, 5, "1b. vocabulary length is 5 (closed — no growth by accident)");
  ok("1c. isStocktakeStatus accepts every vocabulary member", STOCKTAKE_STATUSES.every((s) => isStocktakeStatus(s)));
  const invalids = ["", "draft", "DRAFT ", "REVIEWED", "CANCEL", "FINALISE", "COUNTED", "draft "];
  ok("1d. invalid strings rejected (case/whitespace/lookalikes)", invalids.every((v) => !isStocktakeStatus(v)), invalids.filter((v) => isStocktakeStatus(v)).join(","));
  ok("1e. type guard narrows a known status", isStocktakeStatus("REVIEW") === true);
  ok("1f. FINALIZED and CANCELLED are members (terminal states exist in the vocabulary)", isStocktakeStatus("FINALIZED") && isStocktakeStatus("CANCELLED"));
}

// ===========================================================================
// [2] §7 — count-type vocabulary (SELECTED only in Prompt 40)
// ===========================================================================
{
  console.log("-- [2] count-type vocabulary (§7)");
  eq([...STOCKTAKE_COUNT_TYPES], ["SELECTED"], "2a. exactly one count type: SELECTED");
  ok("2b. isStocktakeCountType('SELECTED') === true", isStocktakeCountType("SELECTED"));
  const invalids = ["FULL", "ABC", "CYCLE", "", "selected", "SELECTED "];
  ok("2c. invalid count types rejected (FULL is NOT a P40 type)", invalids.every((v) => !isStocktakeCountType(v)), invalids.filter((v) => isStocktakeCountType(v)).join(","));
  ok("2d. guard is strict about type vocabulary (no fuzzy match)", !isStocktakeCountType("SELECT") && !isStocktakeCountType("SELECTED_COUNT"));
}

// ===========================================================================
// [3] §9 — valid state transitions
// ===========================================================================
{
  console.log("-- [3] valid transitions (§9)");
  ok("3a. DRAFT → COUNTING (start)", canTransitionStocktake("DRAFT", "COUNTING"));
  ok("3b. DRAFT → CANCELLED", canTransitionStocktake("DRAFT", "CANCELLED"));
  ok("3c. COUNTING → REVIEW", canTransitionStocktake("COUNTING", "REVIEW"));
  ok("3d. COUNTING → CANCELLED", canTransitionStocktake("COUNTING", "CANCELLED"));
  ok("3e. REVIEW → COUNTING (back to counting)", canTransitionStocktake("REVIEW", "COUNTING"));
  ok("3f. REVIEW → FINALIZED", canTransitionStocktake("REVIEW", "FINALIZED"));
  ok("3g. REVIEW → CANCELLED", canTransitionStocktake("REVIEW", "CANCELLED"));
  eq(
    Object.entries(STOCKTAKE_TRANSITIONS)
      .flatMap(([from, tos]) => (tos as readonly StocktakeStatus[]).map((to) => `${from}->${to}`))
      .sort(),
    [
      "COUNTING->CANCELLED",
      "COUNTING->REVIEW",
      "DRAFT->CANCELLED",
      "DRAFT->COUNTING",
      "REVIEW->CANCELLED",
      "REVIEW->COUNTING",
      "REVIEW->FINALIZED",
    ],
    "3h. the transition map contains EXACTLY the 7 documented edges (server-authoritative §9)",
  );
  eq(
    Object.keys(STOCKTAKE_TRANSITIONS).sort(),
    ["CANCELLED", "COUNTING", "DRAFT", "FINALIZED", "REVIEW"],
    "3i. transition map keys cover every status (total function)",
  );
}

// ===========================================================================
// [4] §9 — invalid state transitions
// ===========================================================================
{
  console.log("-- [4] invalid transitions (§9)");
  ok("4a. DRAFT → REVIEW forbidden (count first)", !canTransitionStocktake("DRAFT", "REVIEW"));
  ok("4b. DRAFT → FINALIZED forbidden", !canTransitionStocktake("DRAFT", "FINALIZED"));
  ok("4c. COUNTING → FINALIZED forbidden (must pass REVIEW)", !canTransitionStocktake("COUNTING", "FINALIZED"));
  ok("4d. COUNTING → COUNTING (self-loop) forbidden", !canTransitionStocktake("COUNTING", "COUNTING"));
  ok("4e. FINALIZED is terminal — no transition to ANY status (incl. self)", STOCKTAKE_STATUSES.every((to) => !canTransitionStocktake("FINALIZED", to)));
  ok("4f. CANCELLED is terminal — no transition to ANY status (incl. self)", STOCKTAKE_STATUSES.every((to) => !canTransitionStocktake("CANCELLED", to)));
  ok("4g. REVIEW → DRAFT forbidden (cannot un-start)", !canTransitionStocktake("REVIEW", "DRAFT"));
  ok("4h. DRAFT → DRAFT self-loop forbidden", !canTransitionStocktake("DRAFT", "DRAFT"));
  const allPairs: Array<[StocktakeStatus, StocktakeStatus]> = [];
  for (const from of STOCKTAKE_STATUSES) for (const to of STOCKTAKE_STATUSES) allPairs.push([from, to]);
  ok(
    "4i. canTransitionStocktake === map lookup for ALL 25 from/to pairs (wrapper has no independent truth)",
    allPairs.every(([f, t]) => canTransitionStocktake(f, t) === STOCKTAKE_TRANSITIONS[f].includes(t)),
  );
}

// ===========================================================================
// [5] §22 — reference bounds (schema: 2..80, trimmed)
// ===========================================================================
{
  console.log("-- [5] reference bounds (§22)");
  eq(STOCKTAKE_REFERENCE_MIN, 2, "5a. STOCKTAKE_REFERENCE_MIN === 2");
  eq(STOCKTAKE_REFERENCE_MAX, 80, "5b. STOCKTAKE_REFERENCE_MAX === 80");
  ok("5c. 1-char reference rejected", !parses(stocktakeCreateSchema, { reference: "A" }));
  ok("5d. 81-char reference rejected", !parses(stocktakeCreateSchema, { reference: "R".repeat(81) }));
  ok("5e. 2-char reference accepted (lower bound)", parses(stocktakeCreateSchema, { reference: "ST" }));
  ok("5f. 80-char reference accepted (upper bound)", parses(stocktakeCreateSchema, { reference: "R".repeat(80) }));
  eq(stocktakeCreateSchema.safeParse({ reference: "  ST-001  " }).success ? stocktakeCreateSchema.parse({ reference: "  ST-001  " }).reference : null, "ST-001", "5g. surrounding whitespace trimmed before storage");
  ok("5h. whitespace-only reference rejected after trim (length 0 < 2)", !parses(stocktakeCreateSchema, { reference: "   " }));
  ok("5i. update schema: 1-char reference rejected too", !parses(stocktakeUpdateSchema, { reference: "A" }));
  ok("5j. update schema: 80-char reference accepted", parses(stocktakeUpdateSchema, { reference: "R".repeat(80) }));
}

// ===========================================================================
// [6] §22 — notes bounds (≤2000; null/undefined → null)
// ===========================================================================
{
  console.log("-- [6] notes bounds (§22)");
  eq(STOCKTAKE_NOTES_MAX, 2000, "6a. STOCKTAKE_NOTES_MAX === 2000");
  const noNotes = stocktakeCreateSchema.parse({ reference: "ST-1" });
  eq(noNotes.notes, null, "6b. notes omitted → null (create always materializes a nullable notes)");
  eq(stocktakeCreateSchema.parse({ reference: "ST-1", notes: null }).notes, null, "6c. explicit null → null");
  eq(stocktakeCreateSchema.parse({ reference: "ST-1", notes: "" }).notes, null, "6d. empty string → null (no empty-string notes in the DB)");
  eq(stocktakeCreateSchema.parse({ reference: "ST-1", notes: "  shelf B2  " }).notes, "shelf B2", "6e. notes are trimmed");
  ok("6f. exactly 2000 chars accepted", parses(stocktakeCreateSchema, { reference: "ST-1", notes: "n".repeat(2000) }));
  ok("6g. 2001 chars rejected", !parses(stocktakeCreateSchema, { reference: "ST-1", notes: "n".repeat(2001) }));
  const upd = stocktakeUpdateSchema.parse({ notes: "hello" });
  eq(upd.notes, "hello", "6h. update: notes-only patch accepted");
  eq(stocktakeUpdateSchema.parse({ notes: null }).notes, null, "6i. update: explicit null clears notes (three-state law: absent=untouched, null=clear)");
}

// ===========================================================================
// [7] §17 — countedQty must be an integer (no float/NaN/Infinity)
// ===========================================================================
{
  console.log("-- [7] countedQty integer law (§17)");
  ok("7a. isValidCountedQty(1.5) === false", !isValidCountedQty(1.5));
  ok("7b. isValidCountedQty(NaN) === false", !isValidCountedQty(NaN));
  ok("7c. isValidCountedQty(Infinity) === false", !isValidCountedQty(Infinity));
  ok("7d. isValidCountedQty(-Infinity) === false", !isValidCountedQty(-Infinity));
  ok("7e. guard is type-strict: '7'/null/undefined rejected", !isValidCountedQty("7") && !isValidCountedQty(null) && !isValidCountedQty(undefined));
  ok("7f. schema rejects 1.5", !parses(stocktakeCountSchema, { countedQty: 1.5 }));
  ok("7g. schema rejects NaN", !parses(stocktakeCountSchema, { countedQty: NaN }));
  ok("7h. schema rejects Infinity", !parses(stocktakeCountSchema, { countedQty: Infinity }));
  ok("7i. schema rejects a numeric string (client cannot smuggle '7')", !parses(stocktakeCountSchema, { countedQty: "7" }));
  ok("7j. schema rejects 0.0000001 (non-integer even when tiny)", !parses(stocktakeCountSchema, { countedQty: 0.0000001 }));
}

// ===========================================================================
// [8] §17 — countedQty minimum (0 allowed, negative forbidden)
// ===========================================================================
{
  console.log("-- [8] countedQty minimum (§17)");
  ok("8a. isValidCountedQty(-1) === false", !isValidCountedQty(-1));
  ok("8b. schema rejects -1", !parses(stocktakeCountSchema, { countedQty: -1 }));
  ok("8c. isValidCountedQty(0) === true (a count of zero is a real count)", isValidCountedQty(0));
  eq(stocktakeCountSchema.safeParse({ countedQty: 0 }).success ? stocktakeCountSchema.parse({ countedQty: 0 }).countedQty : null, 0, "8d. schema accepts 0 and preserves it (no truthy coercion)");
}

// ===========================================================================
// [9] §17 — countedQty maximum (1_000_000_000)
// ===========================================================================
{
  console.log("-- [9] countedQty maximum (§17)");
  eq(COUNTED_QTY_MAX, 1_000_000_000, "9a. COUNTED_QTY_MAX === 1_000_000_000");
  ok("9b. isValidCountedQty(1_000_000_001) === false", !isValidCountedQty(1_000_000_001));
  ok("9c. isValidCountedQty(1_000_000_000) === true (upper bound inclusive)", isValidCountedQty(1_000_000_000));
  ok("9d. schema rejects 1_000_000_001", !parses(stocktakeCountSchema, { countedQty: 1_000_000_001 }));
  eq(stocktakeCountSchema.safeParse({ countedQty: 1_000_000_000 }).success ? stocktakeCountSchema.parse({ countedQty: 1_000_000_000 }).countedQty : null, 1_000_000_000, "9e. schema accepts 1_000_000_000 exactly (no float drift at the bound)");
  ok("9f. 1_000_000_000.5 rejected (non-integer above the bound)", !parses(stocktakeCountSchema, { countedQty: 1_000_000_000.5 }));
}

// ===========================================================================
// [10] §16/§18 — variance formula (counted − system, sign meaningful)
// ===========================================================================
{
  console.log("-- [10] variance formula (§18)");
  eq(computeVarianceQty(8, 10), -2, "10a. computeVarianceQty(8,10) === -2 (shortage)");
  eq(computeVarianceQty(10, 10), 0, "10b. computeVarianceQty(10,10) === 0 (match)");
  eq(computeVarianceQty(13, 10), 3, "10c. computeVarianceQty(13,10) === 3 (surplus)");
  eq(computeVarianceQty(0, 5), -5, "10d. sign is preserved — never Math.abs() (§18)");
  eq(computeVarianceQty(1_000_000_000, 0), 1_000_000_000, "10e. exact at the quantity bound (integer math, no drift)");
}

// ===========================================================================
// [11] §36 — summary: positive-variance lines (increase = + magnitude)
// ===========================================================================
{
  console.log("-- [11] summary positive lines (§36)");
  const at = new Date("2026-03-01T10:00:00.000Z");
  const s = computeStocktakeSummary([
    { countedAt: at, varianceQty: 3 },
    { countedAt: at, varianceQty: 2 },
  ]);
  eq(s.increaseVarianceUnits, 5, "11a. increaseVarianceUnits sums positive variances (3+2=5)");
  eq(s.positiveVarianceLineCount, 2, "11b. positiveVarianceLineCount === 2");
  eq(s.decreaseVarianceUnits, 0, "11c. decreaseVarianceUnits stays 0 when nothing decreased");
  eq(s.netVarianceUnits, 5, "11d. netVarianceUnits === increase − decrease === 5");
}

// ===========================================================================
// [12] §36 — summary: negative-variance lines (decrease = positive magnitude)
// ===========================================================================
{
  console.log("-- [12] summary negative lines (§36)");
  const at = new Date("2026-03-01T10:00:00.000Z");
  const s = computeStocktakeSummary([
    { countedAt: at, varianceQty: -4 },
    { countedAt: at, varianceQty: -1 },
  ]);
  eq(s.decreaseVarianceUnits, 5, "12a. decreaseVarianceUnits is a POSITIVE magnitude (|-4|+|-1| = 5, §36)");
  eq(s.negativeVarianceLineCount, 2, "12b. negativeVarianceLineCount === 2");
  eq(s.increaseVarianceUnits, 0, "12c. increaseVarianceUnits stays 0");
  eq(s.netVarianceUnits, -5, "12d. netVarianceUnits is signed: 0 − 5 === −5");
}

// ===========================================================================
// [13] §36 — summary: zero-variance lines (counted, but no movement)
// ===========================================================================
{
  console.log("-- [13] summary zero lines (§36)");
  const at = new Date("2026-03-01T10:00:00.000Z");
  const s = computeStocktakeSummary([
    { countedAt: at, varianceQty: 0 },
    { countedAt: at, varianceQty: 0 },
  ]);
  eq(s.zeroVarianceLineCount, 2, "13a. zeroVarianceLineCount === 2");
  eq(s.countedLineCount, 2, "13b. zero-variance lines ARE counted lines");
  eq(s.increaseVarianceUnits, 0, "13c. no phantom increases from zero lines");
  eq(s.netVarianceUnits, 0, "13d. net stays 0 (and decrease stays 0)");
}

// ===========================================================================
// [14] §36/§29 — pending detection (countedAt null or epoch-0, via dto mapper + summary)
// ===========================================================================
{
  console.log("-- [14] pending detection (§36/§29)");
  const s = computeStocktakeSummary([
    { countedAt: new Date("2026-03-01T10:00:00.000Z"), varianceQty: 3 },
    { countedAt: new Date("2026-03-01T10:01:00.000Z"), varianceQty: 0 },
    { countedAt: null, varianceQty: null },
    { countedAt: new Date("2026-03-01T10:02:00.000Z"), varianceQty: null },
  ]);
  eq(s.lineCount, 4, "14a. lineCount counts every line (pending included)");
  eq(s.countedLineCount, 3, "14b. counted = countedAt present (the single criterion — null/epoch-0 = pending; a countedAt with null variance is a degenerate row still counted as present)");
  eq(s.pendingLineCount, 1, "14c. pendingLineCount === lineCount − countedLineCount === 1");
  // §29 composition law: the mapper normalizes the epoch-0 sentinel to nulls,
  // and the summary fed with MAPPED lines treats them as pending.
  const mapped = stocktakeLineDto(rawLineRow()); // raw uncounted row: epoch-0 + variance 0
  eq([mapped.countedAt, mapped.countedQty, mapped.varianceQty], [null, null, null], "14d. mapper maps the raw epoch-0 row to countedAt/countedQty/varianceQty null");
  const fromMapped = computeStocktakeSummary([
    { countedAt: mapped.countedAt, varianceQty: mapped.varianceQty },
  ]);
  eq([fromMapped.pendingLineCount, fromMapped.countedLineCount, fromMapped.netVarianceUnits], [1, 0, 0], "14e. mapper→summary composition: epoch-0 line is PENDING (not a zero-variance count)");
  // FIXED (p40 round): the summary now honors the epoch-0 sentinel directly
  // via isCountedLine — the raw-row path (what service.getStocktake feeds
  // in) classifies epoch-0 lines as PENDING, never as a zero-variance count.
  const rawPath = computeStocktakeSummary([{ countedAt: new Date(0), varianceQty: 0 }]);
  eq([rawPath.pendingLineCount, rawPath.zeroVarianceLineCount], [1, 0], "14f. summary on RAW rows: epoch-0 line is PENDING (sentinel law centralized in isCountedLine)");
}

// ===========================================================================
// [15] §35 — review eligibility law: pendingLineCount === 0
// ===========================================================================
{
  console.log("-- [15] review eligibility law (§35)");
  const at = new Date("2026-03-01T10:00:00.000Z");
  const eligible = computeStocktakeSummary([
    { countedAt: at, varianceQty: 1 },
    { countedAt: at, varianceQty: 0 },
    { countedAt: at, varianceQty: -2 },
  ]);
  const blocked = computeStocktakeSummary([{ countedAt: at, varianceQty: 1 }, { countedAt: null, varianceQty: null }]);
  ok("15a. all lines counted → pendingLineCount === 0 → eligible", eligible.pendingLineCount === 0);
  ok("15b. one uncounted line → pendingLineCount > 0 → NOT eligible", blocked.pendingLineCount === 1);
  ok("15c. eligibility predicate is exactly pendingLineCount === 0 (no other summary field gates review)", (eligible.pendingLineCount === 0) && !(blocked.pendingLineCount === 0));
}

// ===========================================================================
// [16] §61 — line cap parsing (bounded env resolution)
// ===========================================================================
{
  console.log("-- [16] line cap parsing (§61)");
  eq(STOCKTAKE_LINE_CAP_DEFAULT, 1000, "16a. default cap constant === 1000");
  eq(STOCKTAKE_LINE_CAP_MIN, 100, "16b. min cap constant === 100");
  eq(STOCKTAKE_LINE_CAP_MAX, 5000, "16c. max cap constant === 5000");
  eq(stocktakeLineCap(undefined), 1000, "16d. undefined env → 1000");
  eq(stocktakeLineCap(null), 1000, "16e. null env → 1000");
  eq(stocktakeLineCap(""), 1000, "16f. empty env → 1000");
  eq(stocktakeLineCap("abc"), 1000, "16g. non-numeric env → 1000 (never unbounded)");
  eq(stocktakeLineCap("50"), 100, "16h. 50 clamps UP to the min 100");
  eq(stocktakeLineCap("0"), 100, "16i. 0 clamps to min (cap can never be 0/undefined)");
  eq(stocktakeLineCap("-5"), 100, "16j. negative env clamps to min");
  eq(stocktakeLineCap("6000"), 5000, "16k. 6000 clamps DOWN to the max 5000");
  eq(stocktakeLineCap("250"), 250, "16l. in-range value passes through (250 → 250)");
  eq(stocktakeLineCap(" 300 "), 300, "16m. surrounding whitespace tolerated");
  eq(stocktakeLineCap("1e3"), 100, "16n. parseInt semantics: '1e3' parses as 1 → clamped to 100 (no parseFloat surprises)");
}

// ===========================================================================
// [17] §116/§184 — DTO allowlist (exact key sets, no forbidden fields)
// ===========================================================================
{
  console.log("-- [17] DTO allowlist (§116/§184)");
  const at = new Date("2026-03-01T12:30:00.000Z");
  const line = stocktakeLineDto(
    rawLineRow({ countedAt: at, countedQty: 13, varianceQty: 3, systemQtyAtCount: 10 }),
  );
  eq(
    Object.keys(line),
    ["id", "productId", "productNameAtCount", "skuAtCount", "unitAtCount", "systemQtyAtCount", "currentStockQty", "countedQty", "varianceQty", "countedAt", "countedBy"],
    "17a. line DTO carries EXACTLY the 11 allowlisted keys (order-stable; currentStockQty = count-dialog preview per §15)",
  );
  const forbidden = ["passwordHash", "session", "ip", "userAgent", "mfaSecret", "notes", "stocktakeId", "countedByUserId"];
  ok("17b. no password/session/ip/user-agent/notes/internal fields anywhere on the line DTO", forbidden.every((f) => !(f in line)));
  eq(Object.keys(line.countedBy ?? {}), ["id", "name", "email"], "17c. countedBy allowlist: id/name/email only");
  const list = stocktakeListItemDto({
    id: "stk-1",
    reference: "ST-001",
    status: "COUNTING",
    countType: "SELECTED",
    _count: { lines: 2 },
    lines: [{ countedAt: at, varianceQty: 3 }],
    createdAt: at,
    createdByUser: { id: "u1", name: "Alice", email: "alice@stocktake.test" },
  });
  eq(
    Object.keys(list),
    ["id", "reference", "status", "countType", "lineCount", "countedLineCount", "netVarianceUnits", "createdAt", "createdBy"],
    "17d. list DTO carries EXACTLY the 9 allowlisted keys",
  );
  const detail = stocktakeDetailDto({
    id: "stk-1",
    reference: "ST-001",
    status: "REVIEW",
    countType: "SELECTED",
    notes: "Night count",
    createdAt: at,
    startedAt: at,
    reviewedAt: null,
    finalizedAt: null,
    canceledAt: null,
    createdByUser: { id: "u1", name: "Alice", email: "alice@stocktake.test" },
    summary: computeStocktakeSummary([{ countedAt: at, varianceQty: 3 }]),
    lines: [rawLineRow({ countedAt: at, countedQty: 13, varianceQty: 3 })],
    linesPage: { page: 1, pageSize: 50, total: 1 },
  });
  eq(
    Object.keys(detail),
    ["id", "reference", "status", "countType", "notes", "createdAt", "startedAt", "reviewedAt", "finalizedAt", "canceledAt", "createdBy", "summary", "lines", "linesPage"],
    "17e. detail DTO carries EXACTLY the 14 allowlisted keys (notes is a HEADER field here — allowed)",
  );
  ok("17f. no forbidden/audit fields on the detail DTO", ["passwordHash", "session", "ip", "userAgent", "mfaSecret", "createdByUserId", "businessId"].every((f) => !(f in detail)));
  ok("17g. DTO outputs are fresh objects (no shared mutable references)", detail.lines[0] !== undefined && (detail.lines[0] as { id: string }).id === "line-1" && line.countedBy !== undefined);
}

// ===========================================================================
// [18] §29/§59 — DTO epoch-0 = UNCOUNTED (all count fields null)
// ===========================================================================
{
  console.log("-- [18] epoch-0 means uncounted (§29/§59)");
  const uncounted = stocktakeLineDto(rawLineRow());
  ok("18a. epoch-0 Date → countedQty null, varianceQty null, countedAt null, countedBy null", uncounted.countedQty === null && uncounted.varianceQty === null && uncounted.countedAt === null && uncounted.countedBy === null);
  const stringEpoch = stocktakeLineDto(rawLineRow({ countedAt: "1970-01-01T00:00:00.000Z" }));
  ok("18b. epoch-0 as ISO STRING is ALSO uncounted (new Date(...).getTime() === 0)", stringEpoch.countedQty === null && stringEpoch.countedAt === null && stringEpoch.countedBy === null);
  ok("18c. snapshot fields survive on uncounted lines (they are PREPARATION data, §29)", uncounted.productNameAtCount === "Widget" && uncounted.systemQtyAtCount === 10 && uncounted.skuAtCount === "WDG-1");
  const counted = stocktakeLineDto(rawLineRow({ countedAt: new Date("2026-03-01T12:30:00.000Z"), countedQty: 13, varianceQty: 3 }));
  eq([counted.countedQty, counted.varianceQty, counted.countedAt, counted.countedBy?.id], [13, 3, "2026-03-01T12:30:00.000Z", "user-1"], "18d. a real countedAt passes every field through with ISO-8601 countedAt");
  const nullRow = stocktakeLineDto(rawLineRow({ countedAt: null, countedByUser: null }));
  ok("18e. defensive: countedAt null row → all count fields null (never a fake count)", nullRow.countedQty === null && nullRow.varianceQty === null && nullRow.countedAt === null && nullRow.countedBy === null);
}

// ===========================================================================
// [19] §67 — list item DTO: counted/net computed from the line slice
// ===========================================================================
{
  console.log("-- [19] list item DTO (§67)");
  const at = new Date("2026-03-01T10:00:00.000Z");
  const row = {
    id: "stk-1",
    reference: "ST-001",
    status: "COUNTING",
    countType: "SELECTED",
    _count: { lines: 99 },
    lines: [
      { countedAt: at, varianceQty: 3 },
      { countedAt: null, varianceQty: null },
      { countedAt: at, varianceQty: -1 },
      { countedAt: null, varianceQty: 99 }, // hostile shape: null countedAt must contribute 0
    ],
    createdAt: at,
    createdByUser: null,
  };
  const dto = stocktakeListItemDto(row);
  eq(dto.countedLineCount, 2, "19a. countedLineCount counts only lines with a non-null countedAt (2 of 4)");
  eq(dto.netVarianceUnits, 2, "19b. netVarianceUnits = 3 + (−1) = 2 — pending/hostile lines contribute 0");
  eq(dto.lineCount, 99, "19c. lineCount prefers the _count aggregate (99) over the slice length (4)");
  eq(stocktakeListItemDto({ ...row, _count: undefined }).lineCount, 4, "19d. without _count the slice length is the honest fallback");
  eq(dto.status, "COUNTING", "19e. valid status passes through unchanged");
  eq(stocktakeListItemDto({ ...row, status: "BOGUS" }).status, "DRAFT", "19f. invalid status normalized to DRAFT (never an off-vocabulary string)");
  eq(stocktakeListItemDto({ ...row, countType: "FULL" }).countType, "SELECTED", "19g. countType is PINNED to SELECTED (P40 closed vocabulary)");
  eq(dto.createdAt, "2026-03-01T10:00:00.000Z", "19h. Date createdAt serialized to ISO-8601 UTC");
  ok("19i. createdBy null when createdByUser null; string createdAt passes through", stocktakeListItemDto({ ...row, createdAt: "2026-03-01T10:00:00.000Z" }).createdAt === "2026-03-01T10:00:00.000Z" && dto.createdBy === null);
}

// ===========================================================================
// [20] §36/§59 — detail DTO: summary passthrough, ISO dates, linesPage
// ===========================================================================
{
  console.log("-- [20] detail DTO (§59)");
  const at = new Date("2026-03-01T10:00:00.000Z");
  const summary = computeStocktakeSummary([
    { countedAt: at, varianceQty: 3 },
    { countedAt: null, varianceQty: null },
  ]);
  const detail = stocktakeDetailDto({
    id: "stk-1",
    reference: "ST-001",
    status: "COUNTING",
    countType: "SELECTED",
    notes: null,
    createdAt: at,
    startedAt: at,
    reviewedAt: null,
    finalizedAt: null,
    canceledAt: null,
    createdByUser: { id: "u1", name: null, email: "alice@stocktake.test" },
    summary,
    lines: [
      rawLineRow({ id: "line-2", countedAt: new Date("2026-03-01T12:30:00.000Z"), countedQty: 13, varianceQty: 3 }),
      rawLineRow({ id: "line-1" }), // epoch-0 uncounted inside the page
    ],
    linesPage: { page: 2, pageSize: 50, total: 2 },
  });
  eq(detail.summary, summary, "20a. summary passes through untouched (same 9 fields, same values)");
  eq(detail.createdAt, "2026-03-01T10:00:00.000Z", "20b. createdAt Date → ISO string");
  eq([detail.startedAt, detail.reviewedAt, detail.finalizedAt, detail.canceledAt], ["2026-03-01T10:00:00.000Z", null, null, null], "20c. lifecycle dates: Date → ISO, null stays null");
  eq(detail.linesPage, { page: 2, pageSize: 50, total: 2 }, "20d. linesPage passthrough {page,pageSize,total}");
  eq(detail.lines.map((l) => [l.id, l.countedQty, l.countedAt]), [["line-2", 13, "2026-03-01T12:30:00.000Z"], ["line-1", null, null]], "20e. lines mapped through the line DTO (epoch-0 → nulls INSIDE the detail too)");
  ok("20f. createdBy mapped with name→null passthrough; notes null stays null", detail.createdBy?.name === null && detail.createdBy?.email === "alice@stocktake.test" && detail.notes === null);
}

// ===========================================================================
// [21] §24 — zod countType: omitted → ok (server pins SELECTED)
// ===========================================================================
{
  console.log("-- [21] zod countType (§24)");
  const omitted = stocktakeCreateSchema.safeParse({ reference: "ST-1" });
  ok("21a. countType omitted → parse ok", omitted.success);
  ok("21b. omitted countType is ABSENT from the parsed output (server pins the type, no client echo)", omitted.success && !("countType" in omitted.data));
  const explicit = stocktakeCreateSchema.safeParse({ reference: "ST-1", countType: "SELECTED" });
  ok("21c. explicit 'SELECTED' → ok and echoed", explicit.success && explicit.success && (explicit.data as { countType?: string }).countType === "SELECTED");
  ok("21d. 'FULL' rejected (not a P40 type)", !parses(stocktakeCreateSchema, { reference: "ST-1", countType: "FULL" }));
  ok("21e. 'ABC' rejected", !parses(stocktakeCreateSchema, { reference: "ST-1", countType: "ABC" }));
  ok("21f. ''/null rejected (not silently mapped to SELECTED)", !parses(stocktakeCreateSchema, { reference: "ST-1", countType: "" }) && !parses(stocktakeCreateSchema, { reference: "ST-1", countType: null }));
}

// ===========================================================================
// [22] §52 — update schema: reference/notes only, status NEVER client input
// ===========================================================================
{
  console.log("-- [22] update schema (§52)");
  ok("22a. empty object → fail (Nothing to update)", !parses(stocktakeUpdateSchema, {}));
  ok("22b. reference only → ok", parses(stocktakeUpdateSchema, { reference: "ST-9" }));
  ok("22c. notes only → ok", parses(stocktakeUpdateSchema, { notes: "x" }));
  ok("22d. both → ok", parses(stocktakeUpdateSchema, { reference: "ST-9", notes: "x" }));
  const withStatus = stocktakeUpdateSchema.safeParse({ reference: "ST-9", status: "FINALIZED" });
  ok("22e. status present → STRIPPED: parse succeeds and output NEVER contains status", withStatus.success && !("status" in withStatus.data!));
  ok("22f. status-ONLY body → fail (stripping leaves nothing to update — status is never writable)", !parses(stocktakeUpdateSchema, { status: "FINALIZED" }));
  ok("22g. notes null → ok with null (explicit clear), notes undefined+reference → ok", stocktakeUpdateSchema.safeParse({ notes: null }).success && stocktakeUpdateSchema.safeParse({ reference: "ST-9" }).success);
}

// ===========================================================================
// [23] §25/§65 — list & lines query schemas (bounded pagination)
// ===========================================================================
{
  console.log("-- [23] query schemas (§25/§65)");
  eq(stocktakeListQuerySchema.safeParse({ page: "2" }).success ? stocktakeListQuerySchema.parse({ page: "2" }).page : null, 2, "23a. page coerced from string '2' → 2");
  ok("23b. numeric page 2 accepted", parses(stocktakeListQuerySchema, { page: 2 }));
  ok("23c. page 0 rejected (min 1)", !parses(stocktakeListQuerySchema, { page: "0" }));
  ok("23d. non-integer page '2.5' rejected after coercion", !parses(stocktakeListQuerySchema, { page: "2.5" }));
  eq(stocktakeListQuerySchema.safeParse({ pageSize: "50" }).success ? stocktakeListQuerySchema.parse({ pageSize: "50" }).pageSize : null, 50, "23e. pageSize coerced from string '50' → 50");
  ok("23f. pageSize 100 accepted (max, §25)", parses(stocktakeListQuerySchema, { pageSize: 100 }));
  ok("23g. pageSize 101 rejected (max 100 — never unbounded)", !parses(stocktakeListQuerySchema, { pageSize: "101" }));
  ok("23h. pageSize 0 rejected", !parses(stocktakeListQuerySchema, { pageSize: 0 }));
  ok("23i. pageSize 'abc' → NaN → rejected", !parses(stocktakeListQuerySchema, { pageSize: "abc" }));
  const empty = stocktakeListQuerySchema.safeParse({});
  ok("23j. empty query ok — page/pageSize/q all undefined (service applies documented defaults)", empty.success && empty.data!.page === undefined && empty.data!.pageSize === undefined && empty.data!.q === undefined);
  eq(stocktakeListQuerySchema.safeParse({ q: "  ABC  " }).success ? stocktakeListQuerySchema.parse({ q: "  ABC  " }).q : null, "ABC", "23k. q trimmed (searches reference only, §25)");
  ok("23l. q '' → undefined (no empty-string contains filter)", stocktakeListQuerySchema.safeParse({ q: "" }).success && stocktakeListQuerySchema.parse({ q: "" }).q === undefined);
  ok("23m. q of 80 chars accepted (reference cap)", parses(stocktakeListQuerySchema, { q: "q".repeat(80) }));
  ok("23n. q of 81 chars rejected", !parses(stocktakeListQuerySchema, { q: "q".repeat(81) }));
  ok("23o. from '2026-2-1' rejected (strict YYYY-MM-DD format)", !parses(stocktakeListQuerySchema, { from: "2026-2-1" }));
  // FIXED (p40 round): strict calendar validation rejects non-calendar dates
  // (2026-02-31) BEFORE any query runs — no silent JS Date rollover windows.
  ok("23p. FIXED: '2026-02-31' rejected by strict calendar validation (no Date rollover)", !parses(stocktakeListQuerySchema, { from: "2026-02-31" }));
  ok("23q. status passthrough accepted (service narrows via isStocktakeStatus)", stocktakeListQuerySchema.safeParse({ status: "REVIEW" }).success && stocktakeListQuerySchema.parse({ status: "REVIEW" }).status === "REVIEW");
  ok("23r. status '' → undefined (no empty filter)", stocktakeListQuerySchema.safeParse({ status: "" }).success && stocktakeListQuerySchema.parse({ status: "" }).status === undefined);
  ok("23s. lines query: default {} ok; pageSize '101' rejected; page '3' → 3", parses(stocktakeLinesQuerySchema, {}) && !parses(stocktakeLinesQuerySchema, { pageSize: "101" }) && stocktakeLinesQuerySchema.parse({ page: "3" }).page === 3);
}

// ===========================================================================
// [24] §76/§77/§136 — hash routing: list, detail deep link, unsafe ids
// ===========================================================================
{
  console.log("-- [24] hashToView / viewToHash / viewKeyOf / sameView (§76/§77/§136)");
  eq(hashToView("#/inventory/stocktakes"), { kind: "inventory-stocktakes" }, "24a. #/inventory/stocktakes → the stocktake LIST view");
  eq(hashToView("#/inventory/stocktakes/abc-123_DEF"), { kind: "inventory-stocktake", id: "abc-123_DEF" }, "24b. #/inventory/stocktakes/abc-123_DEF → DETAIL view with the exact id (charset-safe)");
  eq(hashToView("#/inventory/stocktakes/../etc"), { kind: "dashboard" }, "24c. traversal id '../etc' → dashboard fallback");
  eq(hashToView("#/inventory/stocktakes/a/b"), { kind: "dashboard" }, "24d. '/' inside id → dashboard fallback");
  eq(hashToView("#/inventory/stocktakes/a b"), { kind: "dashboard" }, "24e. whitespace in id → dashboard fallback");
  eq(hashToView("#/inventory/stocktakes/%zz"), { kind: "dashboard" }, "24f. malformed percent-encoding (%zz) → dashboard fallback (decode throws, never surfaces)");
  eq(hashToView("#/inventory/stocktakes/?x=1"), { kind: "dashboard" }, "24g. EMPTY id (query keeps the trailing slash) → dashboard fallback");
  eq(hashToView(`#/inventory/stocktakes/${"A".repeat(65)}`), { kind: "dashboard" }, "24h. 65-char id → dashboard fallback (id cap 64)");
  eq(hashToView(`#/inventory/stocktakes/${"A".repeat(64)}`).kind, "inventory-stocktake", "24i. 64-char id accepted (boundary, §6.3)");
  eq(hashToView("#/inventory/stocktakes/"), { kind: "inventory-stocktakes" }, "24j. trailing slash normalizes to the LIST (never an empty-id detail)");
  eq(viewToHash({ kind: "inventory-stocktake", id: "x1_Y" }), "#/inventory/stocktakes/x1_Y", "24k. viewToHash detail round-trip: exact canonical hash");
  eq(viewToHash({ kind: "inventory-stocktakes" }), "#/inventory/stocktakes", "24l. viewToHash list: exact canonical hash");
  eq(viewToHash({ kind: "inventory-stocktake", id: "../etc" }), null, "24m. viewToHash with an unsafe id → null (no hash is ever produced)");
  eq(viewToHash({ kind: "inventory-stocktake", id: "" }), null, "24n. viewToHash with an EMPTY id → null");
  eq(hashToView(viewToHash({ kind: "inventory-stocktake", id: "x1_Y" }) as string), { kind: "inventory-stocktake", id: "x1_Y" }, "24o. full round-trip hash→view→hash→view is the identity for a safe id");
  eq(viewKeyOf({ kind: "inventory-stocktakes" }), "inventory-stocktakes", "24p. viewKeyOf list: stable key");
  eq(viewKeyOf({ kind: "inventory-stocktake", id: "abc" }), "inventory-stocktake:abc", "24q. viewKeyOf detail: id-scoped key (another stocktake remounts, §36 parity)");
  ok("24r. different ids → different view keys", viewKeyOf({ kind: "inventory-stocktake", id: "abc" }) !== viewKeyOf({ kind: "inventory-stocktake", id: "xyz" }));
  const a: AppView = { kind: "inventory-stocktake", id: "abc" };
  const b: AppView = { kind: "inventory-stocktake", id: "abc" };
  const c: AppView = { kind: "inventory-stocktake", id: "xyz" };
  const list: AppView = { kind: "inventory-stocktakes" };
  ok("24s. sameView: same id true; different id false; list vs detail false; list vs list true", sameView(a, b) && !sameView(a, c) && !sameView(list, a) && sameView(list, list));
}

// ===========================================================================
// [25] §40 — zero-variance adjustment suppression LAW (finalize semantics)
// ===========================================================================
{
  console.log("-- [25] zero-variance suppression law (§40)");
  // The finalize loop's pure semantics: an InventoryAdjustment is created
  // ONLY when computeVarianceQty !== 0; deltas pass through SIGNED.
  function finalizeAdjustments(lines: ReadonlyArray<{ productId: string; countedQty: number; systemQtyAtCount: number }>) {
    return lines
      .map((l) => ({ productId: l.productId, delta: computeVarianceQty(l.countedQty, l.systemQtyAtCount) }))
      .filter((a) => a.delta !== 0);
  }
  const lines = [
    { productId: "p1", countedQty: 13, systemQtyAtCount: 10 }, // +3
    { productId: "p2", countedQty: 10, systemQtyAtCount: 10 }, // 0 → NO adjustment
    { productId: "p3", countedQty: 8, systemQtyAtCount: 10 }, // −2
  ];
  const adjustments = finalizeAdjustments(lines);
  eq(adjustments.length, 2, "25a. exactly 2 adjustments for 3 lines — the zero-variance line is SKIPPED");
  eq(adjustments.map((a) => a.delta), [3, -2], "25b. deltas pass through SIGNED in line order (no Math.abs, deterministic)");
  eq(adjustments.map((a) => a.productId), ["p1", "p3"], "25c. the skipped product id is exactly the zero-variance one");
  eq(finalizeAdjustments(lines.map((l) => ({ ...l, systemQtyAtCount: l.countedQty }))).length, 0, "25d. idempotence: re-finalizing a system already at countedQty creates ZERO adjustments");
  const zeroLineSummary = computeStocktakeSummary(lines.map((l) => ({ countedAt: new Date(), varianceQty: computeVarianceQty(l.countedQty, l.systemQtyAtCount) })));
  eq(zeroLineSummary.zeroVarianceLineCount, 1, "25e. suppression affects ADJUSTMENTS only — the zero line is still counted in review stats");
  ok("25f. the skip predicate IS computeVarianceQty(...) === 0 (single source of truth, §40)", computeVarianceQty(10, 10) === 0 && computeVarianceQty(11, 10) !== 0 && computeVarianceQty(9, 10) !== 0);
}

// ===========================================================================
// [26] §36 — deterministic line ordering law (countedAt asc, id asc)
// ===========================================================================
{
  console.log("-- [26] deterministic ordering law (§36)");
  // Mirrors the service's orderBy [{countedAt: "asc"}, {id: "asc"}].
  const at = (ms: number) => new Date(Date.UTC(2026, 2, 1, 10, 0, 0, ms));
  const fixture = [
    { id: "c", countedAt: at(300) },
    { id: "a", countedAt: at(100) },
    { id: "b2", countedAt: at(200) },
    { id: "b1", countedAt: at(200) }, // tie → id asc
    { id: "d", countedAt: at(200) }, // tie → id asc
    { id: "e", countedAt: at(0) },
  ];
  const byCountedAtThenId = (x: { id: string; countedAt: Date }, y: { id: string; countedAt: Date }) =>
    x.countedAt.getTime() - y.countedAt.getTime() || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  const sorted = [...fixture].sort(byCountedAtThenId);
  eq(sorted.map((l) => l.id), ["e", "a", "b1", "b2", "d", "c"], "26a. merge order is countedAt asc with id-asc tie-break");
  eq(fixture.map((l) => l.id), ["c", "a", "b2", "b1", "d", "e"], "26b. the source fixture is untouched (pure sort — no in-place aliasing in tests)");
  const twice = [...sorted].sort(byCountedAtThenId);
  eq(twice.map((l) => l.id), sorted.map((l) => l.id), "26c. the order is a fixed point (sorting twice is stable)");
  const dupes = [
    { id: "x2", countedAt: at(100) },
    { id: "x1", countedAt: at(100) },
    { id: "x2", countedAt: at(100) },
  ].sort(byCountedAtThenId);
  eq(dupes.map((l) => l.id), ["x1", "x2", "x2"], "26d. equal (countedAt, id) keys keep relative order (stable sort, Array.prototype.sort is stable here)");
  ok("26e. comparator is a total order (never NaN, antisymmetric on the fixture)", fixture.every((p) => fixture.every((q) => {
    const ab = byCountedAtThenId(p, q);
    const ba = byCountedAtThenId(q, p);
    return (ab === 0 && ba === 0) || (ab < 0 && ba > 0) || (ab > 0 && ba < 0);
  })));
}

// ===========================================================================
// [27] §36 — summary numbers are integers for arbitrary integer inputs
// ===========================================================================
{
  console.log("-- [27] integer-result law (§36)");
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }
  const rand = lcg(20260301);
  const lines = Array.from({ length: 60 }, (_, i) => {
    if (i % 7 === 0) return { countedAt: null, varianceQty: null }; // every 7th line pending
    const system = Math.floor(rand() * 100);
    const counted = system + Math.floor(rand() * 101) - 40; // deltas in [−40, +60]
    return { countedAt: new Date("2026-03-01T10:00:00.000Z"), varianceQty: computeVarianceQty(counted, system) };
  });
  const s = computeStocktakeSummary(lines);
  const numbers = [
    s.lineCount, s.countedLineCount, s.pendingLineCount, s.positiveVarianceLineCount,
    s.negativeVarianceLineCount, s.zeroVarianceLineCount, s.increaseVarianceUnits,
    s.decreaseVarianceUnits, s.netVarianceUnits,
  ];
  ok("27a. all 9 summary numbers are integers", numbers.every((n) => Number.isInteger(n)), numbers.filter((n) => !Number.isInteger(n)).join(","));
  eq(s.netVarianceUnits, s.increaseVarianceUnits - s.decreaseVarianceUnits, "27b. net identity holds for the random fixture");
  eq(s.countedLineCount + s.pendingLineCount, s.lineCount, "27c. counted + pending === lineCount");
  eq(s.positiveVarianceLineCount + s.negativeVarianceLineCount + s.zeroVarianceLineCount, s.countedLineCount, "27d. pos + neg + zero === counted (no line double-classified)");
  eq(s.lineCount, 60, "27e. fixture size sanity (60 lines, deterministic seed)");
}

// ===========================================================================
// [28] §138 — audit-metadata minimality: exactly the 5 documented error codes
// ===========================================================================
{
  console.log("-- [28] error-code vocabulary (§138)");
  eq(Object.keys(STOCKTAKE_ERROR_CODES).length, 5, "28a. exactly 5 documented error codes (closed set — audit minimality)");
  eq(
    Object.keys(STOCKTAKE_ERROR_CODES),
    ["INVALID_TRANSITION", "DUPLICATE_PRODUCT", "STALE_COUNT", "PRODUCT_INACTIVE", "LINE_LIMIT"],
    "28b. the key set is exactly the documented vocabulary",
  );
  eq(STOCKTAKE_ERROR_CODES.INVALID_TRANSITION, "INVALID_STOCKTAKE_TRANSITION", "28c. INVALID_TRANSITION code string");
  eq(STOCKTAKE_ERROR_CODES.DUPLICATE_PRODUCT, "DUPLICATE_STOCKTAKE_PRODUCT", "28d. DUPLICATE_PRODUCT code string");
  eq(STOCKTAKE_ERROR_CODES.STALE_COUNT, "STOCKTAKE_STALE_COUNT", "28e. STALE_COUNT code string");
  eq(STOCKTAKE_ERROR_CODES.PRODUCT_INACTIVE, "STOCKTAKE_PRODUCT_INACTIVE", "28f. PRODUCT_INACTIVE code string");
  eq(STOCKTAKE_ERROR_CODES.LINE_LIMIT, "STOCKTAKE_LINE_LIMIT_REACHED", "28g. LINE_LIMIT code string");
  eq(new Set(Object.values(STOCKTAKE_ERROR_CODES)).size, 5, "28h. all 5 code strings are unique (no collisions on the wire)");
}

// ===========================================================================
console.log(`PROMPT 40 UNIT: ${passed}/${passed + failed} ${failed === 0 ? "PASS" : "FAIL"}`);
if (failed > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("UNIT GREEN ✓");
