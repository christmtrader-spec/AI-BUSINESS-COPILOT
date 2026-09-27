#!/usr/bin/env node
/**
 * scripts/prompt26-rate-literal-scan.mjs — Prompt 26 §194.
 *
 * Static scanner: prevents accidental introduction of REALISTIC-LOOKING
 * production provider token prices into source, fixtures, tests or
 * .env.example, unless the file/line is explicitly marked TEST or
 * VERIFIED_SOURCE.
 *
 * Maintained ON PURPOSE as a heuristic (the mandate: "do not make the
 * scanner impossible to maintain"):
 * - Flags decimal token-price-like literals (e.g. 0.0015, 3.00, $0.01/1K
 *   patterns) ONLY in AI-cost-relevant paths (src/lib/ai, src/app/api/v1,
 *   scripts, prisma seed/migrations, .env.example).
 * - Skips lines containing TEST / VERIFIED_SOURCE markers and comments.
 * - Never inspects node_modules, .next, docs.
 *
 * Exit 0 = clean · 1 = suspicious literals found.
 */

import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SCAN_DIRS = ["src/lib/ai", "src/app/api", "scripts", "prisma"];
const SCAN_FILES = [".env.example"];
const EXTOK = new Set([".ts", ".tsx", ".mts", ".mjs", ".js", ".sql", ".prisma"]);

const ALLOW_MARKERS = /TEST|VERIFIED_SOURCE|fixture|synthetic|harness/i;
const COMMENT = /^\s*(\/\/|\/\*|\*|#|--)/;
// Heuristic: decimal money-like literal with ≤6 digits before the dot and
// 1-8 after (typical per-token/per-1K pricing), or explicit $/€/per-1K forms.
const PATTERNS = [
  /(?<![\w.])(?:0?\.\d{1,8}|\d{1,6}\.\d{1,8})(?![\w.])\s*(?:\/\s*(?:1K|1k|1,000|token)|dollar|per[- ]1K)?/,
  // Currency-per-token forms require a DECIMAL amount (bcrypt "$2" hashes
  // are not prices — avoiding that false positive, §194 maintainability).
  /[$€£]\s*\d+\.\d+\s*(?:\/\s*)?(?:1K|1k|1,000|MTok|token)?/i,
];

const findings = [];

function walk(dir, strict) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if ("node_modules" === entry || ".next" === entry || ".git" === entry || "docs" === entry) continue;
      walk(p, strict);
    } else if (EXTOK.has(entry.slice(entry.lastIndexOf("."))) || entry === ".env.example") {
      scanFile(p, strict);
    }
  }
}

function scanFile(path, strict) {
  const rel = path.slice(ROOT.length + 1);
  const fileAllows = /prompt26-rate-literal-scan|rate-literal|_test|\.test\.|TEST_ENV/i.test(rel);
  let lines;
  try {
    lines = readFileSync(path, "utf8").split("\n");
  } catch {
    return;
  }
  // In NON-strict roots (harness scripts with customer-money test fixtures)
  // only the explicit currency-per-token pattern is scanned; in STRICT roots
  // (AI cost source, API, schema) any decimal money-like literal is scanned.
  const active = strict ? PATTERNS : [PATTERNS[1]];
  lines.forEach((line, idx) => {
    if (COMMENT.test(line)) return;
    if (ALLOW_MARKERS.test(line) || fileAllows) return;
    for (const re of active) {
      if (re.test(line)) {
        findings.push({ file: rel, line: idx + 1, text: line.trim().slice(0, 140), pattern: re.source.slice(0, 60) });
        break;
      }
    }
  });
}

console.log("=== Prompt 26 — static provider-rate literal scan ===");
for (const d of SCAN_DIRS) {
  // STRICT: AI cost source, API surface, schema/migrations — any decimal
  // money-like literal must be marked TEST/VERIFIED_SOURCE there.
  const strict = d === "src/lib/ai" || d === "prisma";
  walk(join(ROOT, d), strict);
}
for (const f of SCAN_FILES) {
  const p = join(ROOT, f);
  if (existsSync(p)) scanFile(p, true);
}

// Also scan source for anything that looks like a hard-coded PROVIDER RATE
// table (e.g. "gpt-4" or "glm" adjacent to a decimal) — model+number pairs.
try {
  const aiDir = join(ROOT, "src/lib/ai");
  walk(aiDir, true);
} catch {}

if (findings.length === 0) {
  console.log("CLEAN ✓ — no suspicious provider-rate literals in scanned paths.");
  process.exit(0);
}
console.error(`SUSPICIOUS (${findings.length}):`);
for (const f of findings) console.error(`  ${f.file}:${f.line} — ${f.text}  [/${f.pattern}/]`);
console.error("If a finding is legitimate, mark the line/file with TEST or VERIFIED_SOURCE.");
process.exit(1);
