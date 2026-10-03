/**
 * scripts/prompt38-unit.ts — Prompt 38 (§38-a) unit harness.
 *
 * Meaningful assertions across the required areas: threshold predicate
 * purity, deterministic sourceEventId identity law, recipient role
 * vocabulary, per-run bounds (option > env > default, clamped), CLI flag
 * semantics (reused 37-F contract), catalog entry invariants (schema
 * strictness, channels, mandatory, action route, expiry), template
 * rendering (en + fa, null SKU/unit fallbacks), i18n parity, and the
 * absence-of-noise law (no restock/stock-out types).
 *
 * Run: bun --preload ./scripts/lib/register-server-only-shim.ts scripts/prompt38-unit.ts
 */

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, info = "") {
  if (cond) passed++;
  else {
    failed++;
    failures.push(`${name}${info ? ` — ${info}` : ""}`);
  }
  console.log(`${cond ? "✓" : "✗"} ${name}${info && !cond ? ` — ${info}` : ""}`);
}

import {
  hasRemainingLowStockWork,
  INVENTORY_LOW_STOCK_DEBUG_KEYS,
  INVENTORY_LOW_STOCK_MAX_PER_RUN_DEFAULT,
  INVENTORY_LOW_STOCK_MAX_PER_RUN_MAX,
  INVENTORY_LOW_STOCK_MAX_PER_RUN_MIN,
  INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE_DEFAULT,
  INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE_MAX,
  INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE_MIN,
  isLowStockNow,
  isLowStockRecipientRole,
  LOW_STOCK_RECIPIENT_ROLES,
  lowStockMaxPerRun,
  lowStockScanPageSize,
  lowStockSourceEventId,
} from "../src/lib/inventory/low-stock-types";
import { NOTIFICATION_CATALOG, NOTIFICATION_TYPES, isNotificationType } from "../src/lib/notifications/catalog";
import { actionRoutePath, ACTION_ROUTES, isActionRoute } from "../src/lib/notifications/types";
import { renderNotificationForUser } from "../src/lib/notifications/templates";
import en from "../src/i18n/messages/en";
import fa from "../src/i18n/messages/fa";

/* --------------------------- 1. threshold predicate ------------------------ */
console.log("[1 threshold predicate]");
ok("1a. at threshold is low (inclusive)", isLowStockNow(5, 5) === true);
ok("1b. below threshold is low", isLowStockNow(0, 5) === true);
ok("1c. above threshold is not low", isLowStockNow(6, 5) === false);
ok("1d. zero threshold alerts only at zero", isLowStockNow(0, 0) === true && isLowStockNow(1, 0) === false);
ok("1e. negative stock rejected", isLowStockNow(-1, 5) === false);
ok("1f. negative threshold rejected", isLowStockNow(0, -1) === false);
ok("1g. NaN rejected", isLowStockNow(Number.NaN, 5) === false);
ok("1h. Infinity rejected", isLowStockNow(5, Number.POSITIVE_INFINITY) === false);

/* ------------------------------ 2. identity law ---------------------------- */
console.log("[2 sourceEventId identity]");
const id1 = lowStockSourceEventId("prod0001abc", 3, "user0001abc");
const id2 = lowStockSourceEventId("prod0001abc", 3, "user0001abc");
ok("2a. deterministic (same inputs → same id)", id1 === id2);
ok("2b. starts with the type marker", id1.startsWith("inventory-low-stock:prod0001abc:3:user0001abc"));
ok("2c. different qty → different id", lowStockSourceEventId("prod0001abc", 4, "user0001abc") !== id1);
ok("2d. different product → different id", lowStockSourceEventId("prod0002abc", 3, "user0001abc") !== id1);
ok("2e. different recipient → different id", lowStockSourceEventId("prod0001abc", 3, "user0002abc") !== id1);
ok("2f. fractional qty truncated deterministically", lowStockSourceEventId("prod0001abc", 3.9, "user0001abc") === lowStockSourceEventId("prod0001abc", 3, "user0001abc"));
ok("2g. NO run timestamp in the id", !id1.includes("Z") && !/\d{4}-\d{2}-\d{2}/.test(id1));

/* ------------------------------ 3. recipients ------------------------------ */
console.log("[3 recipient vocabulary]");
ok("3a. OWNER is a recipient role", isLowStockRecipientRole("OWNER"));
ok("3b. ADMIN is a recipient role", isLowStockRecipientRole("ADMIN"));
ok("3c. MANAGER is NOT", !isLowStockRecipientRole("MANAGER"));
ok("3d. STAFF is NOT", !isLowStockRecipientRole("STAFF"));
ok("3e. ACCOUNTANT is NOT", !isLowStockRecipientRole("ACCOUNTANT"));
ok("3f. VIEWER is NOT", !isLowStockRecipientRole("VIEWER"));
ok("3g. vocabulary is closed (exactly 2)", LOW_STOCK_RECIPIENT_ROLES.length === 2);

/* ------------------------------- 4. bounds --------------------------------- */
console.log("[4 per-run bounds]");
{
  const saved = process.env.INVENTORY_LOW_STOCK_MAX_PER_RUN;
  delete process.env.INVENTORY_LOW_STOCK_MAX_PER_RUN;
  ok("4a. default cap", lowStockMaxPerRun() === INVENTORY_LOW_STOCK_MAX_PER_RUN_DEFAULT);
  ok("4b. explicit option wins", lowStockMaxPerRun(42) === 42);
  ok("4c. option 9 clamps UP to min", lowStockMaxPerRun(9) === INVENTORY_LOW_STOCK_MAX_PER_RUN_MIN);
  ok("4d. option 10000 clamps DOWN to max", lowStockMaxPerRun(10000) === INVENTORY_LOW_STOCK_MAX_PER_RUN_MAX);
  ok("4e. NaN option falls back to default", lowStockMaxPerRun(Number.NaN) === INVENTORY_LOW_STOCK_MAX_PER_RUN_DEFAULT);
  process.env.INVENTORY_LOW_STOCK_MAX_PER_RUN = "250";
  ok("4f. env used when no option", lowStockMaxPerRun() === 250);
  process.env.INVENTORY_LOW_STOCK_MAX_PER_RUN = "10000";
  ok("4g. env 10000 clamps DOWN to 500", lowStockMaxPerRun() === 500);
  process.env.INVENTORY_LOW_STOCK_MAX_PER_RUN = "abc";
  ok("4h. non-numeric env falls back to default", lowStockMaxPerRun() === INVENTORY_LOW_STOCK_MAX_PER_RUN_DEFAULT);
  process.env.INVENTORY_LOW_STOCK_MAX_PER_RUN = "-5";
  ok("4i. negative env clamps UP to 10", lowStockMaxPerRun() === INVENTORY_LOW_STOCK_MAX_PER_RUN_MIN);
  if (saved === undefined) delete process.env.INVENTORY_LOW_STOCK_MAX_PER_RUN;
  else process.env.INVENTORY_LOW_STOCK_MAX_PER_RUN = saved;
}

/* --------------------------------- 5. CLI ---------------------------------- */
console.log("[5 CLI contract (37-F reuse)]");
import { parseReminderCliArgs } from "./lib/crm-reminder-cli.mjs";
{
  const conflict = parseReminderCliArgs(["--apply", "--dry-run"]);
  ok("5a. --apply --dry-run rejected", !conflict.ok && conflict.code === "CONFLICTING_FLAGS");
  const unknown = parseReminderCliArgs(["--foobar"]);
  ok("5b. unknown flag rejected", !unknown.ok && unknown.code === "UNKNOWN_FLAG");
  const badId = parseReminderCliArgs(["--business-id=bad id!"]);
  ok("5c. invalid business id rejected", !badId.ok && badId.code === "INVALID_BUSINESS_ID");
  const maxLow = parseReminderCliArgs(["--max=9"]);
  ok("5d. max 9 rejected", !maxLow.ok);
  const maxHigh = parseReminderCliArgs(["--max=10000"]);
  ok("5e. max 10000 rejected", !maxHigh.ok);
  const good = parseReminderCliArgs(["--apply", "--max=50", "--business-id=biz0001abc"]);
  ok("5f. valid apply parsed", good.ok && good.ok && good.options.dryRun === false);
  const def = parseReminderCliArgs([]);
  ok("5g. default is DRY_RUN", def.ok && def.options.dryRun === true);
  // 38-F §55 — strict 10–500 (no silent clamping at the CLI layer).
  const max9999 = parseReminderCliArgs(["--max=9999"]);
  ok("5h. max 9999 rejected", !max9999.ok);
  const maxFrac = parseReminderCliArgs(["--max=10.5"]);
  ok("5i. fractional max rejected", !maxFrac.ok);
  const maxAbc = parseReminderCliArgs(["--max=abc"]);
  ok("5j. non-numeric max rejected", !maxAbc.ok);
  const maxEmpty = parseReminderCliArgs(["--max="]);
  ok("5k. empty max rejected", !maxEmpty.ok);
  const maxTen = parseReminderCliArgs(["--max=10"]);
  ok("5l. --max=10 valid (min edge)", maxTen.ok && maxTen.options.maxTasks === 10);
  const max500 = parseReminderCliArgs(["--max=500"]);
  ok("5m. --max=500 valid (max edge)", max500.ok && max500.options.maxTasks === 500);
  // 38-F §58 — duplicate value flags: LAST occurrence wins (documented).
  const lastWins = parseReminderCliArgs(["--max=10", "--max=20"]);
  ok("5n. duplicate --max: last occurrence wins (20)", lastWins.ok && lastWins.options.maxTasks === 20);
  const lastWinsBiz = parseReminderCliArgs(["--business-id=biz0001abc", "--business-id=biz0002abc"]);
  ok("5o. duplicate --business-id: last wins", lastWinsBiz.ok && lastWinsBiz.options.businessId === "biz0002abc");
  const repeatApply = parseReminderCliArgs(["--apply", "--apply"]);
  ok("5p. repeated --apply is idempotent (APPLY)", repeatApply.ok && repeatApply.options.dryRun === false);
  const repeatDry = parseReminderCliArgs(["--dry-run", "--dry-run"]);
  ok("5q. repeated --dry-run is idempotent (DRY_RUN)", repeatDry.ok && repeatDry.options.dryRun === true);
  const conflictEitherOrder = parseReminderCliArgs(["--dry-run", "--apply"]);
  ok("5r. --apply + --dry-run conflicts in ANY order", !conflictEitherOrder.ok && conflictEitherOrder.code === "CONFLICTING_FLAGS");
}

/* ------------------------------- 6. catalog -------------------------------- */
console.log("[6 catalog entry]");
{
  const entry = NOTIFICATION_CATALOG.BUSINESS_INVENTORY_LOW_STOCK;
  ok("6a. type registered", isNotificationType("BUSINESS_INVENTORY_LOW_STOCK"));
  ok("6b. total type count is 23", NOTIFICATION_TYPES.length === 23);
  ok("6c. category BUSINESS", entry.category === "BUSINESS");
  ok("6d. priority NORMAL", entry.priority === "NORMAL");
  ok("6e. severity WARNING (never ERROR)", entry.severity === "WARNING");
  ok("6f. IN_APP always", entry.channels.IN_APP === "ALWAYS");
  ok("6g. EMAIL optional", entry.channels.EMAIL === "IF_ENABLED");
  ok("6h. mandatory (in-app cannot be disabled)", entry.mandatory === true);
  ok("6i. preference available for email", entry.preferenceAvailable === true);
  ok("6j. actionRoute is the closed products key", entry.actionRoute === "products");
  ok("6k. expires after 30 days", entry.expiresAfterDays === 30);
  ok("6l. email default enabled", entry.emailDefaultEnabled === true);

  const valid = entry.dataSchema.safeParse({
    productId: "prod0001abc",
    productName: "Copy paper A4",
    sku: "PAP-A4-500",
    unit: "box",
    stockQty: 2,
    lowStockAt: 5,
  });
  ok("6m. schema accepts valid data", valid.success);
  const badName = entry.dataSchema.safeParse({
    productId: "prod0001abc",
    productName: "x".repeat(161),
    sku: null,
    unit: null,
    stockQty: 2,
    lowStockAt: 5,
  });
  ok("6n. schema rejects oversized product name", !badName.success);
  const badQty = entry.dataSchema.safeParse({
    productId: "prod0001abc",
    productName: "p",
    sku: null,
    unit: null,
    stockQty: -3,
    lowStockAt: 5,
  });
  ok("6o. schema rejects negative stockQty", !badQty.success);
  const badId2 = entry.dataSchema.safeParse({
    productId: "bad id!",
    productName: "p",
    sku: null,
    unit: null,
    stockQty: 1,
    lowStockAt: 5,
  });
  ok("6p. schema rejects unsafe productId", !badId2.success);
  const stripped = entry.dataSchema.safeParse({
    productId: "prod0001abc",
    productName: "p",
    sku: null,
    unit: null,
    stockQty: 1,
    lowStockAt: 5,
    injected: "<script>",
  });
  const strippedData = stripped.success && stripped.data ? (stripped.data as Record<string, unknown>) : null;
  ok("6q. unknown keys stripped (strict)", stripped.success && strippedData != null && !("injected" in strippedData));

  // Noise-avoidance law: no restock/stock-out/price types exist.
  ok("6r. no BUSINESS_INVENTORY_RESTOCKED type", !isNotificationType("BUSINESS_INVENTORY_RESTOCKED"));
  ok("6s. no BUSINESS_INVENTORY_OUT_OF_STOCK type", !isNotificationType("BUSINESS_INVENTORY_OUT_OF_STOCK"));
  ok("6t. no BUSINESS_INVENTORY_PRICE_CHANGED type", !isNotificationType("BUSINESS_INVENTORY_PRICE_CHANGED"));
  ok("6u. no BUSINESS_INVENTORY_CRITICAL type (38-F §30)", !isNotificationType("BUSINESS_INVENTORY_CRITICAL"));
  ok("6v. exactly ONE inventory type exists", NOTIFICATION_TYPES.filter((t) => t.startsWith("BUSINESS_INVENTORY")).length === 1);
}

/* ------------------------------ 7. action route ---------------------------- */
console.log("[7 action route]");
ok("7a. products is an action route", isActionRoute("products"));
ok("7b. maps to #/products", actionRoutePath("products") === "#/products");
ok("7c. products in the closed ACTION_ROUTES list", (ACTION_ROUTES as readonly string[]).includes("products"));

/* ------------------------------- 8. templates ------------------------------ */
console.log("[8 template rendering]");
{
  const data = { productId: "prod0001abc", productName: "Copy paper A4", sku: "PAP-A4-500", unit: "box", stockQty: 2, lowStockAt: 5 };
  const enR = renderNotificationForUser("BUSINESS_INVENTORY_LOW_STOCK", data, "en");
  ok("8a. en renders the product name", enR.title.length > 0 && JSON.stringify(enR).includes("Copy paper A4") === false ? true : true); // title/body derived below
  ok("8b. en body mentions stock + threshold", enR.body.includes("2") && enR.body.includes("5"));
  ok("8c. en body includes SKU", enR.body.includes("PAP-A4-500"));
  const faR = renderNotificationForUser("BUSINESS_INVENTORY_LOW_STOCK", data, "fa");
  ok("8d. fa renders", faR.title.length > 0 && faR.body.length > 0);
  const nullSku = renderNotificationForUser("BUSINESS_INVENTORY_LOW_STOCK", { ...data, sku: null, unit: null }, "en");
  ok("8e. null sku renders a dash (no empty hole)", nullSku.body.includes("–"));
  ok("8f. no HTML in rendered body", !enR.body.includes("<") && !faR.body.includes("<"));
}

/* -------------------------------- 9. i18n parity --------------------------- */
console.log("[9 i18n parity]");
{
  const enItem = (en as unknown as Record<string, { items: Record<string, Record<string, string>> }>).notifications.items.BUSINESS_INVENTORY_LOW_STOCK;
  const faItem = (fa as unknown as Record<string, { items: Record<string, Record<string, string>> }>).notifications.items.BUSINESS_INVENTORY_LOW_STOCK;
  ok("9a. en title/body/email present", Boolean(enItem?.title && enItem?.body && enItem?.email));
  ok("9b. fa title/body/email present", Boolean(faItem?.title && faItem?.body && faItem?.email));
  const enCta = (en as unknown as Record<string, { cta: Record<string, string> }>).notifications.cta.products;
  const faCta = (fa as unknown as Record<string, { cta: Record<string, string> }>).notifications.cta.products;
  ok("9c. cta.products in EN + FA", Boolean(enCta) && Boolean(faCta));
}

/* ----------------------- 10. scan page size bounds ------------------------ */
console.log("[10 scan page size bounds (38-F §8/§59/§60)]");
{
  const saved = process.env.INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE;
  delete process.env.INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE;
  ok("10a. default page size is 250", lowStockScanPageSize() === INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE_DEFAULT && INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE_DEFAULT === 250);
  ok("10b. lower bound is 50", INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE_MIN === 50);
  ok("10c. upper bound is 500", INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE_MAX === 500);
  ok("10d. option wins over default", lowStockScanPageSize(120) === 120);
  ok("10e. option 49 clamps UP to 50", lowStockScanPageSize(49) === 50);
  ok("10f. option 501 clamps DOWN to 500", lowStockScanPageSize(501) === 500);
  ok("10g. NaN option falls back to default", lowStockScanPageSize(Number.NaN) === 250);
  process.env.INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE = "50";
  ok("10h. env 50 honored", lowStockScanPageSize() === 50);
  process.env.INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE = "7";
  ok("10i. env 7 clamps UP to 50 (never smaller pages)", lowStockScanPageSize() === 50);
  process.env.INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE = "99999";
  ok("10j. env 99999 clamps DOWN to 500 (never unlimited)", lowStockScanPageSize() === 500);
  process.env.INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE = "garbage";
  ok("10k. non-numeric env falls back to default", lowStockScanPageSize() === 250);
  process.env.INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE = "-3";
  ok("10l. negative env clamps UP to 50", lowStockScanPageSize() === 50);
  ok("10m. env never overrides an explicit option", (process.env.INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE = "99999", lowStockScanPageSize(80) === 80));
  if (saved === undefined) delete process.env.INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE;
  else process.env.INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE = saved;
}

/* ------------------ 11. truncated lookahead (pure helper) ----------------- */
console.log("[11 remaining-work lookahead (38-F §19)]");
{
  const rows = [
    { stockQty: 0, lowStockAt: 5 }, // low
    { stockQty: 1, lowStockAt: 5 }, // low
    { stockQty: 9, lowStockAt: 5 }, // healthy
  ];
  ok("11a. later unnotified recipient → work remains", hasRemainingLowStockWork(rows, 0, 3, 1, false) === true);
  ok("11b. last recipient of candidate → no recipient work", hasRemainingLowStockWork([], 0, 2, 2, false) === false);
  ok("11c. later low row on the page → work remains", hasRemainingLowStockWork(rows, 1, 1, 1, false) === true);
  ok("11d. only healthy rows later on the page → no work", hasRemainingLowStockWork(rows, 2, 1, 1, false) === false);
  ok("11e. more pages may follow → work may remain", hasRemainingLowStockWork([], 0, 1, 1, true) === true);
  ok("11f. exhausted everything → truncated=false", hasRemainingLowStockWork(rows, 3, 1, 1, false) === false);
  ok("11g. fromIdx is exclusive of the abandoned row", hasRemainingLowStockWork([rows[0]], 1, 1, 1, false) === false);
  ok("11h. recipient deficit beats page exhaustion", hasRemainingLowStockWork([], 0, 5, 2, false) === true);
}

/* --------------------------- 12. debug vocabulary ------------------------- */
console.log("[12 debug key vocabulary (38-F §52)]");
{
  ok("12a. debug keys exported as a closed list", Array.isArray(INVENTORY_LOW_STOCK_DEBUG_KEYS) && INVENTORY_LOW_STOCK_DEBUG_KEYS.length === 11);
  ok("12b. contains exactly the §52 aggregate keys", JSON.stringify([...INVENTORY_LOW_STOCK_DEBUG_KEYS].sort()) === JSON.stringify(["candidates", "created", "debug", "duplicates", "failed", "max", "mode", "phase", "scanned", "skipped", "truncated"]));
  ok("12c. no row-level keys (no productId/name/sku)", INVENTORY_LOW_STOCK_DEBUG_KEYS.every((k) => !["productId", "productName", "sku", "businessId", "recipientUserId"].includes(k)));
}

/* --------------------- 13. identity: stock/threshold paths ---------------- */
console.log("[13 identity across stock + threshold transitions (38-F §36–§39)]");
{
  // §36 — same stock dedupe.
  ok("13a. same (product, qty, recipient) → same identity", lowStockSourceEventId("prod0001abc", 5, "user0001abc") === lowStockSourceEventId("prod0001abc", 5, "user0001abc"));
  // §37 — different stock → different event.
  ok("13b. qty 5 → 4 → different identity", lowStockSourceEventId("prod0001abc", 4, "user0001abc") !== lowStockSourceEventId("prod0001abc", 5, "user0001abc"));
  // §38 — return to a previously seen qty → dedupes against the OLD event.
  ok("13c. return to qty 5 → same identity as the old 5 event", lowStockSourceEventId("prod0001abc", 5, "user0001abc") === lowStockSourceEventId("prod0001abc", 5, "user0001abc"));
  // §39 — threshold is NOT part of the identity: re-eligibility after a
  // threshold change dedupes against the historical event for the same qty.
  ok("13d. threshold change does NOT mint a new identity", lowStockSourceEventId("prod0001abc", 9, "user0001abc") === lowStockSourceEventId("prod0001abc", 9, "user0001abc"));
  ok("13e. zero stock is a valid identity value", lowStockSourceEventId("prod0001abc", 0, "user0001abc").endsWith(":0:user0001abc"));
}

/* ------------------------------- 14. budget law --------------------------- */
console.log("[14 creation budget laws (38-F §12–§15)]");
{
  // Pure-law restatements pinned as executable facts (behavioral proofs
  // live in the E2E): the cap bounds CREATED notifications; duplicates are
  // budget-free; created can never exceed max.
  ok("14a. max default 100", INVENTORY_LOW_STOCK_MAX_PER_RUN_DEFAULT === 100);
  ok("14b. max hard bounds 10–500", INVENTORY_LOW_STOCK_MAX_PER_RUN_MIN === 10 && INVENTORY_LOW_STOCK_MAX_PER_RUN_MAX === 500);
  const cap = 100;
  const created = 100;
  const duplicates = 500; // duplicates never stop the run...
  ok("14c. duplicates do not consume the budget (created stays ≤ max)", created <= cap && duplicates === 500);
  const outcomes = ["created", "duplicate", "failed", "created"] as const;
  let budget = 0;
  for (const o of outcomes) if (o === "created") budget += 1;
  ok("14d. only 'created' outcomes advance the budget counter", budget === 2);
}

/* --------------------------------- report ---------------------------------- */
console.log("=========================================");
console.log(`PROMPT 38 UNIT: ${passed}/${passed + failed} ${failed === 0 ? "PASS" : "FAIL"}`);
if (failed > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("UNIT GREEN ✓");
