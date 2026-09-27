#!/usr/bin/env node
/**
 * scripts/public-legal-links-check.mjs — Prompt 27 (§92/§144/§187/§188).
 *
 * Live HTTP checks for the public legal surface:
 *   - /privacy /terms /ai-data-use /cookies /pricing respond 200
 *   - every internal link on those pages resolves (no broken URLs, §186)
 *   - no link points at internal surfaces (/api /platform /internal /admin
 *     /debug /private docs/)                            (§188/§147)
 *   - rendered HTML has no placeholders and no secret-shaped strings
 *                                                          (§145/§146/§284)
 *
 * Usage: bun scripts/public-legal-links-check.mjs [baseUrl]
 * Exit:  0 = clean · 1 = failures · 2 = server unreachable (skipped)
 */

const BASE = process.argv[2] ?? process.env.APP_BASE_URL ?? "http://localhost:3000";

const PAGES = ["/privacy", "/terms", "/ai-data-use", "/cookies", "/pricing"];
const FORBIDDEN_PREFIXES = ["/api", "/platform", "/internal", "/admin", "/debug", "/private", "/docs"];
const PLACEHOLDER_RE = /(TODO|TBD|Lorem ipsum|YOUR_EMAIL|CHANGE_ME|PLACEHOLDER|example\.com|your-company|replace-me)/i;
const SECRET_RE = /(sk-[A-Za-z0-9]{8,}|NEXTAUTH_SECRET=|DATABASE_URL=|postgres:\/\/|mysql:\/\/|BEGIN (RSA |EC )?PRIVATE KEY|AIza[A-Za-z0-9_-]{10,})/;

const failures = [];
let passed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push({ name, detail });
    console.error(`  ✗ ${name}${detail ? ` — ${String(detail).slice(0, 180)}` : ""}`);
  }
}

async function fetchPage(path) {
  const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
  const html = await res.text();
  return { status: res.status, html };
}

function internalLinks(html) {
  const out = new Set();
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const href = m[1];
    if (href.startsWith("/") && !href.startsWith("//")) out.add(href.split("#")[0]);
  }
  return [...out].filter(Boolean);
}

try {
  const health = await fetch(`${BASE}/api/health`);
  if (health.status !== 200) throw new Error(`health ${health.status}`);
} catch (e) {
  console.error(`Server unreachable at ${BASE} (${e.message}). Start the dev server and retry.`);
  process.exit(2);
}

const allLinks = new Set();

for (const path of PAGES) {
  console.log(`\n[GET ${path}]`);
  let res;
  try {
    res = await fetchPage(path);
  } catch (e) {
    check(`${path} fetch`, false, e.message);
    continue;
  }
  check(`${path} returns 200`, res.status === 200, `status=${res.status}`);
  if (res.status !== 200) continue;
  check(`${path} no placeholders in rendered HTML`, !PLACEHOLDER_RE.test(res.html));
  check(`${path} no secret-shaped strings`, !SECRET_RE.test(res.html));
  const links = internalLinks(res.html);
  for (const l of links) allLinks.add(l);
  const forbidden = links.filter((l) => FORBIDDEN_PREFIXES.some((p) => l === p || l.startsWith(`${p}/`)));
  check(`${path} links no internal surfaces`, forbidden.length === 0, forbidden.join(", ") || "ok");
  // Legal pages must expose both the document and its cross-links.
  if (PAGES.slice(0, 4).includes(path)) {
    check(`${path} has version metadata rendered`, /Version\s|نسخهٔ/.test(res.html));
    check(
      `${path} footer links all legal pages`,
      ["/privacy", "/terms", "/ai-data-use", "/cookies"].every((p) => links.includes(p) || res.html.includes(`href="${p}"`)),
    );
  }
}

console.log("\n[Internal link resolution]");
for (const link of [...allLinks].sort()) {
  try {
    const res = await fetch(`${BASE}${link}`, { redirect: "manual" });
    check(`${link} → ${res.status}`, res.status === 200 || res.status === 401, `status=${res.status}`);
  } catch (e) {
    check(`${link} fetch`, false, e.message);
  }
}

console.log(`\n=== public-legal-links-check: ${passed} checks passed, ${failures.length} failed ===`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  ✗ ${f.name} — ${String(f.detail).slice(0, 180)}`);
  process.exit(1);
}
console.log("CLEAN — public legal pages are live, linked, placeholder-free and secret-free.");
