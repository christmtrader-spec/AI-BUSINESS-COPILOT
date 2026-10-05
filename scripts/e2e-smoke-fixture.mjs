#!/usr/bin/env node
/**
 * e2e-smoke-fixture.mjs — ensure the persistent fixture contract required by
 * scripts/e2e-smoke.ts after a sandbox DB revert. Idempotent: safe to run
 * repeatedly.
 *
 * Contract (see e2e-smoke.ts header + §1b comment):
 *  - sara@copilot.dev  password testpass123 — OWNER of EXACTLY ONE business
 *    ("Sara Copilot Business"). She sits at the FREE-plan BUSINESSES_MAX
 *    limit on purpose; throwaway sections use their own fresh owner.
 *  - eve@outsider.dev  password testpass123 — VIEWER member of sara's
 *    business (copilot RBAC check expects PERMISSION_DENIED).
 *
 * The fixture is created DIRECTLY via Prisma (not the register API) so the
 * fixture itself never consumes rate limits; the membership mirrors the
 * member.add semantics (role string from rbac.ts).
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

function hashPassword(password) {
  return bcrypt.hashSync(password, 10); // matches src/lib/auth.ts (bcryptjs)
}

const SARA = "sara@copilot.dev";
const EVE = "eve@outsider.dev";
const ALI = "ali@copilot.dev";
const REP = "rep16007@t.dev";
const BIZ_SLUG = "sara-copilot-business";
const REP_BIZ_SLUG = "rep16007-empty-business";

async function ensureUser(email, name) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // REPAIR path (found the hard way): a rebuilt environment may hold a stub
    // row (e.g. the p26 fixture creates sara with passwordHash "x"), which
    // makes the credentials login 302-to-error and every API call 401 — the
    // smoke's login() cannot distinguish this by status alone. Normalize the
    // hash so the documented fixture contract (testpass123) always holds.
    if (!bcrypt.compareSync("testpass123", existing.passwordHash)) {
      await prisma.user.update({
        where: { id: existing.id },
        data: { passwordHash: hashPassword("testpass123") },
      });
      console.log(`[smoke-fixture] password repaired for ${email}`);
    }
    return existing;
  }
  const user = await prisma.user.create({
    data: {
      email,
      name,
      passwordHash: hashPassword("testpass123"),
      emailVerifiedAt: new Date(),
    },
  });
  console.log(`[smoke-fixture] user created: ${email} -> ${user.id}`);
  return user;
}

async function main() {
  const sara = await ensureUser(SARA, "Sara Copilot");
  const eve = await ensureUser(EVE, "Eve Outsider");
  const ali = await ensureUser(ALI, "Ali Admin");
  const rep = await ensureUser(REP, "Rep Empty");

  let business = await prisma.business.findUnique({ where: { slug: BIZ_SLUG } });
  if (!business) {
    business = await prisma.business.create({
      data: {
        name: "Sara Copilot Business",
        slug: BIZ_SLUG,
        currencyCode: "USD",
        currencySymbol: "$",
        decimalPrecision: 2,
        locale: "en",
        timezone: "Asia/Tehran",
        ownerId: sara.id,
      },
    });
    console.log(`[smoke-fixture] business created: ${business.id}`);
  } else {
    console.log(`[smoke-fixture] business exists: ${business.id}`);
  }

  // eve must be a VIEWER member of sara's business (RBAC negative control).
  const eveMember = await prisma.businessMember.findUnique({
    where: { businessId_userId: { businessId: business.id, userId: eve.id } },
  });
  if (!eveMember) {
    await prisma.businessMember.create({
      data: { businessId: business.id, userId: eve.id, role: "VIEWER" },
    });
    console.log("[smoke-fixture] eve VIEWER membership created");
  } else if (eveMember.role !== "VIEWER") {
    await prisma.businessMember.update({
      where: { id: eveMember.id },
      data: { role: "VIEWER" },
    });
    console.log("[smoke-fixture] eve membership normalized to VIEWER");
  } else {
    console.log("[smoke-fixture] eve VIEWER membership exists");
  }

  // ali must be an ADMIN member of sara's business (OWNER-only negatives:
  // import blocked + business delete blocked) while NOT being a member of
  // anything else the smoke's copilot-chat scoping check uses.
  const aliMember = await prisma.businessMember.findUnique({
    where: { businessId_userId: { businessId: business.id, userId: ali.id } },
  });
  if (!aliMember) {
    await prisma.businessMember.create({
      data: { businessId: business.id, userId: ali.id, role: "ADMIN" },
    });
    console.log("[smoke-fixture] ali ADMIN membership created");
  } else if (aliMember.role !== "ADMIN") {
    await prisma.businessMember.update({
      where: { id: aliMember.id },
      data: { role: "ADMIN" },
    });
    console.log("[smoke-fixture] ali membership normalized to ADMIN");
  } else {
    console.log("[smoke-fixture] ali ADMIN membership exists");
  }

  // rep16007 must own an EMPTY business (export → dry-run import round-trip).
  let repBusiness = await prisma.business.findUnique({ where: { slug: REP_BIZ_SLUG } });
  if (!repBusiness) {
    repBusiness = await prisma.business.create({
      data: {
        name: "Rep Empty Business",
        slug: REP_BIZ_SLUG,
        currencyCode: "USD",
        currencySymbol: "$",
        decimalPrecision: 2,
        locale: "en",
        timezone: "Asia/Tehran",
        ownerId: rep.id,
      },
    });
    console.log(`[smoke-fixture] rep business created: ${repBusiness.id}`);
  } else {
    console.log(`[smoke-fixture] rep business exists: ${repBusiness.id}`);
  }

  // The businesses list endpoint resolves through BusinessMember rows, so the
  // owner needs an explicit OWNER membership (register API creates one —
  // direct Prisma creation does not).
  const repMember = await prisma.businessMember.findUnique({
    where: { businessId_userId: { businessId: repBusiness.id, userId: rep.id } },
  });
  if (!repMember) {
    await prisma.businessMember.create({
      data: { businessId: repBusiness.id, userId: rep.id, role: "OWNER" },
    });
    console.log("[smoke-fixture] rep OWNER membership created");
  } else {
    console.log("[smoke-fixture] rep OWNER membership exists");
  }

  // sara must own exactly ONE business (FREE-plan limit contract).
  const owned = await prisma.business.count({ where: { ownerId: sara.id } });
  const saraMember = await prisma.businessMember.findUnique({
    where: { businessId_userId: { businessId: business.id, userId: sara.id } },
  });
  if (!saraMember) {
    await prisma.businessMember.create({
      data: { businessId: business.id, userId: sara.id, role: "OWNER" },
    });
    console.log("[smoke-fixture] sara OWNER membership created");
  }
  console.log(
    `[smoke-fixture] state: businesses owned by sara=${owned} users=${await prisma.user.count()}`,
  );
  if (owned !== 1) {
    console.warn(
      "[smoke-fixture] WARNING: sara does not own exactly 1 business — check for leaks",
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
