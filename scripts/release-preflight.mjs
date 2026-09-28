#!/usr/bin/env node
/**
 * release-preflight.mjs — Prompt 29 §64/§65/§66/§150.
 *
 * Release artifact verification — run after `bun run build` in an ISOLATED
 * process (§67/§69: never against a dev server that is mutating .next).
 *
 * Validates:
 *  - package metadata (name/version parseable),
 *  - app version source of truth (src/lib/app-version.ts == package.json),
 *  - build artifact (.next/standalone/server.js + static assets),
 *  - public assets (public/ copied into standalone),
 *  - Prisma client generated,
 *  - migration directory availability + count,
 *  - environment contract (env var NAMES documented in .env.example),
 *  - version + database report (§66): app version, migration count, latest
 *    migration, database integrity state, schema-drift suspicion.
 *
 * Exit codes: 0 = release artifact acceptable · 1 = blocking problem.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadProjectEnv();

let blocking = [];
function block(m) { blocking.push(m); console.error(` ⛔ ${m}`); }
function pass(m) { console.log(` ✔ ${m}`); }
function warn(m) { console.log(` ⚠ ${m}`); }
function section(t) { console.log(`\n== ${t} ${"=".repeat(Math.max(0, 64 - t.length))}`); }

console.log("release-preflight — release artifact verification");

/* --------------------------- package metadata ----------------------------- */
section("Package metadata");
let pkg = null;
try {
  pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  if (!pkg.name || !pkg.version) block("package.json missing name/version");
  else pass(`package: ${pkg.name}@${pkg.version}`);
} catch (e) { block(`package.json unreadable: ${String(e?.message ?? e).slice(0, 60)}`); }

/* ------------------------- version source (§65) --------------------------- */
section("Version authority (src/lib/app-version.ts)");
let appVersion = null;
try {
  const src = readFileSync(join(ROOT, "src", "lib", "app-version.ts"), "utf8");
  const m = src.match(/APP_VERSION\s*=\s*"([^"]+)"/);
  appVersion = m ? m[1] : null;
} catch { /* ignore */ }
if (!appVersion) block("src/lib/app-version.ts missing or unparsable (the version authority, §65)");
else if (pkg && appVersion !== pkg.version) block(`VERSION MISMATCH: app-version.ts=${appVersion} vs package.json=${pkg.version} — keep in sync (§65)`);
else pass(`app version: ${appVersion} (single authority, matches package.json)`);

/* ---------------------------- build artifact ------------------------------ */
section("Build artifact (§150: verify after isolated build)");
const standaloneServer = join(ROOT, ".next", "standalone", "server.js");
const standaloneStatic = join(ROOT, ".next", "standalone", ".next", "static");
const standalonePublic = join(ROOT, ".next", "standalone", "public");
if (!existsSync(standaloneServer)) {
  warn(".next/standalone/server.js NOT FOUND — no build has been run (or build ran elsewhere). Run `bun run build` in an isolated process (§67/§69).");
} else {
  pass("standalone server.js present");
  if (existsSync(standaloneStatic)) pass("static assets present in standalone output");
  else block("static assets MISSING from standalone output (build script must copy .next/static)");
  if (existsSync(standalonePublic)) pass("public assets present in standalone output");
  else block("public assets MISSING from standalone output (build script must copy public/)");
}

/* ----------------------------- prisma client ------------------------------ */
section("Prisma client");
const prismaClientIndex = join(ROOT, "node_modules", ".prisma", "client", "index.js");
if (existsSync(prismaClientIndex) || existsSync(join(ROOT, "node_modules", "@prisma", "client"))) {
  pass("prisma client generated (node_modules present)");
} else {
  block("prisma client missing — run `prisma generate` (then RESTART the server; stale-cache lesson)");
}
if (!existsSync(join(ROOT, "prisma", "schema.prisma"))) block("prisma/schema.prisma missing");

/* --------------------------- migration directory -------------------------- */
section("Migrations");
const migrationsDir = join(ROOT, "prisma", "migrations");
let migrationDirs = [];
try {
  migrationDirs = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
} catch { /* ignore */ }
if (migrationDirs.length === 0) block("prisma/migrations directory empty or missing");
else pass(`${migrationDirs.length} migrations (latest: ${migrationDirs[migrationDirs.length - 1]})`);

/* --------------------------- environment contract -------------------------- */
section("Environment contract (.env.example documents every variable)");
const envExample = join(ROOT, ".env.example");
if (!existsSync(envExample)) block(".env.example missing — operators cannot know the contract");
else {
  const exampleKeys = new Set(
    readFileSync(envExample, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => l.split("=")[0].trim()),
  );
  const required = ["DATABASE_URL", "NEXTAUTH_SECRET", "NEXTAUTH_URL"];
  for (const k of required) {
    if (exampleKeys.has(k)) pass(`${k} documented`);
    else block(`${k} NOT documented in .env.example`);
  }
  for (const k of ["EMAIL_SERVER_HOST", "EMAIL_SERVER_PORT", "EMAIL_FROM", "EMAIL_SECURE", "EMAIL_TIMEOUT_MS"]) {
    if (exampleKeys.has(k)) pass(`${k} documented`);
    else warn(`${k} not documented (Prompt 29 email contract)`);
  }
}

/* ---------------------- version + database report (§66) ------------------- */
section("Version + database report (§66)");
const dbUrl = (process.env.DATABASE_URL ?? "").trim();
if (dbUrl) {
  let dbPath = null;
  if (dbUrl.toLowerCase().startsWith("file:")) {
    const p = dbUrl.slice(5).split("?")[0];
    dbPath = p.startsWith("/") ? p : join(ROOT, "prisma", p);
  } else if (!dbUrl.startsWith("/")) dbPath = join(ROOT, dbUrl);
  else dbPath = dbUrl;
  if (existsSync(dbPath)) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const applied = Number(db.prepare(`SELECT COUNT(*) AS c FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`).get()?.c ?? 0);
      const pending = Number(db.prepare(`SELECT COUNT(*) AS c FROM "_prisma_migrations" WHERE finished_at IS NULL`).get()?.c ?? 0);
      const latestRow = db.prepare(`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`).get();
      const integrity = String(Object.values(db.prepare("PRAGMA integrity_check").get() ?? { v: "unknown" })[0]);
      pass(`database integrity: ${integrity}`);
      pass(`migrations: ${applied} applied / ${pending} unfinished (latest: ${latestRow?.migration_name ?? "?"})`);
      if (applied !== migrationDirs.length) {
        warn(`migration-count drift suspicion: DB has ${applied} applied, migration dir has ${migrationDirs.length} — run prisma migrate status before release`);
      }
      db.close();
    } catch (e) { warn(`database unreadable: ${String(e?.message ?? e).slice(0, 60)}`); }
  } else {
    warn(`database file not found (path withheld) — fresh deployment?`);
  }
} else {
  warn("DATABASE_URL unset — database report skipped");
}

console.log(`\n== RELEASE RESULT ${"=".repeat(42)}`);
if (blocking.length > 0) {
  console.error(`✖ RELEASE: BLOCKED (${blocking.length} problem(s))`);
  process.exit(1);
}
console.log(`✔ RELEASE: artifact acceptable${existsSync(standaloneServer) ? "" : " (NO BUILD PRESENT — record honestly per §150)"}`);
process.exit(0);
