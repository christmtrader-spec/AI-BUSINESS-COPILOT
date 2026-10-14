/**
 * scripts/prompt49-aging-details-unit.ts — Prompt 49 UNIT harness.
 *
 * Pure-function assertions over the detailed-aging domain
 * (src/lib/aging-details.ts + src/lib/aging-details-cursor.ts) and the
 * §6 party-identity law in src/lib/aging.ts — NO database, NO server:
 *
 *   [1] cursor codec — encode/decode roundtrip + payload privacy
 *   [2] cursor binding — side/party/bucket/pastDue/tenant mismatches → 422
 *   [3] cursor tampering — bit-flip / truncation / garbage → 422
 *   [4] query parsing — closed vocab, clamps, receivables pastDue rejection
 *   [5] outstanding guard — exact integer law + non-integer rejection
 *   [6] receivables item — invoice-age semantics, bucket edges, NO due date
 *   [7] payables item — dueDate ?? spentAt anchor, past-due law (due today
 *       NOT past due; no dueDate never past due), SupplierBill metadata
 *   [8] §6 party identity — same display names NEVER merge (aging engine)
 *   [9] export caps — env discipline + sane clamps
 *  [10] DTO shape — closed explicit fields, no note/Prisma leakage
 *  [11] EN/FA parity — agingDetails + statements.openSourceDocument keys
 *
 * Run: bun scripts/prompt49-aging-details-unit.ts
 */

import { createRequire } from "node:module";
import path from "node:path";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
  if (!cond) failures.push(name);
}
function eq<T>(actual: T, expected: T, name: string) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
}
function throws(name: string, fn: () => unknown, Err?: new (...a: never[]) => Error) {
  try {
    fn();
    ok(name, false, "did not throw");
  } catch (e) {
    ok(name, Err ? e instanceof Err : true, e instanceof Error ? e.message : String(e));
  }
}

import {
  encodeAgingDetailCursor,
  decodeAgingDetailCursor,
  AgingDetailValidationError,
  isAgingDetailSide,
  isAgingBucketKey,
  type AgingDetailCursorExpectation,
} from "../src/lib/aging-details-cursor";
import {
  parseAgingDetailQuery,
  outstandingOf,
  saleDetailItem,
  expenseDetailItem,
  AGING_DETAIL_DEFAULT_LIMIT,
  AGING_DETAIL_MIN_LIMIT,
  AGING_DETAIL_MAX_LIMIT,
  AGING_DETAIL_SCAN_CAP,
  AGING_DETAIL_EXPORT_MAX_ROWS,
  AGING_DETAIL_CHUNK,
  type SaleSourceRow,
  type ExpenseSourceRow,
} from "../src/lib/aging-details";
import {
  AGING_BUCKET_KEYS,
  buildAgingSide,
  type AgingItem,
} from "../src/lib/aging";

const BIZ = "biz-p49-unit";
const TZ = "Asia/Tehran"; // +03:30 fixed, DST-free since 2022
const now = new Date("2026-10-03T12:00:00.000Z"); // Tehran 2026-10-03 15:30

const expectation: AgingDetailCursorExpectation = {
  businessId: BIZ,
  side: "receivables",
  partyId: null,
  bucket: null,
  pastDue: false,
};

console.log("[1] cursor codec — roundtrip + privacy");
{
  const token = encodeAgingDetailCursor({
    v: "v1",
    b: BIZ,
    s: "payables",
    p: "sup-1",
    k: "D31_60",
    d: "1",
    ts: "2026-10-01T10:00:00.000Z",
    id: "exp-9",
  });
  ok("1a. token is payload.signature", /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token));
  ok("1b. token bounded (≤1024)", token.length <= 1024);
  const decoded = decodeAgingDetailCursor(token, {
    businessId: BIZ,
    side: "payables",
    partyId: "sup-1",
    bucket: "D31_60",
    pastDue: true,
  });
  ok("1c. roundtrip preserves the last scanned key", decoded.ts === "2026-10-01T10:00:00.000Z" && decoded.id === "exp-9");
  const plain = Buffer.from(token.split(".")[0], "base64url").toString("utf8");
  ok("1d. payload carries no names/references/amounts", !plain.includes("Acme") && !plain.includes("INV-") && !/"minor"/.test(plain));
  ok("1e. closed sides/buckets vocabularies", isAgingDetailSide("receivables") && isAgingDetailSide("payables") && !isAgingDetailSide("both") && isAgingBucketKey("D90_PLUS") && !isAgingBucketKey("D0_29"));
}

console.log("[2] cursor binding — side/party/bucket/pastDue/tenant");
{
  const token = encodeAgingDetailCursor({
    v: "v1",
    b: BIZ,
    s: "receivables",
    p: "cus-1",
    k: "D0_30",
    d: "*",
    ts: "2026-10-02T08:00:00.000Z",
    id: "sale-5",
  });
  throws("2a. other business rejected", () => decodeAgingDetailCursor(token, { ...expectation, businessId: "biz-OTHER" }), AgingDetailValidationError);
  throws("2b. other side rejected", () => decodeAgingDetailCursor(token, { ...expectation, side: "payables" }), AgingDetailValidationError);
  throws("2c. other party rejected", () => decodeAgingDetailCursor(token, { ...expectation, partyId: "cus-2" }), AgingDetailValidationError);
  throws("2d. no-party expectation rejected for party cursor", () => decodeAgingDetailCursor(token, expectation), AgingDetailValidationError);
  throws("2e. other bucket rejected", () => decodeAgingDetailCursor(token, { ...expectation, partyId: "cus-1", bucket: "D90_PLUS" }), AgingDetailValidationError);
  throws("2f. pastDue expectation rejected for non-pastDue cursor", () => decodeAgingDetailCursor(token, { ...expectation, partyId: "cus-1", pastDue: true }), AgingDetailValidationError);
  const ok2 = decodeAgingDetailCursor(token, { ...expectation, partyId: "cus-1", bucket: "D0_30" });
  ok("2g. exact binding accepted", ok2.id === "sale-5");
}

console.log("[3] cursor tampering");
{
  const token = encodeAgingDetailCursor({ v: "v1", b: BIZ, s: "payables", p: "*", k: "*", d: "*", ts: "2026-10-01T10:00:00.000Z", id: "exp-1" });
  const [payload, sig] = token.split(".");
  // Flip one char of the payload (same length, different bytes).
  const flipped = (payload[0] === "A" ? "B" : "A") + payload.slice(1);
  throws("3a. modified payload rejected", () => decodeAgingDetailCursor(`${flipped}.${sig}`, expectation), AgingDetailValidationError);
  throws("3b. modified signature rejected", () => decodeAgingDetailCursor(`${payload}.${sig.slice(0, -1)}A`, expectation), AgingDetailValidationError);
  throws("3c. truncated token rejected", () => decodeAgingDetailCursor(payload, expectation), AgingDetailValidationError);
  throws("3d. garbage rejected", () => decodeAgingDetailCursor("garbage.token", expectation), AgingDetailValidationError);
  throws("3e. unsigned JSON rejected", () => decodeAgingDetailCursor(Buffer.from(JSON.stringify({ v: "v1", b: BIZ, s: "payables", p: "*", k: "*", d: "*", ts: "2026-10-01T10:00:00.000Z", id: "x" })).toString("base64url"), expectation), AgingDetailValidationError);
}

console.log("[4] query parsing — closed vocabulary + clamps");
{
  throws("4a. missing side rejected", () => parseAgingDetailQuery(new URLSearchParams("")));
  throws("4b. unknown side rejected", () => parseAgingDetailQuery(new URLSearchParams("side=everything")));
  throws("4c. garbage bucket rejected", () => parseAgingDetailQuery(new URLSearchParams("side=receivables&bucket=D45")));
  throws("4d. pastDue on receivables rejected (§9 — no invented customer due date)", () => parseAgingDetailQuery(new URLSearchParams("side=receivables&pastDue=true")));
  throws("4e. non-numeric limit rejected", () => parseAgingDetailQuery(new URLSearchParams("side=receivables&limit=abc")));
  throws("4f. limit below minimum rejected", () => parseAgingDetailQuery(new URLSearchParams(`side=receivables&limit=${AGING_DETAIL_MIN_LIMIT - 1}`)));
  throws("4g. limit above maximum rejected", () => parseAgingDetailQuery(new URLSearchParams(`side=receivables&limit=${AGING_DETAIL_MAX_LIMIT + 1}`)));
  throws("4h. malformed partyId rejected", () => parseAgingDetailQuery(new URLSearchParams("side=receivables&partyId=<script>")));
  throws("4i. pastDue value must be true/1", () => parseAgingDetailQuery(new URLSearchParams("side=payables&pastDue=yes")));
  const parsed = parseAgingDetailQuery(new URLSearchParams(`side=payables&pastDue=1&limit=17&bucket=D61_90`));
  ok("4j. valid payables pastDue query accepted", parsed.side === "payables" && parsed.pastDue === true && parsed.limit === 17 && parsed.bucket === "D61_90" && parsed.partyId === null);
  const defaulted = parseAgingDetailQuery(new URLSearchParams("side=receivables"));
  ok("4k. defaults: limit 25, no filters", defaulted.limit === AGING_DETAIL_DEFAULT_LIMIT && defaulted.bucket === null && defaulted.partyId === null && defaulted.cursor === null);
  ok("4l. page bounds are the documented 10..100", AGING_DETAIL_MIN_LIMIT === 10 && AGING_DETAIL_MAX_LIMIT === 100 && AGING_DETAIL_DEFAULT_LIMIT === 25);
}

console.log("[5] outstanding guard — exact integer law");
{
  ok("5a. exact integer difference", outstandingOf(10_000, 4_000) === 6_000);
  ok("5b. zero paid", outstandingOf(500, 0) === 500);
  ok("5c. fully paid → 0 (the open guard filters it later)", outstandingOf(500, 500) === 0);
  throws("5d. non-integer total rejected", () => outstandingOf(10.5, 0));
  throws("5e. non-integer paid rejected", () => outstandingOf(10, 0.25));
}

console.log("[6] receivables item — invoice age, buckets, NO due date");
{
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
  const row = (id: string, age: number, total: number, paid: number): SaleSourceRow => ({
    id,
    number: 7,
    issueDate: daysAgo(age),
    totalMinor: total,
    paidMinor: paid,
    customer: { id: "cus-1", name: "Acme" },
  });
  const item = saleDetailItem(row("s1", 10, 100_000, 40_000), TZ, now);
  ok("6a. sourceType SALE + reference via the canonical formatter", item.sourceType === "SALE" && item.reference === "INV-0007");
  ok("6b. age + bucket exact (10 days → D0_30)", item.ageDays === 10 && item.bucket === "D0_30");
  ok("6c. outstanding = total − paid (integer)", item.outstandingMinor === 60_000 && item.totalMinor === 100_000 && item.paidMinor === 40_000);
  ok("6d. NO customer due date (§9 — never invented)", item.dueDate === null);
  ok("6e. receivables NEVER past due (§9)", item.pastDue === false);
  eq(
    ["D0_30", "D0_30", "D31_60", "D31_60", "D61_90", "D61_90", "D90_PLUS", "D90_PLUS"],
    [0, 30, 31, 60, 61, 90, 91, 120].map((a) => saleDetailItem(row(`x${a}`, a, 100, 0), TZ, now).bucket),
    "6f. bucket edges land exactly",
  );
  ok("6g. anchor == documentDate for receivables", item.anchorDate === item.documentDate);
}

console.log("[7] payables item — due-date law + SupplierBill metadata");
{
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
  const row = (over: Partial<ExpenseSourceRow>): ExpenseSourceRow => ({
    id: "e1",
    reference: null,
    category: "Utilities",
    spentAt: daysAgo(50),
    dueDate: null,
    amountMinor: 200_000,
    paidMinor: 50_000,
    supplier: { id: "sup-1", name: "Globex" },
    supplierBill: null,
    ...over,
  });
  const anchorSpent = expenseDetailItem(row({}), TZ, now);
  ok("7a. anchor falls back to spentAt (no stated due date)", anchorSpent.anchorDate === anchorSpent.documentDate && anchorSpent.bucket === "D31_60");
  ok("7b. reference falls back to category (§12 statement law)", anchorSpent.reference === "Utilities" && anchorSpent.dueDate === null);
  ok("7c. no due date → never past due (§9)", anchorSpent.pastDue === false);

  const dueFuture = expenseDetailItem(row({ dueDate: daysAgo(10) }), TZ, now);
  ok("7d. due 10 days ago → past due + D0_30 bucket (anchor = dueDate)", dueFuture.pastDue === true && dueFuture.bucket === "D0_30");
  ok("7e. age measured from the DUE anchor", dueFuture.ageDays === 10 && dueFuture.dueDate !== null);

  const dueToday = expenseDetailItem(row({ dueDate: now, spentAt: daysAgo(45) }), TZ, now);
  ok("7f. due TODAY is NOT past due (strictly-after law, §9)", dueToday.pastDue === false);
  ok("7g. due today still ages from the due anchor", dueToday.ageDays === 0 && dueToday.bucket === "D0_30");

  const posted = expenseDetailItem(row({ supplierBill: { reference: "SB-20261001-AAAAAA", status: "POSTED" } }), TZ, now);
  ok("7h. posted bill reference surfaces as supplemental metadata", posted.supplierBillReference === "SB-20261001-AAAAAA");
  ok("7i. bill metadata adds NO second balance (outstanding unchanged)", posted.outstandingMinor === 150_000 && posted.totalMinor === 200_000);
  const draftBill = expenseDetailItem(row({ supplierBill: { reference: "SB-DRAFT", status: "DRAFT" } }), TZ, now);
  ok("7j. non-posted bill reference suppressed", draftBill.supplierBillReference === null);
}

console.log("[8] §6 party identity — same display names never merge");
{
  const mk = (partyId: string, balance: number, name: string): AgingItem => ({
    anchor: new Date(now.getTime() - 5 * 86_400_000),
    balanceMinor: balance,
    party: name,
    partyId,
  });
  const side = buildAgingSide(
    [mk("cus-a", 100, "Twin"), mk("cus-b", 250, "Twin"), mk("cus-a", 50, "Twin"), mk(null as unknown as string, 10, "Twin")],
    { timeZone: TZ, now },
  );
  ok("8a. two same-name parties stay two groups (id-keyed)", side.topParties.length === 3); // cus-b 250, cus-a 150, unassigned 10
  ok("8b. per-id totals exact", side.topParties[0]?.balanceMinor === 250 && side.topParties[1]?.balanceMinor === 150);
  ok("8c. groups carry the authoritative partyId", side.topParties[0]?.partyId === "cus-b" && side.topParties[1]?.partyId === "cus-a");
  ok("8d. unassigned group preserved with partyId null", side.topParties[2]?.partyId === null);
  const side2 = buildAgingSide([mk("sup-a", 100, "Twin"), mk("sup-b", 100, "Twin")], { timeZone: TZ, now });
  ok("8e. exact-balance same-name tie still two groups, id-ordered", side2.topParties.length === 2 && side2.topParties[0].partyId === "sup-a" && side2.topParties[1].partyId === "sup-b");
}

console.log("[9] export/scan caps — env discipline (documented defaults)");
{
  ok("9a. production defaults", AGING_DETAIL_SCAN_CAP === 5000 && AGING_DETAIL_EXPORT_MAX_ROWS === 5000);
  ok("9b. chunk bounded below the cap", AGING_DETAIL_CHUNK === 400 && AGING_DETAIL_CHUNK < AGING_DETAIL_SCAN_CAP);
  ok("9c. caps are positive integers", Number.isInteger(AGING_DETAIL_SCAN_CAP) && AGING_DETAIL_SCAN_CAP > 0);
}

console.log("[10] DTO shape — closed explicit fields");
{
  const item = saleDetailItem(
    { id: "s1", number: 1, issueDate: now, totalMinor: 100, paidMinor: 0, customer: { id: "c", name: "C" } },
    TZ,
    now,
  );
  eq(
    [
      "sourceType", "sourceId", "reference", "partyId", "partyName",
      "documentDate", "anchorDate", "dueDate", "totalMinor", "paidMinor",
      "outstandingMinor", "ageDays", "bucket", "pastDue", "supplierBillReference",
    ],
    Object.keys(item),
    "10a. exact closed field list (no note, no Prisma rows)",
  );
  ok("10b. no internal-note-like field", !("note" in item) && !("internalNotes" in item));
  const exp = expenseDetailItem(
    { id: "e1", reference: "R-1", category: "Rent", spentAt: now, dueDate: null, amountMinor: 10, paidMinor: 0, supplier: { id: "s", name: "S" }, supplierBill: null },
    TZ,
    now,
  );
  ok("10c. payables carry the same closed shape", JSON.stringify(Object.keys(exp)) === JSON.stringify(Object.keys(item)));
  ok("10d. all buckets present in engine order", AGING_BUCKET_KEYS.join(",") === "D0_30,D31_60,D61_90,D90_PLUS");
}

console.log("[11] EN/FA parity — agingDetails + statement source action");
{
  // server-only guard: messages load through createRequire (P48 convention).
  const esmRequire = createRequire(path.join(process.cwd(), "package.json"));
  const enMod = esmRequire("./src/i18n/messages/en") as { default: Record<string, unknown> };
  const faMod = esmRequire("./src/i18n/messages/fa") as { default: Record<string, unknown> };
  const enAging = (enMod.default.finance as Record<string, unknown>).agingDetails as Record<string, unknown>;
  const faAging = (faMod.default.finance as Record<string, unknown>).agingDetails as Record<string, unknown>;
  const enKeys = Object.keys(enAging);
  const faKeys = Object.keys(faAging);
  ok("11a. agingDetails key parity (EN ⊆ FA)", enKeys.every((k) => faKeys.includes(k)));
  ok("11b. agingDetails key parity (FA ⊆ EN)", faKeys.every((k) => enKeys.includes(k)));
  ok("11c. agingDetails is non-trivial (≥60 keys)", enKeys.length >= 60, String(enKeys.length));
  const required = [
    "invoiceAge", "invoiceAgeDays", "pastDueBadge", "noDueDate", "dueToday",
    "colOutstanding", "exportTooLarge", "pageTruncated", "summaryTruncated",
    "csvPastDue", "csvSupplierBill", "panelTitle", "unassignedParty", "viewStatement",
  ];
  ok("11d. truthful-semantics keys present in BOTH locales", required.every((k) => k in enAging && k in faAging));
  ok("11e. FA invoice-age is عمر فاکتور (professional terminology)", faAging.invoiceAge === "عمر فاکتور");
  ok("11f. FA past-due badge is سررسید گذشته", faAging.pastDueBadge === "سررسید گذشته");
  const enStatements = enMod.default.statements as Record<string, unknown>;
  const faStatements = faMod.default.statements as Record<string, unknown>;
  ok("11g. statements.openSourceDocument in BOTH locales", enStatements.openSourceDocument === "Open source document" && typeof faStatements.openSourceDocument === "string" && faStatements.openSourceDocument.length > 0);
  ok("11h. receivables wording never says overdue for age", !String(enAging.invoiceAge).toLowerCase().includes("overdue") && !String(faAging.invoiceAge).includes("معوق"));
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
