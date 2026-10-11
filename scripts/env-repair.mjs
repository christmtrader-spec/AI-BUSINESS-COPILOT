#!/usr/bin/env node
/**
 * env-repair.mjs — ONE-COMMAND repair for the recurring sandbox revert.
 *
 * The sandbox has repeatedly (4+ times) reset db/custom.db and .env between
 * rounds: schema tables survive but with zero rows, the _prisma_migrations
 * ledger is emptied, and .env is reduced to DATABASE_URL-only. This script
 * performs the complete documented repair sequence (see worklog +
 * docs/database/data-inventory-before-baseline.md) in the exact sanctioned
 * order, idempotently:
 *
 *   1. Re-baseline the migration ledger (prisma migrate resolve --applied ×24;
 *      ledger writes ONLY — never touches application tables).
 *   2. Restore the dev .env baseline (real secrets via node:crypto).
 *   3. Re-seed billing plans + pricing books (sanctioned idempotent seeds).
 *   4. Re-create the persistent dev-baseline fixture (includes the p20-A5
 *      subscription guard).
 *   5. Re-create the e2e-smoke persistent fixture contract
 *      (sara/eve/ali/rep16007 + memberships).
 *   6. Verify: migrations 24/0, health endpoint, DB integrity, row floors.
 *
 * Safe to run repeatedly; every step detects existing state first.
 */
import { execSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prisma = new PrismaClient();

const MIGRATIONS = [
  "0_init",
  "20260923075730_prompt20_billing_foundation",
  // Legacy duplicate directories that HAVE ALWAYS shipped in this repo and
  // were applied in every real environment ledger (their tables exist).
  // They must stay baselined or a sandbox revert leaves them falsely
  // pending (they carry no new schema — resolve is ledger-writes-only).
  "20260924130000_prompt25_public_commercial",
  "20260924140000_prompt26_ai_cost_governance",
  "20260923091927_prompt21_usage_metering",
  "20260924061428_prompt22_payment_providers",
  "20260924073654_prompt23_real_provider",
  "20260924113235_prompt24_price_books",
  "20260924114500_prompt24_seed_datetime_normalize",
  "20260924120000_prompt25_commercial_conversion",
  "20260924130000_prompt26_ai_cost_governance",
  "20260927084100_prompt27_legal_acceptance",
  "20260928060000_prompt28_platform_control_plane",
  "20260929090000_prompt30_identity_security_v2",
  "20260929112056_prompt31_data_portability",
  "20260929113938_prompt31_import_storage_key",
  "20260929120000_prompt32_notification_platform",
  "20261001090000_prompt35_crm_foundation",
  "20261002081507_prompt36_crm_activities_tasks",
  "20261002113000_prompt37_crm_task_reminders",
  "20261003093000_payables_aging_expense_terms",
  "20261005080000_prompt40_inventory_stocktake",
  "20261006090000_prompt41_purchase_orders",
  // Prompt 42 (P42-F §107) — the P42 migration IS now genuinely applied
  // (22 applied / 0 pending; its tables exist in every real environment).
  // Maintenance law: EVERY applied migration must stay in this baseline
  // list, otherwise a sandbox revert re-baselines the ledger WITHOUT it and
  // leaves that migration falsely pending (a later `migrate deploy` would
  // then try to re-create existing tables and break the environment).
  "20261007090000_prompt42_goods_receipts",
  // Prompt 43 (§117) — the P43 migration is genuinely applied (23 applied /
  // 0 pending). Same maintenance law: keep every applied migration in this
  // baseline list so a sandbox revert never leaves it falsely pending.
  "20261008090000_prompt43_goods_returns",
  // Prompt 44 — the P44 Goods Dispatch migration is genuinely applied (24
  // applied / 0 pending). Same maintenance law.
  "20261010090000_prompt44_goods_dispatches",
  // Prompt 45 (§118/§142) — the P45 Sales Order migration is genuinely
  // applied (25 applied / 0 pending). Same maintenance law: keep every
  // applied migration in this baseline list so a sandbox revert never
  // leaves it falsely pending.
  "20261011090000_prompt45_sales_orders",
];

function log(step, msg) {
  console.log(`[env-repair] ${step}: ${msg}`);
}

function run(cmd, opts = {}) {
  return spawnSync(cmd[0], cmd.slice(1), {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 240_000,
    ...opts,
  });
}

// --- Step 1: migration ledger baseline (ledger writes ONLY) -----------------
function baselineMigrations() {
  const status = run(["bunx", "prisma", "migrate", "status"]);
  const out = `${status.stdout ?? ""}${status.stderr ?? ""}`;
  if (/up to date/i.test(out) && !/not yet been applied/i.test(out)) {
    log(1, "migration ledger already complete — skipped");
    return;
  }
  let n = 0;
  for (const m of MIGRATIONS) {
    const r = run(["bunx", "prisma", "migrate", "resolve", "--applied", m]);
    if (r.status === 0) n++;
    else console.error(`  resolve failed for ${m}: ${(r.stderr ?? "").slice(-160)}`);
  }
  log(1, `re-baselined ${n}/${MIGRATIONS.length} migrations`);
}

// --- Step 2: .env baseline ---------------------------------------------------
function envNeedsRepair() {
  if (!existsSync(`${ROOT}/.env`)) return true;
  const raw = readFileSync(`${ROOT}/.env`, "utf8");
  const keys = new Set(
    raw
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("#"))
      .map((l) => l.split("=")[0].trim()),
  );
  const REQUIRED = [
    "NEXTAUTH_SECRET",
    "NEXTAUTH_URL",
    "APP_BASE_URL",
    "BILLING_TRIALS_ENABLED",
    "BILLING_TRIAL_DAYS",
    "BILLING_TRIAL_PLAN",
    "MFA_ENABLED",
    "MFA_ENCRYPTION_KEY",
    "AUTH_EMAIL_VERIFICATION_MODE",
  ];
  return REQUIRED.some((k) => !keys.has(k));
}

function repairEnv() {
  if (!envNeedsRepair()) {
    log(2, ".env baseline already present — skipped");
    return false;
  }
  const secret = () => randomBytes(32).toString("base64");
  const block = [
    "",
    "# --- dev env baseline (restored by scripts/env-repair.mjs) ---",
    `NEXTAUTH_SECRET=${secret()}`,
    "NEXTAUTH_URL=http://localhost:3000",
    "APP_BASE_URL=http://localhost:3000",
    "BILLING_TRIALS_ENABLED=true",
    "BILLING_TRIAL_DAYS=14",
    "BILLING_TRIAL_PLAN=STARTER",
    "MFA_ENABLED=true",
    `MFA_ENCRYPTION_KEY=${secret()}`,
    "AUTH_EMAIL_VERIFICATION_MODE=OPTIONAL",
    "",
  ].join("\n");
  // APPEND, never overwrite (DATABASE_URL and any custom vars are preserved).
  writeFileSync(`${ROOT}/.env`, readFileSync(`${ROOT}/.env`, "utf8").replace(/\n*$/, "\n") + block);
  log(2, ".env baseline APPENDED (existing vars preserved)");
  return true;
}

// --- Step 3-5: seeds + fixtures ---------------------------------------------
function runScript(cmd) {
  const r = run(cmd);
  if (r.status !== 0) {
    console.error(`${(r.stdout ?? "") + (r.stderr ?? "")}`.slice(-600));
    throw new Error(`step failed: ${cmd.join(" ")}`);
  }
}

// --- Verification -------------------------------------------------------------
async function verify(envChanged) {
  const status = run(["bunx", "prisma", "migrate", "status"]);
  const okMig = status.status === 0 && /up to date/i.test(`${status.stdout}${status.stderr}`);
  log(6, `migrations: ${okMig ? "up to date ✓" : "STILL BROKEN ✗"}`);

  const [users, businesses, plans] = await Promise.all([
    prisma.user.count(),
    prisma.business.count(),
    prisma.plan.count(),
  ]);
  log(6, `rows: users=${users} businesses=${businesses} plans=${plans}`);
  if (users < 1 || businesses < 1 || plans < 1) throw new Error("row floors not met");

  const quick = await prisma.$queryRawUnsafe("PRAGMA quick_check");
  const fk = await prisma.$queryRawUnsafe("PRAGMA foreign_key_check");
  log(6, `integrity: ${JSON.stringify(quick).includes("ok") ? "ok" : "FAIL"} · fk violations=${fk.length}`);

  // Health check — restart first if .env changed (secrets are read at boot).
  if (envChanged) {
    log(6, ".env changed → restarting dev server via ensure-dev.sh…");
    run(["bash", "scripts/ensure-dev.sh"]);
  }
  const health = await fetch("http://localhost:3000/api/health", { signal: AbortSignal.timeout(20_000) })
    .then((r) => r.json())
    .catch(() => null);
  const healthOk = health?.status === "ok" && health?.database?.reachable === true && health?.migrations?.pending === 0;
  log(6, `health: ${JSON.stringify(health)}`);
  if (!okMig || !healthOk) {
    console.error("[env-repair] VERIFICATION FAILED");
    process.exit(1);
  }
  console.log("[env-repair] ALL GREEN — environment fully restored.");
}

async function main() {
  const t0 = Date.now();
  console.log("[env-repair] starting full sandbox-revert repair sequence…");
  baselineMigrations();
  const envChanged = repairEnv();
  runScript(["bun", "scripts/seed-billing.ts"]);
  log(3, "billing seed OK");
  runScript(["bun", "scripts/seed-pricing.ts"]);
  log(3, "pricing seed OK");
  runScript(["node", "scripts/dev-baseline-fixture.mjs"]);
  log(4, "dev-baseline fixture OK (subscription guard included)");
  runScript(["node", "scripts/e2e-smoke-fixture.mjs"]);
  log(5, "e2e-smoke fixture OK (sara/eve/ali/rep16007 + memberships)");
  await verify(envChanged);
  console.log(`[env-repair] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main()
  .catch((e) => {
    console.error("[env-repair] FAILED:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
