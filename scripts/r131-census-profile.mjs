/**
 * R131 — census profiler (read-only): lists non-p-battery users with their
 * business memberships + session counts so the sweep allowlist can be
 * extended WITHOUT touching baseline identities.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const BATTERY_DOMAINS = ["p19check.local", "p22check.local", "p23check.local", "p24check.local", "p25check.local"];

function quote(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function main() {
  const nots = BATTERY_DOMAINS.map((d) => `email NOT LIKE ${quote("%@" + d)}`).join(" AND ");
  const users = await db.$queryRawUnsafe(
    `SELECT id, email, createdAt FROM User WHERE ${nots} ORDER BY createdAt ASC`,
  );
  console.log(`non-battery users: ${users.length}`);
  for (const u of users) {
    const uid = String(u.id);
    const mem = await db.$queryRawUnsafe(
      `SELECT b.name AS name, m.role AS role FROM BusinessMember m JOIN Business b ON b.id = m.businessId WHERE m.userId = ${quote(uid)}`,
    );
    const sess = await db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM UserSession WHERE userId = ${quote(uid)}`);
    console.log(
      `${String(u.email).padEnd(44)} created=${new Date(u.createdAt).toISOString().slice(0, 10)} sessions=${sess[0].n} biz=[${mem.map((m) => `${m.name}(${m.role})`).join(", ")}]`,
    );
  }
  const biz = await db.$queryRawUnsafe(`SELECT id, name FROM Business ORDER BY createdAt ASC`);
  console.log(`\nbusinesses: ${biz.length}`);
  for (const b of biz) {
    const mem = await db.$queryRawUnsafe(
      `SELECT u.email AS email FROM BusinessMember m JOIN User u ON u.id = m.userId WHERE m.businessId = ${quote(String(b.id))}`,
    );
    console.log(`  ${String(b.name).padEnd(44)} members=[${mem.map((m) => m.email).join(", ")}]`);
  }
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
