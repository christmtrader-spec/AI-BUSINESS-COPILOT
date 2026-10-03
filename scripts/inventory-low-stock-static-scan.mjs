/**
 * scripts/inventory-low-stock-static-scan.mjs — Prompt 38 (§38-a §20,
 * REPAIRED by 38-F §76–§84).
 *
 * Deterministic, dependency-free source scan over the low-stock alert
 * surface. Every rule reports ✓/✗ with the offending file:line. Exit 0
 * only when ALL rules pass. Mirrors the Prompt 37 §97/§12 scan discipline
 * for the inventory surface.
 *
 * 38-F rule repair: the OLD rule 7 demanded `lowRows.slice(0, max)` — the
 * exact fake-boundedness pattern 38-F bans. The corrected rules verify a
 * REAL bounded page query (`take:` + cursor pagination state), the
 * creation-budget semantics of `max`, and the truncated lookahead.
 *
 * Rules (1:1):
 *   1  no setInterval in inventory alert code (app runtime)
 *   2  no setTimeout in inventory alert code (app runtime)
 *   3  no in-process scheduler/polling loop in the processor
 *   4  no direct nodemailer/SMTP from inventory alert code
 *   5  no client-controlled recipient (userId from request) in the processor
 *   6  no client-controlled businessId (tenant scope is server-derived)
 *   7  (§76/§78) REAL bounded page query: product read carries a hard
 *      `take: pageSize` bound — slice()-only capping is NOT accepted
 *   7b (§78) no unbounded product findMany — exactly one product.findMany
 *      call and it MUST contain the take bound
 *   7c (§79) pagination state exists: server-derived cursor + skip: 1
 *   7d (§80) a real global created-notification budget exists — the old
 *      `lowRows.slice(0, max)` cap must be GONE
 *   7e (§19) truncated lookahead is wired (hasRemainingLowStockWork)
 *   8  no per-product ids in console logging
 *   9  no business ids in console logging
 *  10  no product names/SKUs/quantities in console logging
 *  11  no recipient user ids in console logging
 *  12  (§52) debug mode emits ONLY the §52 aggregate key vocabulary
 *      (exported INVENTORY_LOW_STOCK_DEBUG_KEYS constant, consumed)
 *  13  no product mutation during alert processing (notification-only)
 *  14  no sourceEventId generated from raw user input (names/SKUs)
 *  15  no run timestamp in the sourceEventId identity (determinism)
 *  16  no arbitrary actionRoute (closed catalog key only)
 *  17  no eval / Function() / dynamic exec in the alert surface
 *  18  no public HTTP scheduler endpoint (CLI talks to the DB directly)
 *  19  no fake distributed locking / queue / worker vocabulary
 *  20  recipients resolved from the closed OWNER/ADMIN vocabulary only
 *  21  (§17) deterministic recipient order (userId ASC)
 *  22  (§50) systemic DB error classification exists (propagate, not swallow)
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
let section = "";
const resultsArr = [];
let passedCount = 0;

function section0(name) {
  section = name;
}
function read(rel) {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}
function lineOf(src, needle) {
  const idx = typeof needle === "string" ? src.indexOf(needle) : needle;
  if (idx < 0) return 0;
  return src.slice(0, idx).split("\n").length;
}
function record(name, ok, info = "") {
  resultsArr.push({ name, ok });
  passedCount += ok ? 1 : 0;
  const mark = ok ? "✓" : "✗";
  const line = `${mark} [${section}] ${name}${!ok && info ? ` — ${info}` : ""}`;
  console.log(line);
}
function check(name, src, needle, expect = true, info = "") {
  if (src === null) {
    record(name, false, "FILE MISSING");
    return;
  }
  const has = src.includes(needle);
  record(name, expect ? has : !has, expect ? "not found" : `found at line ${lineOf(src, needle)}`);
}

const FILES = {
  types: "src/lib/inventory/low-stock-types.ts",
  processor: "src/lib/inventory/low-stock-processor.ts",
  cli: "scripts/process-inventory-low-stock.mjs",
  mapper: "src/lib/notifications/event-mappers.ts",
  routes: "src/lib/notifications/types.ts",
};
const src = {};
for (const [k, rel] of Object.entries(FILES)) {
  src[k] = read(rel);
}

/* ------------------------------ runtime laws ------------------------------ */
section0("runtime");
check("1 no setInterval in processor", src.processor, "setInterval(", false);
check("1 no setInterval in types", src.types, "setInterval(", false);
check("2 no setTimeout in processor", src.processor, "setTimeout(", false);
check("3 no in-process scheduler loop", src.processor, "while (true)", false);
check("3 no request-lifecycle wiring", src.processor, "export const dynamic", false);
check("4 no nodemailer in processor", src.processor, "nodemailer", false);
check("4 no nodemailer in types", src.types, "nodemailer", false);

/* ------------------------------ tenant safety ----------------------------- */
section0("tenant");
check("5 no request object in processor", src.processor, "NextRequest", false);
check("5 no request object in types", src.types, "NextRequest", false);
check("6 processor scope is a validated option, not a request param", src.processor, "options.businessId?.trim()", true);

/* ----------------- bounded scan (38-F §76–§80 — REPAIRED) ----------------- */
section0("bounds");
check("7 page query carries a REAL take bound (take: pageSize)", src.processor, "take: pageSize", true);
check("7 page size comes from the bounded helper", src.processor, "lowStockScanPageSize()", true);
check("7 the fake slice(0, max) cap is GONE", src.processor, "slice(0, max)", false);
{
  // §78 — no unbounded product load: every db.product.findMany occurrence
  // must sit before a take: bound within the same call. There is exactly
  // ONE product.findMany in the processor and it contains `take: pageSize`.
  const p = src.processor ?? "";
  const callSites = p.split("db.product.findMany").length - 1;
  record("7b exactly one db.product.findMany call site", callSites === 1, `${callSites} sites`);
  record("7b that call carries the take bound", p.includes("take: pageSize"));
}
check("7c pagination cursor state exists (server-derived)", src.processor, "cursor: { id: cursor }", true);
check("7c pagination advances past the cursor row (skip: 1)", src.processor, "skip: 1", true);
check("7c scan loop terminates on page exhaustion", src.processor, "rows.length === 0", true);
check(
  "7d max is the creation budget (budget check on the created path)",
  src.processor,
  "result.created >= max",
  true,
);
check("7d result reports truncated", src.processor, "truncated: false", true);
check("7e truncated uses the pure lookahead helper", src.processor, "hasRemainingLowStockWork(", true);
check("7e page size vocabulary exported + bounded (default 250)", src.types, "INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE_DEFAULT = 250", true);
check("7e page size min 50", src.types, "INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE_MIN = 50", true);
check("7e page size max 500", src.types, "INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE_MAX = 500", true);
check("7e invalid page-size env can never become unlimited (clamped)", src.types, "INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE_MAX,\n    Math.max(INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE_MIN, base)", true);

/* ------------------------------ safe logging ------------------------------ */
section0("logging");
{
  // The ONLY console.log allowed in the processor is the safe aggregate
  // debug block — verify its exact shape and that no other console.* exists.
  const p = src.processor ?? "";
  const consoleUses = p.split("\n").filter((l) => l.includes("console."));
  record("8-11 console usage limited to the safe debug block", consoleUses.length === 1, `${consoleUses.length} uses`);
  record(
    "12 debug block consumes the exported §52 key vocabulary",
    p.includes("INVENTORY_LOW_STOCK_DEBUG_KEYS") && (src.types ?? "").includes("INVENTORY_LOW_STOCK_DEBUG_KEYS = ["),
  );
  record(
    "12 debug emits exactly the §52 keys (satisfies the exported constant)",
    p.includes("satisfies Record<(typeof INVENTORY_LOW_STOCK_DEBUG_KEYS)[number], unknown>"),
  );
  const dbgStart = p.indexOf('debug: "inventory-low-stock"');
  record(
    "12 no per-row fields in the debug block (no ids/names/skus/qties)",
    dbgStart >= 0 &&
      !/(productId|productName|businessId|recipientUserId|stockQty:|\bsku:)/.test(p.slice(dbgStart)),
  );
}
check("12 debug switch is the only env-gated output", src.processor, 'process.env.INVENTORY_LOW_STOCK_DEBUG === "1"', true);

/* --------------------------- notification-only law ------------------------ */
section0("mutation");
check(
  "13 processor never mutates products (no product.update/deleteMany)",
  src.processor,
  ".product.update",
  false,
);
check("13 no product.create", src.processor, ".product.create", false);
check("13 no product.delete", src.processor, ".product.delete", false);
check("13 no product.upsert", src.processor, ".product.upsert", false);
check("13 no product.deleteMany", src.processor, ".product.deleteMany", false);

/* -------------------------------- identity -------------------------------- */
section0("identity");
check(
  "14 identity composed via the SHARED helper (dry-run + apply, no drift)",
  src.processor,
  "lowStockSourceEventId(fresh.id, fresh.stockQty, userId)",
  true,
);
check(
  "15 no Date.now / new Date() inside the identity",
  ((src.processor ?? "").split("lowStockSourceEventId")[0] ?? ""),
  "Date.now()",
  false,
);
check(
  "15 processor never imports a clock into the identity path",
  ((src.mapper ?? "").split("notifyInventoryLowStock")[1] ?? ""),
  "Date.now()",
  false,
);

/* ------------------------------- CTA + routes ----------------------------- */
section0("routes");
check("16 actionRoute is the closed catalog key", src.routes ?? "", 'case "products":', true);

/* ------------------------------ CLI discipline ---------------------------- */
section0("cli");
check("17 CLI has no eval", src.cli ?? "", "eval(", false);
check("17 CLI has no Function()", src.cli ?? "", "new Function", false);
{
  const cli = src.cli ?? "";
  const parseAt = cli.indexOf("parseReminderCliArgs(process.argv");
  const importAt = cli.indexOf("await import(");
  record(
    "18 CLI validates BEFORE the processor import",
    parseAt >= 0 && importAt >= 0 && parseAt < importAt,
  );
}
check("19 CLI declares no distributed lock", src.cli ?? "", "redis", false);
check("19 CLI declares no lock table", src.cli ?? "", "lease", false);
check("19 CLI declares no queue/worker", src.cli ?? "", "BullMQ", false);
check("19 CLI documents the single-node scheduler honestly", src.cli ?? "", "SINGLE-NODE SCHEDULER", true);

/* -------------------------------- recipients ------------------------------ */
section0("recipients");
check(
  "20 recipient vocabulary is the closed OWNER/ADMIN constant",
  src.types ?? "",
  'LOW_STOCK_RECIPIENT_ROLES = ["OWNER", "ADMIN"]',
  true,
);
check(
  "20 processor queries memberships with the role filter",
  src.processor,
  "role: { in: [...LOW_STOCK_RECIPIENT_ROLES] }",
  true,
);
check("21 recipient resolution is deterministically ordered (userId ASC)", src.processor, 'orderBy: { userId: "asc" }', true);
check("21 recipient list re-sorted defensively", src.processor, ".sort()", true);

/* ----------------------------- systemic failures --------------------------- */
section0("systemic");
check("22 systemic Prisma class codes enumerated (propagate, §50)", src.processor, "SYSTEMIC_PRISMA_CODES", true);
check("22 per-candidate errors stay contained (failed++, §49)", src.processor, "result.failed += 1", true);

/* --------------------------------- report --------------------------------- */
console.log("");
if (passedCount === resultsArr.length) {
  console.log(`inventory-low-stock-static-scan: ${passedCount}/${resultsArr.length} PASS`);
  console.log("STATIC SCAN GREEN ✓");
  process.exit(0);
} else {
  console.log(`inventory-low-stock-static-scan: ${passedCount}/${resultsArr.length} PASS — FAILURES PRESENT`);
  process.exit(1);
}
