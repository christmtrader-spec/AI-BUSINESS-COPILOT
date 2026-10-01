#!/usr/bin/env node
/**
 * scripts/search-static-scan.mjs — Prompt 33 static security scan (§36).
 *
 * Deterministic source-level checks over the search subsystem. Fails when
 * any forbidden pattern is detected:
 *   1  search route accepting businessId as authority from the request
 *   2  search route accepting userId as authority from the request
 *   3  entity search without businessId scoping
 *   4  deleted records included (missing deletedAt guard)
 *   5  full Prisma entity returned (missing select)
 *   6  password/security models referenced
 *   7  AI cost models referenced
 *   8  platform models referenced
 *   9  raw search query logged
 *   10 arbitrary redirect returned
 *   11 dangerouslySetInnerHTML
 *   12 raw SQL / string-built queries
 *   13 generic arbitrary type accepted (missing allowlist)
 *   14 unrestricted limit
 *   15 unrestricted q length
 *
 * Run:  node scripts/search-static-scan.mjs
 * Exit: 0 = all green · 1 = at least one failure.
 */
import { readFileSync, existsSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const results = [];
let section = "";
function record(name, pass, info = "") {
  results.push(pass);
  console.log(`${pass ? "✓" : "✗"} [${section}] ${name}${info ? ` — ${info}` : ""}`);
}
function read(p) {
  const full = `${ROOT}${p}`;
  return existsSync(full) ? readFileSync(full, "utf8") : null;
}

/* ------------------------------- files exist ------------------------------ */
section = "surface";
const ROUTE = "src/app/api/v1/search/route.ts";
const QUERY = "src/lib/search/query.ts";
const SCHEMA = "src/lib/search/schema.ts";
const SERVICE = "src/lib/search/service.ts";
const NORMALIZE = "src/lib/search/normalize.ts";
const PALETTE = "src/modules/shell/command-palette.tsx";
const CENTER = "src/modules/search/search-view.tsx";
const CLIENT = "src/modules/search/search-api.ts";
const STORE = "src/store/app-store.ts";
for (const f of [ROUTE, QUERY, SCHEMA, SERVICE, NORMALIZE, PALETTE, CENTER, CLIENT, STORE]) {
  record(`${f} exists`, read(f) !== null);
}
const routeSrc = read(ROUTE) ?? "";
const querySrc = read(QUERY) ?? "";
const schemaSrc = read(SCHEMA) ?? "";
const serviceSrc = read(SERVICE) ?? "";
const paletteSrc = read(PALETTE) ?? "";
const centerSrc = read(CENTER) ?? "";
const clientSrc = read(CLIENT) ?? "";
const storeSrc = read(STORE) ?? "";
const indexSrc = read("src/lib/search/index.ts") ?? "";

/* --------------------- 1/2 — no client identity authority ----------------- */
section = "authority";
record(
  "route never reads businessId from query/body (§3)",
  !/searchParams\.get\(\s*["']businessId/i.test(routeSrc) &&
    !/body\.businessId/i.test(routeSrc),
);
record(
  "route never reads userId/tenantId/ownerId params (§3)",
  !/searchParams\.get\(\s*["'](userId|tenantId|ownerId)["']/i.test(routeSrc),
);
record(
  "route derives context via getAuthContext (§3)",
  routeSrc.includes("getAuthContext(req)"),
);
record(
  "route enforces data:read (§3)",
  /requirePermission\(\s*ctx\s*,\s*["']data:read["']\s*\)/.test(routeSrc),
);

/* ------------------ 3/4/5 — tenant scope + delete + select ---------------- */
section = "queries";
{
  // Each entity query block: db.<entity>.findMany({ ... }) — extract from
  // the call to the bounded take, then verify scope/select per block.
  // Prompt 35 (§122): CRM entities joined the search surface (8 total).
  const ENTITIES = ["customer", "supplier", "product", "sale", "expense", "payment", "crmLead", "crmOpportunity"];
  record("eight entity findMany calls present (§2 + P35 §122)", ENTITIES.every((e) => querySrc.includes(`db.${e}.findMany(`)), ENTITIES.filter((e) => !querySrc.includes(`db.${e}.findMany(`)).join(","));
  const blocks = {};
  for (const e of ENTITIES) {
    const start = querySrc.indexOf(`db.${e}.findMany(`);
    const end = querySrc.indexOf("SEARCH_PER_ENTITY_TAKE", start);
    blocks[e] = start >= 0 && end > start ? querySrc.slice(start, end) : "";
  }
  record(
    "every where block scopes businessId (§3)",
    ENTITIES.every((e) => blocks[e].includes("businessId,")),
  );
  const softDeleteEntities = ["customer", "supplier", "product", "sale", "expense"];
  for (const e of softDeleteEntities) {
    record(`${e} excludes soft-deleted rows (§3/§20)`, blocks[e].includes("deletedAt: null"));
  }
  {
    // Product: WHERE section must NOT filter isActive (inactive ≠ deleted);
    // the SELECT section legitimately carries isActive for the status token.
    // Line comments are stripped first so doc comments cannot false-fail.
    const stripComments = (src) => src.replace(/\/\/.*$/gm, "");
    const wherePart = stripComments(blocks.product.split("select:")[0] ?? "");
    record("product query does NOT filter isActive (§20 inactive ≠ deleted)", !wherePart.includes("isActive"));
  }
  record(
    "every findMany uses explicit select (§21)",
    ENTITIES.every((e) => blocks[e].includes("select:")),
  );
  record(
    "bounded take on every entity query (§6)",
    ENTITIES.every((e) => blocks[e].includes("take:")),
  );
  record(
    "per-entity take imported from schema (8)",
    querySrc.includes("SEARCH_PER_ENTITY_TAKE"),
  );
  record("every entity query has deterministic orderBy", ENTITIES.every((e) => blocks[e].includes("orderBy")));
}

/* ---------------- 6/7/8 — forbidden models never referenced --------------- */
section = "domains";
const FORBIDDEN_MODELS = [
  "passwordHash", "sessionVersion", "MfaCredential", "MfaRecoveryCode",
  "MfaLoginChallenge", "PasswordResetToken", "EmailVerificationToken",
  "SecurityEvent", "PlatformOperator", "PlatformAuditLog", "AiCostRate",
  "AiCostRecord", "AiCostAnomaly", "CommercialEvent", "CheckoutSession",
  "PaymentTransaction", "ProcessedWebhookEvent", "DataExportJob",
  "DataImportJob", "AuditLog", "db.user.findMany", "UserSession",
];
const searchSrc = querySrc + serviceSrc + indexSrc;
for (const m of FORBIDDEN_MODELS) {
  record(`search lib never references ${m}`, !searchSrc.includes(m));
}

/* --------------------------- 9 — no query logging ------------------------- */
section = "observability";
record("route never logs the raw query (§22)", !routeSrc.includes("logDebug") && !routeSrc.includes("logInfo") && !routeSrc.includes("console."));
record("service emits only count/duration metrics (§22)", serviceSrc.includes("searchExecuted") && !/log\w+\([^)]*\bq\b|log\w+\([^)]*\bquery\b/.test(serviceSrc.replace(/\/\/.*$/gm, "")));

/* ------------------------ 10/11 — web safety ------------------------------ */
section = "web-safety";
record("no arbitrary redirect in search UI (§14/§16)", !paletteSrc.includes("window.location =") && !centerSrc.includes("window.location =") && !paletteSrc.includes("window.location.href =") && !centerSrc.includes("window.location.href ="));
record("no dangerouslySetInnerHTML (§16)", !paletteSrc.includes("dangerouslySetInnerHTML") && !centerSrc.includes("dangerouslySetInnerHTML"));
record("no raw SQL in the search subsystem (§6)", !searchSrc.includes("$queryRaw") && !searchSrc.includes("$executeRaw") && !querySrc.includes("SELECT "));
/* Prompt 34 update — results now resolve type+id through the CLOSED entity
 * vocabulary (lib/entity-routes.ts) to the exact entity detail; the module
 * destination field remains in the DTO but navigation is entity-level. */
const entityRoutesSrc = read("src/lib/entity-routes.ts");
record("client navigation uses the closed entity map (§14 + Prompt 34)", paletteSrc.includes("entityViewFromSearchItem(item)") && centerSrc.includes("entityViewFromSearchItem(item)") && entityRoutesSrc.includes("SEARCH_TYPE_TO_ENTITY") && clientSrc.includes("SEARCH_DESTINATIONS") === false && !/module:\s*item\.(?!destination)/.test(paletteSrc + centerSrc));

/* ------------------- 13/14/15 — validation bounds ------------------------- */
section = "validation";
record("types allowlist enforced (§4.2)", schemaSrc.includes("SEARCH_ENTITY_TYPES") && schemaSrc.includes("Unknown search type"));
record("unknown type values rejected, not ignored (§4.2)", /Unknown search type/.test(schemaSrc));
record("limit clamped to ≤ 30 (§4.2)", /SEARCH_LIMIT_MAX\s*=\s*30/.test(schemaSrc) && schemaSrc.includes("Math.min(SEARCH_LIMIT_MAX"));
record("q minimum 2 characters enforced (§4.2)", /SEARCH_Q_MIN\s*=\s*2/.test(schemaSrc) && schemaSrc.includes("SEARCH_Q_MIN"));
record("q maximum 64 characters enforced (§4.2)", /SEARCH_Q_MAX\s*=\s*64/.test(schemaSrc));
record("per-entity cap = 8 (§6)", /SEARCH_PER_ENTITY_TAKE\s*=\s*8/.test(schemaSrc));

/* ------------------- route hygiene: rate limit + cache -------------------- */
section = "route";
record("dedicated search rate limiter keyed by user+business (§10)", /rateLimit\(\s*`search:\$\{ctx\.userId\}:\$\{ctx\.businessId\}`/.test(routeSrc));
record("429 with project error envelope (§10/§35)", routeSrc.includes("RATE_LIMITED"));
record("private no-store cache header (§11)", routeSrc.includes("private, no-store"));
record("route reads ONLY q/types/limit (§4.2)", !/searchParams\.get\("(?!q"|types"|limit")[^"]*"/.test(routeSrc));

/* ------------------- client cache keys (§18/§30) --------------------------- */
section = "client";
record("query keys include businessId + query + types (§18)", clientSrc.includes("searchKeys.query") && /businessId[\s\S]{0,40}q[\s\S]{0,40}types/s.test(clientSrc));
record("palette enables search only when open && q ≥ 2 (§30)", paletteSrc.includes("useSearchQuery") && /enabled:\s*open/.test(paletteSrc));
record("store adds #/search with encoded q (§29)", storeSrc.includes('"/search?q=${encodeURIComponent(q)}"') || /#\/search\?q=\$\{encodeURIComponent/.test(storeSrc));
record("hash parser sanitizes the q param (§16)", storeSrc.includes("sanitizeSearchHashQuery"));

/* ---------------------------- summary ------------------------------------- */
const passedCount = results.filter(Boolean).length;
const failedCount = results.length - passedCount;
console.log(`\nsearch-static-scan: ${passedCount}/${results.length} checks passed`);
if (failedCount > 0) {
  console.log(`FAILED: ${failedCount} check(s)`);
  process.exit(1);
}
