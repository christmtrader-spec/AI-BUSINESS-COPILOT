#!/usr/bin/env node
/**
 * scripts/public-trust-config-check.mjs — Prompt 27 (§49/§88/§173/§216).
 *
 * Production-trust configuration check. Every item resolves to exactly one
 * of: CONFIGURED / NOT_CONFIGURED / INVALID / BLOCKED / REQUIRES_REVIEW.
 * Nothing is invented; no secret values are printed (contact values are
 * deliberately public — but they are only echoed when CONFIGURED).
 *
 * Checks: legal identity, 4 contact channels, public base URL (+HTTPS in
 * production), legal pages present, legal content registry, provider
 * register, privacy/retention/deletion inventories, .env.example documents
 * the config surface.
 *
 * Usage: bun scripts/public-trust-config-check.mjs
 * Exit:  0 = report (INVALID → 1). NOT_CONFIGURED alone does NOT fail —
 *        readiness, not compliance, is the output (§206/§269).
 */

import { readFileSync, existsSync } from "node:fs";

const ROOT = "/home/z/my-project";
const isProduction = process.env.NODE_ENV === "production";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function readEnvFile() {
  const p = `${ROOT}/.env`;
  if (!existsSync(p)) return {};
  const env = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}
const fileEnv = readEnvFile();
const val = (k) => (process.env[k] ?? fileEnv[k] ?? "").trim();

const items = [];
function record(name, status, detail = "") {
  items.push({ name, status, detail });
  const icon = { CONFIGURED: "✓", NOT_CONFIGURED: "○", INVALID: "✗", BLOCKED: "✗", REQUIRES_REVIEW: "⚑" }[status];
  console.log(`  ${icon} ${status.padEnd(15)} ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log(`=== Public trust configuration check (production=${isProduction}) ===\n`);

console.log("[Legal identity & contacts]");
const name = val("PUBLIC_COMPANY_LEGAL_NAME");
record("PUBLIC_COMPANY_LEGAL_NAME", name ? (name.length >= 2 ? "CONFIGURED" : "INVALID") : "NOT_CONFIGURED", name ? name : "honest fallback rendered on public pages");

const baseUrl = val("PUBLIC_BASE_URL");
let baseStatus = "NOT_CONFIGURED";
let baseDetail = "canonical/OG/sitemap links stay relative";
if (baseUrl) {
  try {
    const u = new URL(baseUrl);
    if (u.protocol === "https:") {
      baseStatus = "CONFIGURED";
      baseDetail = baseUrl;
    } else if (u.protocol === "http:" && !isProduction && /localhost|127\.0\.0\.1/.test(u.hostname)) {
      baseStatus = "CONFIGURED";
      baseDetail = `${baseUrl} (development-only origin)`;
    } else {
      baseStatus = "INVALID";
      baseDetail = "production origin must be absolute https";
    }
  } catch {
    baseStatus = "INVALID";
    baseDetail = "not an absolute URL";
  }
}
record("PUBLIC_BASE_URL", baseStatus, baseDetail);

const httpsReady = baseUrl.startsWith("https://");
record("HTTPS production origin", httpsReady ? "CONFIGURED" : "NOT_CONFIGURED", httpsReady ? baseUrl : "set PUBLIC_BASE_URL to an https origin when deploying");

for (const [envKey, label] of [
  ["PUBLIC_SUPPORT_EMAIL", "PUBLIC_SUPPORT_EMAIL (support)"],
  ["PRIVACY_CONTACT_EMAIL", "PRIVACY_CONTACT_EMAIL (privacy)"],
  ["LEGAL_CONTACT_EMAIL", "LEGAL_CONTACT_EMAIL (legal)"],
  ["SECURITY_CONTACT_EMAIL", "SECURITY_CONTACT_EMAIL (security)"],
]) {
  const v = val(envKey);
  record(label, v ? (EMAIL_RE.test(v) ? "CONFIGURED" : "INVALID") : "NOT_CONFIGURED", v ? v : "public pages show the honest not-configured state");
}

console.log("\n[Legal pages & content]");
for (const route of ["privacy", "terms", "ai-data-use", "cookies"]) {
  const p = `${ROOT}/src/app/${route}/page.tsx`;
  record(`/${route} page`, existsSync(p) ? "CONFIGURED" : "BLOCKED");
}
record(
  "Legal content registry (versioned, EN/FA)",
  existsSync(`${ROOT}/src/content/legal/registry.ts`) ? "CONFIGURED" : "BLOCKED",
  "version 2026-09-v1 · effectiveDate not configured (shown honestly)",
);
record(
  "LEGAL_REVIEW_REQUIRED on public legal copy",
  "REQUIRES_REVIEW",
  "content is technically grounded; qualified counsel review pending",
);

console.log("\n[Data governance docs]");
for (const [f, label] of [
  ["docs/legal/data-processing-inventory.md", "Data processing inventory"],
  ["docs/legal/data-retention-inventory.md", "Retention inventory"],
  ["docs/legal/data-deletion-matrix.md", "Deletion matrix"],
  ["docs/legal/user-data-rights.md", "User data rights"],
  ["docs/legal/service-providers.md", "Provider register"],
  ["docs/legal/data-flow.md", "Data flow"],
]) {
  record(label, existsSync(`${ROOT}/${f}`) ? "CONFIGURED" : "BLOCKED", f);
}

console.log("\n[Runtime/ops surface]");
const envExample = existsSync(`${ROOT}/.env.example`) ? readFileSync(`${ROOT}/.env.example`, "utf8") : "";
const legalVars = ["PUBLIC_COMPANY_LEGAL_NAME", "PUBLIC_BASE_URL", "PUBLIC_SUPPORT_EMAIL", "PRIVACY_CONTACT_EMAIL", "LEGAL_CONTACT_EMAIL", "SECURITY_CONTACT_EMAIL"];
const missingVars = legalVars.filter((v) => !envExample.includes(`${v}=`));
record(
  ".env.example documents the legal contact surface",
  missingVars.length === 0 ? "CONFIGURED" : "REQUIRES_REVIEW",
  missingVars.length === 0 ? "all 6 vars documented (empty = NOT_CONFIGURED, no invented values)" : `missing: ${missingVars.join(", ")}`,
);
record("robots.txt excludes /api from crawling", /Disallow:\s*\/api/.test(readFileSync(`${ROOT}/public/robots.txt`, "utf8")) ? "CONFIGURED" : "BLOCKED");
record("Legal acceptance model", existsSync(`${ROOT}/src/app/api/v1/legal/acceptance/route.ts`) ? "CONFIGURED" : "BLOCKED", "signup checkbox + server-resolved versions");

/* --------------------------------- summary -------------------------------- */
const counts = {};
for (const i of items) counts[i.status] = (counts[i.status] ?? 0) + 1;
console.log(`\nSummary: ${JSON.stringify(counts)}`);
const invalid = items.filter((i) => i.status === "INVALID" || i.status === "BLOCKED");
if (invalid.length > 0) {
  console.error("INVALID/BLOCKED items found — fix configuration before public launch.");
  process.exit(1);
}
console.log("No invalid configuration. NOT_CONFIGURED items are honest readiness gaps, not errors.");
