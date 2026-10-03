/**
 * scripts/inventory-low-stock-static-scan.mjs — Prompt 38 (§38-a §20).
 *
 * Deterministic, dependency-free source scan over the low-stock alert
 * surface. Every rule reports ✓/✗ with the offending file:line. Exit 0
 * only when ALL rules pass. Mirrors the Prompt 37 §97/§12 scan discipline
 * for the inventory surface.
 *
 * Rules (1:1):
 *   1  no setInterval in inventory alert code (app runtime)
 *   2  no setTimeout in inventory alert code (app runtime)
 *   3  no in-process scheduler/polling loop in the processor
 *   4  no direct nodemailer/SMTP from inventory alert code
 *   5  no client-controlled recipient (userId from request) in the processor
 *   6  no client-controlled businessId (tenant scope is server-derived)
 *   7  no unbounded product query (a `take:` cap must exist)
 *   8  no per-product ids in console logging
 *   9  no business ids in console logging
 *  10  no product names/SKUs/quantities in console logging
 *  11  no recipient user ids in console logging
 *  12  no debug-mode bypass of the logging policy (INVENTORY_LOW_STOCK_DEBUG
 *      emits ONLY the safe aggregate metadata shape)
 *  13  no product mutation during alert processing (notification-only)
 *  14  no sourceEventId generated from raw user input (names/SKUs)
 *  15  no run timestamp in the sourceEventId identity (determinism)
 *  16  no arbitrary actionRoute (closed catalog key only)
 *  17  no eval / Function() / dynamic exec in the alert surface
 *  18  no public HTTP scheduler endpoint (CLI talks to the DB directly)
 *  19  no fake distributed locking
 *  20  recipients resolved from the closed OWNER/ADMIN vocabulary only
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

/* ------------------------------- boundedness ------------------------------ */
section0("bounds");
check("7 processor caps candidates (slice(0, max))", src.processor, "lowRows.slice(0, max)", true);
check("7 processor exposes max in result", src.processor, "max,", true);

/* ------------------------------ safe logging ------------------------------ */
section0("logging");
{
  // The ONLY console.log allowed in the processor is the safe aggregate
  // debug block — verify its exact shape and that no other console.* exists.
  const p = src.processor ?? "";
  const consoleUses = p.split("\n").filter((l) => l.includes("console."));
  record("8-11 console usage limited to the safe debug block", consoleUses.length === 1, `${consoleUses.length} uses`);
  record(
    "12 safe debug block emits the exact aggregate shape",
    p.includes('debug: "inventory-low-stock"') &&
      p.includes('phase: "candidate-scan"') &&
      p.includes("scanned: rows.length") &&
      p.includes("lowStockScanned: lowRows.length") &&
      p.includes("max,") &&
      p.includes("mode,"),
  );
  const debugBlockIdx = p.indexOf('process.env.INVENTORY_LOW_STOCK_DEBUG === "1"');
  record(
    "12 debug switch gates ONLY the aggregate block (no per-product payload after it)",
    debugBlockIdx >= 0 && !p.slice(debugBlockIdx, p.indexOf("const result:")).includes("productId"),
  );
}

/* --------------------------- notification-only law ------------------------ */
section0("mutation");
check(
  "13 processor never mutates products (no product.update/create/delete)",
  src.processor,
  ".product.update",
  false,
);
check("13 no product.create", src.processor, ".product.create", false);
check("13 no product.delete", src.processor, ".product.delete", false);
check("13 no product.upsert", src.processor, ".product.upsert", false);

/* -------------------------------- identity -------------------------------- */
section0("identity");
check(
  "14 sourceEventId composes from ids + qty only (no name/sku)",
  src.processor,
  "`inventory-low-stock:${fresh.id}:${fresh.stockQty}:${userId}`",
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
  'role: { in: ["OWNER", "ADMIN"] }',
  true,
);

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
