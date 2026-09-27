#!/usr/bin/env node
/**
 * scripts/ai-context-secret-scan.mjs — Prompt 27 (§12/§242/§244).
 *
 * Verifies the AI provider boundary stays secret-free, structurally:
 *   A. The ONLY file allowed to talk to an AI SDK is src/lib/ai/provider.ts
 *      (single seam, server-only) — no other src file imports the SDK.
 *   B. Context assembly files (snapshot.ts, copilot routes, provider.ts)
 *      contain NO forbidden identifiers once comments are stripped:
 *      credentials, auth secrets, AI-cost tables, payment internals.
 *   C. snapshot.ts never queries forbidden tables (User/CheckoutSession/
 *      PaymentTransaction/AiCost*); its DB selects are business-finance only.
 *   D. The grounding snapshot DTO is built from an explicit literal object —
 *      no `JSON.stringify(user)`, no whole-model serialization (§244).
 *
 * Usage: bun scripts/ai-context-secret-scan.mjs
 * Exit:  0 = CLEAN · 1 = violations
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/home/z/my-project";
const failures = [];
let passed = 0;

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push({ name, detail });
    console.error(`  ✗ ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ""}`);
  }
}

/** Strip // and /* *​/ comments so prose inside comments never trips the scan. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/(?<=[^:"`])\/\/.*$/gm, " ");
}

/* ---- A. single AI SDK seam (§241) ---------------------------------------- */
console.log("=== A. Single AI SDK seam ===");
function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
      yield* walk(p);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      yield p;
    }
  }
}
const sdkImporters = [];
for (const file of walk(`${ROOT}/src`)) {
  const src = readFileSync(file, "utf8");
  if (/z-ai-web-dev-sdk/.test(src)) sdkImporters.push(file.replace(`${ROOT}/`, ""));
}
check(
  "z-ai-web-dev-sdk imported ONLY in src/lib/ai/provider.ts",
  sdkImporters.length === 1 && sdkImporters[0] === "src/lib/ai/provider.ts",
  sdkImporters.join(", "),
);
check(
  "provider.ts is server-only",
  /import\s+"server-only"/.test(readFileSync(`${ROOT}/src/lib/ai/provider.ts`, "utf8")),
);

/* ---- B. forbidden identifiers in context assembly (§242) ----------------- */
console.log("=== B. Forbidden identifiers in context assembly ===");
const CONTEXT_FILES = [
  "src/lib/ai/snapshot.ts",
  "src/lib/ai/provider.ts",
  "src/app/api/v1/copilot/route.ts",
  "src/app/api/v1/copilot/stream/route.ts",
];
const FORBIDDEN = [
  /\bpasswordHash\b/i,
  /\bpassword\b/i,
  /\btokenHash\b/i,
  /\bresetToken\b/i,
  /\bsessionToken\b/i,
  /\bsessionToken\b/i,
  /\bNEXTAUTH_SECRET\b/,
  /\bDATABASE_URL\b/,
  /\bapiKey\b/i,
  /\bapi_key\b/i,
  /\bproviderKey\b/i,
  /\bmerchantId\b/i,
  /\bcredential/i,
  /\bAuthorization\b/,
  /\bcookieJar\b/i,
  /\bcreditCard\b/i,
  /\bcardNumber\b/i,
  /\bcvv\b/i,
  /\bAiCostRate\b/,
  /\bAiCostRecord\b/,
  /\bAiCostAnomaly\b/,
  /\bcostNanoMinor\b/,
  /\brateVersion\b/,
  /\bunknownReason\b/,
  /\bcheckoutSession\b/i,
  /\bpaymentTransaction\b/i,
  /\bprocessedWebhook\b/i,
  /\bzarinpal\b/i,
  /\bBearer\s/,
  /\bbcrypt\b/i,
];
for (const rel of CONTEXT_FILES) {
  const code = stripComments(readFileSync(`${ROOT}/${rel}`, "utf8"));
  const hits = FORBIDDEN.map((re) => (code.match(re) ?? [])[0]).filter(Boolean);
  check(`${rel}: no forbidden identifiers`, hits.length === 0, [...new Set(hits)].join(", ") || "ok");
}

/* ---- C. snapshot.ts query surface (§242) --------------------------------- */
console.log("=== C. snapshot.ts DB query surface ===");
const snapCode = stripComments(readFileSync(`${ROOT}/src/lib/ai/snapshot.ts`, "utf8"));
const TABLE_ALLOW = ["sale", "expense", "payment", "business", "report"];
const queried = [...snapCode.matchAll(/db\.([a-zA-Z]+)\./g)].map((m) => m[1]);
check(
  "snapshot queries only business-finance models",
  queried.every((t) => TABLE_ALLOW.includes(t)),
  queried.join(", ") || "none",
);
const FORBIDDEN_TABLES = ["user", "user_", "checkoutSession", "paymentTransaction", "aiCost", "processedWebhook", "legalAcceptance", "auditLog"];
check(
  "snapshot never queries auth/payment/cost tables",
  !queried.some((t) => FORBIDDEN_TABLES.some((f) => t.toLowerCase().startsWith(f))),
  queried.join(", "),
);

/* ---- D. explicit DTO serialization (§244) -------------------------------- */
console.log("=== D. Explicit DTO serialization ===");
check(
  "snapshot builds a literal snapshot object (no whole-model JSON)",
  /const snapshot = \{/.test(snapCode),
);
check(
  "snapshot never stringifies a DB record directly",
  !/JSON\.stringify\(\s*(user|business|row|record|result)\b/.test(snapCode),
);
check(
  "monetary values enter the snapshot as display strings (fmt)",
  /revenueIssued: fmt\(/.test(snapCode),
);

/* --------------------------------- summary -------------------------------- */
console.log(`\n=== ai-context-secret-scan: ${passed} checks passed, ${failures.length} failed ===`);
if (failures.length > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  ✗ ${f.name} — ${String(f.detail).slice(0, 200)}`);
  process.exit(1);
}
console.log("CLEAN — AI provider boundary is structurally secret-free.");
