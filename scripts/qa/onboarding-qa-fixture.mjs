// One-off QA fixture: a verified user with NO business (lands on onboarding).
// Usage: bun scripts/qa/onboarding-qa-fixture.mjs [--teardown]
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const EMAIL = "onboarding-qa@fixture.local";

const teardown = process.argv.includes("--teardown");

if (teardown) {
  const user = await db.user.findUnique({ where: { email: EMAIL } });
  if (user) {
    // Business.owner is Restrict — delete owned businesses first (they
    // cascade members/subscription/events/products/sales/…).
    const owned = await db.business.findMany({ where: { ownerId: user.id }, select: { id: true, name: true } });
    for (const b of owned) {
      await db.business.delete({ where: { id: b.id } });
      console.log("[onboarding-qa] business deleted:", b.name);
    }
    await db.user.delete({ where: { id: user.id } });
    console.log("[onboarding-qa] user deleted:", user.id);
  } else {
    console.log("[onboarding-qa] nothing to tear down");
  }
  await db.$disconnect();
  process.exit(0);
}

const existing = await db.user.findUnique({ where: { email: EMAIL } });
if (existing) {
  console.log("[onboarding-qa] user exists:", existing.id);
} else {
  const user = await db.user.create({
    data: {
      email: EMAIL,
      name: "Onboarding QA",
      passwordHash: bcrypt.hashSync("testpass123", 10),
      emailVerifiedAt: new Date(),
    },
  });
  console.log("[onboarding-qa] user created:", user.id);
}

const owned = await db.business.count({ where: { ownerId: (await db.user.findUnique({ where: { email: EMAIL } })).id } });
console.log("[onboarding-qa] owned businesses:", owned, "(must be 0 for onboarding)");
await db.$disconnect();
