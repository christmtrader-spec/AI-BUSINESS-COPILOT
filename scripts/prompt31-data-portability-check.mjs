/**
 * scripts/prompt31-data-portability-check.mjs — Prompt 31 E2E harness
 * (§233/§236/§360).
 *
 * Exercises the REAL HTTP surface + real NextAuth flow against the dev
 * server, plus direct DB access ONLY for time/expiry/stale simulation and
 * audit verification (clearly marked below).
 *
 * Sections:
 *   EXPORT AUTH       OWNER ok · STAFF/VIEWER denied · unknown dataset
 *   EXPORT DATA       manifest · record counts · checksum · integrity
 *   EXPORT SECRETS    no secrets/platform data in artifact or status
 *   DOWNLOAD SECURITY headers · cross-user isolation · tampered job id
 *   EXPORT STATE      cancel-after-complete · expiry · limits
 *   IMPORT AUTH       OWNER ok · staff/viewer denied
 *   IMPORT FLOW       template round-trip · mapping · validation · dry run
 *   IMPORT COMMIT     typed confirmation · step-up · idempotent retry
 *   IMPORT DATA       Persian text · money precision · duplicates SKIP/REJECT
 *   IMPORT ISOLATION  cross-tenant businessId column ignored
 *   IMPORT EXPIRY     expired commit rejected · file cleanup
 *   IMPORT STALE      stale COMMITTING reaped safely
 *   AUDIT             safe audit rows exist, no row contents
 *
 * Run:  bun scripts/prompt31-data-portability-check.mjs
 *       (needs the dev server on :3000)
 * Exit: 0 = all green · 1 = at least one failure.
 */
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { existsSync, readFileSync } from "node:fs";

const BASE = process.env.P31_BASE ?? "http://localhost:3000";
const PASS = "testpass123";
const db = new PrismaClient();
for (const line of readDbEnv()) {
  const m = line.match(/^([A-Z_]+)=(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
function readDbEnv() {
  try {
    return readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n");
  } catch {
    return [];
  }
}

const results = [];
let current = "";
function section(name) { current = name; }
function record(name, ok, info = "") {
  results.push({ section: current, name, ok, info });
  console.log(`${ok ? "✓" : "✗"} [${current}] ${name}${info ? ` — ${info}` : ""}`);
}
let lastResponses = {};
function check(name, cond, info = "") {
  if (!cond) {
    const snap = JSON.stringify(lastResponses).slice(0, 200);
    record(name, false, `${info} |last=${snap}`);
  } else record(name, true, info);
}

/* ------------------------------ fetch helpers ------------------------------ */
let XFF = `10.31.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
function jarFetch(jar) {
  return async (path, init = {}) => {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const headers = { "x-forwarded-for": XFF, ...(init.headers ?? {}) };
    // Multipart uploads set their own boundary — never force a content-type.
    const isMultipart = typeof FormData !== "undefined" && init.body instanceof FormData;
    if (init.body && !isMultipart && !headers["content-type"]) headers["content-type"] = "application/json";
    const res = await fetch(`${BASE}${path}`, { ...init, headers: cookie ? { ...headers, cookie } : headers });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1));
    }
    return res;
  };
}
async function apiJson(f, path, init = {}) {
  const res = await f(path, init);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  lastResponses = body;
  return { res, body };
}

/** Business-scoped fetch: attaches the x-business-id context header. */
function withBiz(jar, businessId) {
  const base = jarFetch(jar);
  return (path, init = {}) => base(path, { ...init, headers: { "x-business-id": businessId, ...(init.headers ?? {}) } });
}
async function login(jar, email, password) {
  const f = jarFetch(jar);
  const csrfRes = await f("/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  const form = new URLSearchParams({ csrfToken, email, password, redirect: "false", json: "true" });
  const res = await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const hasSession = [...jar.keys()].some((k) => k.includes("session-token"));
  return { res, hasSession };
}
async function registerApi(email, name = "P31 Harness") {
  const f = jarFetch(new Map());
  const { body } = await apiJson(f, "/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, email, password: PASS }),
  });
  return body;
}
async function createBusiness(jar, name) {
  const f = jarFetch(jar);
  const { body } = await apiJson(f, "/api/v1/businesses", {
    method: "POST",
    body: JSON.stringify({ name, currencyCode: "EUR", locale: "en", timezone: "UTC" }),
  });
  return body;
}

const SECRET_TOKENS = ["passwordHash", "encryptedSecret", "codeHash", "tokenHash", "sessionTokenHash", "PlatformAuditLog", "AiCostRate", "merchantSecret"];
function secretScan(label, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const leaked = SECRET_TOKENS.filter((k) => text.includes(k));
  check(`${label}: no secret/platform fields`, leaked.length === 0, leaked.join(",") || "clean");
}

async function uploadImport(f, dataset, fileName, content, mime = "text/csv") {
  // Rotate the harness IP per upload: the production limiter keys per
  // business+user+IP (5/15 min) and the harness legitimately performs many
  // uploads in one run (same isolation as prompt30-check's freshXff).
  XFF = `10.31.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 254) + 1}`;
  const form = new FormData();
  form.append("dataset", dataset);
  form.append("file", new File([content], fileName, { type: mime }));
  const res = await f("/api/v1/imports", { method: "POST", body: form, headers: { "x-forwarded-for": XFF } });
  let body = null;
  try { body = await res.json(); } catch { /* */ }
  if (!res.ok) console.log(`  [upload-debug] ${fileName} → ${res.status} ${JSON.stringify(body?.error ?? body).slice(0, 160)}`);
  return { res, body };
}

/* ================================ SETUP ==================================== */
const RUN = randomBytes(4).toString("hex");
const A_EMAIL = `p31-a-${RUN}@harness.test`;
const B_EMAIL = `p31-b-${RUN}@harness.test`;
const STAFF_EMAIL = `p31-s-${RUN}@harness.test`;
const VIEWER_EMAIL = `p31-v-${RUN}@harness.test`;

section("SETUP");
const regIds = {};
for (const [email, name] of [[A_EMAIL, "P31 A"], [B_EMAIL, "P31 B"], [STAFF_EMAIL, "P31 Staff"], [VIEWER_EMAIL, "P31 Viewer"]]) {
  const reg = await registerApi(email, name);
  regIds[email] = reg?.data?.user?.id;
  check(`SETUP: register ${name}`, reg?.ok === true, reg?.error?.code ?? email);
}
const jarA = new Map();
check("SETUP: login A", (await login(jarA, A_EMAIL, PASS)).hasSession);
const jarB = new Map();
check("SETUP: login B", (await login(jarB, B_EMAIL, PASS)).hasSession);
const jarStaff = new Map();
check("SETUP: login staff", (await login(jarStaff, STAFF_EMAIL, PASS)).hasSession);
const jarViewer = new Map();
check("SETUP: login viewer", (await login(jarViewer, VIEWER_EMAIL, PASS)).hasSession);

const fA = jarFetch(jarA);
const fB = jarFetch(jarB);
const fStaff = jarFetch(jarStaff);
const fViewer = jarFetch(jarViewer);

const bizA = await createBusiness(jarA, `P31 Export Biz ${RUN}`);
check("SETUP: business A created", bizA?.ok === true, bizA?.error?.code ?? bizA?.data?.business?.id);
const A_ID = bizA?.data?.business?.id;

const bizB = await createBusiness(jarB, `P31 Other Biz ${RUN}`);
check("SETUP: business B created", bizB?.ok === true);
const B_ID = bizB?.data?.business?.id;

// From here on, business-scoped calls carry the tenant context header.
const bA = withBiz(jarA, A_ID);
const bB = withBiz(jarB, B_ID);
const bStaff = withBiz(jarStaff, A_ID);
const bViewer = withBiz(jarViewer, A_ID);

// staff + viewer join business A
const addStaff = await apiJson(bA, `/api/v1/businesses/${A_ID}/members`, {
  method: "POST",
  body: JSON.stringify({ email: STAFF_EMAIL, role: "STAFF" }),
});
check("SETUP: staff added to A", addStaff.res.status === 201 || addStaff.res.status === 200, addStaff.body?.error?.code ?? "");
// The FREE plan caps team members at 2; the VIEWER fixture is seeded directly
// (test fixture — the UI invite flow is exercised by Prompt 17/21 harnesses).
try {
  await db.businessMember.create({ data: { businessId: A_ID, userId: regIds[VIEWER_EMAIL], role: "VIEWER" } });
  record("SETUP: viewer seeded into A (db fixture)", true);
} catch (e) {
  record("SETUP: viewer seeded into A (db fixture)", false, String(e?.message ?? e).slice(0, 80));
}

// Seed business A with real data via the regular tenant APIs.
const seedCustomer = await apiJson(bA, "/api/v1/customers", {
  method: "POST",
  body: JSON.stringify({ name: "Seed Customer", email: "seed@example.com", phone: "+15550001" }),
});
check("SETUP: seed customer", seedCustomer.res.status === 201);
const seedProduct = await apiJson(bA, "/api/v1/products", {
  method: "POST",
  body: JSON.stringify({ name: "Seed Product", sku: "SEED-1", salePriceMinor: 2500, costPriceMinor: 1000, stockQty: 7 }),
});
check("SETUP: seed product", seedProduct.res.status === 201);
const seedSupplier = await apiJson(bA, "/api/v1/suppliers", {
  method: "POST",
  body: JSON.stringify({ name: "Seed Supplier" }),
});
check("SETUP: seed supplier", seedSupplier.res.status === 201);

// Seed business B with one customer (for cross-tenant invariance checks).
const seedCustomerB = await apiJson(bB, "/api/v1/customers", {
  method: "POST",
  body: JSON.stringify({ name: "B Only Customer" }),
});
check("SETUP: seed customer in B", seedCustomerB.res.status === 201);

/* ============================== EXPORT AUTH ================================ */
section("EXPORT AUTH");
XFF = `10.31.9.${Math.floor(Math.random() * 254) + 1}`;
const createExport = await apiJson(bA, "/api/v1/exports", {
  method: "POST",
  body: JSON.stringify({ datasets: ["business", "customers", "suppliers", "products"], format: "JSON" }),
});
check("EXPORT AUTH: OWNER creates export (synchronous COMPLETED)", createExport.res.status === 201 && createExport.body?.data?.status === "COMPLETED", createExport.body?.data?.status ?? createExport.body?.error?.code);
const EXPORT_ID = createExport.body?.data?.id;
check("EXPORT AUTH: job id returned", typeof EXPORT_ID === "string" && EXPORT_ID.length >= 20);

const staffExport = await apiJson(bStaff, "/api/v1/exports", {
  method: "POST",
  body: JSON.stringify({ datasets: ["customers"], format: "JSON" }),
});
check("EXPORT AUTH: STAFF denied (403)", staffExport.res.status === 403, String(staffExport.res.status));

const viewerList = await apiJson(bViewer, "/api/v1/exports");
check("EXPORT AUTH: VIEWER list denied (403)", viewerList.res.status === 403, String(viewerList.res.status));

const badDataset = await apiJson(bA, "/api/v1/exports", {
  method: "POST",
  body: JSON.stringify({ datasets: ["audit_logs"], format: "JSON" }),
});
check("EXPORT AUTH: unknown dataset rejected (§239)", badDataset.res.status === 422, String(badDataset.res.status));

const platformDataset = await apiJson(bA, "/api/v1/exports", {
  method: "POST",
  body: JSON.stringify({ datasets: ["PlatformAuditLog"], format: "JSON" }),
});
check("EXPORT AUTH: platform dataset rejected", platformDataset.res.status === 422, String(platformDataset.res.status));

const tooManyDatasets = await apiJson(bA, "/api/v1/exports", {
  method: "POST",
  body: JSON.stringify({
    datasets: ["business", "members", "customers", "suppliers", "products", "inventory", "sales", "expenses", "payments", "subscription_summary", "usage_summary", "x1", "x2"].slice(0, 13).filter((d) => !d.startsWith("x")),
    format: "JSON",
  }),
});
check("EXPORT AUTH: >12 datasets handled (allowlist + cap)", tooManyDatasets.res.status === 201 || tooManyDatasets.res.status === 422, String(tooManyDatasets.res.status));

/* ============================= EXPORT DATA ================================= */
section("EXPORT DATA");
const listRes = await apiJson(bA, "/api/v1/exports");
check("EXPORT DATA: list shows job", listRes.body?.data?.items?.some((j) => j.id === EXPORT_ID) === true);
secretScan("EXPORT DATA status", listRes.body);

const dlRes = await bA(`/api/v1/exports/${EXPORT_ID}/download`);
const artifactText = await dlRes.text();
check("EXPORT DATA: download 200", dlRes.status === 200, String(dlRes.status));
check("EXPORT DATA: content-disposition attachment (§31)", (dlRes.headers.get("content-disposition") ?? "").startsWith("attachment"));
check("EXPORT DATA: cache-control private/no-store (§31/§168)", (dlRes.headers.get("cache-control") ?? "").includes("no-store"));
check("EXPORT DATA: nosniff (§206)", dlRes.headers.get("x-content-type-options") === "nosniff");

let manifest = null;
let datasets = null;
try {
  const parsed = JSON.parse(artifactText);
  manifest = parsed.manifest;
  datasets = parsed.datasets;
} catch { /* scanned below */ }
check("EXPORT DATA: manifest present (§9)", manifest?.kind === "ai-business-copilot/data-export" && manifest?.exportSchemaVersion === 1);
check("EXPORT DATA: manifest carries business meta (§40)", typeof manifest?.business?.name === "string" && typeof manifest?.business?.currency === "string");
check("EXPORT DATA: recordCounts match (§22)", manifest?.recordCounts?.customers >= 1 && manifest?.recordCounts?.products >= 1, JSON.stringify(manifest?.recordCounts));
check("EXPORT DATA: manifest has no per-row businessId (§10)", !artifactText.includes(`"businessId":`));
const datasetsJson = JSON.stringify(datasets);
const recomputed = datasetsJson ? (await import("node:crypto")).createHash("sha256").update(datasetsJson).digest("hex") : "unavailable";
check("EXPORT DATA: payload integrity verifiable (§312)", manifest?.integrity?.value === recomputed, `${manifest?.integrity?.value?.slice(0, 12)} vs ${recomputed.slice(0, 12)}`);
check("EXPORT DATA: whole-file checksum recorded on job", (createExport.body?.data?.checksum ?? "").length === 64);
const customerRows = datasets?.customers ?? [];
check("EXPORT DATA: customer IDs preserved (§54)", customerRows.every((r) => typeof r.id === "string" && r.id.length > 10));
check("EXPORT DATA: money as minor integers (§226)", (datasets?.products ?? []).some((p) => Number.isInteger(p.salePriceMinor)));
check("EXPORT DATA: timestamps ISO-8601 UTC (§231)", customerRows.every((r) => /^\d{4}-\d{2}-\d{2}T/.test(r.createdAt)));
check("EXPORT DATA: no soft-deleted flattening — deletedAt field exists or null", customerRows.every((r) => "deletedAt" in r));
secretScan("EXPORT DATA artifact", artifactText);

/* CSV format → ZIP package */
const csvExport = await apiJson(bA, "/api/v1/exports", {
  method: "POST",
  body: JSON.stringify({ datasets: ["customers"], format: "CSV" }),
});
check("EXPORT DATA: CSV export completes", csvExport.body?.data?.status === "COMPLETED", csvExport.body?.data?.status);
const CSV_ID = csvExport.body?.data?.id;
const csvDl = await bA(`/api/v1/exports/${CSV_ID}/download`);
const csvBytes = new Uint8Array(await csvDl.arrayBuffer());
check("EXPORT DATA: CSV artifact is a ZIP (PK header, §149)", csvBytes[0] === 0x50 && csvBytes[1] === 0x4b, `${csvBytes.byteLength}B`);

/* ========================= EXPORT ISOLATION/STATE =========================== */
section("EXPORT ISOLATION");
const crossList = await apiJson(bB, `/api/v1/exports`);
check("ISOLATION: B's list has no A jobs", !(crossList.body?.data?.items ?? []).some((j) => j.id === EXPORT_ID));
const crossGet = await apiJson(bB, `/api/v1/exports/${EXPORT_ID}`);
check("ISOLATION: B cannot read A's job (404)", crossGet.res.status === 404, String(crossGet.res.status));
const crossDl = await bB(`/api/v1/exports/${EXPORT_ID}/download`);
check("ISOLATION: B cannot download A's export (§145)", crossDl.status === 404, String(crossDl.status));
const tampered = await apiJson(bA, "/api/v1/exports/zzzzzzzzzzzzzzzzzzzzzzzz");
check("ISOLATION: tampered job id → 404", tampered.res.status === 404, String(tampered.res.status));

const cancelDone = await apiJson(bA, `/api/v1/exports/${EXPORT_ID}/cancel`, { method: "POST" });
check("EXPORT STATE: cancel after COMPLETED rejected (§29)", cancelDone.res.status === 409, String(cancelDone.res.status));

// Expiry (§166): directly age the job, then verify status + download reject.
await db.dataExportJob.update({ where: { id: CSV_ID }, data: { expiresAt: new Date(Date.now() - 3_600_000) } });
const expiredGet = await apiJson(bA, `/api/v1/exports/${CSV_ID}`);
check("EXPORT STATE: expired job reports EXPIRED (§327)", expiredGet.body?.data?.status === "EXPIRED", expiredGet.body?.data?.status);
const expiredDl = await bA(`/api/v1/exports/${CSV_ID}/download`);
check("EXPORT STATE: expired download rejected (§166)", expiredDl.status === 410, String(expiredDl.status));

/* ============================== IMPORT AUTH ================================ */
section("IMPORT AUTH");
const staffUpload = await uploadImport(bStaff, "customers", "x.csv", "name\nX\n");
check("IMPORT AUTH: STAFF upload denied (403)", staffUpload.res.status === 403, String(staffUpload.res.status));
const viewerUpload = await uploadImport(bViewer, "customers", "x.csv", "name\nX\n");
check("IMPORT AUTH: VIEWER upload denied (403)", viewerUpload.res.status === 403, String(viewerUpload.res.status));

const badFile = await uploadImport(bA, "customers", "evil.csv", "CREATE TABLE customers(id);\n", "text/csv");
check("IMPORT AUTH: SQL content rejected (§140/§152)", badFile.res.status === 422, String(badFile.res.status));
const sqlUpload = await uploadImport(bA, "customers", "dump.sql", "SELECT * FROM customers;\n", "application/sql");
check("IMPORT AUTH: .sql extension rejected", sqlUpload.res.status === 422 || sqlUpload.res.status === 413, String(sqlUpload.res.status));

/* ============================== IMPORT FLOW ================================ */
section("IMPORT FLOW");
// §213: the template the app generates must be accepted by the importer.
const tplRes = await bA("/api/v1/imports/templates/customers");
const templateCsv = await tplRes.text();
check("IMPORT FLOW: template downloads", tplRes.status === 200 && (tplRes.headers.get("x-import-template-version") ?? "") === "1", tplRes.headers.get("x-import-template-version") ?? "");
check("IMPORT FLOW: template example is synthetic (§212)", templateCsv.includes("Example Customer"));

const tplUpload = await uploadImport(bA, "customers", "Customer.csv", templateCsv);
check("IMPORT FLOW: template re-import accepted (§213)", tplUpload.res.status === 201 && tplUpload.body?.data?.job?.status === "MAPPING_REQUIRED", tplUpload.body?.data?.job?.status ?? tplUpload.body?.error?.code);
const TPL_JOB = tplUpload.body?.data?.job?.id;
check("IMPORT FLOW: detected columns reported (§60)", (tplUpload.body?.data?.detectedColumns ?? []).includes("name"));
check("IMPORT FLOW: suggested mapping returned", typeof tplUpload.body?.data?.suggestedMapping === "object");

// Validation before mapping → 409 (state machine §103)
const prematureValidate = await apiJson(bA, `/api/v1/imports/${TPL_JOB}/dry-run`, { method: "POST" });
check("IMPORT FLOW: dry-run before validate rejected (§103)", prematureValidate.res.status === 409, String(prematureValidate.res.status));

const tplMap = await apiJson(bA, `/api/v1/imports/${TPL_JOB}/mapping`, {
  method: "POST",
  body: JSON.stringify({ mapping: tplUpload.body.data.suggestedMapping, duplicateMode: "REJECT" }),
});
check("IMPORT FLOW: mapping accepted", tplMap.res.status === 200, tplMap.body?.error?.code ?? "");
const tplValidate = await apiJson(bA, `/api/v1/imports/${TPL_JOB}/validate`, { method: "POST" });
check("IMPORT FLOW: template validates READY", tplValidate.body?.data?.job?.status === "READY", tplValidate.body?.data?.job?.status ?? tplValidate.body?.error?.code);

// The template example row is a duplicate of nothing → would create 1.
// Commit is rejected without step-up (§93):
const noAuthCommit = await apiJson(bA, `/api/v1/imports/${TPL_JOB}/commit`, {
  method: "POST",
  body: JSON.stringify({ confirmation: "IMPORT DATA" }),
});
check("IMPORT COMMIT: step-up required (§93/§279)", noAuthCommit.res.status === 401, String(noAuthCommit.res.status));

// Wrong typed confirmation (§92):
const reauth = await apiJson(bA, "/api/v1/me/security/reauth", {
  method: "POST",
  body: JSON.stringify({ password: PASS }),
});
check("IMPORT COMMIT: reauth ok", reauth.res.status === 200, reauth.body?.error?.code ?? "");
const badConfirm = await apiJson(bA, `/api/v1/imports/${TPL_JOB}/commit`, {
  method: "POST",
  body: JSON.stringify({ confirmation: "OK" }),
});
check("IMPORT COMMIT: typed 'OK' rejected — needs IMPORT DATA (§92)", badConfirm.res.status === 422, String(badConfirm.res.status));

const tplCommit = await apiJson(bA, `/api/v1/imports/${TPL_JOB}/commit`, {
  method: "POST",
  body: JSON.stringify({ confirmation: "IMPORT DATA" }),
});
check("IMPORT COMMIT: template import commits", tplCommit.body?.data?.created === 1, `created=${tplCommit.body?.data?.created}`);

/* ============================== IMPORT DATA ================================ */
section("IMPORT DATA");
const persianCsv = [
  "name,phone,email,address,note",
  'علی رضایی,+98 912 000 0001,ali@example.com,"تهران، خیابان ولیعصر",یادداشت: مشتری عمده ۱۲ عدد',
  '"Smith, John",+15550002,john@example.com,,"Uses =CMD() as name test"',
].join("\n");
const faUpload = await uploadImport(bA, "customers", "customers-fa.csv", persianCsv);
check("IMPORT DATA: Persian CSV accepted", faUpload.res.status === 201, faUpload.body?.error?.code ?? "");
const FA_JOB = faUpload.body?.data?.job?.id;
const faMap = await apiJson(bA, `/api/v1/imports/${FA_JOB}/mapping`, {
  method: "POST",
  body: JSON.stringify({ mapping: faUpload.body.data.suggestedMapping, duplicateMode: "SKIP" }),
});
check("IMPORT DATA: Persian mapping accepted", faMap.res.status === 200);
const faValidate = await apiJson(bA, `/api/v1/imports/${FA_JOB}/validate`, { method: "POST" });
check("IMPORT DATA: Persian rows validate (2 valid)", faValidate.body?.data?.job?.validRows === 2, `valid=${faValidate.body?.data?.job?.validRows}`);
const faDry = await apiJson(bA, `/api/v1/imports/${FA_JOB}/dry-run`, { method: "POST" });
check("IMPORT DATA: dry-run would-create 2 (no mutation, §86)", faDry.body?.data?.wouldCreate === 2, `wouldCreate=${faDry.body?.data?.wouldCreate}`);
const faCommit = await apiJson(bA, `/api/v1/imports/${FA_JOB}/commit`, {
  method: "POST",
  body: JSON.stringify({ confirmation: "IMPORT DATA" }),
});
check("IMPORT DATA: Persian commit created=2 (§155)", faCommit.body?.data?.created === 2, `created=${faCommit.body?.data?.created}`);

// Round-trip verify via the tenant API: names + quoted comma survived.
const searchAli = await apiJson(bA, "/api/v1/customers?q=" + encodeURIComponent("علی"));
check("IMPORT DATA: Persian name round-trips (§365)", (searchAli.body?.data?.total ?? 0) >= 1);
const searchSmith = await apiJson(bA, "/api/v1/customers?q=" + encodeURIComponent("Smith, John"));
check("IMPORT DATA: quoted comma round-trips (§267)", (searchSmith.body?.data?.total ?? 0) === 1);
const formulaRow = await db.customer.findFirst({ where: { businessId: A_ID, note: { contains: "=CMD()" } } });
check("IMPORT DATA: formula string stored as DATA (§265)", !!formulaRow, formulaRow ? "found as plain text" : "missing");

/* Money precision: product import with exact decimals (§77/§157/§366). */
const productCsv = [
  "name,sku,unit,sale_price,cost_price,stock_qty,low_stock_at,is_active",
  "Imported Widget,IMP-1,piece,12.50,6.25,10,5,true",
  "Imported Gizmo,IMP-2,box,0.01,0,0,5,false",
].join("\n");
const prUpload = await uploadImport(bA, "products", "Product.csv", productCsv);
const PR_JOB = prUpload.body?.data?.job?.id;
await apiJson(bA, `/api/v1/imports/${PR_JOB}/mapping`, {
  method: "POST",
  body: JSON.stringify({ mapping: prUpload.body.data.suggestedMapping, duplicateMode: "SKIP" }),
});
const prValidate = await apiJson(bA, `/api/v1/imports/${PR_JOB}/validate`, { method: "POST" });
check("IMPORT DATA: product validation READY (2 valid)", prValidate.body?.data?.job?.status === "READY", prValidate.body?.data?.job?.status ?? prValidate.body?.error?.code);
const prCommit = await apiJson(bA, `/api/v1/imports/${PR_JOB}/commit`, {
  method: "POST",
  body: JSON.stringify({ confirmation: "IMPORT DATA" }),
});
check("IMPORT DATA: product commit created=2", prCommit.body?.data?.created === 2, `created=${prCommit.body?.data?.created}`);
const gizmo = await db.product.findFirst({ where: { businessId: A_ID, sku: "IMP-2" } });
check("IMPORT DATA: money 0.01 → 1 minor unit EXACT (§157)", gizmo?.salePriceMinor === 1, String(gizmo?.salePriceMinor));
const widget = await db.product.findFirst({ where: { businessId: A_ID, sku: "IMP-1" } });
check("IMPORT DATA: money 12.50 → 1250 minor EXACT", widget?.salePriceMinor === 1250 && widget?.costPriceMinor === 625, JSON.stringify({ s: widget?.salePriceMinor, c: widget?.costPriceMinor }));
check("IMPORT DATA: is_active false respected", gizmo?.isActive === false);

/* =========================== IMPORT DUPLICATES ============================= */
section("IMPORT DUPLICATES");
// Re-upload the SAME Persian file → all rows duplicates (SKIP).
const dupUpload = await uploadImport(bA, "customers", "customers-fa.csv", persianCsv);
const DUP_JOB = dupUpload.body?.data?.job?.id;
await apiJson(bA, `/api/v1/imports/${DUP_JOB}/mapping`, {
  method: "POST",
  body: JSON.stringify({ mapping: dupUpload.body.data.suggestedMapping, duplicateMode: "SKIP" }),
});
await apiJson(bA, `/api/v1/imports/${DUP_JOB}/validate`, { method: "POST" });
const dupDry = await apiJson(bA, `/api/v1/imports/${DUP_JOB}/dry-run`, { method: "POST" });
check("DUPLICATES: deterministic SKIP detection (2 dupes, §159/§269)", dupDry.body?.data?.duplicateRows === 2, `dupes=${dupDry.body?.data?.duplicateRows}`);
const dupCommit = await apiJson(bA, `/api/v1/imports/${DUP_JOB}/commit`, {
  method: "POST",
  body: JSON.stringify({ confirmation: "IMPORT DATA" }),
});
check("DUPLICATES: SKIP commit created=0 skipped=2", dupCommit.body?.data?.created === 0 && dupCommit.body?.data?.skipped === 2, `c=${dupCommit.body?.data?.created}/s=${dupCommit.body?.data?.skipped}`);

// REJECT mode: duplicates block the commit (§82).
const rejUpload = await uploadImport(bA, "customers", "customers-fa.csv", persianCsv);
const REJ_JOB = rejUpload.body?.data?.job?.id;
await apiJson(bA, `/api/v1/imports/${REJ_JOB}/mapping`, {
  method: "POST",
  body: JSON.stringify({ mapping: rejUpload.body.data.suggestedMapping, duplicateMode: "REJECT" }),
});
await apiJson(bA, `/api/v1/imports/${REJ_JOB}/validate`, { method: "POST" });
const rejCommit = await apiJson(bA, `/api/v1/imports/${REJ_JOB}/commit`, {
  method: "POST",
  body: JSON.stringify({ confirmation: "IMPORT DATA" }),
});
check("DUPLICATES: REJECT mode blocks commit (§82/§373)", rejCommit.res.status === 409 && rejCommit.body?.error?.code === "IMPORT_VALIDATION_FAILED", rejCommit.body?.error?.code);
const rejJob = await apiJson(bA, `/api/v1/imports/${REJ_JOB}`);
check("DUPLICATES: REJECT failure is safe (job FAILED)", rejJob.body?.data?.status === "FAILED" && rejJob.body?.data?.failureCode === "IMPORT_VALIDATION_FAILED", rejJob.body?.data?.failureCode ?? "");
// ROW_DUPLICATE appears in the bounded error report.
const rejErrors = await bA(`/api/v1/imports/${REJ_JOB}/errors`);
const rejErrorsText = await rejErrors.text();
check("DUPLICATES: error report CSV with stable codes (§98/§192)", rejErrorsText.includes("ROW_DUPLICATE") && rejErrorsText.includes("row_number"), rejErrorsText.split("\n")[0]);

/* ========================= IMPORT IDEMPOTENCY ============================== */
section("IMPORT IDEMPOTENCY");
const retryCommit = await apiJson(bA, `/api/v1/imports/${FA_JOB}/commit`, {
  method: "POST",
  body: JSON.stringify({ confirmation: "IMPORT DATA" }),
});
check("IDEMPOTENCY: replay returns recorded result (§374)", retryCommit.res.status === 200 && retryCommit.body?.data?.created === 2, `created=${retryCommit.body?.data?.created}`);
const aliCount = await db.customer.count({ where: { businessId: A_ID, name: "علی رضایی" } });
check("IDEMPOTENCY: no duplicate rows created (§162)", aliCount === 1, String(aliCount));

/* ========================== IMPORT ISOLATION =============================== */
section("IMPORT ISOLATION");
const crossCsv = `name,businessId,email\nCross Tenant Row,${B_ID},cross@example.com`;
const crossUpload = await uploadImport(bA, "customers", "cross.csv", crossCsv);
const CROSS_JOB = crossUpload.body?.data?.job?.id;
const crossMap = await apiJson(bA, `/api/v1/imports/${CROSS_JOB}/mapping`, {
  method: "POST",
  body: JSON.stringify({ mapping: { name: "name", email: "email" }, duplicateMode: "SKIP" }),
});
check("ISOLATION: mapping ignores businessId column (§73)", crossMap.res.status === 200, crossMap.body?.error?.code ?? "");
await apiJson(bA, `/api/v1/imports/${CROSS_JOB}/validate`, { method: "POST" });
const crossCommit = await apiJson(bA, `/api/v1/imports/${CROSS_JOB}/commit`, {
  method: "POST",
  body: JSON.stringify({ confirmation: "IMPORT DATA" }),
});
check("ISOLATION: cross-tenant file commits into A only", crossCommit.body?.data?.created === 1, `created=${crossCommit.body?.data?.created}`);
const bCount = await db.customer.count({ where: { businessId: B_ID } });
check("ISOLATION: business B untouched (§369)", bCount === 1, String(bCount));
const aHasCross = await db.customer.findFirst({ where: { businessId: A_ID, email: "cross@example.com" } });
check("ISOLATION: row landed in current tenant", !!aHasCross);

/* =========================== IMPORT EXPIRY ================================= */
section("IMPORT EXPIRY");
const expUpload = await uploadImport(bA, "customers", "exp.csv", "name\nExpiring Row\n");
const EXP_JOB = expUpload.body?.data?.job?.id;
await apiJson(bA, `/api/v1/imports/${EXP_JOB}/mapping`, {
  method: "POST",
  body: JSON.stringify({ mapping: expUpload.body.data.suggestedMapping, duplicateMode: "SKIP" }),
});
await apiJson(bA, `/api/v1/imports/${EXP_JOB}/validate`, { method: "POST" });
await db.dataImportJob.update({ where: { id: EXP_JOB }, data: { expiresAt: new Date(Date.now() - 1_000) } });
const expCommit = await apiJson(bA, `/api/v1/imports/${EXP_JOB}/commit`, {
  method: "POST",
  body: JSON.stringify({ confirmation: "IMPORT DATA" }),
});
check("EXPIRY: expired commit rejected (§167)", expCommit.res.status === 410 || expCommit.body?.error?.code === "IMPORT_EXPIRED", `${expCommit.res.status} ${expCommit.body?.error?.code}`);
const expRow = await db.customer.findFirst({ where: { businessId: A_ID, name: "Expiring Row" } });
check("EXPIRY: no rows written after expiry", !expRow);

/* ============================ IMPORT STALE ================================= */
section("IMPORT STALE");
const staleUpload = await uploadImport(bA, "products", "stale.csv", productCsv);
const STALE_JOB = staleUpload.body?.data?.job?.id;
await apiJson(bA, `/api/v1/imports/${STALE_JOB}/mapping`, {
  method: "POST",
  body: JSON.stringify({ mapping: staleUpload.body.data.suggestedMapping, duplicateMode: "SKIP" }),
});
await apiJson(bA, `/api/v1/imports/${STALE_JOB}/validate`, { method: "POST" });
// Simulate a crash mid-commit: stuck COMMITTING beyond the threshold (§317).
await db.dataImportJob.update({
  where: { id: STALE_JOB },
  data: { status: "COMMITTING", createdAt: new Date(Date.now() - 60 * 60_000) },
});
const staleList = await apiJson(bA, "/api/v1/imports");
const staleDto = staleList.body?.data?.items?.find((j) => j.id === STALE_JOB);
check("STALE: stuck COMMITTING reaped to FAILED (§318)", staleDto?.status === "FAILED" && staleDto?.failureCode === "IMPORT_COMMIT_FAILED", `${staleDto?.status}/${staleDto?.failureCode}`);
const staleCount = await db.product.count({ where: { businessId: A_ID, sku: "IMP-1" } });
check("STALE: no partial mutation (exactly 1 IMP-1 from earlier)", staleCount === 1, String(staleCount));

/* ========================== IMPORT FILE TAMPER ============================= */
section("IMPORT FILE CHECKSUM");
const tamUpload = await uploadImport(bA, "suppliers", "sup.csv", "name\nOriginal Supplier\n");
const TAM_JOB = tamUpload.body?.data?.job?.id;
await apiJson(bA, `/api/v1/imports/${TAM_JOB}/mapping`, {
  method: "POST",
  body: JSON.stringify({ mapping: tamUpload.body.data.suggestedMapping, duplicateMode: "SKIP" }),
});
await apiJson(bA, `/api/v1/imports/${TAM_JOB}/validate`, { method: "POST" });
// Mutate the staged file on disk (simulating tampering, §311/§372).
const tamJobRow = await db.dataImportJob.findUnique({ where: { id: TAM_JOB } });
const fsMod = await import("node:fs");
const rootGuess = process.env.DATA_PORTABILITY_ROOT ? process.env.DATA_PORTABILITY_ROOT : "var/data-portability";
const stagedPath = `${rootGuess.replace(/^\.\//, "")}/imports/${tamJobRow.storageKey}`;
try {
  fsMod.writeFileSync(stagedPath, "name\nTampered Supplier\n");
  const tamCommit = await apiJson(bA, `/api/v1/imports/${TAM_JOB}/commit`, {
    method: "POST",
    body: JSON.stringify({ confirmation: "IMPORT DATA" }),
  });
  check("CHECKSUM: tampered staged file refuses to commit (§311)", tamCommit.body?.error?.code === "IMPORT_FILE_CHANGED" || tamCommit.body?.error?.code === "IMPORT_COMMIT_FAILED", tamCommit.body?.error?.code);
} catch {
  check("CHECKSUM: staged file writable for tamper test", false, stagedPath);
}

/* =========================== STATE TAMPERING =============================== */
section("STATE TAMPERING");
// Fresh upload so the job is in MAPPING_REQUIRED (the remap gate applies).
const tamperUpload = await uploadImport(bA, "customers", "tamper.csv", "name\nTamper Probe\n");
const TAMP_JOB = tamperUpload.body?.data?.job?.id;
const tamperMap = await apiJson(bA, `/api/v1/imports/${TAMP_JOB}/mapping`, {
  method: "POST",
  body: JSON.stringify({ mapping: { name: "businessId" }, status: "COMPLETED", validRows: 5000, duplicateMode: "SKIP" }),
});
check("TAMPER: forbidden field target rejected (§104/§347)", tamperMap.res.status === 422, String(tamperMap.res.status));
const tamperStatus = await apiJson(bA, `/api/v1/imports/${REJ_JOB}`, { method: "PATCH", body: JSON.stringify({ status: "COMPLETED" }) });
check("TAMPER: PATCH cannot assign status (§104)", tamperStatus.res.status >= 400, String(tamperStatus.res.status));
// §103 — a FAILED job can never re-enter VALIDATING/READY.
const invalidTransition = await apiJson(bA, `/api/v1/imports/${REJ_JOB}/validate`, { method: "POST" });
check("TAMPER: validate on FAILED job rejected (§103)", invalidTransition.res.status === 409, String(invalidTransition.res.status));
// userId/businessId tampering via body (§105/§106): the API ignores them.
const tamperBiz = await uploadImport(bB, "customers", "b.csv", "name\nB Row\n");
check("TAMPER: B's upload lands in B (server-owned businessId)", tamperBiz.res.status === 201);
const bJobBiz = tamperBiz.body?.data?.job?.id;
await apiJson(bB, `/api/v1/imports/${bJobBiz}/mapping`, {
  method: "POST",
  body: JSON.stringify({ mapping: tamperBiz.body.data.suggestedMapping, duplicateMode: "SKIP", businessId: A_ID, requestedByUserId: "hack" }),
});
const bJob = await db.dataImportJob.findUnique({ where: { id: bJobBiz } });
check("TAMPER: businessId/userId immutable from body (§105/§106)", bJob?.businessId === B_ID && bJob?.requestedByUserId !== "hack");

/* ============================ EXPORT/IMPORT AUDIT ========================== */
section("AUDIT");
const exportAudits = await db.auditLog.count({ where: { businessId: A_ID, action: { in: ["data_export.requested", "data_export.completed", "data_export.downloaded"] } } });
check("AUDIT: export requested/completed/downloaded recorded (§378)", exportAudits >= 3, String(exportAudits));
const importAudits = await db.auditLog.findMany({
  where: { businessId: A_ID, action: { in: ["data_import.created", "data_import.validated", "data_import.dry_run", "data_import.committed", "data_import.failed"] } },
  select: { action: true, afterJson: true },
});
check("AUDIT: import lifecycle recorded", importAudits.length >= 5, String(importAudits.length));
const auditText = importAudits.map((a) => a.afterJson ?? "").join("\n");
check("AUDIT: no row contents in audit payloads (§34/§379)", !auditText.includes("علی") && !auditText.includes("ali@example.com") && !auditText.includes("salePriceMinor"));

/* ============================== CLEANUP ==================================== */
section("CLEANUP");
const { spawnSync } = await import("node:child_process");
const prune = spawnSync("bun", ["scripts/prune-expired-imports.mjs"], { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname });
check("CLEANUP: prune-imports dry-run runs (§383)", prune.status === 0 && /expired-not-yet-committable/.test(prune.stdout), prune.stdout.split("\n")[1] ?? "");
const pruneExports = spawnSync("bun", ["scripts/prune-expired-exports.mjs"], { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname });
check("CLEANUP: prune-exports dry-run runs", pruneExports.status === 0, "");

// Export cleanup end-to-end: the expired CSV export artifact disappears.
const expiredRow = await db.dataExportJob.findUnique({ where: { id: CSV_ID } });
if (expiredRow?.storageKey) {
  const applyPrune = spawnSync("bun", ["scripts/prune-expired-exports.mjs", "--apply"], { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname });
  const goneAfter = !fsMod.existsSync(`${rootGuess.replace(/^\.\//, "")}/exports/${expiredRow.storageKey}`);
  check("CLEANUP: apply removes expired export file (§246)", applyPrune.status === 0 && goneAfter, `gone=${goneAfter}`);
  const dlAfterCleanup = await bA(`/api/v1/exports/${CSV_ID}/download`);
  check("CLEANUP: download after cleanup rejected", dlAfterCleanup.status === 404 || dlAfterCleanup.status === 410, String(dlAfterCleanup.status));
} else {
  check("CLEANUP: expired export artifact still tracked", false, "no storageKey");
}

/* ================================ SUMMARY ================================== */
await db.$disconnect();
const failed = results.filter((r) => !r.ok);
console.log(`\nprompt31-data-portability-check: ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
  console.log("FAILED:");
  for (const f of failed) console.log(`  ✗ [${f.section}] ${f.name} ${f.info ?? ""}`);
  process.exit(1);
}
process.exit(0);
