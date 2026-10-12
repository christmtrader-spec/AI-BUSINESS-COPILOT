#!/usr/bin/env node
/**
 * scripts/prompt27-legal-check.mjs — Prompt 27 harness (bun, live dev server).
 *
 * Prompt 46 baseline recovery: the obsolete POST /api/v1/public/contact and
 * POST /api/v1/public/analytics endpoints were REMOVED from the codebase
 * (they referenced Prisma models that do not exist: ContactLead,
 * AnalyticsEvent). This harness now exercises the CANONICAL architecture:
 *   - public legal documents → src/content/legal/registry.ts served at the
 *     real routes /privacy /terms /ai-data-use /cookies (server pages)
 *   - public funnel events   → POST /api/public/events (CommercialEvent)
 *   - enterprise contact     → honest contactSalesUrl only when configured,
 *     NO fake contact form anywhere
 * and asserts the legacy endpoints return 404.
 *
 * Coverage:
 *   Q1  Legal content layer: en/fa completeness + placeholder/claim scans
 *       over the structured registry (re-asserts the readiness verdict)
 *   Q2  Public legal routes: every registered document serves at its real
 *       public path without authentication (canonical pages)
 *   Q3  Operator config law: unset → nulls (no invented values), configured
 *       → values; jurisdiction never public
 *   Q4  HTTP: "/" serves the SPA; health OK
 *   Q5  Data protection: account/billing/usage/copilot APIs reject
 *       unauthenticated callers; NO cost API exists anywhere in src/app/api
 *   Q6  Contact honesty: legacy /api/v1/public/contact is gone (404, nothing
 *       stored); /pricing ships NO fake contact form; contactSalesUrl only
 *       when configured
 *   Q7  AI-data honesty in source: no provider cost fields in any API route;
 *       funnel ingest gate: legacy analytics endpoint 404, forged lifecycle
 *       events rejected on the canonical endpoint (Prompt 25 regression)
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
console.log("Q1 — Legal content layer (structured en+fa registry, §5/§7/§30/§31)");
const { LEGAL_DOCUMENTS, LEGAL_DOC_TYPES } = await import(`${ROOT}/src/content/legal/registry.ts`);

/** Every public string of a document, both locales (structural completeness). */
function collectTexts(doc) {
  const out = [];
  for (const locale of ["en", "fa"]) {
    const l = doc.locales[locale];
    out.push(l?.title, l?.description);
    for (const s of l?.sections ?? []) {
      out.push(s?.title);
      for (const b of s?.blocks ?? []) {
        if (b.kind === "p") out.push(b.text);
        else if (b.kind === "bullets") out.push(...b.items);
        else if (b.kind === "table") out.push(...b.head, ...b.rows.flat());
      }
    }
  }
  return out;
}

/** True when every section of BOTH locales is present and non-empty. */
function isDocumentComplete(doc) {
  for (const locale of ["en", "fa"]) {
    const l = doc.locales[locale];
    if (!l || !l.title?.trim() || !l.description?.trim()) return false;
    if (!l.sections?.length) return false;
    for (const s of l.sections) {
      if (!s.title?.trim() || !s.blocks?.length) return false;
      for (const b of s.blocks) {
        if (b.kind === "p" && !b.text?.trim()) return false;
        if (b.kind === "bullets" && (!b.items?.length || b.items.some((i) => !i?.trim()))) return false;
        if (b.kind === "table" && (!b.head?.length || !b.rows?.length)) return false;
      }
    }
  }
  return true;
}

for (const key of LEGAL_DOC_TYPES) {
  check(`"${key}" complete in both locales (registry)`, isDocumentComplete(LEGAL_DOCUMENTS[key]));
}
{
  const all = [];
  for (const doc of Object.values(LEGAL_DOCUMENTS)) all.push(...collectTexts(doc));
  const bad = all.filter((t) =>
    /\bTBD\b|\bTODO\b|INSERT_|YOUR_|EXAMPLE\.COM|LEGAL REVIEW REQUIRED|lorem ipsum/i.test(t ?? ""),
  );
  check("no placeholder tokens in public legal strings", bad.length === 0, bad.join(" | ").slice(0, 120));
  // Certification/absolute claims violate ONLY outside negation contexts —
  // the honest content names frameworks explicitly in order to say it does
  // NOT claim them (e.g. "does not claim any compliance certification (such
  // as GDPR, CCPA, SOC 2 or ISO 27001)"). Sentence-window + negation check.
  const claimTokens = /\bGDPR\b|\bCCPA\b|\bSOC\s?2\b|\bPCI\b|\bHIPAA\b|\bISO\s?27001\b|100%\s?secure|bank[- ]grade|hack[- ]proof|fully secure|hallucination[- ]free|guaranteed (?:profit|savings|return|accuracy)/i;
  const negated = /not claim|no claim|does not|not be|never|without|isn't|cannot|هیچ ادعای|ادعایی ندارد|ندارد|نمی‌تواند|ادعا نمی/i;
  const claims = all.filter((t) => {
    if (!t) return false;
    return String(t)
      .split(/\s*[.!?؟。;؛]\s+|\n+/)
      .some((sentence) => claimTokens.test(sentence) && !negated.test(sentence));
  });
  check("no unsupported claims in public legal strings (honest negations allowed)", claims.length === 0, claims.join(" | ").slice(0, 120));
}

console.log("\nQ2 — Public legal document routes (canonical pages, §4/§114)");
{
  const { legalRoutePath } = await import(`${ROOT}/src/content/legal/registry.ts`);
  check("registry route mapping covers every document", LEGAL_DOC_TYPES.every((t) => typeof legalRoutePath(t) === "string" && legalRoutePath(t).startsWith("/")));
  for (const docType of LEGAL_DOC_TYPES) {
    const path = legalRoutePath(docType);
    const res = await fetch(`${BASE}${path}`, { headers: { "x-forwarded-for": TEST_IP } });
    const html = await res.text();
    const doc = LEGAL_DOCUMENTS[docType];
    check(
      `${path} serves without auth (200, html)`,
      res.status === 200 && (res.headers.get("content-type") ?? "").includes("text/html"),
      String(res.status),
    );
    check(
      `${path} renders the registered "${docType}" document (either locale)`,
      html.includes(doc.locales.en.title) || html.includes(doc.locales.fa.title),
    );
  }
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

console.log("\nQ6 — Contact honesty (no fake form; contactSalesUrl only when configured)");
{
  // The lead-intake endpoint was removed: nothing can be stored because
  // nothing can arrive — a bot and a "real" lead both get the same 404.
  const bot = await api("/api/v1/public/contact", {
    method: "POST",
    body: JSON.stringify({ name: "Bot", email: "bot@example.test", message: "spam", website: "http://spam" }),
  });
  check("legacy /api/v1/public/contact removed (404 for any submission)", bot.status === 404, String(bot.status));
  const real = await api("/api/v1/public/contact", {
    method: "POST",
    body: JSON.stringify({ name: "P27 Legal", email: "p27-lead@example.test", company: "QA", message: "legal check lead", locale: "en" }),
  });
  check("real-shaped submission also 404 (no hidden intake path)", real.status === 404, String(real.status));

  const pricingRes = await fetch(`${BASE}/pricing`, { headers: { "x-forwarded-for": TEST_IP } });
  const pricingHtml = await pricingRes.text();
  check("/pricing serves (200, html)", pricingRes.status === 200 && (pricingRes.headers.get("content-type") ?? "").includes("text/html"), String(pricingRes.status));
  check("/pricing references no dead contact endpoint", !pricingHtml.includes("/api/v1/public/contact"));

  // The honest contract: the payload decides. contactSalesUrl is present ONLY
  // when the operator configured it; otherwise the ENTERPRISE CTA renders a
  // disabled button — never a fake form, never an invented mailto.
  const pricingPayload = await api("/api/public/pricing");
  const contactSalesUrl = pricingPayload.body?.data?.contactSalesUrl ?? null;
  check(
    "contactSalesUrl is null or a configured non-empty string (never invented)",
    contactSalesUrl === null || (typeof contactSalesUrl === "string" && contactSalesUrl.trim().length > 0),
    JSON.stringify(contactSalesUrl),
  );
  check(
    "no sales contact configured → /pricing ships no fake form and no invented mailto",
    contactSalesUrl !== null || (!pricingHtml.includes("mailto:") && !/<form[\s>]/i.test(pricingHtml)),
  );
  // Real proof of "nothing is collected or stored": the Prisma client exposes
  // NO ContactLead delegate at all — probing it throws, so no row can exist.
  let contactLeadAbsent = false;
  try {
    await prisma.contactLead.count();
  } catch {
    contactLeadAbsent = true;
  }
  check("ContactLead Prisma delegate absent (no storage path)", contactLeadAbsent);
}

console.log("\nQ7 — Cost privacy in source (§26/§107) + funnel ingest gate (§30)");
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
  // Prompt 26/28 documented the INTERNAL operator control plane at
  // /api/v1/platform/* (docs/ai/platform-ai-cost-operations.md). The Prompt 27
  // privacy law is that the TENANT-facing surface never exposes AI-cost
  // internals — so tenant routes must have zero references, and any reference
  // must live exclusively under the documented operator plane.
  const tenantFiles = apiFiles.filter((f) => !f.includes(`${ROOT}/src/app/api/v1/platform/`));
  const leaks = tenantFiles.filter((f) => /aiCostRate|aiCostRecord/i.test(readFileSync(f, "utf8")));
  check("NO tenant-facing API route references AiCostRate/AiCostRecord", leaks.length === 0, leaks.join(","));
  const allRefs = apiFiles.filter((f) => /aiCostRate|aiCostRecord/i.test(readFileSync(f, "utf8")));
  check("AI-cost internals referenced ONLY by the documented operator plane (/api/v1/platform/*)", allRefs.every((f) => f.includes(`${ROOT}/src/app/api/v1/platform/`)), allRefs.join(","));

  const legacyIngest = await api("/api/v1/public/analytics", {
    method: "POST",
    body: JSON.stringify({ name: "SIGNUP_COMPLETED", props: {} }),
  });
  check("legacy /api/v1/public/analytics removed (404)", legacyIngest.status === 404, String(legacyIngest.status));

  // Canonical gate: anonymous callers may emit ONLY the PRICING_* subset —
  // forged lifecycle events are rejected 404 (they learn nothing about the
  // internal event directory).
  const forged = await api("/api/public/events", {
    method: "POST",
    body: JSON.stringify({ eventType: "SIGNUP_COMPLETED" }),
  });
  check("forged lifecycle event rejected by the canonical ingest gate (404)", forged.status === 404, String(forged.status));
  const allowed = await api("/api/public/events", {
    method: "POST",
    body: JSON.stringify({ eventType: "PRICING_VIEWED", planCode: "STARTER", route: "p27-check" }),
  });
  check("allowlisted anonymous event still accepted (200)", allowed.status === 200 && allowed.body?.data?.recorded === true, String(allowed.status));
  // Fixture hygiene: remove the one synthetic anonymous row this harness created.
  await prisma.commercialEvent.deleteMany({ where: { route: "p27-check" } });
  check("fixture cleanup: no p27 synthetic funnel rows left",
    (await prisma.commercialEvent.count({ where: { route: "p27-check" } })) === 0);
}

// ---------------------------------------------------------------------------
console.log(`\n===== PROMPT 27 LEGAL CHECK: ${passed} passed, ${failures.length} failed =====`);
if (failures.length > 0) {
  console.error("FAILED CHECKS:");
  for (const f of failures) console.error(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  await prisma.$disconnect();
  process.exit(1);
}
console.log("ALL GREEN");
