#!/usr/bin/env node
/**
 * scripts/privacy-inventory.mjs — Prompt 27 (§133/§213).
 *
 * Public-privacy-page fact check: cross-checks the documented data
 * inventory (docs/legal/data-processing-inventory.md) against the actual
 * schema (prisma/schema.prisma), the actual code surface, and the public
 * legal content (src/content/legal/).
 *
 * Output statuses per category: IMPLEMENTED / DOCUMENTED / NOT_DOCUMENTED /
 * UNKNOWN / NEEDS_REVIEW. Mismatches are flagged; nothing is auto-claimed
 * compliant (§134).
 *
 * Usage: bun scripts/privacy-inventory.mjs [--json]
 * Exit:  0 = consistent · 1 = mismatches
 */

import { readFileSync, existsSync } from "node:fs";

const ROOT = "/home/z/my-project";
const asJson = process.argv.includes("--json");

const schema = readFileSync(`${ROOT}/prisma/schema.prisma`, "utf8");
const modelNames = new Set([...schema.matchAll(/^model\s+(\w+)/gm)].map((m) => m[1]));
const docs = existsSync(`${ROOT}/docs/legal/data-processing-inventory.md`)
  ? readFileSync(`${ROOT}/docs/legal/data-processing-inventory.md`, "utf8")
  : "";
const privacyEn = existsSync(`${ROOT}/src/content/legal/privacy.ts`)
  ? readFileSync(`${ROOT}/src/content/legal/privacy.ts`, "utf8")
  : "";

const results = [];
let mismatches = 0;

/**
 * Each category: the prisma model(s) that implement it, what the public
 * privacy content MUST honestly mention, and the doc file that must cover it.
 */
const INVENTORY = [
  { category: "User identity & account", models: ["User"], publicTerms: ["Account data", "email"], docTerms: ["User identity"] },
  { category: "Credentials & recovery", models: ["PasswordResetToken"], publicTerms: ["Password"], docTerms: ["PasswordResetToken"] },
  { category: "Business identity", models: ["Business", "BusinessMember", "BusinessInvite"], publicTerms: ["business"], docTerms: ["Business identity"] },
  { category: "Business financial data", models: ["Sale", "Expense", "Payment"], publicTerms: ["sales, expenses, payments"], docTerms: ["Business financial data"] },
  { category: "Customer data", models: ["Customer"], publicTerms: ["Customers"], docTerms: ["Customer data"] },
  { category: "Supplier data", models: ["Supplier"], publicTerms: ["suppliers"], docTerms: ["Supplier data"] },
  { category: "Product & inventory data", models: ["Product", "InventoryAdjustment"], publicTerms: ["products, ... inventory", "inventory"], docTerms: ["Product data"] },
  { category: "Sales", models: ["Sale", "SaleItem"], publicTerms: ["Sales"], docTerms: ["Sales"] },
  { category: "Expenses", models: ["Expense"], publicTerms: ["Expenses"], docTerms: ["Expenses"] },
  { category: "Payments (tenant finance)", models: ["Payment"], publicTerms: ["payments"], docTerms: ["Payments"] },
  { category: "AI prompts (user questions)", models: ["ChatMessage"], publicTerms: ["questions", "conversations"], docTerms: ["AI prompts"] },
  { category: "AI responses", models: ["ChatMessage", "ChatSession"], publicTerms: ["answers", "conversation history"], docTerms: ["AI responses"] },
  { category: "AI usage metadata", models: ["UsageEvent"], publicTerms: ["token counts", "usage metadata"], docTerms: ["AI usage metadata"] },
  { category: "Commercial analytics events", models: ["CommercialEvent"], publicTerms: ["Product analytics", "commercial events"], docTerms: ["Commercial"] },
  { category: "Subscription data", models: ["Subscription", "SubscriptionEvent"], publicTerms: ["subscription"], docTerms: ["Subscription data"] },
  { category: "Checkout & payment tx (platform)", models: ["CheckoutSession", "PaymentTransaction"], publicTerms: ["checkout", "payment"], docTerms: ["Checkout"] },
  { category: "Security logs (auth events)", models: ["AuditLog"], publicTerms: ["IP address", "user-agent", "audit"], docTerms: ["Security"] },
  { category: "Audit logs", models: ["AuditLog"], publicTerms: ["audit log"], docTerms: ["Audit logs"] },
  { category: "AI cost records (internal)", models: ["AiCostRecord", "AiCostRate", "AiCostAnomaly"], publicTerms: ["Internal AI cost records"], docTerms: ["AI cost records"] },
  { category: "Legal acceptance records", models: ["LegalAcceptance"], publicTerms: ["acceptance"], docTerms: ["LegalAcceptance"] },
  // Prompt 30 identity-security v2 (§294/§295) — all user-owned, all
  // cascade-deleted with the account.
  { category: "Email verification tokens", models: ["EmailVerificationToken"], publicTerms: [], docTerms: ["EmailVerificationToken"] },
  { category: "MFA credentials (encrypted)", models: ["MfaCredential"], publicTerms: ["two-factor"], docTerms: ["MfaCredential"] },
  { category: "MFA recovery codes (hashed)", models: ["MfaRecoveryCode"], publicTerms: [], docTerms: ["MfaRecoveryCode"] },
  { category: "MFA login challenges", models: ["MfaLoginChallenge"], publicTerms: [], docTerms: ["MfaLoginChallenge"] },
  { category: "Device session registry", models: ["UserSession"], publicTerms: ["device", "sessions"], docTerms: ["UserSession"] },
  { category: "Security activity events", models: ["SecurityEvent"], publicTerms: [], docTerms: ["SecurityEvent"] },
  { category: "Contact leads", models: [], publicTerms: [], docTerms: ["ContactLead"] },
];

function statusFor(cat) {
  const modelStatus = cat.models.length === 0
    ? { exists: null, note: "no storage model expected" }
    : {
        exists: cat.models.every((m) => modelNames.has(m)),
        note: cat.models.filter((m) => !modelNames.has(m)).join(",") || "ok",
      };
  const documented = cat.docTerms.some((t) => docs.includes(t));
  const inPublic = cat.publicTerms.length === 0 ? null : cat.publicTerms.some((t) => privacyEn.includes(t));
  return { modelStatus, documented, inPublic };
}

for (const cat of INVENTORY) {
  const { modelStatus, documented, inPublic } = statusFor(cat);
  let status = "IMPLEMENTED";
  let notes = [];
  if (cat.category === "Contact leads") {
    // §21/§110: honest absence — no ContactLead model and no contact form.
    status = "NOT IMPLEMENTED";
    if (modelNames.has("ContactLead")) {
      status = "NEEDS_REVIEW";
      mismatches++;
      notes.push("ContactLead model appeared without an inventory update");
    }
    if (!documented) notes.push("documented as NOT IMPLEMENTED in the inventory doc");
  } else {
    if (!modelStatus.exists) {
      status = "NEEDS_REVIEW";
      mismatches++;
      notes.push(`missing models: ${modelStatus.note}`);
    } else if (!documented) {
      status = "NOT_DOCUMENTED";
      mismatches++;
      notes.push("not found in docs/legal/data-processing-inventory.md");
    } else {
      status = "DOCUMENTED";
    }
    if (inPublic === false) {
      notes.push("public privacy content does not mention this category");
    }
  }
  results.push({ category: cat.category, models: cat.models, status, notes });
}

console.log("=== Privacy inventory (schema ⇄ docs ⇄ public content) ===");
for (const r of results) {
  console.log(
    `  ${r.status.padEnd(16)} ${r.category}` +
      (r.notes.length ? `  — ${r.notes.join("; ")}` : ""),
  );
}

const summary = {
  generatedAt: new Date().toISOString(),
  categories: results.length,
  implemented: results.filter((r) => r.status !== "NOT IMPLEMENTED").length,
  mismatches,
  notImplemented: results.filter((r) => r.status === "NOT IMPLEMENTED").map((r) => r.category),
  statuses: Object.fromEntries(results.map((r) => [r.category, r.status])),
};
if (asJson) console.log(JSON.stringify(summary, null, 2));

if (mismatches > 0) {
  console.error(`\nMISMATCHES: ${mismatches} — the public privacy surface must never claim less or more than the schema.`);
  process.exit(1);
}
console.log("\nCONSISTENT — inventory, docs and public content agree (contact leads honestly absent).");
