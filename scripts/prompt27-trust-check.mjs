#!/usr/bin/env node
/**
 * scripts/prompt27-trust-check.mjs — Prompt 27 harness (BUN + live server).
 *
 * Coverage:
 *   A1- Legal content model (registry): docs, deterministic versions, EN/FA
 *       parity, effectiveDate-null honesty, accepted contract types
 *   B1- Signup acceptance flow: acceptedLegal recorded (2 rows, server
 *       versions), absent acceptedLegal stays backward-compatible, bad
 *       shape rejected, duplicate email 409
 *   C1- Acceptance API: documents metadata minimal, POST idempotent,
 *       server-resolved version (client version ignored), non-contract
 *       types rejected, per-user isolation
 *   D1- Account deletion cascades acceptance rows (no orphans, §166)
 *   E1- Export/tenant surface: no AI cost, no provider secrets, no password
 *       hashes in the business export; no tenant-facing cost routes exist
 *   F1- Public honesty: /privacy renders the not-configured contact state,
 *       no example.com; /cookies documents the REAL cookie names;
 *       robots.txt disallows /api
 *
 * Usage: bun scripts/prompt27-trust-check.mjs [baseUrl]
 * Exit:  0 = all green · 1 = failures
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3000";
const ROOT = "/home/z/my-project";
const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = `${ROOT}/.env`;
  if (existsSync(envPath)) {
    const line = readFileSync(envPath, "utf8")
      .split("\n")
      .find((l) => l.trim().startsWith("DATABASE_URL="));
    return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("DATABASE_URL not available");
}
const prisma = new PrismaClient({ datasources: { db: { url: loadDatabaseUrl() } } });

const failures = [];
let passed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push({ name, detail });
    console.error(`  ✗ ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ""}`);
  }
}

const STAMP = Date.now();
const PASSWORD = "Prompt27-Trust-2026!";
// Unique test IP per run: register rate limits are keyed by IP, and repeated
// harness runs on the same IP would trip the 10/15min register budget.
const IP = `203.0.113.${Math.floor(Math.random() * 200) + 10}`;

/* ------------------------------ HTTP helpers ------------------------------ */

function newJar() {
  const cookies = new Map();
  return {
    capture(res) {
      const raw =
        typeof res.headers.getSetCookie === "function"
          ? res.headers.getSetCookie()
          : [res.headers.get("set-cookie")].filter(Boolean);
      for (const line of raw) {
        const [pair] = line.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    header() {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    get(nameSuffix) {
      for (const [k, v] of cookies) if (k.endsWith(nameSuffix)) return v;
      return null;
    },
  };
}

async function rawFetch(path, { method = "GET", body, headers = {}, jar, businessId } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect: "manual",
    headers: {
      "x-forwarded-for": IP,
      ...(businessId ? { "x-business-id": businessId } : {}),
      ...(body !== undefined && typeof body !== "string" ? { "content-type": "application/json" } : {}),
      ...(jar ? { cookie: jar.header() } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  if (jar) jar.capture(res);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}

async function login(email, password) {
  const jar = newJar();
  const csrfRes = await rawFetch("/api/auth/csrf", { jar });
  const csrfToken = jar.get("csrf-token")
    ? decodeURIComponent(jar.get("csrf-token")).split("|")[0]
    : csrfRes.json?.csrfToken;
  const res = await rawFetch("/api/auth/callback/credentials", {
    method: "POST",
    jar,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, email, password, callbackUrl: `${BASE}/`, json: "true" }).toString(),
  });
  if (!jar.get("session-token")) throw new Error(`login failed for ${email} (${res.status})`);
  return jar;
}

async function register(name, email, extra = {}) {
  return rawFetch("/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, email, password: PASSWORD, ...extra }),
  });
}

/* ------------------------- A. Legal content model ------------------------- */

const registry = await import("../src/content/legal/registry.ts");
const { LEGAL_DOCUMENTS, LEGAL_DOC_TYPES, ACCEPTED_DOC_TYPES, currentLegalVersions } = registry;

console.log("\n=== A. Legal content model ===");
// Self-heal sweep: prior crashed runs may have left probe businesses/users.
for (const b of await prisma.business.findMany({ where: { name: { contains: "P27 Trust Probe" } }, select: { id: true } })) {
  await prisma.business.delete({ where: { id: b.id } }).catch(() => {});
}
const staleIds = [
  ...(await prisma.user.findMany({ where: { email: { contains: "p27acc-" } }, select: { id: true } })).map((u) => u.id),
  ...(await prisma.user.findMany({ where: { email: { contains: "p27plain-" } }, select: { id: true } })).map((u) => u.id),
  ...(await prisma.user.findMany({ where: { email: { contains: "p27del-acc-" } }, select: { id: true } })).map((u) => u.id),
];
for (const id of staleIds) await prisma.user.delete({ where: { id } }).catch(() => {});
await prisma.commercialEvent.deleteMany({ where: { eventType: "SIGNUP_COMPLETED", userId: { in: staleIds } } });
const createdUserIds = [];
check("4 public documents registered", LEGAL_DOC_TYPES.length === 4 && ["privacy", "terms", "ai-data-use", "cookies"].every((t) => LEGAL_DOCUMENTS[t]));
for (const type of LEGAL_DOC_TYPES) {
  const doc = LEGAL_DOCUMENTS[type];
  check(`${type}: deterministic version + nullable effectiveDate`, /^\d{4}-\d{2}-v\d+$/.test(doc.version) && doc.effectiveDate === null, `${doc.version}/${doc.effectiveDate}`);
  check(`${type}: EN/FA section parity`, doc.locales.en.sections.length === doc.locales.fa.sections.length);
}
check("accepted contract types are exactly privacy+terms", ACCEPTED_DOC_TYPES.length === 2 && ACCEPTED_DOC_TYPES.includes("privacy") && ACCEPTED_DOC_TYPES.includes("terms"));
check("server version map matches documents", Object.values(currentLegalVersions()).every((v) => /^\d{4}-\d{2}-v\d+$/.test(v)));

/* ----------------------- B. Signup acceptance flow ------------------------ */

console.log("\n=== B. Signup acceptance flow ===");
const uAcc = `p27acc-${STAMP}@check.local`;
const uPlain = `p27plain-${STAMP}@check.local`;
const uDel = `p27del-acc-${STAMP}@check.local`;

const regAcc = await register("P27 Accepted", uAcc, { acceptedLegal: { terms: true, privacy: true } });
check("register with acceptedLegal → 201", regAcc.status === 201, regAcc.status);
const accUser = await prisma.user.findUnique({ where: { email: uAcc } });
if (accUser) createdUserIds.push(accUser.id);
const accRows = await prisma.legalAcceptance.findMany({ where: { userId: accUser.id } });
check("2 acceptance rows recorded", accRows.length === 2, accRows.length);
check("rows reference CURRENT server versions", accRows.every((r) => r.documentVersion === currentLegalVersions()[r.documentType]));
check("types are privacy+terms", accRows.map((r) => r.documentType).sort().join(",") === "privacy,terms");
check("locale recorded (en at signup)", accRows.every((r) => r.locale === "en"));
check("ip recorded for acceptance evidence", accRows.every((r) => r.ip === IP));
check("no legal TEXT stored (version reference only)", accRows.every((r) => !JSON.stringify(r).match(/privacy policy|data we collect/i)));

const regPlain = await register("P27 Plain", uPlain);
check("register without acceptedLegal → 201 (backward compatible)", regPlain.status === 201, regPlain.status);
const plainUser = await prisma.user.findUnique({ where: { email: uPlain } });
if (plainUser) createdUserIds.push(plainUser.id);
check("no acceptance rows for legacy-shaped signup", (await prisma.legalAcceptance.count({ where: { userId: plainUser.id } })) === 0);

const regDup = await register("P27 Accepted", uAcc, { acceptedLegal: { terms: true, privacy: true } });
check("duplicate email → 409", regDup.status === 409, regDup.status);

const regBad = await register("P27 Bad", `p27bad-${STAMP}@check.local`, { acceptedLegal: { terms: false, privacy: true } });
check("acceptedLegal must be explicit acceptance (false rejected)", regBad.status === 422, regBad.status);

/* ------------------------ C. Acceptance API flow -------------------------- */

console.log("\n=== C. Acceptance API ===");
const anonDocs = await rawFetch("/api/v1/legal/documents");
check("documents endpoint requires a session", anonDocs.status === 401, anonDocs.status);

const jarAcc = await login(uAcc, PASSWORD);

const docs = await rawFetch("/api/v1/legal/documents", { jar: jarAcc });
check("GET documents → 200", docs.status === 200, docs.status);
check("exactly 4 documents", docs.json?.data?.documents?.length === 4);
const docKeys = docs.json?.data?.documents?.[0] ? Object.keys(docs.json.data.documents[0]).sort().join(",") : "";
check("metadata fields only (documentType/version/effectiveDate/lastUpdated)", docKeys === "documentType,effectiveDate,lastUpdated,version", docKeys);

const post1 = await rawFetch("/api/v1/legal/acceptance", { method: "POST", jar: jarAcc, body: JSON.stringify({ documentType: "privacy" }) });
check("POST acceptance → 200", post1.status === 200, post1.status);
const post2 = await rawFetch("/api/v1/legal/acceptance", { method: "POST", jar: jarAcc, body: JSON.stringify({ documentType: "privacy" }) });
check("repeat POST is idempotent", post2.status === 200 && post2.json?.data?.alreadyAccepted === true, JSON.stringify(post2.json?.data));
check("same acceptedAt preserved (append-only, no rewrite)", post1.json?.data?.acceptance?.acceptedAt === post2.json?.data?.acceptance?.acceptedAt);

const postSpoof = await rawFetch("/api/v1/legal/acceptance", { method: "POST", jar: jarAcc, body: JSON.stringify({ documentType: "privacy", documentVersion: "1999-01-v9" }) });
check("client-supplied version IGNORED (server resolves current)", postSpoof.json?.data?.acceptance?.documentVersion === currentLegalVersions().privacy);
const postCookies = await rawFetch("/api/v1/legal/acceptance", { method: "POST", jar: jarAcc, body: JSON.stringify({ documentType: "cookies" }) });
check("non-contract type (cookies) → 422", postCookies.status === 422, postCookies.status);

const listAcc = await rawFetch("/api/v1/legal/acceptance", { jar: jarAcc });
check("GET acceptance returns own records", listAcc.json?.data?.acceptances?.length === 2, JSON.stringify(listAcc.json?.data?.acceptances?.length));
const listKeys = listAcc.json?.data?.acceptances?.[0] ? Object.keys(listAcc.json.data.acceptances[0]).sort().join(",") : "";
check("acceptance list exposes no ip/userAgent (minimal metadata)", listKeys === "acceptedAt,documentType,documentVersion,locale", listKeys);

// Isolation: another user must not see anyone else's acceptances (§106).
const jarPlain = await login(uPlain, PASSWORD);
const listPlain = await rawFetch("/api/v1/legal/acceptance", { jar: jarPlain });
check("second user sees only own (empty) acceptance list", Array.isArray(listPlain.json?.data?.acceptances) && listPlain.json.data.acceptances.length === 0);

/* ---------------- D. Account deletion cascades acceptance ----------------- */

console.log("\n=== D. Account deletion × acceptance lifecycle (§166) ===");
const regDel = await register("P27 Deleted", uDel, { acceptedLegal: { terms: true, privacy: true } });
check("fixture user registered with acceptance", regDel.status === 201, regDel.status);
const delUser = await prisma.user.findUnique({ where: { email: uDel } });
check("acceptance rows exist before deletion", (await prisma.legalAcceptance.count({ where: { userId: delUser.id } })) === 2);
const jarDel = await login(uDel, PASSWORD);
const delRes = await rawFetch("/api/v1/me", { method: "DELETE", jar: jarDel, body: JSON.stringify({ password: PASSWORD, confirmation: "DELETE" }) });
check("DELETE /api/v1/me → 200", delRes.status === 200, `${delRes.status} ${JSON.stringify(delRes.json).slice(0, 120)}`);
check("acceptance rows cascaded (no orphans)", (await prisma.legalAcceptance.count({ where: { userId: delUser.id } })) === 0);
check("user row gone", (await prisma.user.count({ where: { id: delUser.id } })) === 0);

/* ----------------- E. AI cost / secret separation surfaces ---------------- */

console.log("\n=== E. AI cost & secret separation surfaces ===");
const bizRes = await rawFetch("/api/v1/businesses", { method: "POST", jar: jarAcc, body: JSON.stringify({ name: `P27 Trust Probe ${STAMP}`, currencyCode: "EUR" }) });
check("business created for export test", bizRes.status === 201, bizRes.status);
const bizId = bizRes.json?.data?.business?.id;
const exp = await rawFetch(`/api/v1/businesses/${bizId}/export`, { jar: jarAcc, businessId: bizId });
check("export → 200", exp.status === 200, exp.status);
const expText = JSON.stringify(exp.json);
for (const forbidden of ["passwordHash", "tokenHash", "costNanoMinor", "rateVersion", "unknownReason", "inputRateNanoMinorPer1K", "sessionVersion", "session-token", "AI_COST", "zarinpal"]) {
  check(`export leak-free: ${forbidden}`, !expText.includes(forbidden));
}

// No tenant-facing AI-cost route may exist (P26 §220 — enforced structurally).
const sep = process.platform === "win32" ? "\\" : "/";
function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) yield* walk(p);
    else if (entry === "route.ts") yield p;
  }
}
// Prompt 28 evolution: the /api/v1/platform/* namespace is the INTERNAL
// operator control plane (platform:ai-cost:* gated, reauth + audited) — it
// is NOT tenant-facing. The invariant stays: no TENANT route may touch cost.
// r30-F: match PATH SEGMENTS, not substrings — the Prompt 30 security route
// `.../recovery-codes/regenerate/` contains "rate" inside "regenerate" and
// is not a cost/rate route.
const costRoutes = [...walk(`${ROOT}/src/app/api`)].filter((f) =>
  f.split(/[\\/]/).some((seg) => /^(cost|rate|rates|ai-cost|ai-rates)$/i.test(seg))
  && !f.includes(`${sep}platform${sep}`),
);
check("no tenant-facing AI cost routes exist", costRoutes.length === 0, costRoutes.join(", ") || "ok");

/* ------------------------- F/G/H. Public honesty -------------------------- */

console.log("\n=== F/G/H. Public honesty surfaces ===");
const privacyHtml = (await rawFetch("/privacy")).text;
check("/privacy reachable", privacyHtml.length > 1000);
check("/privacy shows honest not-configured contact state", privacyHtml.includes("Not currently configured"));
check("/privacy shows version 2026-09-v1", privacyHtml.includes("2026-09-v1"));
check("/privacy has no invented contact address", !/example\.com|legal@example|hello@example/i.test(privacyHtml));

const cookiesHtml = (await rawFetch("/cookies")).text;
for (const cookieName of ["next-auth.session-token", "copilot_funnel", "sidebar_state"]) {
  check(`/cookies documents the real cookie ${cookieName}`, cookiesHtml.includes(cookieName));
}

const robots = (await rawFetch("/robots.txt")).text;
check("robots.txt disallows /api", robots.includes("Disallow: /api"));

const termsHtml = (await rawFetch("/terms")).text;
check("/terms shows payment-not-active honesty", termsHtml.includes("payment is not active yet") || termsHtml.includes("not active yet"));
const aiHtml = (await rawFetch("/ai-data-use")).text;
check("/ai-data-use avoids model-name claims", !/gpt-|claude-|gemini-/i.test(aiHtml));
check("/ai-data-use discloses third-party processing", /third-party AI (service )?provider/i.test(aiHtml));

/* --------------------------------- cleanup -------------------------------- */

console.log("\n=== Cleanup ===");
if (bizId) {
  const delBiz = await rawFetch(`/api/v1/businesses/${bizId}`, { method: "DELETE", jar: jarAcc, businessId: bizId, body: JSON.stringify({ confirmName: `P27 Trust Probe ${STAMP}` }) });
  check("probe business deleted", delBiz.status === 200, delBiz.status);
}
for (const email of [uAcc, uPlain]) {
  const u = await prisma.user.findUnique({ where: { email } });
  if (u) await prisma.user.delete({ where: { id: u.id } });
}
// First-party signup funnel events created for fixture users (analytics rows).
await prisma.commercialEvent.deleteMany({ where: { eventType: "SIGNUP_COMPLETED", userId: { in: createdUserIds } } });
const leftovers = [
  await prisma.user.count({ where: { email: { contains: "p27acc-" } } }),
  await prisma.user.count({ where: { email: { contains: "p27plain-" } } }),
  await prisma.legalAcceptance.count({ where: { user: { email: { contains: "p27" } } } }),
  await prisma.business.count({ where: { name: { contains: "P27 Trust Probe" } } }),
];
check("zero fixture leftovers", leftovers.every((n) => n === 0), JSON.stringify(leftovers));

/* --------------------------------- summary -------------------------------- */

console.log(`\n=== prompt27-trust-check: ${passed} checks passed, ${failures.length} failed ===`);
if (failures.length > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  ✗ ${f.name} — ${String(f.detail).slice(0, 220)}`);
  process.exitCode = 1;
} else {
  console.log("TRUST CHECKS GREEN — acceptance, deletion, isolation and public honesty all verified.");
}
await prisma.$disconnect();
