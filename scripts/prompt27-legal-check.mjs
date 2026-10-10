#!/usr/bin/env node
/**
 * scripts/prompt27-legal-check.mjs — Prompt 27 harness (bun, live dev server).
 *
 * Coverage:
 *   Q1  Legal content layer: en/fa completeness + placeholder/claim scans
 *       (re-asserts the readiness verdict inside the regression suite)
 *   Q2  Routing: hashToView/viewToHash for all legal docs (public deep links)
 *   Q3  Operator config law: unset → nulls (no invented values), configured
 *       → values; jurisdiction never public
 *   Q4  HTTP: "/" serves the SPA; health OK; legal views need no auth
 *   Q5  Data protection: account/billing/usage/copilot APIs reject
 *       unauthenticated callers; NO cost API exists anywhere in src/app/api
 *   Q6  Contact sales: honeypot swallows, real submit stores the lead,
 *       generic response never leaks storage state; fixture cleanup
 *   Q7  AI-data honesty in source: no provider cost fields in any API route;
 *       analytics ingest rejects forged event names (Prompt 25 regression)
 *
 * Usage: bun scripts/prompt27-legal-check.mjs [baseUrl]
 * Exit:  0 = all checks passed · 1 = failures printed
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { readdirSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const ROOT = "/home/z/my-project";
const TEST_IP = `10.227.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;

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
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
console.log("Q1 — Legal content layer (structured en+fa source, §5/§7/§83)");
const { LEGAL_CONTENT, isDocumentComplete } = await import(`${ROOT}/src/content/legal/index.ts`);
for (const key of ["privacy", "terms", "ai-data-use", "trust"]) {
  check(`"${key}" complete in both locales`, isDocumentComplete(LEGAL_CONTENT[key]));
}
{
  const all = [];
  for (const doc of Object.values(LEGAL_CONTENT)) {
    for (const p of doc.intro) all.push(p.en, p.fa);
    for (const s of doc.sections) {
      all.push(s.heading.en, s.heading.fa);
      for (const p of s.paragraphs ?? []) all.push(p.en, p.fa);
      for (const b of s.bullets ?? []) all.push(b.en, b.fa);
    }
  }
  const bad = all.filter((t) =>
    /\bTBD\b|\bTODO\b|INSERT_|YOUR_|EXAMPLE\.COM|LEGAL REVIEW REQUIRED|NOT CONFIGURED|lorem ipsum/i.test(t ?? ""),
  );
  check("no placeholder tokens in public legal strings", bad.length === 0, bad.join(" | ").slice(0, 120));
  const claims = all.filter((t) =>
    /GDPR|CCPA|SOC\s?2|\bPCI\b|HIPAA|ISO\s?27001|100%\s?secure|bank[- ]grade|hack[- ]proof|fully secure|never wrong|always correct|hallucination[- ]free|guaranteed (profit|savings|return|accuracy)/i.test(t ?? ""),
  );
  check("no unsupported claims in public legal strings", claims.length === 0, claims.join(" | ").slice(0, 120));
}

console.log("\nQ2 — Hash routing for legal documents (§4)");
{
  const store = await import(`${ROOT}/src/store/app-store.ts`);
  for (const doc of ["privacy", "terms", "ai-data-use", "trust"]) {
    const v = store.hashToView(`#/${doc}`);
    check(`#/${doc} deep link → legal view`, v.kind === "legal" && v.doc === doc);
    check(`#/${doc} round-trip`, store.viewToHash(v) === `#/${doc}`);
  }
  check("unknown hash never becomes a legal doc", store.hashToView("#/x-privacy").kind === "dashboard");
}

console.log("\nQ3 — Operator configuration law (§66/§79/§80/§147)");
{
  const cfg = await import(`${ROOT}/src/config/legal.ts`);
  const saved = {};
  for (const k of ["PUBLIC_COMPANY_LEGAL_NAME", "PUBLIC_SUPPORT_EMAIL", "PRIVACY_CONTACT_EMAIL", "LEGAL_CONTACT_EMAIL", "PUBLIC_BUSINESS_ADDRESS", "LEGAL_JURISDICTION"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  const c = cfg.getLegalContacts();
  check(
    "unset env → all contacts null (never invented)",
    Object.values(c).every((v) => v === null),
    JSON.stringify(c),
  );
  check("hasRequiredContacts() false when unset", cfg.hasRequiredContacts() === false);
  process.env.PRIVACY_CONTACT_EMAIL = "ops@example.test";
  check(
    "configured env flows through verbatim",
    cfg.getLegalContacts().privacyEmail === "ops@example.test",
  );
  delete process.env.PRIVACY_CONTACT_EMAIL;
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { "content-type": "application/json", "x-forwarded-for": TEST_IP, ...(opts.headers ?? {}) },
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body };
}

console.log("\nQ4 — Public reachability (§4/§114)");
{
  const home = await fetch(`${BASE}/`);
  check("GET / serves the app (200, html)", home.status === 200 && (home.headers.get("content-type") ?? "").includes("text/html"));
  const health = await api("/api/health");
  check("health endpoint OK", health.status === 200);
}

console.log("\nQ5 — Data protection boundaries (§107/§117)");
{
  const me = await api("/api/v1/me");
  check("GET /me unauthenticated → 401", me.status === 401, String(me.status));
  const usage = await api("/api/v1/billing/usage");
  check("GET /billing/usage unauthenticated → 401", usage.status === 401, String(usage.status));
  const sessions = await api("/api/v1/copilot/sessions");
  check("GET /copilot/sessions unauthenticated → 401", sessions.status === 401, String(usage.status));
  const nonexistent = await api("/api/v1/ai-cost");
  check("no /ai-cost endpoint exists (404)", nonexistent.status === 404, String(nonexistent.status));
}

console.log("\nQ6 — Contact Sales behavior (§14/§15/§29)");
{
  const bot = await api("/api/v1/public/contact", {
    method: "POST",
    body: JSON.stringify({ name: "Bot", email: "bot@example.test", message: "spam", website: "http://spam" }),
  });
  check("honeypot swallow → generic success", bot.status === 200 && bot.body?.data?.received === true);
  const leadsAfterBot = await prisma.contactLead.count({ where: { email: "bot@example.test" } });
  check("honeypot stored NOTHING", leadsAfterBot === 0, String(leadsAfterBot));

  const real = await api("/api/v1/public/contact", {
    method: "POST",
    body: JSON.stringify({ name: "P27 Legal", email: "p27-lead@example.test", company: "QA", message: "legal check lead", locale: "en" }),
  });
  check("real contact submit → 201 generic received", real.status === 201 && real.body?.data?.received === true);
  const lead = await prisma.contactLead.findFirst({ where: { email: "p27-lead@example.test" } });
  check("lead persisted for the reply purpose", !!lead);
  check(
    "lead stores ONLY name/email/company/message/locale",
    lead &&
      Object.keys(lead).every((k) =>
        ["id", "name", "email", "company", "message", "locale", "createdAt"].includes(k),
      ),
    Object.keys(lead ?? {}).join(","),
  );
  // Cleanup (fixture hygiene — mirrors the p25 harness contract).
  await prisma.contactLead.deleteMany({ where: { email: { in: ["p27-lead@example.test", "bot@example.test"] } } });
  check("fixture cleanup: no p27 contact leads left",
    (await prisma.contactLead.count({ where: { email: { contains: "example.test" } } })) === 0);
}

console.log("\nQ7 — Cost privacy in source (§26/§107) + analytics gate (§30)");
{
  function walk(dir, out = []) {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${f.name}`;
      if (f.isDirectory()) walk(p, out);
      else if (f.name.endsWith(".ts")) out.push(p);
    }
    return out;
  }
  const apiFiles = walk(`${ROOT}/src/app/api`);
  const leaks = apiFiles.filter((f) => /aiCostRate|aiCostRecord/i.test(readFileSync(f, "utf8")));
  check("NO API route references AiCostRate/AiCostRecord", leaks.length === 0, leaks.join(","));
  const ingest = await api("/api/v1/public/analytics", {
    method: "POST",
    body: JSON.stringify({ name: "SIGNUP_COMPLETED", props: {} }),
  });
  check("forged lifecycle event rejected by the ingest gate", ingest.status === 422, String(ingest.status));
}

// ---------------------------------------------------------------------------
console.log(`\n===== PROMPT 27 LEGAL CHECK: ${passed} passed, ${failures.length} failed =====`);
if (failures.length > 0) {
  console.error("FAILED CHECKS:");
  for (const f of failures) console.error(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  process.exit(1);
}
console.log("ALL GREEN");
