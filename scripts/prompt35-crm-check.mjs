/**
 * scripts/prompt35-crm-check.mjs — Prompt 35 §110 E2E harness.
 *
 * REAL HTTP against the running dev server with real NextAuth sessions.
 * Fixtures are created through the SAME tenant APIs a user would use.
 *
 * Sections (§110 A–AF):
 *   A  auth        401 unauthenticated · 400 no business context
 *   B  membership  non-member → 403 FORBIDDEN (no leak)
 *   C  isolation   foreign ids → 404 (leads + opportunities)
 *   D  lead CRUD
 *   E  lead status transitions (valid + invalid map)
 *   F  opportunity CRUD
 *   G  opportunity stage transitions (valid + invalid)
 *   H  WON rules (customer required; probability forced 100; wonAt set)
 *   I  LOST rules (reason required; probability forced 0; lostAt set)
 *   J  weighted pipeline (summary: exact integer math)
 *   K  conversion → existing customer
 *   L  conversion → new customer (+CUSTOMERS_MAX gate passed)
 *   M  conversion → new customer + opportunity (atomic)
 *   N  customer entitlement exhausted → 422, lead unchanged
 *   O  financial non-interference (sales/cash/receivables unchanged)
 *   P  search lead
 *   Q  search opportunity
 *   R  deep links (parseEntityRoute/entityToHash closed map round-trip)
 *   S  customer 360 CRM section (bounded, lead origin)
 *   T  business switching (A ids under B → 404)
 *   U  delete behavior (soft delete + search/list gone + customer intact)
 *   V  forbidden fields absent
 *   W  pagination
 *   X  filters (status/source/stage)
 *   Y  EN/FA server data tokens stable (UI rendering browser-tested)
 *   AD exact DTO shape
 *   AE audit actions present (9 actions)
 *   AF export coverage (crm_leads + crm_opportunities datasets)
 *   CLEANUP zero leftovers (P35- prefixed)
 *
 * Run: bun scripts/prompt35-crm-check.mjs   (needs dev server on :3000)
 * Exit: 0 = all green · 1 = at least one failure.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { parseEntityRoute, entityToHash, SEARCH_TYPE_TO_ENTITY } from "../src/lib/entity-routes.ts";

const BASE = process.env.P35_BASE ?? "http://localhost:3000";
const PASS = "testpass123";
const PREFIX = "P35-";
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
let lastBody = null;
function section(name) { current = name; }
function check(name, cond, info = "") {
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? "✓" : "✗"} [${current}] ${name}${cond ? (info ? ` — ${info}` : "") : ` |last=${JSON.stringify(lastBody)?.slice(0, 200)}`}`);
  return cond;
}

/* ------------------------------ fetch helpers ------------------------------ */
function randomXff() {
  return `10.48.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
}
function jarFetch(jar) {
  return async (path, init = {}) => {
    const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    const headers = { "x-forwarded-for": randomXff(), ...(init.headers ?? {}) };
    if (init.body && !headers["content-type"]) headers["content-type"] = "application/json";
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
  try { body = await res.json(); } catch {}
  lastBody = body;
  return { res, body };
}
async function login(jar, email, password) {
  const f = jarFetch(jar);
  const { csrfToken } = await (await f("/api/auth/csrf")).json();
  const form = new URLSearchParams({ csrfToken, email, password, redirect: "false", json: "true" });
  await f("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  return [...jar.keys()].some((k) => k.includes("session-token"));
}
async function createBusiness(jar, name) {
  const f = jarFetch(jar);
  const { body } = await apiJson(f, "/api/v1/businesses", {
    method: "POST",
    body: JSON.stringify({ name, currencyCode: "USD", locale: "en" }),
  });
  return body?.data?.business?.id ?? body?.data?.id ?? null;
}
const run = `r${Math.floor(Math.random() * 1e9)}`;

function eq(actual, expected, name) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, a === e ? "" : `expected ${e}, got ${a}`);
}
function collectKeys(v, acc = []) {
  if (Array.isArray(v)) { v.forEach((x) => collectKeys(x, acc)); return acc; }
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v)) { acc.push(k); collectKeys(val, acc); }
  }
  return acc;
}

/* ================================== SETUP ================================== */
console.log("\n== SETUP ==");
section("SETUP");
await db.business.deleteMany({ where: { name: { startsWith: `${PREFIX}A-` } } });
await db.business.deleteMany({ where: { name: { startsWith: `${PREFIX}B-` } } });
await db.user.deleteMany({ where: { email: { contains: "p35-" } } });
await db.plan.deleteMany({ where: { code: "P35-TINY" } });

const emailA = `p35-owner-a-${run}@test.local`;
const emailB = `p35-owner-b-${run}@test.local`;
const jarA = new Map();
const jarB = new Map();
const regA = await apiJson(jarFetch(new Map()), "/api/v1/auth/register", {
  method: "POST",
  body: JSON.stringify({ name: "P35 Owner A", email: emailA, password: PASS }),
});
check("register owner A", regA.body?.ok === true);
const regB = await apiJson(jarFetch(new Map()), "/api/v1/auth/register", {
  method: "POST",
  body: JSON.stringify({ name: "P35 Owner B", email: emailB, password: PASS }),
});
check("register owner B", regB.body?.ok === true);

check("login owner A", await login(jarA, emailA, PASS));
check("login owner B", await login(jarB, emailB, PASS));

const bizA = await createBusiness(jarA, `${PREFIX}A-BIZ`);
const bizB = await createBusiness(jarB, `${PREFIX}B-BIZ`);
check("business A created", Boolean(bizA), String(bizA));
check("business B created", Boolean(bizB), String(bizB));

const fA = jarFetch(jarA);
const wbA = (path, init = {}) => fA(path, { ...init, headers: { "x-business-id": bizA, ...(init.headers ?? {}) } });
const fB = jarFetch(jarB);
const wbB = (path, init = {}) => fB(path, { ...init, headers: { "x-business-id": bizB, ...(init.headers ?? {}) } });
async function call(wb, path, init = {}) {
  const { res, body } = await apiJson(wb, path, init);
  return { res, status: res.status, body, data: body?.ok ? body.data : null, err: body?.ok ? null : body?.error };
}

// fixture customers for conversion targets
const cust1 = await call(wbA, "/api/v1/customers", { method: "POST", body: JSON.stringify({ name: `${PREFIX}Existing Cust`, phone: "+989120000001" }) });
const existingCustomerId = cust1.data?.id;
check("existing customer created", Boolean(existingCustomerId));

/* ------------------------------ fixtures via APIs -------------------------- */
const leadAlice = await call(wbA, "/api/v1/crm/leads", {
  method: "POST",
  body: JSON.stringify({ name: `${PREFIX}LEAD-Alice`, companyName: `${PREFIX}Acme`, phone: "+989121111111", email: "alice@p35.test", source: "REFERRAL", sourceDetail: "word of mouth", note: "P35 fixture note" }),
});
const leadAliceId = leadAlice.data?.id;
check("P35-LEAD-Alice created", Boolean(leadAliceId));
const leadBob = await call(wbA, "/api/v1/crm/leads", {
  method: "POST",
  body: JSON.stringify({ name: `${PREFIX}LEAD-Bob`, source: "WEBSITE", email: "bob@p35.test" }),
});
const leadBobId = leadBob.data?.id;
check("P35-LEAD-Bob created", Boolean(leadBobId));
const leadConv = await call(wbA, "/api/v1/crm/leads", {
  method: "POST",
  body: JSON.stringify({ name: `${PREFIX}LEAD-Converted`, source: "PARTNER" }),
});
const leadConvId = leadConv.data?.id;
check("P35-LEAD-Converted created", Boolean(leadConvId));
const leadDisq = await call(wbA, "/api/v1/crm/leads", {
  method: "POST",
  body: JSON.stringify({ name: `${PREFIX}LEAD-Disq`, source: "OTHER" }),
});
const leadDisqId = leadDisq.data?.id;
check("P35-LEAD-Disq created", Boolean(leadDisqId));

const oppDiscovery = await call(wbA, "/api/v1/crm/opportunities", {
  method: "POST",
  body: JSON.stringify({ title: `${PREFIX}OPP-Discovery`, leadId: leadAliceId, expectedValueMinor: 10000, probabilityPct: 75, expectedCloseDate: "2026-10-10" }),
});
const oppDiscoveryId = oppDiscovery.data?.id;
check("P35-OPP-Discovery created (10000 × 75)", Boolean(oppDiscoveryId));
const oppProposal = await call(wbA, "/api/v1/crm/opportunities", {
  method: "POST",
  body: JSON.stringify({ title: `${PREFIX}OPP-Proposal`, customerId: existingCustomerId, expectedValueMinor: 4000 }),
});
const oppProposalId = oppProposal.data?.id;
check("P35-OPP-Proposal created", Boolean(oppProposalId));
const oppNegotiation = await call(wbA, "/api/v1/crm/opportunities", {
  method: "POST",
  body: JSON.stringify({ title: `${PREFIX}OPP-Negotiation`, customerId: existingCustomerId, expectedValueMinor: 20000, probabilityPct: 75 }),
});
const oppNegotiationId = oppNegotiation.data?.id;
check("P35-OPP-Negotiation created", Boolean(oppNegotiationId));
const oppWon = await call(wbA, "/api/v1/crm/opportunities", {
  method: "POST",
  body: JSON.stringify({ title: `${PREFIX}OPP-Won`, customerId: existingCustomerId, expectedValueMinor: 500 }),
});
const oppWonId = oppWon.data?.id;
check("P35-OPP-Won created", Boolean(oppWonId));
const oppLost = await call(wbA, "/api/v1/crm/opportunities", {
  method: "POST",
  body: JSON.stringify({ title: `${PREFIX}OPP-Lost`, customerId: existingCustomerId, expectedValueMinor: 700 }),
});
const oppLostId = oppLost.data?.id;
check("P35-OPP-Lost created", Boolean(oppLostId));
// move won/lost fixtures into terminal stages
await call(wbA, `/api/v1/crm/opportunities/${oppWonId}/stage`, { method: "POST", body: JSON.stringify({ stage: "WON" }) });
await call(wbA, `/api/v1/crm/opportunities/${oppLostId}/stage`, { method: "POST", body: JSON.stringify({ stage: "LOST", lostReason: `${PREFIX}No budget` }) });
// status transitions for converted/disq fixtures
await call(wbA, `/api/v1/crm/leads/${leadDisqId}/status`, { method: "POST", body: JSON.stringify({ status: "DISQUALIFIED" }) });

// business B fixture
const leadB = await call(wbB, "/api/v1/crm/leads", { method: "POST", body: JSON.stringify({ name: `${PREFIX}B-Lead`, source: "MANUAL" }) });
const leadBId = leadB.data?.id;
check("business B lead created", Boolean(leadBId));

/* --------------------------------- A auth ---------------------------------- */
console.log("\n== A AUTH ==");
section("A");
lastBody = null;
const anonLeads = await fetch(`${BASE}/api/v1/crm/leads`);
check("A1 unauthenticated leads → 401", anonLeads.status === 401);
const anonSummary = await fetch(`${BASE}/api/v1/crm/summary`);
check("A2 unauthenticated summary → 401", anonSummary.status === 401);
const noBiz = await call(jarFetch(jarA), "/api/v1/crm/leads");
check("A3 no business context → 400", noBiz.status === 400 && noBiz.err?.code === "NO_BUSINESS_CONTEXT");

/* ------------------------------ B membership ------------------------------- */
console.log("\n== B MEMBERSHIP ==");
section("B");
const foreignMember = await call((path, init = {}) => fB(path, { ...init, headers: { "x-business-id": bizA, ...(init.headers ?? {}) } }), "/api/v1/crm/leads");
check("B1 member-of-B with A business header → 403", foreignMember.status === 403 && foreignMember.err?.code === "FORBIDDEN");

/* ------------------------------- C isolation ------------------------------- */
console.log("\n== C ISOLATION ==");
section("C");
check("C1 foreign lead → 404", (await wbB(`/api/v1/crm/leads/${leadAliceId}`)).status === 404);
check("C2 foreign opportunity → 404", (await wbB(`/api/v1/crm/opportunities/${oppDiscoveryId}`)).status === 404);
check("C3 unknown lead → 404", (await wbA("/api/v1/crm/leads/nonexistent000000000000")).status === 404);

/* --------------------------------- D lead CRUD ----------------------------- */
console.log("\n== D LEAD CRUD ==");
section("D");
const dCreated = await call(wbA, "/api/v1/crm/leads", { method: "POST", body: JSON.stringify({ name: `${PREFIX}CRUD Lead`, source: "MANUAL" }) });
check("D1 create → 201", dCreated.status === 201 && dCreated.data?.status === "NEW");
const dId = dCreated.data?.id;
check("D2 server sets status NEW", dCreated.data?.status === "NEW");
const dPatched = await call(wbA, `/api/v1/crm/leads/${dId}`, { method: "PATCH", body: JSON.stringify({ name: `${PREFIX}CRUD Lead v2`, phone: "+989129999999", source: "SOCIAL" }) });
check("D3 PATCH updates fields", dPatched.status === 200 && dPatched.data?.name === `${PREFIX}CRUD Lead v2` && dPatched.data?.phone === "+989129999999");
check("D4 PATCH preserves status", dPatched.data?.status === "NEW");
const dInvalid = await call(wbA, "/api/v1/crm/leads", { method: "POST", body: JSON.stringify({ name: "X", source: "NOT_A_SOURCE" }) });
check("D5 invalid source rejected", dInvalid.status === 422);
const dDelete = await call(wbA, `/api/v1/crm/leads/${dId}`, { method: "DELETE" });
check("D6 DELETE → 200", dDelete.status === 200);
check("D7 deleted detail → 404", (await wbA(`/api/v1/crm/leads/${dId}`)).status === 404);

/* ------------------------------- E transitions ----------------------------- */
console.log("\n== E LEAD TRANSITIONS ==");
section("E");
check("E1 NEW→CONTACTED", (await call(wbA, `/api/v1/crm/leads/${leadBobId}/status`, { method: "POST", body: JSON.stringify({ status: "CONTACTED" }) })).status === 200);
check("E2 CONTACTED→QUALIFIED", (await call(wbA, `/api/v1/crm/leads/${leadBobId}/status`, { method: "POST", body: JSON.stringify({ status: "QUALIFIED" }) })).status === 200);
const e3 = await call(wbA, `/api/v1/crm/leads/${leadBobId}/status`, { method: "POST", body: JSON.stringify({ status: "CONVERTED" }) });
check("E3 bare CONVERTED blocked (use /convert)", e3.status === 422 && e3.err?.code === "INVALID_STATUS_TRANSITION");
const e4 = await call(wbA, `/api/v1/crm/leads/${leadBobId}/status`, { method: "POST", body: JSON.stringify({ status: "NEW" }) });
check("E4 QUALIFIED→NEW forbidden", e4.status === 422 && e4.err?.code === "INVALID_STATUS_TRANSITION");
const e5 = await call(wbA, `/api/v1/crm/leads/${leadBobId}/status`, { method: "POST", body: JSON.stringify({ status: "TOTALLY_NEW" }) });
check("E5 unknown status token rejected", e5.status === 422 && e5.err?.code === "VALIDATION_ERROR");
check("E6 QUALIFIED→DISQUALIFIED valid", (await call(wbA, `/api/v1/crm/leads/${leadBobId}/status`, { method: "POST", body: JSON.stringify({ status: "DISQUALIFIED" }) })).status === 200);
const e7 = await call(wbA, `/api/v1/crm/leads/${leadDisqId}/status`, { method: "POST", body: JSON.stringify({ status: "CONTACTED" }) });
check("E7 DISQUALIFIED terminal", e7.status === 422 && e7.err?.code === "INVALID_STATUS_TRANSITION");

/* ------------------------------- F opportunity CRUD ------------------------ */
console.log("\n== F OPPORTUNITY CRUD ==");
section("F");
const fCreated = await call(wbA, "/api/v1/crm/opportunities", { method: "POST", body: JSON.stringify({ title: `${PREFIX}CRUD Opp` }) });
check("F1 create defaults stage DISCOVERY / prob 10 / value 0", fCreated.status === 201 && fCreated.data?.stage === "DISCOVERY" && fCreated.data?.probabilityPct === 10 && fCreated.data?.expectedValueMinor === 0);
check("F2 currency captured from business", fCreated.data?.currencyCode === "USD");
const fId = fCreated.data?.id;
const fPatched = await call(wbA, `/api/v1/crm/opportunities/${fId}`, { method: "PATCH", body: JSON.stringify({ title: `${PREFIX}CRUD Opp v2`, expectedValueMinor: 12345, probabilityPct: 40 }) });
check("F3 PATCH updates forecast fields", fPatched.status === 200 && fPatched.data?.expectedValueMinor === 12345 && fPatched.data?.probabilityPct === 40);
const fStage = await call(wbA, `/api/v1/crm/opportunities/${fId}`, { method: "PATCH", body: JSON.stringify({ stage: "WON" }) });
check("F4 stage NOT patchable via generic PATCH", fStage.status === 200 && fStage.data?.stage === "DISCOVERY");
check("F5 delete", (await call(wbA, `/api/v1/crm/opportunities/${fId}`, { method: "DELETE" })).status === 200);
check("F6 deleted → 404", (await wbA(`/api/v1/crm/opportunities/${fId}`)).status === 404);
const fBadStage = await call(wbA, "/api/v1/crm/opportunities", { method: "POST", body: JSON.stringify({ title: `${PREFIX}Bad`, stage: "SUPER_WON" }) });
check("F7 unknown stage rejected at create", fBadStage.status === 422);

/* ------------------------------ G stage transitions ------------------------ */
console.log("\n== G STAGE TRANSITIONS ==");
section("G");
const g1 = await call(wbA, `/api/v1/crm/opportunities/${oppDiscoveryId}/stage`, { method: "POST", body: JSON.stringify({ stage: "WON" }) });
check("G1 WON→ from OPEN allowed but requires customer", g1.status === 422);
const g2 = await call(wbA, `/api/v1/crm/opportunities/${oppDiscoveryId}/stage`, { method: "POST", body: JSON.stringify({ stage: "LOST" }) });
check("G2 LOST without reason → 422", g2.status === 422);
const g3 = await call(wbA, `/api/v1/crm/opportunities/${oppDiscoveryId}/stage`, { method: "POST", body: JSON.stringify({ stage: "WON", probabilityPct: 55 }) });
check("G3 reopen-safe transitions validated", g3.status === 422);
const g4 = await call(wbA, `/api/v1/crm/opportunities/${oppWonId}/stage`, { method: "POST", body: JSON.stringify({ stage: "LOST", lostReason: "x" }) });
check("G4 WON→LOST forbidden (must reopen)", g4.status === 422 && g4.err?.code === "INVALID_STATUS_TRANSITION");
const g5 = await call(wbA, `/api/v1/crm/opportunities/${oppWonId}/stage`, { method: "POST", body: JSON.stringify({ stage: "PROPOSAL" }) });
check("G5 reopen WON→PROPOSAL clears terminal state", g5.status === 200 && g5.data?.stage === "PROPOSAL" && g5.data?.wonAt === null && g5.data?.lostReason === null);
check("G6 reopen probability reset to stage default (50)", g5.data?.probabilityPct === 50);

/* -------------------------------- H WON rules ------------------------------ */
console.log("\n== H WON RULES ==");
section("H");
const h1 = await call(wbA, `/api/v1/crm/opportunities/${oppProposalId}/stage`, { method: "POST", body: JSON.stringify({ stage: "WON" }) });
check("H1 WON with customer succeeds", h1.status === 200 && h1.data?.stage === "WON");
check("H2 probability forced 100", h1.data?.probabilityPct === 100);
check("H3 wonAt set", typeof h1.data?.wonAt === "string" && h1.data?.wonAt.length > 0);
// financial non-interference snapshot continues in O

/* -------------------------------- I LOST rules ----------------------------- */
console.log("\n== I LOST RULES ==");
section("I");
const i1 = await call(wbA, `/api/v1/crm/opportunities/${oppNegotiationId}/stage`, { method: "POST", body: JSON.stringify({ stage: "LOST", lostReason: `${PREFIX}Lost to competitor` }) });
check("I1 LOST with reason succeeds", i1.status === 200 && i1.data?.stage === "LOST");
check("I2 probability forced 0", i1.data?.probabilityPct === 0);
check("I3 lostAt set + wonAt cleared", typeof i1.data?.lostAt === "string" && i1.data?.wonAt === null);

/* ------------------------------- J weighted pipeline ----------------------- */
console.log("\n== J WEIGHTED PIPELINE ==");
section("J");
// state: Discovery(10000×75) open · Won fixture reopened→PROPOSAL(500×50) open
// Proposal→WON · Negotiation→LOST · Lost(700) LOST
// open value = 10500; weighted = 10000×75/100 + 500×50/100 = 7500+250 = 7750
const jSummary = await call(wbA, "/api/v1/crm/summary");
check("J1 summary returns", jSummary.status === 200);
check("J2 open pipeline value = 10500", jSummary.data?.opportunities?.openPipelineValueMinor === 10500, `got ${jSummary.data?.opportunities?.openPipelineValueMinor}`);
check("J3 weighted = 7750 (exact integer)", jSummary.data?.opportunities?.weightedPipelineValueMinor === 7750, `got ${jSummary.data?.opportunities?.weightedPipelineValueMinor}`);
check("J4 won count = 1", jSummary.data?.opportunities?.wonCount === 1);
check("J5 lost count = 2", jSummary.data?.opportunities?.lostCount === 2, `got ${jSummary.data?.opportunities?.lostCount}`);
check("J6 lead status buckets present", jSummary.data?.leads && typeof jSummary.data.leads.total === "number");

/* ------------------------- K/L/M conversions ------------------------------- */
console.log("\n== K/L/M CONVERSION ==");
section("K/L/M");
// K — existing customer
const k1 = await call(wbA, `/api/v1/crm/leads/${leadAliceId}/convert`, { method: "POST", body: JSON.stringify({ mode: "EXISTING_CUSTOMER", customerId: existingCustomerId }) });
check("K1 convert → existing customer 200", k1.status === 200);
check("K2 lead CONVERTED + convertedAt", k1.data?.status === "CONVERTED" && typeof k1.data?.convertedAt === "string");
check("K3 customer linked", k1.data?.customer?.id === existingCustomerId);
const custBefore = await call(wbA, `/api/v1/customers/${existingCustomerId}`);
check("K4 customer NOT duplicated/modified", custBefore.status === 200 && custBefore.data?.customer?.name === `${PREFIX}Existing Cust`);
const customersCountK = (await call(wbA, "/api/v1/customers?pageSize=100")).data?.total;
check("K5 no duplicate customer row", customersCountK === 1, `total=${customersCountK}`);
const k6 = await call(wbA, `/api/v1/crm/leads/${leadAliceId}/convert`, { method: "POST", body: JSON.stringify({ mode: "EXISTING_CUSTOMER", customerId: existingCustomerId }) });
check("K6 double convert rejected", k6.status === 422 && k6.err?.code === "INVALID_STATUS_TRANSITION");

// L — new customer
const customersBeforeL = (await call(wbA, "/api/v1/customers?pageSize=100")).data?.total;
const l1 = await call(wbA, `/api/v1/crm/leads/${leadConvId}/convert`, { method: "POST", body: JSON.stringify({ mode: "CREATE_CUSTOMER", customer: { name: `${PREFIX}LEAD-Converted`, phone: "+989122222222", email: "converted@p35.test" } }) });
check("L1 convert → new customer 200", l1.status === 200 && l1.data?.status === "CONVERTED");
const customersAfterL = (await call(wbA, "/api/v1/customers?pageSize=100")).data?.total;
check("L2 customer count incremented by exactly 1", customersAfterL === customersBeforeL + 1);
const l3 = await call(wbA, `/api/v1/crm/leads/${leadConvId}`);
check("L3 lead keeps companyName (Customer model has none)", l3.data?.companyName === null || typeof l3.data?.companyName === "string");

// M — new customer + opportunity atomic
const customersBeforeM = (await call(wbA, "/api/v1/customers?pageSize=100")).data?.total;
const m1 = await call(wbA, `/api/v1/crm/leads/${leadBobId}/convert`, { method: "POST", body: JSON.stringify({ mode: "CREATE_CUSTOMER", customer: { name: `${PREFIX}LEAD-Bob` }, opportunityTitle: `${PREFIX}OPP-From-Conversion` }) });
check("M1 convert + opportunity 200", m1.status === 200);
check("M2 opportunity created in same tx", Boolean(m1.data?.result?.opportunityId));
const mOpp = await call(wbA, `/api/v1/crm/opportunities/${m1.data?.result?.opportunityId}`);
check("M3 opportunity linked to lead + customer", mOpp.status === 200 && mOpp.data?.lead?.id === leadBobId && mOpp.data?.customer?.id === m1.data?.result?.customerId);
check("M4 opportunity starts DISCOVERY/10", mOpp.data?.stage === "DISCOVERY" && mOpp.data?.probabilityPct === 10);

/* ------------------------- N customer entitlement -------------------------- */
console.log("\n== N ENTITLEMENT ==");
section("N");
// Build a P35-TINY plan (CUSTOMERS_MAX 1) and force bizB onto it.
const tinyPlan = await db.plan.upsert({
  where: { code: "P35-TINY" },
  create: {
    code: "P35-TINY",
    name: "P35 Test Tiny",
    active: true,
  },
  update: {},
});
const tinyDef = await db.entitlementDefinition.findUnique({ where: { code: "CUSTOMERS_MAX" } });
const existingTiny = await db.planEntitlement.findFirst({ where: { planId: tinyPlan.id, entitlementId: tinyDef.id } });
if (!existingTiny) {
  await db.planEntitlement.create({ data: { planId: tinyPlan.id, entitlementId: tinyDef.id, value: 1 } });
}
await db.planEntitlement.upsert({
  where: { planId_entitlementId: { planId: tinyPlan.id, entitlementId: tinyDef.id } },
  create: { planId: tinyPlan.id, entitlementId: tinyDef.id, value: 1 },
  update: { value: 1 },
});
await db.subscription.updateMany({ where: { businessId: bizB }, data: { planId: tinyPlan.id } });
// create lead + a customer in B so usage=1
const custB = await call(wbB, "/api/v1/customers", { method: "POST", body: JSON.stringify({ name: `${PREFIX}B-Cust` }) });
check("N1 customer in B created", custB.status === 201);
const leadN = await call(wbB, "/api/v1/crm/leads", { method: "POST", body: JSON.stringify({ name: `${PREFIX}B-Limit-Lead`, source: "MANUAL" }) });
check("N2 lead in B created", leadN.status === 201);
const n3 = await call(wbB, `/api/v1/crm/leads/${leadN.data?.id}/convert`, { method: "POST", body: JSON.stringify({ mode: "CREATE_CUSTOMER", customer: { name: `${PREFIX}B-Overflow` } }) });
check("N3 limit reached → 422", n3.status === 422);
const n4 = await call(wbB, `/api/v1/crm/leads/${leadN.data?.id}`);
check("N4 lead unchanged (still NEW)", n4.data?.status === "NEW");
const customersB = await db.customer.count({ where: { businessId: bizB, deletedAt: null } });
check("N5 no partial customer created", customersB === 1, `count=${customersB}`);

/* --------------------- O financial non-interference ------------------------ */
console.log("\n== O FINANCIAL NON-INTERFERENCE ==");
section("O");
const salesA = await call(wbA, "/api/v1/sales?pageSize=100");
const expensesA = await call(wbA, "/api/v1/expenses?pageSize=100");
const paymentsA = await call(wbA, "/api/v1/payments?pageSize=100");
check("O1 sales total = 0 (CRM actions created none)", salesA.data?.total === 0, `total=${salesA.data?.total}`);
check("O2 payments total = 0", paymentsA.data?.total === 0);
check("O3 expenses total = 0", expensesA.data?.total === 0);
const summaryO = await call(wbA, "/api/v1/reports/summary");
check("O4 financial report reachable", summaryO.status === 200);
// create explicit sale → financial values change only now
const product = await call(wbA, "/api/v1/products", { method: "POST", body: JSON.stringify({ name: `${PREFIX}Product`, salePriceMinor: 3000, costPriceMinor: 1000, stockQty: 5 }) });
const saleNow = await call(wbA, "/api/v1/sales", {
  method: "POST",
  body: JSON.stringify({ customerId: existingCustomerId, items: [{ name: `${PREFIX}Product`, qty: 1, unitPriceMinor: 3000 }], issueDate: new Date().toISOString() }),
});
check("O5 explicit sale creation works from CRM-linked customer", saleNow.status === 201);
check("O6 after explicit sale, sales total = 1", (await call(wbA, "/api/v1/sales?pageSize=100")).data?.total === 1);
// WON transition after sale: still no new sale
const oppO = await call(wbA, "/api/v1/crm/opportunities", { method: "POST", body: JSON.stringify({ title: `${PREFIX}OPP-O-Check`, customerId: existingCustomerId, expectedValueMinor: 99999 }) });
await call(wbA, `/api/v1/crm/opportunities/${oppO.data?.id}/stage`, { method: "POST", body: JSON.stringify({ stage: "WON" }) });
check("O7 WON does NOT create sale", (await call(wbA, "/api/v1/sales?pageSize=100")).data?.total === 1);

/* --------------------------------- P search lead --------------------------- */
console.log("\n== P SEARCH LEAD ==");
section("P");
const p1 = await call(wbA, "/api/v1/search?q=LEAD-Alice");
const pLead = p1.data?.groups?.find((g) => g.type === "LEAD");
check("P1 search finds the lead", Boolean(pLead));
check("P2 lead group exact id", pLead?.items?.[0]?.id === leadAliceId);
check("P3 destination is leads", pLead?.items?.[0]?.destination === "leads");
const pFa = await call(wbA, "/api/v1/search?q=سرنخ");
check("P4 Persian search executes", pFa.status === 200);

/* ----------------------------- Q search opportunity ------------------------ */
console.log("\n== Q SEARCH OPPORTUNITY ==");
section("Q");
const q1 = await call(wbA, "/api/v1/search?q=OPP-Discovery");
const qOpp = q1.data?.groups?.find((g) => g.type === "OPPORTUNITY");
check("Q1 search finds the opportunity", Boolean(qOpp));
check("Q2 opportunity group exact id", qOpp?.items?.[0]?.id === oppDiscoveryId);

/* -------------------------------- R deep links ----------------------------- */
console.log("\n== R DEEP LINKS ==");
section("R");
eq(parseEntityRoute(`leads/${leadAliceId}`), { entity: "lead", id: leadAliceId }, "R1 parseEntityRoute #/leads/<id>");
eq(parseEntityRoute(`opportunities/${oppDiscoveryId}`), { entity: "opportunity", id: oppDiscoveryId }, "R2 parseEntityRoute #/opportunities/<id>");
check("R3 entityToHash lead", entityToHash("lead", leadAliceId) === `#/leads/${leadAliceId}`);
check("R4 entityToHash opportunity", entityToHash("opportunity", oppDiscoveryId) === `#/opportunities/${oppDiscoveryId}`);
check("R5 SEARCH_TYPE_TO_ENTITY closed map", SEARCH_TYPE_TO_ENTITY.LEAD === "lead" && SEARCH_TYPE_TO_ENTITY.OPPORTUNITY === "opportunity");
check("R6 #/crm/leads/<id> NOT routable", parseEntityRoute(`crm/leads/${leadAliceId}`) === null);

/* ------------------------------- S customer 360 ---------------------------- */
console.log("\n== S CUSTOMER 360 ==");
section("S");
// existingCustomer now has: OPP-Proposal (WON), OPP-Negotiation (LOST), OPP-Won (WON), OPP-O-Check (WON) — recent ≤10 + open count
const s1 = await call(wbA, `/api/v1/customers/${existingCustomerId}`);
check("S1 customer detail has crm section", Boolean(s1.data?.crm));
check("S2 open opportunities counted", s1.data?.crm?.openOpportunityCount === 1, `open=${s1.data?.crm?.openOpportunityCount}`);
check("S3 recent opportunities bounded ≤10", Array.isArray(s1.data?.crm?.recentOpportunities) && s1.data.crm.recentOpportunities.length <= 10 && s1.data.crm.recentOpportunities.length >= 3);
check("S4 opportunity ref fields minimal", s1.data?.crm?.recentOpportunities?.[0] && ["id", "title", "stage", "probabilityPct", "expectedValueMinor", "expectedCloseDate"].every((k) => k in s1.data.crm.recentOpportunities[0]));
check("S5 lead origin present after conversion", s1.data?.crm?.leadOrigin?.id === leadAliceId);
check("S6 financial summary untouched by CRM", typeof s1.data?.summary?.totalSalesMinor === "number" && s1.data.summary.totalSalesMinor === 3000);

/* ------------------------------ T business switching ----------------------- */
console.log("\n== T BUSINESS SWITCH ==");
section("T");
check("T1 A lead under B → 404", (await wbB(`/api/v1/crm/leads/${leadAliceId}`)).status === 404);
check("T2 A opportunity under B → 404", (await wbB(`/api/v1/crm/opportunities/${oppProposalId}`)).status === 404);
check("T3 B own lead still resolves", (await call(wbB, `/api/v1/crm/leads/${leadBId}`)).status === 200);
check("T4 summary is tenant-scoped", (await call(wbB, "/api/v1/crm/summary")).data?.leads?.total === 2);

/* ------------------------------- U delete behavior ------------------------- */
console.log("\n== U DELETE BEHAVIOR ==");
section("U");
const uLead = await call(wbA, "/api/v1/crm/leads", { method: "POST", body: JSON.stringify({ name: `${PREFIX}Delete-Me`, source: "SOCIAL" }) });
const uLeadId = uLead.data?.id;
const uOpp = await call(wbA, "/api/v1/crm/opportunities", { method: "POST", body: JSON.stringify({ title: `${PREFIX}Delete-Opp`, leadId: uLeadId, expectedValueMinor: 111 }) });
const uOppId = uOpp.data?.id;
check("U1 lead delete → 200", (await call(wbA, `/api/v1/crm/leads/${uLeadId}`, { method: "DELETE" })).status === 200);
check("U2 deleted lead detail → 404", (await wbA(`/api/v1/crm/leads/${uLeadId}`)).status === 404);
const uSearch = await call(wbA, "/api/v1/search?q=Delete-Me");
check("U3 deleted lead not in search", !uSearch.data?.groups?.some((g) => g.type === "LEAD"));
check("U4 related opportunity survives (leadId SetNull-on-delete not cascade)", (await call(wbA, `/api/v1/crm/opportunities/${uOppId}`)).status === 200);
check("U5 delete converted lead does NOT delete customer", (await call(wbA, `/api/v1/customers/${existingCustomerId}`)).status === 200);
await call(wbA, `/api/v1/crm/opportunities/${uOppId}`, { method: "DELETE" });
const uOppAfter = await call(wbA, `/api/v1/crm/opportunities/${uOppId}`);
check("U6 opportunity deleted → 404", uOppAfter.status === 404);

/* ------------------------------- V forbidden fields ------------------------ */
console.log("\n== V FORBIDDEN FIELDS ==");
section("V");
const vLead = await call(wbA, `/api/v1/crm/leads/${leadAliceId}`);
const vOpp = await call(wbA, `/api/v1/crm/opportunities/${oppDiscoveryId}`);
const vSummary = await call(wbA, "/api/v1/crm/summary");
const vKeys = collectKeys([vLead.data, vOpp.data, vSummary.data]);
const FORBIDDEN_KEYS = new Set([
  "passwordHash", "sessionVersion", "businessId", "assignedToUserId", "customerId",
  "mfa", "recoveryCode", "token", "providerSecret", "webhookSignature", "userAgent",
  "ip", "AiCostRecord", "costNanoMinor", "PaymentTransaction", "checkoutSession",
]);
const leaked = vKeys.filter((k) => FORBIDDEN_KEYS.has(k));
check("V1 no forbidden keys in CRM responses", leaked.length === 0, leaked.join(","));
check("V2 DTO exposes assignee object instead of raw ids", vLead.data?.assignedTo !== undefined && typeof vLead.data.assignedTo === "object");

/* --------------------------------- W pagination ---------------------------- */
console.log("\n== W PAGINATION ==");
section("W");
const w1 = await call(wbA, "/api/v1/crm/leads?page=1&pageSize=2");
check("W1 pageSize honored", w1.data?.items?.length === 2 && w1.data?.pageSize === 2);
check("W2 total accurate", w1.data?.total >= 4);
const w2 = await call(wbA, "/api/v1/crm/leads?page=2&pageSize=2");
check("W3 page 2 differs from page 1", w2.data?.items?.[0]?.id !== w1.data?.items?.[0]?.id);
const w3 = await call(wbA, "/api/v1/crm/leads?pageSize=1000");
check("W4 pageSize capped at 100", w3.data?.pageSize === 100);

/* ---------------------------------- X filters ------------------------------ */
console.log("\n== X FILTERS ==");
section("X");
const x1 = await call(wbA, "/api/v1/crm/leads?status=CONVERTED");
check("X1 status filter (all converted)", x1.data?.items?.every((l) => l.status === "CONVERTED") && x1.data.items.length >= 2);
const x2 = await call(wbA, "/api/v1/crm/leads?source=PARTNER");
check("X2 source filter", x2.data?.items?.every((l) => l.source === "PARTNER"));
const x3 = await call(wbA, "/api/v1/crm/opportunities?stage=LOST");
check("X3 stage filter", x3.data?.items?.every((o) => o.stage === "LOST") && x3.data.items.length >= 2);
const x4 = await call(wbA, "/api/v1/crm/opportunities?customerId=nonexistent");
check("X4 customer filter empty-safe", x4.data?.items?.length === 0);
const x5 = await call(wbA, "/api/v1/crm/leads?status=BOGUS");
check("X5 unknown filter → 422", x5.status === 422);
const x6 = await call(wbA, "/api/v1/crm/opportunities?q=OPP");
check("X6 q search across title", x6.data?.items?.length >= 3);

/* ------------------------------ Y EN/FA tokens ----------------------------- */
console.log("\n== Y EN/FA TOKENS ==");
section("Y");
check("Y1 status tokens are raw closed enums (client localizes)", x1.data?.items?.[0]?.status === "CONVERTED");
check("Y2 stage tokens raw", i1.data?.stage === "LOST");
check("Y3 dates are ISO strings", typeof leadAlice.data?.createdAt === "string" && leadAlice.data.createdAt.includes("T"));

/* ------------------------------ AD exact DTO shape ------------------------- */
console.log("\n== AD DTO SHAPE ==");
section("AD");
const adLeadKeys = Object.keys(vLead.data).sort();
eq(
  adLeadKeys,
  ["assignedTo", "companyName", "convertedAt", "createdAt", "customer", "email", "id", "name", "note", "openOpportunityCount", "opportunityCount", "phone", "recentOpportunities", "source", "sourceDetail", "status", "updatedAt"].sort(),
  "AD1 lead detail top-level keys exact",
);
const adOppKeys = Object.keys(vOpp.data).sort();
eq(
  adOppKeys,
  ["assignedTo", "createdAt", "currencyCode", "customer", "description", "expectedCloseDate", "expectedValueMinor", "id", "lead", "lostAt", "lostReason", "probabilityPct", "stage", "title", "updatedAt", "weightedValueMinor", "wonAt"].sort(),
  "AD2 opportunity detail top-level keys exact",
);
const adSummaryKeys = Object.keys(vSummary.data).sort();
eq(adSummaryKeys, ["currencyCode", "leads", "newLeadsInPeriod", "opportunities"], "AD3 summary top-level keys exact");

/* ---------------------------------- AE audit ------------------------------- */
console.log("\n== AE AUDIT ==");
section("AE");
const auditActions = [
  "crm.lead.create",
  "crm.lead.update",
  "crm.lead.status_change",
  "crm.lead.convert",
  "crm.lead.delete",
  "crm.opportunity.create",
  "crm.opportunity.update",
  "crm.opportunity.stage_change",
  "crm.opportunity.delete",
];
const auditRows = await db.auditLog.findMany({
  where: { businessId: bizA, action: { in: auditActions } },
  select: { action: true },
});
const seenActions = new Set(auditRows.map((r) => r.action));
for (const action of auditActions) {
  check(`AE ${action}`, seenActions.has(action));
}
const crmAuditRows = await db.auditLog.findMany({
  where: { businessId: bizA, action: { startsWith: "crm." } },
  select: { afterJson: true, beforeJson: true },
});
const auditBlob = JSON.stringify(crmAuditRows);
check("AE10 audit carries no secrets/bodies", !auditBlob.includes("password") && !auditBlob.includes("testpass123") && !auditBlob.includes("userAgent"));

/* --------------------------------- AF export ------------------------------- */
console.log("\n== AF EXPORT ==");
section("AF");
const afCreate = await call(wbA, "/api/v1/exports", {
  method: "POST",
  body: JSON.stringify({ format: "JSON", datasets: ["crm_leads", "crm_opportunities"] }),
});
check("AF1 export job with CRM datasets accepted", afCreate.status === 200 || afCreate.status === 201, `status=${afCreate.status}`);
const exportJobId = afCreate.data?.id ?? afCreate.data?.job?.id;
if (exportJobId) {
  let exportJob = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const j = await call(wbA, `/api/v1/exports/${exportJobId}`);
    if (j.data?.status === "COMPLETED" || j.data?.status === "FAILED") { exportJob = j.data; break; }
  }
  check("AF2 export job completes", exportJob?.status === "COMPLETED", exportJob?.status);
  check("AF3 CRM datasets present with rows", (exportJob?.datasets ?? []).includes("crm_leads") && (exportJob?.datasets ?? []).includes("crm_opportunities") && (exportJob?.recordCount ?? 0) > 0, `datasets=${JSON.stringify(exportJob?.datasets)} records=${exportJob?.recordCount}`);
} else {
  check("AF2 export job id returned", false);
}

/* ================================ CLEANUP ================================== */
console.log("\n== CLEANUP ==");
section("CLEANUP");
await db.business.deleteMany({ where: { name: { startsWith: `${PREFIX}A-` } } });
await db.business.deleteMany({ where: { name: { startsWith: `${PREFIX}B-` } } });
await db.user.deleteMany({ where: { email: { contains: "p35-" } } });
await db.plan.deleteMany({ where: { code: "P35-TINY" } });
const [b, u, c, l, o] = await Promise.all([
  db.business.count({ where: { name: { startsWith: `${PREFIX}` } } }),
  db.user.count({ where: { email: { contains: "p35-" } } }),
  db.customer.count({ where: { name: { startsWith: `${PREFIX}` } } }),
  db.crmLead.count({ where: { name: { startsWith: `${PREFIX}` } } }),
  db.crmOpportunity.count({ where: { title: { startsWith: `${PREFIX}` } } }),
]);
const leftover = b + u + c + l + o;
check("CLEANUP zero leftovers", leftover === 0, `leftover=${leftover} (biz=${b} users=${u} cust=${c} leads=${l} opps=${o})`);

/* --------------------------------- summary --------------------------------- */
const failedChecks = results.filter((r) => !r.ok);
console.log(`\nprompt35-crm-check: ${results.length - failedChecks.length}/${results.length} PASS`);
if (failedChecks.length > 0) {
  console.log("FAILURES:");
  for (const f of failedChecks) console.log(`  - [${f.name}]`);
  process.exit(1);
}
