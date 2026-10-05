#!/usr/bin/env node
/**
 * dev-baseline-fixture.mjs — re-create the persistent dev-baseline fixture
 * (dev-baseline@fixture.local + Dev Baseline Business) after a sandbox DB
 * revert. Idempotent: safe to run repeatedly.
 *
 * This fixture exists ONLY so that scripts/prompt19-db-check.mjs checks 4b
 * (users>0, businesses>0) and 5b (row counts never DECREASE vs the baseline
 * doc) hold on the living dev database. It is not a product feature.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const prisma = new PrismaClient();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Password hashing must match the app's convention (bcryptjs — src/lib/auth.ts).
function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

const EMAIL = "dev-baseline@fixture.local";

async function main() {
  const existingUser = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (existingUser) {
    console.log(`[dev-baseline] user exists: ${existingUser.id}`);
  } else {
    const user = await prisma.user.create({
      data: {
        email: EMAIL,
        name: "Dev Baseline",
        passwordHash: hashPassword("testpass123"),
        emailVerifiedAt: new Date(),
      },
    });
    console.log(`[dev-baseline] user created: ${user.id}`);
  }

  const existingBusiness = await prisma.business.findUnique({
    where: { slug: "dev-baseline-business" },
  });
  let businessId;
  if (existingBusiness) {
    businessId = existingBusiness.id;
    console.log(`[dev-baseline] business exists: ${existingBusiness.id}`);
  } else {
    const ownerId = (await prisma.user.findUnique({ where: { email: EMAIL } })).id;
    const business = await prisma.business.create({
      data: {
        name: "Dev Baseline Business",
        slug: "dev-baseline-business",
        currencyCode: "USD",
        currencySymbol: "$",
        decimalPrecision: 2,
        locale: "en",
        timezone: "Asia/Tehran",
        ownerId,
      },
    });
    businessId = business.id;
    console.log(`[dev-baseline] business created: ${business.id}`);
  }

  // CRITICAL (p20 A5 lesson): the business MUST own a subscription before
  // this script exits — otherwise the next `seed-billing.ts` run backfills
  // one for it and the "re-running the seed is a no-op" regression check
  // fails. The sanctioned idempotent seed performs the backfill (with proper
  // SubscriptionEvent + audit row) exactly once.
  const subCount = await prisma.subscription.count({
    where: { businessId },
  });
  if (subCount === 0) {
    console.log("[dev-baseline] no subscription on fixture business — running sanctioned seed…");
    execSync("bun scripts/seed-billing.ts", { cwd: ROOT, stdio: "inherit" });
  }

  console.log(
    `[dev-baseline] state: users=${await prisma.user.count()} businesses=${await prisma.business.count()}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
