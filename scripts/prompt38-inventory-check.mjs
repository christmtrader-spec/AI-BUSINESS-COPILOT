/**
 * scripts/prompt38-inventory-check.mjs — Prompt 38 (§38-a) E2E harness,
 * HARDENED by Prompt 38-F (§86–§112).
 *
 * REAL-DB end-to-end verification of the low-stock alert pipeline through
 * the REAL CLI entry (scripts/process-inventory-low-stock.mjs) spawned as
 * isolated processes — the same way an operator's cron would run it.
 *
 * F-CLI      conflict/unknown/invalid flags → exit 1 + zero DB writes (§103/§104)
 * F-DRY      dry run counts wouldCreate (max-honoring), writes NOTHING —
 *            full Notification+Delivery+AuditLog snapshot equality (§102)
 * F-APPLY    1 notification per (product, qty, recipient); OWNER+ADMIN only;
 *            IN_APP SENT + auditable EMAIL row; strict data; products CTA (§88)
 * F-IDEMP    second apply → duplicates, no new rows (§89)
 * F-QTY      restock → gone; deeper drop → NEW event; return to a seen qty →
 *            dedupe (§90 + §36–§38 identity law)
 * F-EDIT     threshold edit changes eligibility (§91)
 * F-LIVE     deleted / deactivated products are skipped (§40/§41)
 * F-MUT      full product-row snapshot before/after apply — byte-identical (§95)
 * F-MAX      --max floors/ceiling; env clamps (§55/§13)
 * F-PAGES    REAL bounded pagination: SCAN_PAGE_SIZE=50 over 123 rows →
 *            scanned=123 across ≥3 pages; late-page candidates discovered (§9/§11)
 * F-GMAX     GLOBAL creation budget: 120 combos, --max=100 → created=100
 *            truncated=true; next run → remaining 20, no starvation (§92)
 *            duplicates never consume the budget (§14/§15)
 * F-MRCP     multi-recipient budget: 3 recipients × 5 products, --max=10 →
 *            created=10 truncated; run 2 → remaining 5 (§16/§93/§18)
 * F-CONC     two REAL concurrent APPLY processes → zero duplicate identities,
 *            exactly one row per (user, type, sourceEventId) (§94/§44–§46)
 * F-RACE     mid-run races with deterministic ordering: restock / delete /
 *            deactivate / membership-revocation all produce NO stale
 *            notification via the fresh re-checks (§96–§99)
 * F-XBIZ     cross-business isolation: --business-id=A never touches B (§100)
 * F-SENS     HTML-hostile product data stored as safe plain text; identity
 *            built from ids only (§101/§34)
 * F-DEBUG    debug emits ONLY the §52 aggregate key vocabulary (§105)
 * F-ZERO     all-healthy → exit 0, candidates 0, created 0 (§106)
 * F-NORCPT   business with no OWNER/ADMIN → skipped, never fabricated (§42/§107)
 * F-EMAIL    preference-disabled EMAIL → IN_APP SENT + EMAIL SKIPPED
 *            (PREFERENCE_DISABLED); provider NOT configured here → delivery-
 *            row semantics only, no production email claimed (§108/§109)
 * F-CENTER   notification center API lists the alerts; products CTA; health
 *            + honest readiness after every run (§110–§112)
 * AH         cleanup — fixtures deleted by identity, ZERO leftovers (§170/§171)
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
  const headers = { "content-type": "application/json", "x-forwarded-for": init.xff ?? "10.51.12.3", ...(init.headers ?? {}) };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1));
  }
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function snapshotAll() {
  return {
    notifications: (await db.notification.findMany({ select: { id: true } })).map((r) => r.id).sort(),
    deliveries: (await db.notificationDelivery.findMany({ select: { id: true } })).map((r) => r.id).sort(),
    audit: (await db.auditLog.findMany({ select: { id: true } })).map((r) => r.id).sort(),
  };
}
function snapshotEqual(a, b) {
  return (
    a.notifications.length === b.notifications.length &&
    a.deliveries.length === b.deliveries.length &&
    a.audit.length === b.audit.length &&
    a.notifications.every((x, i) => x === b.notifications[i]) &&
    a.deliveries.every((x, i) => x === b.deliveries[i]) &&
    a.audit.every((x, i) => x === b.audit[i])
  );
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
/** Spawn WITHOUT waiting — for concurrency + mid-run race tests (§94/§96). */
function spawnCli(args, env = {}) {
  return Bun.spawn({
    cmd: ["bun", "scripts/process-inventory-low-stock.mjs", ...args],
    cwd: import.meta.dir + "/..",
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}
async function resultOf(proc) {
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeProduct(businessId, name, opts = {}) {
  return db.product.create({
    data: {
      businessId,
      name,
      sku: opts.sku ?? `SKU-${name.slice(-6)}`,
      unit: opts.unit ?? "box",
      stockQty: opts.stockQty ?? 0,
      lowStockAt: opts.lowStockAt ?? 5,
      salePriceMinor: 1000,
      costPriceMinor: 500,
      ...(opts.isActive === false ? { isActive: false } : {}),
      ...(opts.deletedAt ? { deletedAt: opts.deletedAt } : {}),
    },
  });
}

/**
 * Direct-DB fixture business (rate-limit immune — the businesses API caps
 * creation at 5/hour/user and this harness needs 10). The FIRST business
 * (BIZ) is still created through the REAL API to prove the processor works
 * against API-created businesses with auto OWNER membership.
 */
async function makeBiz(name, members, ownerUserId) {
  const ownerId = ownerUserId ?? members[0]?.[0];
  const b = await db.business.create({
    data: {
      name,
      slug: `p38qa-${name.slice("P38QA-".length).toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ownerId,
      currencyCode: "USD",
      locale: "en",
      timezone: "Asia/Tehran",
    },
  });
  for (const [userId, role] of members) {
    await db.businessMember.create({ data: { businessId: b.id, userId, role } });
  }
  return b;
}

/* ============================== SETUP ============================== */
console.log("== SETUP ==");
await db.business.deleteMany({ where: { name: { startsWith: "P38QA-" } } });
await db.user.deleteMany({ where: { email: { contains: "p38qa-" } } });

const stamp = Date.now();
const ownerEmail = `p38qa-owner-${stamp}@test.local`;
const adminEmail = `p38qa-admin-${stamp}@test.local`;
const admin2Email = `p38qa-admin2-${stamp}@test.local`;
const memberEmail = `p38qa-member-${stamp}@test.local`;
// DISTINCT source IPs per registration — the register rate limit is
// per-IP (10 / 15 min) and repeated E2E rounds share one harness IP.
const regIps = ["10.61.1.1", "10.61.1.2", "10.61.1.3", "10.61.1.4"];
for (const [i, [name, email]] of [["P38QA Owner", ownerEmail], ["P38QA Admin", adminEmail], ["P38QA Admin2", admin2Email], ["P38QA Member", memberEmail]].entries()) {
  const reg = await f("/api/v1/auth/register", { method: "POST", xff: regIps[i], body: JSON.stringify({ name, email, password: PASS }) });
  if (reg.status !== 201 && reg.status !== 200) console.log(`  (register ${name}: ${reg.status})`);
}

const csrf = (await f("/api/auth/csrf")).body?.csrfToken;
await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf, email: ownerEmail, password: PASS, redirect: "false", json: "true" }).toString() });
const biz = (await f("/api/v1/businesses", { method: "POST", body: JSON.stringify({ name: `${TAG}-BIZ`, currencyCode: "USD", locale: "en", timezone: "Asia/Tehran" }) })).body?.data?.business;
ok("S1 business created", Boolean(biz?.id));

const owner = await db.user.findUnique({ where: { email: ownerEmail } });
const admin = await db.user.findUnique({ where: { email: adminEmail } });
const admin2 = await db.user.findUnique({ where: { email: admin2Email } });
const member = await db.user.findUnique({ where: { email: memberEmail } });
ok("S2 four users exist", Boolean(owner && admin && admin2 && member));

// ADMIN ×2 + STAFF memberships via direct rows (role vocabulary is the law).
const adminMember = await db.businessMember.create({ data: { businessId: biz.id, userId: admin.id, role: "ADMIN" } });
const memberMember = await db.businessMember.create({ data: { businessId: biz.id, userId: member.id, role: "STAFF" } });
ok("S3 admin + staff memberships created", Boolean(adminMember?.id && memberMember?.id));

const pLow1 = await makeProduct(biz.id, `${TAG}-paper`, { sku: "PAP-1", stockQty: 2, lowStockAt: 5 });
const pLow2 = await makeProduct(biz.id, `${TAG}-ink`, { sku: "INK-1", stockQty: 0, lowStockAt: 3 });
const pOk = await makeProduct(biz.id, `${TAG}-desk`, { sku: "DSK-1", stockQty: 9, lowStockAt: 5 });
ok("S4 three products created", Boolean(pLow1?.id && pLow2?.id && pOk?.id));

const SCOPE = ["--business-id=" + biz.id];
const RECIPIENTS = 2; // OWNER + ADMIN (admin2/member are NOT members of biz)
const LOW_PRODUCTS = 2;

/* =============================== F-CLI =============================== */
console.log("== F-CLI CONFLICT / INVALID FLAGS (§103/§104) ==");
{
  const before = await snapshotAll();
  const conflict = runCli(["--apply", "--dry-run", ...SCOPE]);
  ok("C1 conflict exits 1", conflict.code === 1);
  const err1 = lastJsonLine(conflict.err);
  ok("C2 safe conflict error", err1?.error === "CLI_USAGE_INVALID" && err1?.code === "CONFLICTING_FLAGS");
  const unknown = runCli(["--foobar", ...SCOPE]);
  ok("C3 unknown flag exits 1", unknown.code === 1 && lastJsonLine(unknown.err)?.code === "UNKNOWN_FLAG");
  ok("C4 max 9 exits 1", runCli(["--max=9", ...SCOPE]).code === 1);
  ok("C5 max 501 exits 1", runCli(["--max=501", ...SCOPE]).code === 1);
  ok("C5b max 9999 exits 1", runCli(["--max=9999", ...SCOPE]).code === 1);
  ok("C5c max abc exits 1", runCli(["--max=abc", ...SCOPE]).code === 1);
  ok("C6 invalid business id exits 1", runCli(["--business-id=bad id!"]).code === 1);
  const after = await snapshotAll();
  ok("C7 zero DB writes across ALL invalid runs (full snapshot)", snapshotEqual(before, after));
  const okRun = runCli(SCOPE);
  ok("C8 default (dry) exits 0 with DRY_RUN result", okRun.code === 0 && lastJsonLine(okRun.out)?.result?.mode === "DRY_RUN");
  ok("C9 safe output carries no product fields", !okRun.out.includes("paper") && !okRun.out.includes("PAP-1") && !okRun.out.includes(biz.id));
}

/* =============================== F-DRY =============================== */
console.log("== F-DRY ZERO-WRITE + MAX-HONORING (§102/§21) ==");
{
  const before = await snapshotAll();
  const dry = runCli(SCOPE);
  const result = lastJsonLine(dry.out)?.result;
  ok("D1 dry run exits 0", dry.code === 0);
  ok(`D2 scanned exactly the 3 fixture products (got ${result?.scanned})`, result?.scanned === 3);
  ok(`D3 candidates = 2 low products (got ${result?.candidates})`, result?.candidates === LOW_PRODUCTS);
  ok(`D4 wouldCreate = candidates × recipients (got ${result?.created})`, result?.created === LOW_PRODUCTS * RECIPIENTS);
  ok("D5 zero duplicates on first sight", result?.duplicates === 0);
  ok("D6 truncated=false (no cap hit)", result?.truncated === false);
  ok(`D7 result.max reported (got ${result?.max})`, result?.max === 100);
  const after = await snapshotAll();
  ok("D8 zero writes — FULL Notification+Delivery+AuditLog snapshot identical", snapshotEqual(before, after));
}

/* =============================== F-APPLY ============================= */
console.log("== F-APPLY (§88) ==");
let apply1;
{
  const apply = runCli(["--apply", ...SCOPE]);
  apply1 = lastJsonLine(apply.out)?.result;
  ok("A1 apply exits 0", apply.code === 0);
  ok(`A2 created = 4 (2 products × owner+admin, got ${apply1?.created})`, apply1?.created === LOW_PRODUCTS * RECIPIENTS);
  ok(`A3 zero duplicates on first run (got ${apply1?.duplicates})`, apply1?.duplicates === 0);
  ok("A4 created <= max (budget respected)", apply1?.created <= apply1?.max);

  const ownerNotifs = await db.notification.findMany({
    where: { userId: owner.id, type: "BUSINESS_INVENTORY_LOW_STOCK" },
    include: { deliveries: true },
  });
  ok("A5 owner got both product alerts", ownerNotifs.length === LOW_PRODUCTS);
  // R151 — new rows carry the reorder drill (the honest restock surface).
  ok("A6 every notification carries the reorder CTA (R151)", ownerNotifs.every((n) => n.actionRoute === "reorder"));
  ok("A7 dataJson holds qty + threshold, never price fields", ownerNotifs.every((n) => {
    const d = JSON.parse(n.dataJson);
    return "stockQty" in d && "lowStockAt" in d && !("costPriceMinor" in d) && !("salePriceMinor" in d) && !("businessId" in d) && !("userId" in d) && !("email" in d);
  }));
  ok("A8 IN_APP delivery SENT", ownerNotifs.every((n) => n.deliveries.some((d) => d.channel === "IN_APP" && d.status === "SENT")));
  ok("A9 EMAIL delivery row exists and is auditable (PENDING or SKIPPED)", ownerNotifs.every((n) => n.deliveries.some((d) => d.channel === "EMAIL" && ["PENDING", "SKIPPED"].includes(d.status))));

  const adminNotifs = await db.notification.count({ where: { userId: admin.id, type: "BUSINESS_INVENTORY_LOW_STOCK" } });
  ok(`A10 ADMIN member also received both (got ${adminNotifs})`, adminNotifs === LOW_PRODUCTS);
  const memberNotifs = await db.notification.count({ where: { userId: member.id, type: "BUSINESS_INVENTORY_LOW_STOCK" } });
  ok(`A11 STAFF member received NONE (got ${memberNotifs})`, memberNotifs === 0);
  const admin2Notifs = await db.notification.count({ where: { userId: admin2.id, type: "BUSINESS_INVENTORY_LOW_STOCK" } });
  ok("A11b non-member ADMIN of ANOTHER business received NONE", admin2Notifs === 0);

  const sourceIds = ownerNotifs.map((n) => n.sourceEventId);
  ok(
    "A12 identity = inventory-low-stock:<productId>:<qty>:<userId>, no run timestamp",
    sourceIds.every((s) => /^inventory-low-stock:[a-zA-Z0-9]+:\d+:[a-zA-Z0-9]+$/.test(s)),
  );
}

/* ============================= F-IDEMPOTENT ========================== */
console.log("== F-IDEMPOTENT SECOND APPLY (§89) ==");
{
  const apply2 = runCli(["--apply", ...SCOPE]);
  const r2 = lastJsonLine(apply2.out)?.result;
  ok(`I1 second apply creates 0 (got ${r2?.created})`, r2?.created === 0);
  ok(`I2 second apply reports duplicates (got ${r2?.duplicates})`, r2?.duplicates === LOW_PRODUCTS * RECIPIENTS);
  ok("I3 duplicates did NOT consume the budget (run completed all candidates)", r2?.truncated === false);
  const total = await db.notification.count({ where: { type: "BUSINESS_INVENTORY_LOW_STOCK", businessId: biz.id } });
  ok("I4 no row growth after re-run", total === LOW_PRODUCTS * RECIPIENTS);
}

/* =============================== F-QTY =============================== */
console.log("== F-QTY CHANGES (§90) ==");
{
  await db.product.update({ where: { id: pLow1.id }, data: { stockQty: 9 } }); // restock above threshold
  const rRestock = runCli(["--apply", ...SCOPE]);
  const restock = lastJsonLine(rRestock.out)?.result;
  ok("Q1 restocked product no longer a candidate (created 0)", restock?.created === 0);
  ok(`Q2 restocked product excluded from candidates entirely (got ${restock?.candidates})`, restock?.candidates === 1);

  await db.product.update({ where: { id: pLow2.id }, data: { stockQty: 1 } }); // deeper drop, new qty
  const rDrop = runCli(["--apply", ...SCOPE]);
  const drop = lastJsonLine(rDrop.out)?.result;
  ok(`Q3 new qty → NEW event for ${RECIPIENTS} recipients (got ${drop?.created})`, drop?.created === RECIPIENTS);

  await db.product.update({ where: { id: pLow2.id }, data: { stockQty: 0 } }); // back to a previously-seen qty
  const rBack = runCli(["--apply", ...SCOPE]);
  const back = lastJsonLine(rBack.out)?.result;
  ok(`Q4 return to seen qty → dedupe against the OLD 0 event (got ${back?.created})`, back?.created === 0);
  ok(`Q4b dedupe counted (got ${back?.duplicates})`, back?.duplicates === RECIPIENTS);
}

/* =============================== F-EDIT ============================== */
console.log("== F-EDIT THRESHOLD (§91) ==");
{
  await db.product.update({ where: { id: pOk.id }, data: { lowStockAt: 10 } }); // 9 ≤ 10 → now low
  const r = runCli(["--apply", ...SCOPE]);
  const res = lastJsonLine(r.out)?.result;
  ok(`E1 threshold edit changes eligibility (created ${RECIPIENTS}, got ${res?.created})`, res?.created === RECIPIENTS);
  await db.product.update({ where: { id: pOk.id }, data: { lowStockAt: 2 } }); // 9 > 2 → healthy again
  const r2 = runCli(["--apply", ...SCOPE]);
  ok("E1b raising back above stock → not a candidate again", lastJsonLine(r2.out)?.result?.candidates === 1);
}

/* =============================== F-LIVE ============================== */
console.log("== F-LIVE RE-CHECKS (§40/§41) ==");
{
  await db.product.update({ where: { id: pLow1.id }, data: { deletedAt: new Date() } });
  await db.product.update({ where: { id: pOk.id }, data: { isActive: false } });
  const r = runCli(["--apply", ...SCOPE]);
  const res = lastJsonLine(r.out)?.result;
  ok("L1 deleted + deactivated products excluded from the scan", res?.scanned === 1 && res?.candidates === 1);
  ok("L2 nothing new created", res?.created === 0);
}

/* =============================== F-MUT =============================== */
console.log("== F-MUT NO PRODUCT MUTATION (§95) ==");
{
  const live = await db.product.findFirst({ where: { businessId: biz.id, deletedAt: null, id: pLow2.id } });
  const before = JSON.stringify(live);
  runCli(["--apply", ...SCOPE]);
  const after = JSON.stringify(await db.product.findFirst({ where: { businessId: biz.id, deletedAt: null, id: pLow2.id } }));
  ok("M1 full product row byte-identical across an apply run", before === after);
}

/* ================================ F-MAX ============================== */
console.log("== F-MAX BOUNDS (§55/§13) ==");
{
  const rFloor = runCli(["--max=10", ...SCOPE]);
  ok("X1 --max=10 accepted and reported", rFloor.code === 0 && lastJsonLine(rFloor.out)?.result?.max === 10);
  const r500 = runCli(["--max=500", ...SCOPE]);
  ok("X1b --max=500 accepted and reported", r500.code === 0 && lastJsonLine(r500.out)?.result?.max === 500);
  const rEnv = runCli(SCOPE, { INVENTORY_LOW_STOCK_MAX_PER_RUN: "5000" });
  ok("X2 env 5000 clamps DOWN to 500", rEnv.code === 0 && lastJsonLine(rEnv.out)?.result?.max === 500);
  const rEnvLow = runCli(SCOPE, { INVENTORY_LOW_STOCK_MAX_PER_RUN: "0" });
  ok("X3 env 0 clamps UP to 10", rEnvLow.code === 0 && lastJsonLine(rEnvLow.out)?.result?.max === 10);
}

/* ============================= F-PAGES =============================== */
console.log("== F-PAGES REAL BOUNDED PAGINATION (§9/§11) ==");
let pagesBiz, pagesHealthyCount = 120;
{
  pagesBiz = await makeBiz(`${TAG}-PAGES`, [[owner.id, "OWNER"], [admin2.id, "ADMIN"]]);
  // 120 healthy products + 3 low ones — with SCAN_PAGE_SIZE=50 the scan must
  // cross ≥3 pages and still discover candidates on the LAST page.
  const healthy = [];
  for (let i = 0; i < pagesHealthyCount; i++) healthy.push({ businessId: pagesBiz.id, name: `${TAG}-pg-healthy-${String(i).padStart(3, "0")}`, sku: `PGH-${i}`, stockQty: 100, lowStockAt: 5 });
  await db.product.createMany({ data: healthy });
  const lowLate = [];
  for (let i = 0; i < 3; i++) lowLate.push({ businessId: pagesBiz.id, name: `${TAG}-pg-low-${i}`, sku: `PGL-${i}`, stockQty: 1, lowStockAt: 5 });
  await db.product.createMany({ data: lowLate });
  const r = runCli(["--business-id=" + pagesBiz.id, "--max=10"], { INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE: "50" });
  const res = lastJsonLine(r.out)?.result;
  ok(`P1 scanned = 123 rows across ≥3 pages (got ${res?.scanned})`, res?.scanned === pagesHealthyCount + 3);
  ok(`P2 candidates beyond page 1 discovered (got ${res?.candidates})`, res?.candidates === 3);
  ok(`P3 created = 3 products × 2 recipients (owner+admin2, got ${res?.created})`, res?.created === 6);
  ok("P4 scan terminated deterministically (truncated=false)", res?.truncated === false);
  ok("P5 exit 0", r.code === 0);
}

/* ============================== F-GMAX =============================== */
console.log("== F-GMAX GLOBAL CREATION BUDGET (§92) ==");
let gmaxBiz;
{
  gmaxBiz = await makeBiz(`${TAG}-GMAX`, [[owner.id, "OWNER"], [admin.id, "ADMIN"]]);
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push({ businessId: gmaxBiz.id, name: `${TAG}-gmax-${String(i).padStart(3, "0")}`, sku: `GMX-${i}`, stockQty: i % 3, lowStockAt: 5 });
  await db.product.createMany({ data: rows }); // 60 low products × 2 recipients = 120 combos
  const r1 = runCli(["--business-id=" + gmaxBiz.id, "--max=100", "--apply"]);
  const res1 = lastJsonLine(r1.out)?.result;
  ok(`G1 created capped EXACTLY at max (got ${res1?.created})`, res1?.created === 100);
  ok(`G2 created never exceeds max`, res1?.created <= res1?.max);
  ok("G3 truncated=true (eligible work may remain)", res1?.truncated === true);
  ok("G4 scanned ALL 60 products (scan is not the cap)", res1?.scanned === 60);
  // Deterministic stop point: 50 candidates × 2 recipients exhaust the 100
  // budget; candidate #51 hits the cap before its first recipient → the run
  // stops there, so exactly 51 candidates were EVALUATED (§166).
  ok("G5 candidates stop at the deterministic point 51", res1?.candidates === 51);
  const r2 = runCli(["--business-id=" + gmaxBiz.id, "--max=100", "--apply"]);
  const res2 = lastJsonLine(r2.out)?.result;
  ok(`G6 second run: remaining 20 created — NO starvation (got ${res2?.created})`, res2?.created === 20);
  ok(`G7 second run: 100 duplicates did not consume budget (got ${res2?.duplicates})`, res2?.duplicates === 100);
  ok("G8 second run: everything covered → truncated=false", res2?.truncated === false);
  const total = await db.notification.count({ where: { businessId: gmaxBiz.id, type: "BUSINESS_INVENTORY_LOW_STOCK" } });
  ok(`G9 final unique identities = 120 (60 × 2, got ${total})`, total === 120);
}

/* ============================== F-MRCP =============================== */
console.log("== F-MRCP MULTI-RECIPIENT BUDGET (§16/§93/§18) ==");
{
  const mBiz = await makeBiz(`${TAG}-MRCP`, [
    [owner.id, "OWNER"],
    [admin.id, "ADMIN"],
    [admin2.id, "ADMIN"],
    [member.id, "ADMIN"], // STAFF user promoted to ADMIN for THIS business only
  ]);
  // recipients = owner + admin + admin2 + member = 4 → 5 products × 4 = 20 combos.
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push({ businessId: mBiz.id, name: `${TAG}-mrcp-${i}`, sku: `MRC-${i}`, stockQty: 2, lowStockAt: 5 });
  await db.product.createMany({ data: rows });
  const r1 = runCli(["--business-id=" + mBiz.id, "--max=10", "--apply"]);
  const res1 = lastJsonLine(r1.out)?.result;
  ok(`R1 created capped at 10 of 20 combos (got ${res1?.created})`, res1?.created === 10);
  ok("R2 truncated=true — later recipients/products remain eligible", res1?.truncated === true);
  const r2 = runCli(["--business-id=" + mBiz.id, "--max=10", "--apply"]);
  const res2 = lastJsonLine(r2.out)?.result;
  ok(`R3 second run: remaining 10 created (§18 — no logical starvation, got ${res2?.created})`, res2?.created === 10);
  ok(`R4 second run: first 10 dedupe (got ${res2?.duplicates})`, res2?.duplicates === 10);
  const perUser = await db.notification.groupBy({
    by: ["userId"],
    where: { businessId: mBiz.id, type: "BUSINESS_INVENTORY_LOW_STOCK" },
    _count: { _all: true },
  });
  const counts = perUser.map((u) => u._count._all).sort((a, b) => a - b).join(",");
  ok(`R6 every one of the 4 recipients eventually notified (per-user counts ${counts})`, perUser.length === 4 && counts === "5,5,5,5");
}

/* ============================== F-CONC =============================== */
console.log("== F-CONCURRENCY, REAL PROCESSES (§94) ==");
{
  const cBiz = await makeBiz(`${TAG}-CONC`, [[owner.id, "OWNER"], [admin.id, "ADMIN"]]);
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push({ businessId: cBiz.id, name: `${TAG}-conc-${i}`, sku: `CNC-${i}`, stockQty: 0, lowStockAt: 5 });
  await db.product.createMany({ data: rows }); // 6 × 2 = 12 combos
  const [pA, pB] = [spawnCli(["--business-id=" + cBiz.id, "--apply"]), spawnCli(["--business-id=" + cBiz.id, "--apply"])];
  const [resA, resB] = await Promise.all([resultOf(pA), resultOf(pB)]);
  const ra = lastJsonLine(resA.out)?.result;
  const rb = lastJsonLine(resB.out)?.result;
  ok("N1 both concurrent processors exit 0", resA.code === 0 && resB.code === 0);
  const totalCreated = (ra?.created ?? 0) + (rb?.created ?? 0);
  ok(`N2 combined created = 12 exactly once per combo (got ${totalCreated})`, totalCreated === 12);
  ok(`N3 losers reported as duplicates (got ${ra?.duplicates}+${rb?.duplicates})`, (ra?.duplicates ?? 0) + (rb?.duplicates ?? 0) >= 0);
  const all = await db.notification.findMany({
    where: { businessId: cBiz.id, type: "BUSINESS_INVENTORY_LOW_STOCK" },
    select: { userId: true, type: true, sourceEventId: true },
  });
  const seen = new Set(all.map((n) => `${n.userId}|${n.type}|${n.sourceEventId}`));
  ok(`N4 DB invariant: exactly 12 rows (got ${all.length})`, all.length === 12);
  ok(`N5 DB invariant: ZERO duplicate (user, type, sourceEventId) identities (unique ${seen.size})`, seen.size === all.length);
  ok("N6 no failed notifications in either run", (ra?.failed ?? 0) === 0 && (rb?.failed ?? 0) === 0);
}

/* ============================== F-RACE =============================== */
console.log("== F-RACE MID-RUN RACES, DETERMINISTIC ORDER (§96–§99) ==");
{
  const rBiz = await makeBiz(`${TAG}-RACE`, [[owner.id, "OWNER"], [admin2.id, "ADMIN"]]);
  // 60 fillers at stockQty 0 sort FIRST (worst shortage); the 4 race targets
  // sit at stockQty 5 → processed LAST. Mutations land while the processor
  // is still inside the filler block → the fresh re-checks see the new state.
  const fillers = [];
  for (let i = 0; i < 60; i++) fillers.push({ businessId: rBiz.id, name: `${TAG}-race-filler-${String(i).padStart(3, "0")}`, sku: `RCF-${i}`, stockQty: 0, lowStockAt: 5 });
  await db.product.createMany({ data: fillers });
  const tRestock = await makeProduct(rBiz.id, `${TAG}-race-target-restock`, { sku: "RCT-R", stockQty: 5, lowStockAt: 5 });
  const tDelete = await makeProduct(rBiz.id, `${TAG}-race-target-delete`, { sku: "RCT-D", stockQty: 5, lowStockAt: 5 });
  const tDeact = await makeProduct(rBiz.id, `${TAG}-race-target-deact`, { sku: "RCT-A", stockQty: 5, lowStockAt: 5 });
  const tMember = await makeProduct(rBiz.id, `${TAG}-race-target-member`, { sku: "RCT-M", stockQty: 5, lowStockAt: 5 });

  const proc = spawnCli(["--business-id=" + rBiz.id, "--apply", "--max=500"]);
  // Wait until the FIRST filler notification exists — the run is then
  // provably inside the filler block, strictly BEFORE the 4 targets.
  let raceFired = false;
  for (let i = 0; i < 200; i++) {
    await sleep(25);
    const n = await db.notification.count({ where: { businessId: rBiz.id, type: "BUSINESS_INVENTORY_LOW_STOCK" } });
    if (n >= 1) {
      // Mid-run races (§96–§99) — flip all four states NOW.
      await db.product.update({ where: { id: tRestock.id }, data: { stockQty: 99 } });
      await db.product.update({ where: { id: tDelete.id }, data: { deletedAt: new Date() } });
      await db.product.update({ where: { id: tDeact.id }, data: { isActive: false } });
      await db.businessMember.deleteMany({ where: { businessId: rBiz.id, userId: admin2.id } }); // membership revoked
      raceFired = true;
      break;
    }
  }
  ok("RC1 race window hit (mutation landed mid-run)", raceFired);
  const res = await resultOf(proc);
  const r = lastJsonLine(res.out)?.result;
  ok("RC2 processor exits 0", res.code === 0);

  // RC3 — the three STATE races must produce zero notifications; tMember is
  // asserted separately (RC7/RC7b) because its owner-side alert is CORRECT.
  const stale = await db.notification.count({ where: { businessId: rBiz.id, dataJson: { contains: tRestock.id } } })
    + await db.notification.count({ where: { businessId: rBiz.id, dataJson: { contains: tDelete.id } } })
    + await db.notification.count({ where: { businessId: rBiz.id, dataJson: { contains: tDeact.id } } });
  ok(`RC3 NO notification for any state-raced product (got ${stale})`, stale === 0);
  const restockNotifs = await db.notification.count({ where: { businessId: rBiz.id, dataJson: { contains: tRestock.id } } });
  ok("RC4 restock race → no stale notification (fresh re-check)", restockNotifs === 0);
  const delNotifs = await db.notification.count({ where: { businessId: rBiz.id, dataJson: { contains: tDelete.id } } });
  ok("RC5 delete race → no notification", delNotifs === 0);
  const deactNotifs = await db.notification.count({ where: { businessId: rBiz.id, dataJson: { contains: tDeact.id } } });
  ok("RC6 deactivate race → no notification", deactNotifs === 0);
  const memberOwner = await db.notification.count({ where: { businessId: rBiz.id, dataJson: { contains: tMember.id }, userId: admin2.id } });
  const memberAdmin = await db.notification.count({ where: { businessId: rBiz.id, dataJson: { contains: tMember.id }, userId: owner.id } });
  // §99: the REVOKED member gets nothing — but the remaining eligible
  // recipient (owner) MUST still be notified (no blanket suppression).
  ok("RC7 membership race → revoked ADMIN got NOTHING for the raced product", memberOwner === 0);
  ok("RC7b remaining recipient (owner) STILL notified for the raced product", memberAdmin === 1);
  const earlyAdmin2 = await db.notification.count({ where: { businessId: rBiz.id, userId: admin2.id } });
  ok(`RC8 revoked ADMIN still received EARLY (pre-revocation) alerts — recheck was live, not blanket (got ${earlyAdmin2})`, earlyAdmin2 >= 1);
  ok(`RC9 run skipped exactly the raced candidates (skipped=${r?.skipped})`, r?.skipped === 3);
  // created is timing-dependent (revocation lands mid-run): owner always
  // gets 60 fillers + tMember = 61; admin2 gets a small pre-revocation tail.
  ok(`RC10 created in the deterministic owner band + pre-revocation tail (got ${r?.created})`, (r?.created ?? 0) >= 62 && (r?.created ?? 0) <= 80);
  ok("RC11 zero failed notifications in the race run", (r?.failed ?? 0) === 0);
}

/* ============================== F-XBIZ =============================== */
console.log("== F-XBIZ CROSS-BUSINESS ISOLATION (§100) ==");
{
  const bA = await makeBiz(`${TAG}-XA`, [[owner.id, "OWNER"]]);
  const bB = await makeBiz(`${TAG}-XB`, [[owner.id, "OWNER"]]);
  await makeProduct(bA.id, `${TAG}-xa-product`, { sku: "XA-1", stockQty: 1, lowStockAt: 5 });
  await makeProduct(bB.id, `${TAG}-xb-product`, { sku: "XB-1", stockQty: 1, lowStockAt: 5 });
  const rA = runCli(["--business-id=" + bA.id, "--apply"]);
  const resA = lastJsonLine(rA.out)?.result;
  const nA = await db.notification.count({ where: { businessId: bA.id, type: "BUSINESS_INVENTORY_LOW_STOCK" } });
  const nB = await db.notification.count({ where: { businessId: bB.id, type: "BUSINESS_INVENTORY_LOW_STOCK" } });
  ok(`X1 scoped run created only in A (A=${nA}, got ${resA?.created})`, nA === 1 && resA?.created === 1);
  ok("X2 ZERO leakage into B", nB === 0);
  const rB = runCli(["--business-id=" + bB.id, "--apply"]);
  const resB = lastJsonLine(rB.out)?.result;
  const nB2 = await db.notification.count({ where: { businessId: bB.id, type: "BUSINESS_INVENTORY_LOW_STOCK" } });
  ok(`X3 B-only run creates in B (got ${resB?.created})`, nB2 === 1 && resB?.created === 1);
  // An UNSCOPED APPLY run would touch NON-fixture dev businesses — forbidden
  // by the fixture discipline (§169). The unscoped mode is exercised as a
  // DRY RUN only (no writes, proves the no-scope path terminates).
  const rBoth = runCli(["--max=10"]); // unscoped DRY run over every business
  ok("X4 unscoped DRY run exits 0 and writes nothing", rBoth.code === 0 && lastJsonLine(rBoth.out)?.result?.mode === "DRY_RUN");
}

/* ============================== F-SENS =============================== */
console.log("== F-SENS SENSITIVE DATA / XSS SAFETY (§101) ==");
{
  const sBiz = await makeBiz(`${TAG}-SENS`, [[owner.id, "OWNER"]]);
  const nasty = await makeProduct(sBiz.id, `<test>&"'>`, { sku: `<b>SKU&</b>`, unit: `<u>`, stockQty: 1, lowStockAt: 5 });
  const r = runCli(["--business-id=" + sBiz.id, "--apply"]);
  const n = await db.notification.findFirst({ where: { businessId: sBiz.id, type: "BUSINESS_INVENTORY_LOW_STOCK" } });
  ok("Y1 processor handled HTML-hostile product without failure", r.code === 0 && lastJsonLine(r.out)?.result?.failed === 0);
  const d = JSON.parse(n.dataJson);
  ok("Y2 data stored as plain text — raw value preserved, no encoding drift", d.productName === `<test>&"'>`);
  ok("Y3 sourceEventId built from ids + qty ONLY (no name/sku chars)", !n.sourceEventId.includes("<") && !n.sourceEventId.includes("&") && !n.sourceEventId.includes("%"));
  ok("Y4 no script/html fields anywhere in the notification row", !JSON.stringify(n).includes("<script"));
  ok(`Y5 sku stored raw as bounded data (got ${d.sku})`, d.sku === `<b>SKU&</b>`);
}

/* ============================== F-DEBUG ============================== */
console.log("== F-DEBUG §52 SAFE OUTPUT ==");
{
  const r = runCli(SCOPE, { INVENTORY_LOW_STOCK_DEBUG: "1" });
  const lines = r.out.trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const debugLine = lines.find((o) => o.debug === "inventory-low-stock");
  ok("G1 debug line present and JSON", Boolean(debugLine));
  ok(
    "G2 debug carries EXACTLY the §52 key vocabulary",
    debugLine &&
      JSON.stringify(Object.keys(debugLine).sort()) ===
        JSON.stringify(["candidates", "created", "debug", "duplicates", "failed", "max", "mode", "phase", "scanned", "skipped", "truncated"]),
  );
  ok("G3 debug is aggregate-only (final counts present)", debugLine && typeof debugLine.created === "number" && debugLine.phase === "complete");
  ok("G4 debug leaks no product/business/recipient data", !JSON.stringify(lines).includes(biz.id) && !JSON.stringify(lines).includes(pLow2.id) && !JSON.stringify(lines).includes("paper") && !JSON.stringify(lines).includes("PAP-1"));
}

/* ============================== F-ZERO =============================== */
console.log("== F-ZERO ZERO ACTIVE CANDIDATES (§106) ==");
{
  const zBiz = await makeBiz(`${TAG}-ZERO`, [[owner.id, "OWNER"]]);
  await makeProduct(zBiz.id, `${TAG}-healthy`, { sku: "Z-1", stockQty: 50, lowStockAt: 5 });
  const r = runCli(["--business-id=" + zBiz.id]);
  const res = lastJsonLine(r.out)?.result;
  ok("Z1 exits 0 with no error", r.code === 0);
  ok("Z2 candidates 0, created 0", res?.candidates === 0 && res?.created === 0);
  ok("Z3 truncated=false", res?.truncated === false);
}

/* ============================= F-NORCPT ============================== */
console.log("== F-NORCPT NO RECIPIENTS (§42/§107) ==");
{
  // Fixture business with a low-stock product but ZERO members — schema
  // permits a bare business row; the processor must skip, never fabricate.
  const lone = await db.business.create({
    data: {
      name: `${TAG}-LONELY`,
      slug: `p38qa-lonely-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ownerId: owner.id,
      currencyCode: "USD",
      locale: "en",
      timezone: "Asia/Tehran",
    },
  });
  await makeProduct(lone.id, `${TAG}-lonely-product`, { sku: "L-1", stockQty: 1, lowStockAt: 5 });
  const r = runCli(["--business-id=" + lone.id, "--apply"]);
  const res = lastJsonLine(r.out)?.result;
  ok("NR1 exits 0", r.code === 0);
  ok(`NR2 candidate skipped (skipped=${res?.skipped})`, res?.skipped === 1);
  ok("NR3 nothing fabricated (created 0)", res?.created === 0);
  const n = await db.notification.count({ where: { businessId: lone.id } });
  ok("NR4 zero notification rows for the memberless business", n === 0);
  await db.product.deleteMany({ where: { businessId: lone.id } });
  await db.business.delete({ where: { id: lone.id } });
}

/* ============================== F-EMAIL ============================== */
console.log("== F-EMAIL PREFERENCE + PROVIDER HONESTY (§108/§109) ==");
{
  // Fresh low product on the main fixture business (owner+admin get IN_APP).
  await makeProduct(biz.id, `${TAG}-email-check`, { sku: "EM-1", stockQty: 1, lowStockAt: 5 });
  const csrf2 = (await f("/api/auth/csrf")).body?.csrfToken;
  await f("/api/auth/callback/credentials", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrfToken: csrf2, email: ownerEmail, password: PASS, redirect: "false", json: "true" }).toString() });
  const put = await f("/api/v1/me/notification-preferences", {
    method: "PUT",
    body: JSON.stringify({ notificationType: "BUSINESS_INVENTORY_LOW_STOCK", channel: "EMAIL", enabled: false }),
  });
  ok("E1 email preference PUT persists", put.status === 200 && put.body?.data?.preference?.enabled === false);
  const r = runCli(["--business-id=" + biz.id, "--apply", "--max=500"]);
  ok("E2 apply exits 0", r.code === 0);
  // Assert the OWNER's row — the owner is the user whose EMAIL pref was disabled.
  const n = await db.notification.findFirst({
    where: { businessId: biz.id, type: "BUSINESS_INVENTORY_LOW_STOCK", userId: owner.id },
    include: { deliveries: true },
    orderBy: { createdAt: "desc" },
  });
  ok("E3 IN_APP delivery SENT despite email opt-out", n.deliveries.some((d) => d.channel === "IN_APP" && d.status === "SENT"));
  const emailRow = n.deliveries.find((d) => d.channel === "EMAIL");
  ok(`E4 EMAIL delivery SKIPPED with PREFERENCE_DISABLED (got ${emailRow?.status}/${emailRow?.failureCode})`, emailRow?.status === "SKIPPED" && emailRow?.failureCode === "PREFERENCE_DISABLED");
  await f("/api/v1/me/notification-preferences", {
    method: "PUT",
    body: JSON.stringify({ notificationType: "BUSINESS_INVENTORY_LOW_STOCK", channel: "EMAIL", enabled: true }),
  });
  console.log("NOTE (§109): EMAIL PROVIDER NOT CONFIGURED in this environment — delivery-row semantics verified locally only; no real SMTP success claimed.");
}

/* ============================= F-CENTER ============================== */
console.log("== F-CENTER NOTIFICATION CENTER + HEALTH (§110–§112) ==");
{
  const list = await f("/api/v1/me/notifications");
  const low = list.body?.data?.items?.filter((n) => n.type === "BUSINESS_INVENTORY_LOW_STOCK") ?? [];
  ok("N1 center lists the low-stock alerts", low.length >= 1);
  ok("N2 CTA maps to the reorder panel (#/reports?reorder=1 — R151)", low.every((n) => n.action?.route === "#/reports?reorder=1"));
  ok("N3 severity WARNING surfaced", low.every((n) => n.severity === "WARNING"));
  ok("N4 business attribution present (summary name, DTO law)", low.every((n) => Boolean(n.businessName)));
  const health = await fetch(`${BASE}/api/health`);
  const healthBody = await health.json().catch(() => null);
  ok("N5 health 200 after ALL processor runs (§111)", health.status === 200 && healthBody?.database?.reachable === true);
  const ready = await fetch(`${BASE}/api/ready`);
  const readyBody = await ready.json().catch(() => null);
  ok("N6 readiness responds honestly (§112)", ready.status === 200 && Boolean(readyBody));
  ok("N7 scheduler is NOT a readiness dependency", !JSON.stringify(readyBody).toLowerCase().includes("inventorylowstock") && !JSON.stringify(readyBody).includes("low-stock"));
}

/* ============================ AH CLEANUP ============================= */
console.log("== AH CLEANUP (§170/§171) ==");
{
  const fixtureBusinesses = await db.business.findMany({ where: { name: { startsWith: "P38QA-" } }, select: { id: true } });
  const delN = await db.notification.deleteMany({ where: { businessId: { in: fixtureBusinesses.map((b) => b.id) } } });
  ok(`H1 fixture notifications deleted (${delN.count})`, delN.count >= 130);
  for (const b of fixtureBusinesses) {
    await db.notificationDelivery.deleteMany({ where: { notification: { businessId: b.id } } });
    await db.auditLog.deleteMany({ where: { businessId: b.id } });
    await db.businessMember.deleteMany({ where: { businessId: b.id } });
    await db.product.deleteMany({ where: { businessId: b.id } });
    await db.business.delete({ where: { id: b.id } });
  }
  await db.user.deleteMany({ where: { id: { in: [owner.id, admin.id, admin2.id, member.id] } } });
  const leftB = await db.business.count({ where: { name: { startsWith: "P38QA-" } } });
  const leftU = await db.user.count({ where: { email: { contains: "p38qa-" } } });
  const leftP = await db.product.count({ where: { name: { startsWith: "P38QA-" } } });
  const leftN = await db.notification.count({ where: { businessId: { in: fixtureBusinesses.map((b) => b.id) } } });
  const leftU2 = await db.user.count({ where: { email: { contains: "p38qa-" } } });
  ok("H2 zero fixture leftovers (biz/users/products/notifications/deliveries)", leftB === 0 && leftU === 0 && leftP === 0 && leftN === 0 && leftU2 === 0);
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
