#!/usr/bin/env node
/**
 * scripts/data-portability-audit.mjs — Prompt 31 §345-§350/§385.
 *
 * Static scan of the portability surface. GREEN = all checks pass.
 *
 *  §346  Export code must not touch secrets/platform models.
 *  §347  Import field catalogs must not accept forbidden mutable fields.
 *  §348  Every portability route resolves the CURRENT business context
 *        (getAuthContext) — no businessId from the path/browser.
 *  §349  Responses flow through explicit DTO builders.
 *  §350  Import/export ROUTES perform no direct Prisma mutations —
 *        all writes live in the service layer.
 *   +    Parity: client-safe import-fields.ts == server import-catalog.ts.
 *   +    No portability file lives under public/ (§11).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
let failures = 0;
const results = [];
function record(name, ok, info = "") {
  results.push({ name, ok, info });
  console.log(`${ok ? "✓" : "✗"} ${name}${info ? ` — ${info}` : ""}`);
  if (!ok) failures += 1;
}

function read(p) {
  try {
    return readFileSync(join(root, p), "utf8");
  } catch {
    return null;
  }
}

function walk(dir, acc = []) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return acc;
  for (const entry of readdirSync(abs)) {
    const rel = join(dir, entry);
    const st = statSync(join(root, rel));
    if (st.isDirectory()) walk(rel, acc);
    else acc.push(rel);
  }
  return acc;
}

/* ----------------------------- §346 export scan ----------------------------- */

const FORBIDDEN_EXPORT_TOKENS = [
  "passwordHash",
  "MfaCredential",
  "MfaRecoveryCode",
  "MfaLoginChallenge",
  "UserSession",
  "SecurityEvent",
  "PlatformOperator",
  "PlatformAuditLog",
  "AiCostRate",
  "AiCostRecord",
  "AiCostAnomaly",
  "merchantSecret",
  "providerSecret",
  "PaymentTransaction",
  "ProcessedWebhookEvent",
];

const exportSurface = [
  "src/lib/data-portability/export-catalog.ts",
  "src/lib/data-portability/export-service.ts",
  "src/lib/data-portability/manifest.ts",
  "src/app/api/v1/exports/route.ts",
  "src/app/api/v1/exports/[jobId]/route.ts",
  "src/app/api/v1/exports/[jobId]/download/route.ts",
  "src/app/api/v1/exports/[jobId]/cancel/route.ts",
];
for (const file of exportSurface) {
  const src = read(file);
  if (src === null) {
    record(`§346 export surface: ${file} exists`, false, "missing");
    continue;
  }
  const hits = FORBIDDEN_EXPORT_TOKENS.filter((tok) => src.includes(tok));
  record(`§346 export surface clean: ${file}`, hits.length === 0, hits.join(",") || "clean");
}

/* ----------------------------- §347 import scan ----------------------------- */

const FORBIDDEN_IMPORT_FIELDS = [
  "businessId",
  "userId",
  "password",
  "passwordHash",
  "role",
  "platformRole",
  "subscription",
  "paymentStatus",
  "entitlement",
  "mfa",
  "session",
  "token",
  "secret",
  "usage",
  "amount_platform",
];

const importFieldsSrc = read("src/lib/data-portability/import-fields.ts");
{
  // Field NAMES in the client-safe catalog must never be forbidden.
  const fieldNames = [...importFieldsSrc.matchAll(/^\s{4}\{ name: "([^"]+)"/gm)].map((m) => m[1]);
  const bad = fieldNames.filter((n) => FORBIDDEN_IMPORT_FIELDS.includes(n));
  record("§347 import field catalog has no forbidden fields", bad.length === 0, bad.join(",") || `${fieldNames.length} fields, clean`);
}

{
  // The server catalog must not add fields beyond the client-safe one.
  const serverSrc = read("src/lib/data-portability/import-catalog.ts");
  const serverFieldNames = [...serverSrc.matchAll(/name: "([^"]+)", type:/g)].map((m) => m[1]);
  record(
    "§347 server catalog re-uses client-safe field lists (no duplicated definitions)",
    serverFieldNames.length === 0,
    serverFieldNames.length === 0 ? "clean" : serverFieldNames.join(","),
  );
}

/* ------------------------------ §348 route scan ----------------------------- */

const portabilityRoutes = walk("src/app/api/v1/exports")
  .concat(walk("src/app/api/v1/imports"))
  .filter((f) => f.endsWith("route.ts"));
for (const route of portabilityRoutes) {
  const src = read(route);
  // §348 — every portability route must authenticate. Business-scoped routes
  // use getAuthContext (tenant resolution); the template route is
  // deliberately account-scoped (templates are generic) and uses
  // assertFreshSession — both are sanctioned gates.
  const usesCtx = src.includes("getAuthContext") || src.includes("assertFreshSession");
  const gate = src.includes("getAuthContext") ? "getAuthContext" : src.includes("assertFreshSession") ? "assertFreshSession" : "MISSING";
  record(`§348 route resolves tenant/auth context: ${route}`, usesCtx, gate);
  const businessIdInPath = /\[businessId\]/.test(route) || /params\.businessId/.test(src);
  record(`§348 no businessId in route path/params: ${route}`, !businessIdInPath, businessIdInPath ? "businessId present" : "clean");
}

/* ------------------------------ §350 route purity --------------------------- */

for (const route of portabilityRoutes) {
  const src = read(route);
  const directDb = /\bdb\.(customer|supplier|product|sale|expense|payment|business|user)\b/.test(src);
  record(`§350 route performs no direct business mutations: ${route}`, !directDb, directDb ? "direct db usage found" : "clean");
}

/* ------------------------------ DTO check (§349) ---------------------------- */

{
  const svc = read("src/lib/data-portability/export-service.ts");
  record("§349 export job DTO is explicit (jobToDTO)", svc.includes("function jobToDTO"), "explicit mapper");
  const isvc = read("src/lib/data-portability/import-service.ts");
  record("§349 import job DTO is explicit (jobToDTO)", isvc.includes("function jobToDTO"), "explicit mapper");
}

/* --------------------------- import-fields parity --------------------------- */

{
  const clientSrc = importFieldsSrc;
  const serverSrc = read("src/lib/data-portability/import-catalog.ts");
  const clientKeys = [...clientSrc.matchAll(/^  (\w+): \[/gm)].map((m) => m[1]);
  const serverUses = ["customers", "suppliers", "products"].every(
    (k) => clientKeys.includes(k) && serverSrc.includes(`IMPORT_FIELDS.${k}`),
  );
  record("import-fields ↔ import-catalog parity (single source of truth)", serverUses, clientKeys.join(","));
}

/* ------------------------------ §11 storage law ----------------------------- */

{
  const publicDir = join(root, "public");
  let leaked = [];
  if (existsSync(publicDir)) {
    for (const entry of readdirSync(publicDir)) {
      if (/export|portability|import/i.test(entry)) leaked.push(entry);
    }
  }
  record("§11 no export/import artifacts under public/", leaked.length === 0, leaked.join(",") || "clean");
  const storageSrc = read("src/lib/data-portability/storage.ts");
  const guards = storageSrc.includes("validateStorageRoot") && storageSrc.includes("isSymbolicLink");
  record("§304/§313 storage enforces root validation + symlink refusal", guards, guards ? "present" : "MISSING");
}

/* --------------------------------- summary ---------------------------------- */

const passed = results.filter((r) => r.ok).length;
console.log(`\ndata-portability-audit: ${passed}/${results.length} PASS${failures === 0 ? " — GREEN ✓" : ` — ${failures} FAILURE(S) ✗`}`);
process.exit(failures === 0 ? 0 : 1);
