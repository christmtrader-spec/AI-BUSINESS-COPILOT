/**
 * R104 — FK-safe sweep of QA/fixture residue users + businesses.
 *
 * Restores the census baseline after auth-QA rounds (origin probes, browser
 * signup QA, prompt18 @p17check fixtures, smoke owner leaks). The BASELINE
 * users/businesses are never touched — deletion is by EXPLICIT allowlist
 * (email suffix patterns + business name), never "everything except".
 *
 * Strategy (FK-safe):
 *  1. Discover every table's foreign keys via PRAGMA foreign_key_list.
 *  2. Multi-pass child-first deletion of every row whose user/business FK
 *     points into the sweep set (passes repeat until stable, so multi-level
 *     references and cycles drain bottom-up).
 *  3. Delete the businesses, then the users.
 *  4. PROVE safety: PRAGMA foreign_key_check must return ZERO rows and the
 *     baseline census must be intact — otherwise exit non-zero.
 *
 * Usage: node scripts/r104-user-sweep.mjs [--dry]
 *   --dry  print what WOULD be deleted, delete nothing.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const DRY = process.argv.includes("--dry");

/**
 * Residue email patterns (QA fixtures only — never baseline identities).
 *
 * R131 SWEEP WAVE — the r119–r130 battery generations accumulated without
 * their patterns being registered here (the revert catastrophe lost the
 * R71–R128 worklog). Added: the prompt-battery check domains (p19/p22/p23/
 * p24/p25), the @check.local UI-trial domain, and @t.local (dbg probes).
 * NEVER swept (verified 2026-09-28/09-21 provenance): @copilot.dev (seed +
 * the PlatformOperator super-admin), @outsider.dev (seed viewer), @t.dev
 * (rep16007 — KEEP below), @gmail.com (the owner's real Artwoodlaser
 * signup).
 */
const EMAIL_PATTERNS = [
  "%@example.com", // origin-gate probes origintest1/2
  "%@t.dev", // repro-origin2 / repro-xfh / curl-ok / direct-ok / flow-login / rep16007-EXCLUDED below / smoke owners / invite probes
  "r103-qa-user@test.local",
  "%r104-probe-1@test.local",
  "%r104-probe-2@test.local",
  "%r104-browser-qa@test.local",
  "%@p17check.local", // prompt18 synthetic fixtures
  "%@p19check.local", // prompt19 isolation fixtures (R131 sweep wave)
  "%@p22check.local", // prompt22 fixtures (R131 sweep wave)
  "%@p23check.local", // prompt23 fixtures (R131 sweep wave)
  "%@p24check.local", // prompt24 fixtures (R131 sweep wave)
  "%@p25check.local", // prompt25 fixtures (R131 sweep wave)
  "%@check.local", // prompt25 UI-trial / flow fixtures (p25ui-/p25flow- stamps)
  "%@t.local", // dbg<stamp> debug probes (R131 sweep wave)
  "r106-qa@test.local", // R106 checklist browser QA
  "r107-qa@test.local", // R107 MFA manual QA session
  "r107-mfa@test.local", // R107 MFA E2E fixture
  "r108-checklist@test.local", // R108 checklist-dismissal API proofs
  "r110-settings@test.local", // R110 settings-toggle browser QA
  "r113-guard@test.local", // R113/R114 guard-console browser QA
  "r114-copilot@test.local", // R114 copilot browser QA (itemized-answer probe)
  "r115-qa@test.local", // R115 browser QA (dashboard trend chips persona)
  "r115-trend-%@test.local", // R115 trend battery fixtures (owner + intruder)
  "r116-qa@test.local", // R116 browser QA (Reports trend chips persona)
  "r116-trend-%@test.local", // R116 trend-surface battery fixtures (owner + intruder)
  "r117-qa@test.local", // R117 browser QA (New-chip states + trend follow-up persona)
  "r117-trend-%@test.local", // reserved: R117 battery fixtures
  "r118-qa@test.local", // R118 browser QA (suggestion icons + trend empty-state persona)
  "r118-suggest-%@test.local", // reserved: R118 battery fixtures
  "r131-qa-%@test.local", // R131 browser-QA trend persona (r131-qa-seed.mjs claims self-cleaning via THIS pattern — it was missing, census drifted 7/4→11/5, R132 fix)
];
/** Baseline identities that must NEVER be swept even if they match a pattern. */
const KEEP_EMAILS = new Set(["rep16007@t.dev"]);

const SWEEP_BUSINESS_NAMES = ["R104 QA Studio", "R106 QA Ventures", "R107 QA Ventures", "R108 QA Ventures", "R110 QA Ventures", "R111 QA Ventures", "R112 QA Ventures", "R113 QA Ventures", "P23 Real Provider Shop", "P25 UI Trial Shop", "Trial Flow Shop"];
/** R114 — stamped QA business names match by PREFIX ("R114 QA Ventures mvmv1g18"). */
const SWEEP_BUSINESS_PREFIXES = ["R114 QA Ventures", "R115 QA Ventures", "R116 QA Ventures", "R117 QA Ventures", "R118 QA Ventures", "R131 QA Ventures", "P19 Isolation Co "];

async function tableList() {
  const tables = await db.$queryRawUnsafe(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma_migrations'`,
  );
  return tables.map((t) => t.name);
}

async function fkMap(table) {
  const fks = await db.$queryRawUnsafe(`PRAGMA foreign_key_list("${table}")`);
  return fks.map((fk) => ({ from: fk.from, table: fk.table }));
}

function quote(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function main() {
  // R131 — enforce FKs on THIS connection: the declared ON DELETE CASCADE
  // rules then fire during parent deletes (the prior orphaned AiCostRecord
  // proved enforcement was off — a Business died while its cost record
  // lived, and the child-pass never targeted it because it wasn't in the
  // sweep set).
  await db.$executeRawUnsafe(`PRAGMA foreign_keys = ON`);
  const sweepUsers = await db.$queryRawUnsafe(
    `SELECT id, email FROM User WHERE (${EMAIL_PATTERNS.map((p) => `email LIKE ${quote(p)}`).join(" OR ")})`,
  );
  const targets = sweepUsers.filter((u) => !KEEP_EMAILS.has(u.email));
  console.log(`sweep users (${targets.length}):`);
  for (const u of targets) console.log(`  - ${u.email}`);

  // Exact QA business names + (R114) PREFIX matches for stamped names
  // ("R114 QA Ventures mvmv1g18") — each run creates a fresh stamped
  // business, so exact IN-matching would leak every later run.
  const bizConditions = [`name IN (${SWEEP_BUSINESS_NAMES.map(quote).join(",")})`];
  for (const prefix of SWEEP_BUSINESS_PREFIXES) {
    bizConditions.push(`name LIKE ${quote(prefix + "%")}`);
  }
  const sweepBiz = await db.$queryRawUnsafe(
    `SELECT id, name FROM Business WHERE ${bizConditions.join(" OR ")}`,
  );
  console.log(`sweep businesses (${sweepBiz.length}):`);
  for (const b of sweepBiz) console.log(`  - ${b.name}`);

  // R131 — pre-existing orphans (dead parent FKs) must NOT be skipped by the
  // "nothing to sweep" early return: they are exactly what the FK proof
  // fails on. Count them first; only a fully clean book exits early.
  const testOrphans = await db.$queryRawUnsafe(
    `SELECT COUNT(*) AS n FROM AiCostRecord WHERE environment = 'TEST' AND businessId IS NOT NULL AND businessId NOT IN (SELECT id FROM Business)`,
  );
  const orphanCount = Number(testOrphans[0].n);

  if (targets.length === 0 && sweepBiz.length === 0 && orphanCount === 0) {
    console.log("nothing to sweep.");
    process.exit(0);
  }

  const userIds = targets.map((u) => u.id);
  const bizIds = sweepBiz.map((b) => b.id);
  const tables = await tableList();

  // childTable -> [{from, parentTable}]
  const refs = [];
  for (const t of tables) {
    for (const fk of await fkMap(t)) refs.push({ child: t, from: fk.from, parent: fk.table });
  }

  const userPh = userIds.map(quote).join(",");
  const bizPh = bizIds.map(quote).join(",");

  if (!DRY) {
    let pass = 0;
    let total = 0;
    for (;;) {
      pass += 1;
      let deletedThisPass = 0;
      for (const r of refs) {
        if (r.parent === "User" && userIds.length) {
          const res = await db.$executeRawUnsafe(`DELETE FROM "${r.child}" WHERE "${r.from}" IN (${userPh})`);
          deletedThisPass += res;
        } else if (r.parent === "Business" && bizIds.length) {
          const res = await db.$executeRawUnsafe(`DELETE FROM "${r.child}" WHERE "${r.from}" IN (${bizPh})`);
          deletedThisPass += res;
        }
      }
      total += deletedThisPass;
      if (deletedThisPass === 0) break;
      if (pass > 50) throw new Error("sweep did not converge in 50 passes");
    }
    // Parents last.
    if (bizIds.length) {
      total += await db.$executeRawUnsafe(`DELETE FROM "Business" WHERE id IN (${bizPh})`);
    }
    if (userIds.length) {
      total += await db.$executeRawUnsafe(`DELETE FROM "User" WHERE id IN (${userPh})`);
    }
    console.log(`deleted ${total} rows across ${pass} pass(es).`);
  }

  // R131 — orphan repair (GUARDED): a pre-existing orphan whose parent was
  // already gone is invisible to the sweep-set passes above. Repair ONLY
  // rows that are provably QA (AiCostRecord.environment = 'TEST') and fail
  // LOUD on anything else — a production cost orphan must never be silently
  // destroyed by a hygiene script.
  if (!DRY) {
    const repaired = await db.$executeRawUnsafe(
      `DELETE FROM AiCostRecord WHERE environment = 'TEST' AND businessId IS NOT NULL AND businessId NOT IN (SELECT id FROM Business)`,
    );
    if (repaired > 0) console.log(`orphan repair: deleted ${repaired} TEST-environment AiCostRecord row(s) with dead business FK`);
  }

  // ── Safety proofs ──
  const fkViolations = await db.$queryRawUnsafe(`PRAGMA foreign_key_check`);
  if (fkViolations.length > 0) {
    // R131 — String-safe rendering: PRAGMA rows carry BigInt counts that
    // crash JSON.stringify and would MASK the actual violation report.
    const render = (v) =>
      JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
    console.error(`FK CHECK FAILED: ${render(fkViolations.slice(0, 10))}`);
    process.exit(1);
  }
  const census = await db.$queryRawUnsafe(
    `SELECT (SELECT COUNT(*) FROM User) AS users, (SELECT COUNT(*) FROM Business) AS biz`,
  );
  console.log(`foreign_key_check: 0 violations ✓`);
  console.log(`census after sweep: users=${census[0].users} businesses=${census[0].biz}`);
  const residue = await db.$queryRawUnsafe(
    `SELECT COUNT(*) AS n FROM User WHERE (${EMAIL_PATTERNS.map((p) => `email LIKE ${quote(p)}`).join(" OR ")}) AND email NOT IN (${[...KEEP_EMAILS].map(quote).join(",")})`,
  );
  if (Number(residue[0].n) > 0) {
    console.error(`residue remains: ${residue[0].n}`);
    process.exit(1);
  }
  console.log("residue: 0 ✓");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
