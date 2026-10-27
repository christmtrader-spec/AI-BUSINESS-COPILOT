/**
 * R73 — e2e-smoke user-residue pre-sweep (closes the R71 follow-up).
 *
 * PROBLEM: scripts/e2e-smoke.ts registers throwaway users per run
 * (`smkowner<ts>@t.dev`, `inv<ts>@t.dev`). Its final teardown normally
 * removes them, but a CRASHED or interrupted run leaks the rows. Leaked
 * smoke users pollute the user directory (platform console counts, audit
 * event actor lists) and — for invite flows — can trip unique-constraint
 * edge cases in later runs. The existing in-suite self-heal (step 1a)
 * only sweeps leaked "Smoke *" BUSINESSES, never users.
 *
 * THIS SWEEP (FK-safe, conservative by design):
 *  1. Candidates = users matching ONLY the numeric-timestamp throwaway
 *     patterns `smkowner[0-9]+@t.dev` / `inv[0-9]+@t.dev`. Documented
 *     fixtures (sara/ali/eve/rep16007/dev-baseline) and real accounts
 *     can NEVER match.
 *  2. HARD GUARD: any candidate that has EVER used a PlatformSetupKey
 *     (platformSetupKeysUsed non-empty) is REAL, not residue — skipped
 *     and reported. PlatformSetupKey rows themselves are NEVER written
 *     or deleted here (read-only existence checks only).
 *  3. Delete order (R70 FK-safe law): owned businesses (cascades all
 *     business-scoped children) → memberships → commercialEvents
 *     (plain userId ref, no cascade) → platformOperator rows → user
 *     (cascades sessions, security events, MFA, acceptances, tokens,
 *     notifications, chat history).
 *
 * Usage:
 *   bun scripts/e2e-user-sweep.mjs              # standalone run
 *   import { sweepSmokeUsers } from this file   # from e2e-smoke.ts
 */
import { PrismaClient } from "@prisma/client";

const THROWAWAY_PATTERNS = [
  /^smkowner\d+@t\.dev$/,
  /^inv\d+@t\.dev$/,
];

/**
 * Deletes every leaked throwaway smoke user. Returns a report object.
 * Never throws for "nothing to do" — only for real DB failures.
 */
export async function sweepSmokeUsers(db = new PrismaClient()) {
  // Prisma (SQLite) has no regex operator — narrow with endsWith, then
  // apply the exact numeric-timestamp patterns in JS (fail-closed: only
  // rows matching BOTH a suffix and a pattern are candidates).
  const endsWithTDotDev = await db.user.findMany({
    where: { email: { endsWith: "@t.dev" } },
    select: {
      id: true,
      email: true,
      ownedBusinesses: { select: { id: true } },
      platformSetupKeysUsed: { select: { id: true } },
      platformOperator: { select: { id: true, role: true } },
    },
  });
  const candidates = endsWithTDotDev.filter((u) =>
    THROWAWAY_PATTERNS.some((re) => re.test(u.email)),
  );

  const skippedReal = [];
  const deleted = [];
  let ownedBusinessesDeleted = 0;

  for (const u of candidates) {
    // A throwaway that somehow activated a setup key is a REAL account —
    // the sweep must never delete it (single-owner platform law).
    if (u.platformSetupKeysUsed.length > 0) {
      skippedReal.push({ email: u.email, reason: "used a PlatformSetupKey" });
      continue;
    }
    // Belt-and-braces: platform operators are never residue either.
    if (u.platformOperator) {
      skippedReal.push({ email: u.email, reason: `platform operator (${u.platformOperator.role})` });
      continue;
    }

    for (const biz of u.ownedBusinesses) {
      await db.business.delete({ where: { id: biz.id } }); // cascades business-scoped children
      ownedBusinessesDeleted += 1;
    }
    await db.businessMember.deleteMany({ where: { userId: u.id } });
    await db.commercialEvent.deleteMany({ where: { userId: u.id } });
    await db.user.delete({ where: { id: u.id } }); // cascades user-owned records (§295)
    deleted.push(u.email);
  }

  return { candidates: candidates.length, deleted, skippedReal, ownedBusinessesDeleted };
}

if (import.meta.main) {
  const db = new PrismaClient();
  const report = await sweepSmokeUsers(db);
  console.log(`e2e-user-sweep: candidates=${report.candidates} deleted=${report.deleted.length} ` +
    `businesses=${report.ownedBusinessesDeleted} skippedReal=${report.skippedReal.length}`);
  for (const email of report.deleted) console.log(`  deleted: ${email}`);
  for (const s of report.skippedReal) console.log(`  SKIPPED (real): ${s.email} — ${s.reason}`);
  const total = await db.user.count();
  const fk = await db.$queryRawUnsafe("PRAGMA foreign_key_check");
  console.log(`totalUsers=${total} fkViolations=${fk.length}`);
  await db.$disconnect();
  if (report.skippedReal.length > 0) {
    console.log("NOTE: skipped rows are REAL accounts (guarded) — verify manually if unexpected.");
  }
}
