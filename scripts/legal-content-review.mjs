#!/usr/bin/env node
/**
 * scripts/legal-content-review.mjs — Prompt 27 (§212).
 *
 * Review gate for the PUBLIC legal content layer (src/content/legal/):
 *   1. document metadata (type/version/locale/lastUpdated, nullable
 *      effectiveDate, internal review marker)                    (§268/§30)
 *   2. deterministic version format (no UUID versions)           (§220)
 *   3. EN/FA structural parity (same section ids both locales)   (§29)
 *   4. required-section coverage per document                    (§267)
 *   5. placeholder scan on RENDERED text                         (§90/§145)
 *   6. unsupported-claim scan with negation awareness            (§91/§286)
 *   7. secret-leak scan                                          (§146/§285)
 *   8. internal-doc / internal-route link prohibition            (§147/§188)
 *   9. raw-HTML / unsafe-URL prohibition (structured blocks only)(§98-§100)
 *
 * Usage: bun scripts/legal-content-review.mjs
 * Exit:  0 = clean (negated claims allowed but listed) · 1 = failures
 */

import { LEGAL_DOCUMENTS, LEGAL_DOC_TYPES } from "../src/content/legal/registry.ts";

const failures = [];
const reviewFlags = [];
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

function flag(name, detail) {
  reviewFlags.push({ name, detail });
  console.warn(`  ⚑ ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ""}`);
}

/* ------------------------------ text helpers ------------------------------ */

function blocksText(doc, locale) {
  const c = doc.locales[locale];
  const out = [c.title, c.description];
  for (const s of c.sections) {
    out.push(s.title);
    for (const b of s.blocks) {
      if (b.kind === "p") out.push(b.text);
      else if (b.kind === "bullets") out.push(...b.items);
      else if (b.kind === "table") out.push(...b.head, ...b.rows.flat());
    }
  }
  return out;
}

const PLACEHOLDER_RE =
  /\b(TODO|TBD|Lorem ipsum|YOUR_EMAIL|YOUR COMPANY|CHANGE_ME|CHANGEME|PLACEHOLDER|replace-me|your-company|example\.com|example\.org|foo@bar|test@example)\b/i;

const CLAIMS = [
  { re: /\bGDPR[- ]compliant\b|\bGDPR compliance\b|\bcomplies with the GDPR\b/i, label: "GDPR" },
  { re: /\bCCPA\b|\bCPRA\b/i, label: "CCPA/CPRA" },
  { re: /\bSOC 2\b|\bSOC2\b/i, label: "SOC 2" },
  { re: /\bISO 27001\b|\bISO certified\b|\bISO 9001\b/i, label: "ISO" },
  { re: /\bPCI[- ]DSS\b|\bPCI compliant\b/i, label: "PCI" },
  { re: /\bHIPAA\b/i, label: "HIPAA" },
  { re: /\b100% secure\b|\bcompletely secure\b|\bunbreakable\b|\bmilitary[- ]grade\b|\bbank[- ]?grade\b|\bbank[- ]level\b/i, label: "absolute-security" },
  { re: /\bhallucination[- ]free\b/i, label: "hallucination-free" },
  { re: /\bzero risk\b|\brisk[- ]free\b/i, label: "zero-risk" },
  { re: /\bguaranteed privacy\b|\bguaranteed data deletion\b|\b100% anonymous\b/i, label: "guarantee" },
];

const SECRET_RE =
  /(sk-[A-Za-z0-9]{8,}|Bearer [A-Za-z0-9._-]{10,}|NEXTAUTH_SECRET=|DATABASE_URL=|postgres:\/\/|mysql:\/\/|AIza[A-Za-z0-9_-]{10,}|xox[bp]-|BEGIN (RSA |EC )?PRIVATE KEY)/;

const NEGATION_RE =
  /(does not claim|never claims|do not claim|does not promise|no claim|not a claim|only if|unless|does not imply|no .{0,24}(certification|badge)|is not (a |an )?(legal advice|compliance)|treated as open|marked for (legal )?review|subject to legal review|does not (exist|make|claim|publish|offer|provide)|no (SLA|bug bounty|third-party)|\bNOT_CONFIGURED\b|\bNOT IMPLEMENTED\b|هیچ ادعای|ادعا نمی|وعده داده نمی|هرگز|پیکربندی نشده|نمی‌کند|ندارد)/i;

function sentenceAround(text, index) {
  const start = Math.max(text.lastIndexOf(".", index), text.lastIndexOf("؛", index), 0);
  const end = text.indexOf(".", index);
  return text.slice(start === 0 ? 0 : start + 1, end === -1 ? text.length : end + 1).trim();
}

const KNOWN_ROUTES = new Set([
  "/privacy",
  "/terms",
  "/ai-data-use",
  "/cookies",
  "/pricing",
  "/",
]);

/* --------------------------------- checks --------------------------------- */

console.log("\n=== 1. Document metadata & version format (§30/§220/§268) ===");
const VERSION_RE = /^\d{4}-\d{2}-v\d+$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
for (const type of LEGAL_DOC_TYPES) {
  const doc = LEGAL_DOCUMENTS[type];
  check(`${type}: version deterministic`, VERSION_RE.test(doc.version), doc.version);
  check(`${type}: lastUpdated ISO date`, ISO_RE.test(doc.lastUpdated), doc.lastUpdated);
  check(
    `${type}: effectiveDate null-or-ISO`,
    doc.effectiveDate === null || ISO_RE.test(doc.effectiveDate),
    String(doc.effectiveDate),
  );
  check(
    `${type}: internal review marker present (never rendered)`,
    typeof doc.legalReviewRequired === "boolean",
  );
}

console.log("\n=== 2. EN/FA structural parity (§29) ===");
for (const type of LEGAL_DOC_TYPES) {
  const doc = LEGAL_DOCUMENTS[type];
  const enIds = doc.locales.en.sections.map((s) => s.id);
  const faIds = doc.locales.fa.sections.map((s) => s.id);
  check(
    `${type}: identical section ids EN/FA`,
    enIds.length === faIds.length && enIds.every((id, i) => id === faIds[i]),
    `en=${enIds.length} fa=${faIds.length}`,
  );
  check(
    `${type}: non-empty titles/descriptions both locales`,
    [doc.locales.en.title, doc.locales.fa.title, doc.locales.en.description, doc.locales.fa.description]
      .every((t) => typeof t === "string" && t.trim().length > 3),
  );
  check(
    `${type}: section ids are stable anchors`,
    enIds.every((id) => /^[a-z0-9-]+$/.test(id)),
  );
}

console.log("\n=== 3. Required sections (§267) ===");
const REQUIRED = {
  privacy: ["data-we-collect", "how-we-use-data", "ai-processing", "third-party-services", "retention", "deletion", "security", "contact", "changes"],
  terms: ["service", "accounts", "acceptable-use", "ai-features", "billing", "trials", "user-content", "third-party", "termination", "disclaimers", "contact"],
  "ai-data-use": ["ai-features", "data-sent-to-ai", "purpose", "storage", "provider-processing", "limitations", "user-controls", "contact"],
  cookies: ["essential", "analytics", "changes", "contact"],
};
for (const [type, req] of Object.entries(REQUIRED)) {
  const ids = LEGAL_DOCUMENTS[type].locales.en.sections.map((s) => s.id);
  const missing = req.filter((r) => !ids.includes(r));
  check(`${type}: required sections present`, missing.length === 0, missing.join(",") || "ok");
}

console.log("\n=== 4. Placeholder scan (§90/§145/§284) ===");
for (const type of LEGAL_DOC_TYPES) {
  for (const locale of ["en", "fa"]) {
    const texts = blocksText(LEGAL_DOCUMENTS[type], locale);
    const hit = texts.find((t) => PLACEHOLDER_RE.test(t));
    check(`${type}/${locale}: no placeholders`, hit === undefined, hit ?? "ok");
  }
}

console.log("\n=== 5. Unsupported-claim scan with negation awareness (§91/§286) ===");
for (const type of LEGAL_DOC_TYPES) {
  for (const locale of ["en", "fa"]) {
    for (const text of blocksText(LEGAL_DOCUMENTS[type], locale)) {
      for (const claim of CLAIMS) {
        const m = text.match(claim.re);
        if (m) {
          const sentence = sentenceAround(text, m.index);
          if (NEGATION_RE.test(sentence)) {
            flag(`${type}/${locale}: negated claim reference (${claim.label})`, sentence.slice(0, 140));
          } else {
            check(`${type}/${locale}: no unsupported ${claim.label} claim`, false, sentence.slice(0, 140));
          }
        }
      }
    }
  }
}

console.log("\n=== 6. Secret-leak scan (§146/§285) ===");
for (const type of LEGAL_DOC_TYPES) {
  for (const locale of ["en", "fa"]) {
    const hit = blocksText(LEGAL_DOCUMENTS[type], locale).find((t) => SECRET_RE.test(t));
    check(`${type}/${locale}: no secrets`, hit === undefined, hit ? hit.slice(0, 120) : "ok");
  }
}

console.log("\n=== 7. Internal-doc & internal-route prohibition (§147/§188/§239) ===");
for (const type of LEGAL_DOC_TYPES) {
  for (const locale of ["en", "fa"]) {
    const texts = blocksText(LEGAL_DOCUMENTS[type], locale);
    const internal = texts.find((t) => /docs\/|\/internal|\/platform|\/admin\b|\/debug|\/private|docs\.security|docs\.ai/i.test(t));
    check(`${type}/${locale}: no internal doc references`, internal === undefined, internal ? internal.slice(0, 120) : "ok");
  }
}

console.log("\n=== 8. Structured-content safety: no raw HTML, safe links (§98-§100) ===");
for (const type of LEGAL_DOC_TYPES) {
  for (const locale of ["en", "fa"]) {
    const texts = blocksText(LEGAL_DOCUMENTS[type], locale);
    check(
      `${type}/${locale}: no embedded HTML/script/iframe`,
      !texts.some((t) => /<script|<iframe|<img|<a\s+href|javascript:/i.test(t)),
    );
  }
}
// Route-like references inside text must be real public routes.
for (const type of LEGAL_DOC_TYPES) {
  for (const locale of ["en", "fa"]) {
    for (const text of blocksText(LEGAL_DOCUMENTS[type], locale)) {
      const refs = text.match(/\/(?:privacy|terms|ai-data-use|cookies|pricing|api|admin|internal|platform|debug)\b/g) ?? [];
      for (const ref of refs) {
        check(
          `${type}/${locale}: text route reference is public`,
          KNOWN_ROUTES.has(ref),
          ref,
        );
      }
    }
  }
}

/* --------------------------------- summary -------------------------------- */

console.log(`\n=== legal-content-review: ${passed} checks passed, ${failures.length} failed, ${reviewFlags.length} review flags ===`);
for (const f of reviewFlags) {
  console.log(`  ⚑ REVIEW (negated/explanatory — allowed): ${f.name}`);
}
if (failures.length > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  ✗ ${f.name} — ${String(f.detail).slice(0, 200)}`);
  process.exit(1);
}
console.log("CLEAN — public legal content is placeholder-free, claim-safe and parity-complete.");
