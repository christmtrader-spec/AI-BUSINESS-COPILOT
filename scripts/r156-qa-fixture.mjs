#!/usr/bin/env node
/**
 * r156-qa-fixture.mjs — R156 QA data seed (sweep-pattern, idempotent).
 *
 * WHY: the sandbox DB reverted — every QA persona and all seeded business
 * data are gone. The DOCUMENTED baseline (sara/eve/ali, "Sara Copilot
 * Business") is restored by scripts/e2e-smoke-fixture.mjs (run that first —
 * this script assumes it). THIS script seeds the BUSINESS DATA the perf
 * panel QA needs, through the app's OWN API (never Prisma-direct for
 * transactional rows — the sale/expense endpoints own their side effects:
 * numbering, payments, balances, events):
 *
 *   Sales   : 2026-10 (days 05/12/20) · 2026-09 (days 03/18) · 2026-08 (day 09)
 *   Expenses: 2026-10 Materials + Shipping · 2026-09 Materials · 2026-08 Rent
 *
 *   → both perf panels' month groupings get ≥2 rows, the day grouping gets
 *     multi-day rows, and the R155 category facet keeps its Materials row.
 *
 * Idempotency: if sara's business already has ≥4 expenses, seeding is
 * SKIPPED entirely (safe to run every round).
 *
 * Usage: node scripts/r156-qa-fixture.mjs   (after e2e-smoke-fixture.mjs)
 * Env  : QA_BASE (default http://localhost:3000)
 */
import { PrismaClient } from "@prisma/client";

const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const EMAIL = "sara@copilot.dev";
const PASSWORD = "testpass123";
const prisma = new PrismaClient();

let passed = 0;
let failed = 0;
const ok = (name, cond, info = "") => {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${!cond && info ? ` — ${info}` : ""}`);
};

// ---- tiny cookie jar (NextAuth credentials dance) --------------------------
const jar = new Map();
function absorb(res) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      cookie: cookieHeader(),
      ...(init.headers ?? {}),
    },
  });
  absorb(res);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body };
}

async function login() {
  const csrf = await api("/api/auth/csrf");
  ok("csrf fetched", csrf.status === 200 && !!csrf.body?.csrfToken);
  const login = await api("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrfToken: csrf.body.csrfToken,
      email: EMAIL,
      password: PASSWORD,
      callbackUrl: `${BASE}/`,
      json: "true",
    }).toString(),
  });
  ok("credentials login accepted", login.status === 200 || login.status === 302, `status ${login.status}`);
}

// ---- main -------------------------------------------------------------------
await login();

// Sara's OWNED business via Prisma READ (the /api/v1/me payload carries the
// user, not the membership list — the fixture only ever READS here; every
// WRITE still rides the app's own API).
const owner = await prisma.user.findUnique({
  where: { email: EMAIL },
  select: { memberships: { select: { role: true, business: { select: { id: true, name: true } } } } },
});
const biz = owner?.memberships?.find((m) => m.role === "OWNER")?.business;
ok("sara session resolves a business", !!biz?.id, JSON.stringify(owner)?.slice(0, 120));
const BID = biz.id;
const H = { "x-business-id": BID };

const expList = await api("/api/v1/expenses?page=1&pageSize=1", { headers: H });
const existing = expList.body?.data?.total ?? 0;
if (existing >= 4) {
  console.log(`— sara's business already carries ${existing} expenses; seeding SKIPPED (idempotent)`);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

// Sales: three months, multi-day (the perf day/month groupings both get rows).
const SALES = [
  ["2026-10-05T10:00:00.000Z", "Persian rug 2×3", 2, 45000],
  ["2026-10-12T11:30:00.000Z", "Kilim runner", 1, 28000],
  ["2026-10-20T16:45:00.000Z", "Tabriz medallion", 1, 120000],
  ["2026-09-03T09:15:00.000Z", "Gabbeh pile", 3, 33000],
  ["2026-09-18T14:00:00.000Z", "Kilim runner", 2, 56000],
  ["2026-08-09T13:20:00.000Z", "Persian rug 2×3", 1, 47500],
];
let saleOk = 0;
for (const [issueDate, name, qty, unitPriceMinor] of SALES) {
  const r = await api("/api/v1/sales", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ items: [{ name, unit: "pcs", qty, unitPriceMinor }], issueDate }),
  });
  if (r.status === 201) saleOk++;
  else console.log(`  sale ${issueDate} → ${r.status}`, JSON.stringify(r.body)?.slice(0, 160));
}
ok(`sales seeded (${saleOk}/${SALES.length})`, saleOk === SALES.length);

// Expenses: the R155 Materials row + month spread across three months.
const EXPENSES = [
  ["2026-10-07T09:00:00.000Z", "Materials", 32000],
  ["2026-10-15T12:00:00.000Z", "Shipping", 8500],
  ["2026-09-11T10:30:00.000Z", "Materials", 15000],
  ["2026-08-21T08:45:00.000Z", "Rent", 70000],
];
let expOk = 0;
for (const [spentAt, category, amountMinor] of EXPENSES) {
  const r = await api("/api/v1/expenses", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ category, amountMinor, spentAt }),
  });
  if (r.status === 201) expOk++;
  else console.log(`  expense ${spentAt} → ${r.status}`, JSON.stringify(r.body)?.slice(0, 160));
}
ok(`expenses seeded (${expOk}/${EXPENSES.length})`, expOk === EXPENSES.length);

// Verify the perf month groupings the QA journey will click.
// R175 HONESTY FIX: sara's business is on the FREE plan by the DOCUMENTED
// smoke-fixture law (r136 — she sits at FREE's BUSINESSES_MAX 1), and
// ADVANCED_REPORTS is a paid entitlement — after a sandbox revert the
// fixture-restore backfills FREE and this probe 403s. The old shape
// (`body?.data?.groups ?? []`) MASKED the 403 as "empty groups" and failed
// the round. The law is now verified BOTH ways: 403 ENTITLEMENT_NOT_AVAILABLE
// = the server-side gate works (the perf-panel QA rides the r156-qa persona,
// whose seed grants STARTER); 200 = the original ≥2-month-groups proof.
const perfExp = await api(
  "/api/v1/reports/performance?kind=expenses&groupBy=month&from=2026-08-01&to=2026-10-31",
  { headers: H },
);
if (perfExp.status === 403 && perfExp.body?.error?.code === "ENTITLEMENT_NOT_AVAILABLE") {
  ok(
    "perf expenses month groups ≥2 (or the FREE-plan gate holds — the documented fixture law)",
    perfExp.body?.error?.details?.feature === "ADVANCED_REPORTS" &&
      perfExp.body?.error?.details?.planCode === "FREE",
    `unexpected 403 shape: ${JSON.stringify(perfExp.body).slice(0, 200)}`,
  );
} else {
  const expGroups = perfExp.body?.data?.groups ?? [];
  const expMonths = expGroups.filter((g) => g.dimension === "month").map((g) => g.month);
  ok("perf expenses month groups ≥2", expMonths.length >= 2, `got ${JSON.stringify(expMonths)}`);
}

const perfSales = await api(
  "/api/v1/reports/performance?kind=sales&groupBy=month&from=2026-08-01&to=2026-10-31",
  { headers: H },
);
if (perfSales.status === 403 && perfSales.body?.error?.code === "ENTITLEMENT_NOT_AVAILABLE") {
  ok(
    "perf sales month groups ≥2 (or the FREE-plan gate holds — the documented fixture law)",
    perfSales.body?.error?.details?.feature === "ADVANCED_REPORTS" &&
      perfSales.body?.error?.details?.planCode === "FREE",
    `unexpected 403 shape: ${JSON.stringify(perfSales.body).slice(0, 200)}`,
  );
} else {
  const salesGroups = perfSales.body?.data?.groups ?? [];
  const salesMonths = salesGroups.filter((g) => g.dimension === "month").map((g) => g.month);
  ok("perf sales month groups ≥2", salesMonths.length >= 2, `got ${JSON.stringify(salesMonths)}`);
}

console.log(`\nfixture: ${passed} passed, ${failed} failed`);
await prisma.$disconnect();
process.exit(failed === 0 ? 0 : 1);
