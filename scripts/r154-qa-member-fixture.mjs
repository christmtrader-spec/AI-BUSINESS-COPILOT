/**
 * r154-qa-member-fixture.mjs — R154 browser-QA fixture (QA-ONLY).
 *
 * Adds ONE registered user as a second businessMember on the R154 QA
 * business so the invite step's checkmark + the welcome tile's absence
 * can be verified live (the members POST requires an EXISTING account —
 * the UI path would need a signup first; the fixture is the honest
 * shortcut for a QA-only row).
 *
 * THE R131 LESSON IS LAW: the email matches the registered sweep pattern
 * `r136-qa-%@test.local` (scripts/r104-user-sweep.mjs) — never unsweepable.
 *
 * Run: bun scripts/r154-qa-member-fixture.mjs <businessId>
 */
import { PrismaClient } from "@prisma/client";
import { hashSync } from "bcryptjs";

const db = new PrismaClient();
const STAMP = Date.now();
const EMAIL = `r136-qa-member-${STAMP}@test.local`;

async function main() {
  const businessId = process.argv[2];
  if (!businessId) throw new Error("usage: bun scripts/r154-qa-member-fixture.mjs <businessId>");
  const user = await db.user.create({
    data: {
      email: EMAIL,
      name: "R154 QA Member",
      passwordHash: hashSync("R154-QA-2026!", 10),
      emailVerifiedAt: new Date(),
    },
  });
  const member = await db.businessMember.create({
    data: { businessId, userId: user.id, role: "VIEWER" },
  });
  console.log(JSON.stringify({ email: EMAIL, memberId: member.id }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
