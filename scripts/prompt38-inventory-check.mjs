/**
 * scripts/prompt38-inventory-check.mjs — Prompt 38 (§38-a) E2E harness.
 *
 * REAL-DB end-to-end verification of the low-stock alert pipeline through
 * the REAL CLI entry (scripts/process-inventory-low-stock.mjs) spawned as
 * an isolated process — the same way an operator's cron would run it.
 *
 * F-CLI   conflict/unknown/invalid flags → exit 1 + zero DB writes (§5–§9)
 * F-DRY   dry run counts candidates, writes NOTHING (§66 analog)
 * F-APPLY exactly 1 notification per (product, qty, recipient); recipients
 *         are OWNER+ADMIN only; IN_APP SENT + auditable EMAIL row
 * F-IDEMP second apply → duplicates, no new rows (§25/§27/§38-a identity)
 * F-QTY   restock → skip; deeper drop → NEW event; return to a seen qty →
 *         dedupe (identity law, not a history model)
 * F-EDIT  threshold edit changes eligibility (OK → low)
 * F-LIVE  deleted / deactivated products are skipped (defensive re-check)
 * F-MUT   full product-row snapshot before/after apply — byte-identical
 *         (notification-only law, dynamic proof)
 * F-MAX   --max floors to 10; INVENTORY_LOW_STOCK_MAX_PER_RUN clamps 500
 * F-DEBUG debug env emits ONLY the safe aggregate JSON (§11 analog)
 * F-PREFS preferences API exposes the new type; email toggle persists
 * F-CENTER notification center API returns the alert with the products CTA
 * AH      cleanup — fixtures deleted by identity, ZERO leftovers
 *
 * Run: bun scripts/prompt38-inventory-check.mjs
 */

import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

const BASE = "http://localhost:3000";
const PASS = "testpass123";
const TAG = `P38QA-${Date.now()}`;
let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond, info = "") {
  if (cond) passed++;
  else {
    failed++;
    failures.push(`${name}${info ? ` — ${info}` : ""}`);
  }
  console.log(`${cond ? "✓" : "✗"} ${name}${info && !cond ? ` — ${info}` : ""}`);
}

const jar = new Map();
async function f(path, init = {}) {
  const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  const headers = { "content-type": "application/json", "x-forwarded-for": "10.51.12.3", ...(init.headers ?? {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1));
  }
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function snapshotCounts() {
  return {
    notifications: await db.notification.count(),
    deliveries: await db.notificationDelivery.count(),
    products: await db.product.count(),
  };
}

function runCli(args, env = {}) {
  const proc = Bun.spawnSync({
    cmd: ["bun", "scripts/process-inventory-low-stock.mjs", ...args],
    cwd: import.meta.dir + "/..",
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}
function lastJsonLine(text) {
  const lines = text.trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch { /* skip non-JSON lines */ }
  }
  return null;
}

/* ============================== SETUP ============================== */
console.log("== SETUP ==");
await db.business.deleteMany({ where: { name: { startsWith: "P38QA-" } } });
await db.user.deleteMany({ where: { email: { contains: "p38qa-" } } });

const stamp = Date.now();
const ownerEmail = `p38qa-owner-${stamp}@test.local`;
const adminEmail = `p38qa-admin-${stamp}@test.local`;
const memberEmail = `p38qa-member-${stamp}@test.local`;
await f("/api/v1/auth/register", { method: "POST", body: JSON.stringify({ name: "P38QA Owner", email: ownerEmail, password: PASS }) });
await f("/api/v1/auth/register", { method: "POST", body: JSON.stringify({ name: "P38QA Admin", email: adminEmail, password: PASS }) });
await f("/api/v1/auth/register", { method: "POST", body: JSON.stringify({ name: "P38QA Member", email: memberEmail, password: PASS }) });

const csrf = (await f("/api/auth/csrf")).body?.csrfToken;
await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf, email: ownerEmail, password: PASS, redirect: "false", json: "true" }).toString() });
const biz = (await f("/api/v1/businesses", { method: "POST", body: JSON.stringify({ name: `${TAG}-BIZ`, currencyCode: "USD", locale: "en", timezone: "Asia/Tehran" }) })).body?.data?.business;
ok("S1 business created", Boolean(biz?.id));

const owner = await db.user.findUnique({ where: { email: ownerEmail } });
const admin = await db.user.findUnique({ where: { email: adminEmail } });
const member = await db.user.findUnique({ where: { email: memberEmail } });
ok("S2 three users exist", Boolean(owner && admin && member));

// ADMIN + MEMBER memberships via direct rows (role vocabulary is the law).
const adminMember = await db.businessMember.create({ data: { businessId: biz.id, userId: admin.id, role: "ADMIN" } });
const memberMember = await db.businessMember.create({ data: { businessId: biz.id, userId: member.id, role: "STAFF" } });
ok("S3 admin + staff memberships created", Boolean(adminMember?.id && memberMember?.id));

const pLow1 = await db.product.create({ data: { businessId: biz.id, name: `${TAG}-paper`, sku: "PAP-1", unit: "box", stockQty: 2, lowStockAt: 5, salePriceMinor: 1000, costPriceMinor: 500 } });
const pLow2 = await db.product.create({ data: { businessId: biz.id, name: `${TAG}-ink`, sku: "INK-1", unit: "set", stockQty: 0, lowStockAt: 3, salePriceMinor: 2000, costPriceMinor: 900 } });
const pOk = await db.product.create({ data: { businessId: biz.id, name: `${TAG}-desk`, sku: "DSK-1", unit: "piece", stockQty: 9, lowStockAt: 5, salePriceMinor: 5000, costPriceMinor: 2500 } });
ok("S4 three products created", Boolean(pLow1?.id && pLow2?.id && pOk?.id));

const SCOPE = ["--business-id=" + biz.id];
const RECIPIENTS = 2; // OWNER + ADMIN
const LOW_PRODUCTS = 2;

/* =============================== F-CLI =============================== */
console.log("== F-CLI CONFLICT / INVALID FLAGS ==");
{
  const before = await snapshotCounts();
  const conflict = runCli(["--apply", "--dry-run", ...SCOPE]);
  ok("C1 conflict exits 1", conflict.code === 1);
  const err1 = lastJsonLine(conflict.err);
  ok("C2 safe conflict error", err1?.error === "CLI_USAGE_INVALID" && err1?.code === "CONFLICTING_FLAGS");
  const unknown = runCli(["--foobar", ...SCOPE]);
  ok("C3 unknown flag exits 1", unknown.code === 1 && lastJsonLine(unknown.err)?.code === "UNKNOWN_FLAG");
  const maxLow = runCli(["--max=9", ...SCOPE]);
  ok("C4 max 9 exits 1", maxLow.code === 1);
  const maxHigh = runCli(["--max=10000", ...SCOPE]);
  ok("C5 max 10000 exits 1 (never silently clamped)", maxHigh.code === 1);
  const badId = runCli(["--business-id=bad id!"]);
  ok("C6 invalid business id exits 1", badId.code === 1);
  const after = await snapshotCounts();
  ok(
    "C7 zero DB writes across all invalid runs",
    before.notifications === after.notifications &&
      before.deliveries === after.deliveries &&
      before.products === after.products,
  );
  const okRun = runCli(SCOPE);
  ok("C8 default (dry) exits 0 with safe JSON result", okRun.code === 0 && lastJsonLine(okRun.out)?.result?.mode === "DRY_RUN");
  ok("C9 safe output carries no product fields", !okRun.out.includes("paper") && !okRun.out.includes("PAP-1"));
}

/* =============================== F-DRY =============================== */
console.log("== F-DRY ZERO-WRITE ==");
{
  const before = await snapshotCounts();
  const dry = runCli(SCOPE);
  const result = lastJsonLine(dry.out)?.result;
  ok("D1 dry run exits 0", dry.code === 0);
  ok(`D2 scanned exactly the 3 fixture products (got ${result?.scanned})`, result?.scanned === 3);
  ok(`D3 candidates = 2 low products (got ${result?.candidates})`, result?.candidates === LOW_PRODUCTS);
  ok(`D4 wouldCreate = candidates × recipients (got ${result?.created})`, result?.created === LOW_PRODUCTS * RECIPIENTS);
  ok("D5 zero duplicates on first sight", result?.duplicates === 0);
  const after = await snapshotCounts();
  ok(
    "D6 zero writes (notifications/deliveries/products unchanged)",
    before.notifications === after.notifications && before.deliveries === after.deliveries && before.products === after.products,
  );
}

/* =============================== F-APPLY ============================= */
console.log("== F-APPLY ==");
let apply1;
{
  const before = await snapshotCounts();
  const apply = runCli(["--apply", ...SCOPE]);
  apply1 = lastJsonLine(apply.out)?.result;
  ok("A1 apply exits 0", apply.code === 0);
  ok(`A2 created = 4 (2 products × owner+admin, got ${apply1?.created})`, apply1?.created === LOW_PRODUCTS * RECIPIENTS);
  ok(`A3 zero duplicates on first run (got ${apply1?.duplicates})`, apply1?.duplicates === 0);
  const after = await snapshotCounts();
  ok(`A4 notification rows delta = created (got ${after.notifications - before.notifications})`, after.notifications - before.notifications === LOW_PRODUCTS * RECIPIENTS);

  const ownerNotifs = await db.notification.findMany({
    where: { userId: owner.id, type: "BUSINESS_INVENTORY_LOW_STOCK" },
    include: { deliveries: true },
  });
  ok("A5 owner got both product alerts", ownerNotifs.length === LOW_PRODUCTS);
  ok("A6 every notification carries the products CTA", ownerNotifs.every((n) => n.actionRoute === "products"));
  ok("A7 dataJson holds qty + threshold, never price fields", ownerNotifs.every((n) => {
    const d = JSON.parse(n.dataJson);
    return "stockQty" in d && "lowStockAt" in d && !("costPriceMinor" in d) && !("salePriceMinor" in d);
  }));
  ok("A8 IN_APP delivery SENT", ownerNotifs.every((n) => n.deliveries.some((d) => d.channel === "IN_APP" && d.status === "SENT")));
  ok("A9 EMAIL delivery row exists and is auditable (PENDING or SKIPPED)", ownerNotifs.every((n) => n.deliveries.some((d) => d.channel === "EMAIL" && ["PENDING", "SKIPPED"].includes(d.status))));

  const adminNotifs = await db.notification.count({ where: { userId: admin.id, type: "BUSINESS_INVENTORY_LOW_STOCK" } });
  ok(`A10 ADMIN member also received both (got ${adminNotifs})`, adminNotifs === LOW_PRODUCTS);
  const memberNotifs = await db.notification.count({ where: { userId: member.id, type: "BUSINESS_INVENTORY_LOW_STOCK" } });
  ok(`A11 STAFF member received NONE (got ${memberNotifs})`, memberNotifs === 0);

  const sourceIds = ownerNotifs.map((n) => n.sourceEventId);
  ok(
    "A12 identity = inventory-low-stock:<productId>:<qty>:<userId>, no run timestamp",
    sourceIds.every((s) => /^inventory-low-stock:[a-z0-9]+:\d+:[a-z0-9]+$/.test(s)),
  );
}

/* ============================= F-IDEMPOTENT ========================== */
console.log("== F-IDEMPOTENT SECOND APPLY ==");
{
  const apply2 = runCli(["--apply", ...SCOPE]);
  const r2 = lastJsonLine(apply2.out)?.result;
  ok(`I1 second apply creates 0 (got ${r2?.created})`, r2?.created === 0);
  ok(`I2 second apply reports duplicates (got ${r2?.duplicates})`, r2?.duplicates === LOW_PRODUCTS * RECIPIENTS);
  const total = await db.notification.count({ where: { type: "BUSINESS_INVENTORY_LOW_STOCK", businessId: biz.id } });
  ok("I3 no row growth after re-run", total === LOW_PRODUCTS * RECIPIENTS);
}

/* =============================== F-QTY =============================== */
console.log("== F-QTY CHANGES ==");
{
  await db.product.update({ where: { id: pLow1.id }, data: { stockQty: 9 } }); // restock above threshold
  const rRestock = runCli(["--apply", ...SCOPE]);
  const restock = lastJsonLine(rRestock.out)?.result;
  ok("Q1 restocked product no longer a candidate (created 0)", restock?.created === 0);
  ok("Q2 restocked product counted as skipped", restock?.skipped === RECIPIENTS * 1);

  await db.product.update({ where: { id: pLow2.id }, data: { stockQty: 1 } }); // deeper drop, new qty
  const rDrop = runCli(["--apply", ...SCOPE]);
  const drop = lastJsonLine(rDrop.out)?.result;
  ok(`Q3 new qty → NEW event for ${RECIPIENTS} recipients (got ${drop?.created})`, drop?.created === RECIPIENTS);

  await db.product.update({ where: { id: pLow2.id }, data: { stockQty: 0 } }); // back to a previously-seen qty
  const rBack = runCli(["--apply", ...SCOPE]);
  const back = lastJsonLine(rBack.out)?.result;
  ok(`Q4 return to seen qty → dedupe, not a new row (got ${back?.created})`, back?.created === 0);
}

/* =============================== F-EDIT ============================== */
console.log("== F-EDIT THRESHOLD ==");
{
  await db.product.update({ where: { id: pOk.id }, data: { lowStockAt: 10 } }); // 9 ≤ 10 → now low
  const r = runCli(["--apply", ...SCOPE]);
  const res = lastJsonLine(r.out)?.result;
  ok(`E1 threshold edit changes eligibility (created ${RECIPIENTS}, got ${res?.created})`, res?.created === RECIPIENTS);
}

/* =============================== F-LIVE ============================== */
console.log("== F-LIVE RE-CHECKS ==");
{
  await db.product.update({ where: { id: pLow1.id }, data: { deletedAt: new Date() } });
  await db.product.update({ where: { id: pOk.id }, data: { isActive: false } });
  const r = runCli(["--apply", ...SCOPE]);
  const res = lastJsonLine(r.out)?.result;
  ok("L1 deleted + deactivated products excluded from the scan", res?.scanned === 1 && res?.candidates === 1);
  ok("L2 nothing new created", res?.created === 0);
}

/* =============================== F-MUT =============================== */
console.log("== F-MUT NO PRODUCT MUTATION ==");
{
  const live = await db.product.findFirst({ where: { businessId: biz.id, deletedAt: null, id: pLow2.id } });
  const before = JSON.stringify(live);
  runCli(["--apply", ...SCOPE]);
  const after = JSON.stringify(await db.product.findFirst({ where: { businessId: biz.id, deletedAt: null, id: pLow2.id } }));
  ok("M1 full product row byte-identical across an apply run", before === after);
}

/* ================================ F-MAX ============================== */
console.log("== F-MAX BOUNDS ==");
{
  const rFloor = runCli(["--max=10", ...SCOPE]);
  ok("X1 --max=10 accepted and reported", rFloor.code === 0 && lastJsonLine(rFloor.out)?.result?.max === 10);
  const rEnv = runCli(SCOPE, { INVENTORY_LOW_STOCK_MAX_PER_RUN: "5000" });
  ok("X2 env 5000 clamps DOWN to 500", rEnv.code === 0 && lastJsonLine(rEnv.out)?.result?.max === 500);
  const rEnvLow = runCli(SCOPE, { INVENTORY_LOW_STOCK_MAX_PER_RUN: "0" });
  ok("X3 env 0 clamps UP to 10", rEnvLow.code === 0 && lastJsonLine(rEnvLow.out)?.result?.max === 10);
}

/* =============================== F-DEBUG ============================= */
console.log("== F-DEBUG SAFE OUTPUT ==");
{
  const r = runCli(SCOPE, { INVENTORY_LOW_STOCK_DEBUG: "1" });
  const lines = r.out.trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const debugLine = lines.find((o) => o.debug === "inventory-low-stock");
  ok("G1 debug line present and JSON", Boolean(debugLine));
  ok(
    "G2 debug carries ONLY safe aggregate keys",
    debugLine &&
      JSON.stringify(Object.keys(debugLine).sort()) ===
        JSON.stringify(["debug", "lowStockScanned", "max", "mode", "phase", "scanned"]),
  );
  ok("G3 debug leaks no product/business ids", !JSON.stringify(lines).includes(biz.id) && !JSON.stringify(lines).includes(pLow2.id));
}

/* =============================== F-PREFS ============================= */
console.log("== F-PREFS PREFERENCES API ==");
{
  const csrf2 = (await f("/api/auth/csrf")).body?.csrfToken;
  await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf2, email: ownerEmail, password: PASS, redirect: "false", json: "true" }).toString() });
  const prefs = await f("/api/v1/me/notification-preferences");
  const rows = prefs.body?.preferences?.filter((p) => p.notificationType === "BUSINESS_INVENTORY_LOW_STOCK") ?? [];
  ok("P1 preferences list includes the new type", rows.length >= 1);
  const inApp = rows.find((p) => p.channel === "IN_APP");
  const email = rows.find((p) => p.channel === "EMAIL");
  ok("P2 IN_APP is ALWAYS (not disableable)", Boolean(inApp) && inApp.canDisable === false);
  ok("P3 EMAIL is preference-controlled", Boolean(email) && email.canDisable === true);
  const put = await f("/api/v1/me/notification-preferences", {
    method: "PUT",
    body: JSON.stringify({ notificationType: "BUSINESS_INVENTORY_LOW_STOCK", channel: "EMAIL", enabled: false }),
  });
  ok("P4 email preference PUT persists", put.status === 200 && put.body?.preference?.enabled === false);
  await f("/api/v1/me/notification-preferences", {
    method: "PUT",
    body: JSON.stringify({ notificationType: "BUSINESS_INVENTORY_LOW_STOCK", channel: "EMAIL", enabled: true }),
  });
}

/* =============================== F-CENTER ============================ */
console.log("== F-CENTER NOTIFICATION CENTER API ==");
{
  const list = await f("/api/v1/me/notifications");
  const low = list.body?.data?.items?.filter((n) => n.type === "BUSINESS_INVENTORY_LOW_STOCK") ?? [];
  ok("N1 center lists the low-stock alerts", low.length >= 1);
  ok("N2 CTA is the products route", low.every((n) => n.actionRoute === "products"));
  ok("N3 severity WARNING surfaced", low.every((n) => n.severity === "WARNING"));
  const health = await fetch(`${BASE}/api/health`);
  ok("N4 health 200 after all runs", health.status === 200);
}

/* ============================ AH CLEANUP ============================= */
console.log("== AH CLEANUP ==");
{
  const delN = await db.notification.deleteMany({ where: { businessId: biz.id } });
  const delD = await db.notificationDelivery.deleteMany({ where: { notificationId: { not: undefined }, notification: { businessId: biz.id } } });
  ok(`H1 fixture notifications deleted (${delN.count})`, delN.count >= LOW_PRODUCTS * RECIPIENTS);
  await db.businessMember.deleteMany({ where: { businessId: biz.id } });
  await db.product.deleteMany({ where: { businessId: biz.id } });
  await db.business.delete({ where: { id: biz.id } });
  await db.user.deleteMany({ where: { id: { in: [owner.id, admin.id, member.id] } } });
  const leftB = await db.business.count({ where: { name: { startsWith: "P38QA-" } } });
  const leftU = await db.user.count({ where: { email: { contains: "p38qa-" } } });
  const leftN = await db.notification.count({ where: { businessId: biz.id } });
  ok("H2 zero fixture leftovers (biz/users/notifications)", leftB === 0 && leftU === 0 && leftN === 0);
}

/* --------------------------------- report ---------------------------------- */
console.log("=========================================");
console.log(`PROMPT 38 INVENTORY CHECK: ${passed}/${passed + failed} ${failed === 0 ? "PASS" : "FAIL"}`);
if (failed > 0) {
  console.error("FAILURES:");
  for (const fl of failures) console.error("  - " + fl);
  process.exit(1);
}
console.log("P38 E2E GREEN ✓");
process.exit(0);
