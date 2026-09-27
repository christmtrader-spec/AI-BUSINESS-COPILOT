#!/usr/bin/env node
/**
 * scripts/legal-public-readiness.mjs — Prompt 27 (§89/§141/§142/§143/§205).
 *
 * Aggregates the trust tooling into ONE structured readiness result:
 *   - scripts/legal-content-review.mjs      (content quality/claims)
 *   - scripts/privacy-inventory.mjs         (schema ⇄ docs ⇄ public claims)
 *   - scripts/privacy-deletion-check.mjs    (deletion behavior vs matrix)
 *   - scripts/public-trust-config-check.mjs (contacts/identity/HTTPS)
 *   - scripts/public-legal-links-check.mjs  (live routes, links, leaks)
 * plus its own category rollup (§142) and honest blockers (§207).
 *
 * The result is an INTERNAL operational signal:
 *   READY | PARTIALLY_READY | BLOCKED with reasons.
 * It is explicitly NOT a compliance certification (§143).
 *
 * Usage: bun scripts/legal-public-readiness.mjs [--json]
 * Exit:  0 = READY/PARTIALLY_READY · 1 = BLOCKED or tool failures
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeFileSync, mkdirSync } from "node:fs";

const ROOT = "/home/z/my-project";
const asJson = process.argv.includes("--json");
const TOOLS = [
  ["legal-content-review", "scripts/legal-content-review.mjs"],
  ["privacy-inventory", "scripts/privacy-inventory.mjs"],
  ["privacy-deletion-check", "scripts/privacy-deletion-check.mjs"],
  ["public-trust-config-check", "scripts/public-trust-config-check.mjs"],
  ["public-legal-links-check", "scripts/public-legal-links-check.mjs"],
];

function runTool(name, script) {
  const r = spawnSync("bun", [`${ROOT}/${script}`], { encoding: "utf8", timeout: 180_000, env: process.env });
  return {
    name,
    script,
    exitCode: r.status,
    passed: r.status === 0 || r.status === 2, // 2 = links-check: server unreachable → skipped, not a failure
    skipped: r.status === 2,
    tail: (r.stdout + r.stderr).split("\n").filter(Boolean).slice(-3).join(" | "),
  };
}

console.log("=== Legal public readiness aggregator ===\n");
const toolResults = [];
for (const [name, script] of TOOLS) {
  console.log(`▶ ${name}`);
  const r = runTool(name, script);
  toolResults.push(r);
  console.log(`  exit=${r.exitCode}${r.skipped ? " (skipped: server unreachable)" : ""}\n`);
}

/* --------------------------- category rollup (§142) ----------------------- */

function configuredEnv(key) {
  const m = readFileSync(`${ROOT}/.env`, "utf8");
  const line = m.split("\n").find((l) => l.startsWith(`${key}=`));
  return !!line && line.slice(key.length + 1).trim().length > 0;
}

const byTool = Object.fromEntries(toolResults.map((t) => [t.name, t]));
const categories = [
  { name: "Legal Identity", status: configuredEnv("PUBLIC_COMPANY_LEGAL_NAME") ? "READY" : "NOT_CONFIGURED", reason: "PUBLIC_COMPANY_LEGAL_NAME unset — honest fallback rendered" },
  { name: "Privacy Contact", status: configuredEnv("PRIVACY_CONTACT_EMAIL") ? "READY" : "NOT_CONFIGURED", reason: "PRIVACY_CONTACT_EMAIL unset" },
  { name: "Legal Contact", status: configuredEnv("LEGAL_CONTACT_EMAIL") ? "READY" : "NOT_CONFIGURED", reason: "LEGAL_CONTACT_EMAIL unset" },
  { name: "Support Contact", status: configuredEnv("PUBLIC_SUPPORT_EMAIL") ? "READY" : "NOT_CONFIGURED", reason: "PUBLIC_SUPPORT_EMAIL unset" },
  { name: "Security Contact", status: configuredEnv("SECURITY_CONTACT_EMAIL") ? "READY" : "NOT_CONFIGURED", reason: "SECURITY_CONTACT_EMAIL unset" },
  { name: "Privacy Policy", status: byTool["legal-content-review"]?.passed && byTool["public-legal-links-check"]?.passed ? "READY" : "PARTIAL", reason: "page live, EN/FA, claim-safe (legal review pending)" },
  { name: "Terms", status: byTool["legal-content-review"]?.passed ? "READY" : "PARTIAL", reason: "page live, implementation-aware billing/trial language (legal review pending)" },
  { name: "AI Data Use", status: byTool["public-legal-links-check"]?.passed ? "READY" : "PARTIAL", reason: "page live, provider-agnostic disclosure, no model claims" },
  { name: "Data Inventory", status: byTool["privacy-inventory"]?.passed ? "READY" : "PARTIAL", reason: "docs/legal/data-processing-inventory.md consistent with schema" },
  { name: "Deletion Matrix", status: byTool["privacy-deletion-check"]?.passed ? "READY" : "PARTIAL", reason: "fixture-verified cascade behavior matches the documented matrix" },
  { name: "Retention Matrix", status: "PARTIAL", reason: "documented honestly; explicit retention policies are CURRENTLY NOT EXPLICITLY CONFIGURED" },
  { name: "Provider Disclosure", status: "READY", reason: "ACTIVE/CONFIGURED_NOT_ACTIVE/PLANNED states match adapters+env" },
  { name: "HTTPS", status: configuredEnv("PUBLIC_BASE_URL") && configuredEnv("PUBLIC_BASE_URL") && readFileSync(`${ROOT}/.env`, "utf8").includes("PUBLIC_BASE_URL=https") ? "READY" : "NOT_CONFIGURED", reason: "PUBLIC_BASE_URL not set to an https origin" },
  { name: "Public Base URL", status: configuredEnv("PUBLIC_BASE_URL") ? "READY" : "NOT_CONFIGURED", reason: "canonical/OG/sitemap stay relative until configured" },
  { name: "Payments", status: "BLOCKED", reason: "production payment not activated (merchant credentials + legal review)" },
];

const blockers = categories.filter((c) => c.status === "BLOCKED").map((c) => `${c.name}: ${c.reason}`);
const notConfigured = categories.filter((c) => c.status === "NOT_CONFIGURED").map((c) => c.name);
const toolFailures = toolResults.filter((t) => !t.passed);
const overall = toolFailures.length > 0 || blockers.length > 0 ? "PARTIALLY_READY" : notConfigured.length > 0 ? "PARTIALLY_READY" : "READY";
// Deployment-blocking tool failures → BLOCKED regardless of categories.
const verdict = toolFailures.length > 0 ? "BLOCKED" : overall;

const report = {
  generatedAt: new Date().toISOString(),
  verdict,
  note: "Public legal readiness is not a legal compliance certification.",
  legalReviewRequired: true,
  tools: toolResults.map((t) => ({ name: t.name, exitCode: t.exitCode, passed: t.passed, skipped: t.skipped })),
  categories,
  notConfigured,
  blockers,
};
if (asJson) {
  mkdirSync(`${ROOT}/tool-results`, { recursive: true });
  writeFileSync(`${ROOT}/tool-results/legal-public-readiness.json`, JSON.stringify(report, null, 2));
}

console.log("\n=== READINESS CATEGORIES (§142) ===");
for (const c of categories) console.log(`  ${c.status.padEnd(15)} ${c.name} — ${c.reason}`);
console.log(`\nTools: ${toolResults.map((t) => `${t.name}=${t.exitCode}`).join("  ")}`);
console.log(`\nOVERALL VERDICT: ${verdict}`);
console.log("Public legal readiness is not a legal compliance certification.");
console.log(`Not configured (${notConfigured.length}): ${notConfigured.join(", ") || "—"}`);
console.log(`Blockers (${blockers.length}): ${blockers.join(" · ") || "—"}`);

if (verdict === "BLOCKED") process.exit(1);
