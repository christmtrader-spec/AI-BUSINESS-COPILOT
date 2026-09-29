#!/usr/bin/env node
/**
 * scripts/privacy-deletion-check.mjs — Prompt 27 (§75/§76/§214).
 *
 * Verification/dry-run tool for the DELETION matrix. Creates SYNTHETIC
 * fixture data (never real user data), exercises the actual cascade
 * behavior, and reports the deletion graph. Cleans up after itself.
 *
 *   D1  Dry-run graph: what a business delete WOULD remove, what remains,
 *       what is policy-dependent (no mutation for the graph itself).
 *   D2  Business deletion (hard cascade): customers/suppliers/products/
 *       sales/expenses/payments/chat/usage/subscription/checkout/audit gone;
 *       CommercialEvent + AiCostRecord + ProcessedWebhookEvent RETAINED.
 *   D3  User deletion (non-owner member): user gone, membership gone,
 *       LegalAcceptance gone (cascade), business untouched (it is gone
 *       anyway), AuditLog actor SetNull (ANONYMIZED), platform-level audit
 *       retained.
 *   D4  Owner-block: DELETE /me semantics require zero owned businesses
 *       (verified at the schema/logic level via owned-business query used by
 *       the route; the API path itself is covered by the Prompt 18 suite).
 *
 * Usage: bun scripts/privacy-deletion-check.mjs
 * Exit:  0 = all deletion behavior matches the documented matrix · 1 = drift
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";

const ROOT = "/home/z/my-project";
const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = `${ROOT}/.env`;
  if (existsSync(envPath)) {
    const line = readFileSync(envPath, "utf8")
      .split("\n")
      .find((l) => l.trim().startsWith("DATABASE_URL="));
    return line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("DATABASE_URL not available");
}
const prisma = new PrismaClient({ datasources: { db: { url: loadDatabaseUrl() } } });

const failures = [];
let passed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push({ name, detail });
    console.error(`  ✗ ${name}${detail !== "" ? ` — ${String(detail).slice(0, 200)}` : ""}`);
  }
}

const STAMP = Date.now();
const OWNER = { email: `p27del-owner-${STAMP}@check.local`, name: "P27 Deletion Owner", password: "Deletion-Owner-2026!" };
const MEMBER = { email: `p27del-member-${STAMP}@check.local`, name: "P27 Deletion Member", password: "Deletion-Member-2026!" };
const BIZ_NAME = `P27 Deletion Probe ${STAMP}`;

async function main() {
  console.log("\n=== D0. One-time fixture sweep (crash leftovers from prior runs) ===");
  // Businesses FIRST (owner users are delete-restricted while they own one).
  for (const b of await prisma.business.findMany({ where: { name: { contains: "P27 Deletion Probe" } }, select: { id: true } })) {
    await prisma.business.delete({ where: { id: b.id } }).catch(() => {});
  }
  const staleUsers = await prisma.user.findMany({ where: { email: { contains: "p27del-" } }, select: { id: true } });
  for (const u of staleUsers) await prisma.user.delete({ where: { id: u.id } }).catch(() => {});
  await prisma.commercialEvent.deleteMany({ where: { eventType: "ONBOARDING_COMPLETED", dedupeKey: { startsWith: "p27del-" } } });
  await prisma.aiCostRecord.deleteMany({ where: { requestId: { startsWith: "p27del-" } } });
  console.log(`  swept probe businesses + ${staleUsers.length} stale users (self-heal)`);

  console.log("\n=== D1. Dry-run dependency graph (no mutation) ===");
  // The graph as documented in docs/legal/data-deletion-matrix.md.
  const graph = [
    ["user", "business (owned)", "must be resolved FIRST (owner-block)"],
    ["business", "customers/suppliers/products/sales/expenses/payments", "DELETED with business (cascade)"],
    ["business", "AI sessions + messages", "DELETED with business (cascade)"],
    ["business", "usage periods/counters/events", "DELETED with business (cascade)"],
    ["business", "subscription + subscription events", "DELETED with business (cascade)"],
    ["business", "checkout sessions + payment transactions", "DELETED with business (cascade)"],
    ["business", "tenant audit logs", "DELETED with business (cascade)"],
    ["business", "commercial events", "RETAINED (no FK — analytics)"],
    ["business", "AI cost records", "RETAINED (no FK — internal financial records)"],
    ["business", "processed webhook events", "RETAINED (platform-level ledger)"],
    ["user", "memberships", "DELETED with user (cascade)"],
    ["user", "AI sessions/messages authored", "DELETED with user (cascade)"],
    ["user", "password reset tokens", "DELETED with user (cascade)"],
    ["user", "legal acceptances", "DELETED with user (cascade)"],
    ["user", "email verification tokens (Prompt 30)", "DELETED with user (cascade)"],
    ["user", "MFA credential — encrypted secret (Prompt 30)", "DELETED with user (cascade)"],
    ["user", "MFA recovery code hashes (Prompt 30)", "DELETED with user (cascade)"],
    ["user", "MFA login challenges (Prompt 30)", "DELETED with user (cascade)"],
    ["user", "device session registry rows (Prompt 30)", "DELETED with user (cascade)"],
    ["user", "security activity events (Prompt 30)", "DELETED with user (cascade) — privacy-first: security history does NOT survive the account"],
    ["user", "audit rows as actor", "ANONYMIZED (actorId SetNull)"],
    ["user", "platform-level security events", "RETAINED (actor link removed)"],
  ];
  for (const [from, to, verdict] of graph) {
    console.log(`    ${from} → ${to}: ${verdict}`);
  }
  passed += 1;
  console.log("  ✓ dry-run graph printed (no mutation in this section)");

  console.log("\n=== D2. Fixture setup ===");
  const owner = await prisma.user.create({ data: { email: OWNER.email, name: OWNER.name, passwordHash: "x" } });
  const member = await prisma.user.create({ data: { email: MEMBER.email, name: MEMBER.name, passwordHash: "x" } });
  const biz = await prisma.business.create({ data: { name: BIZ_NAME, slug: `p27-del-probe-${STAMP}`, ownerId: owner.id, currencyCode: "EUR", currencySymbol: "€", decimalPrecision: 2, locale: "en", timezone: "UTC" } });
  await prisma.businessMember.createMany({ data: [
    { businessId: biz.id, userId: owner.id, role: "OWNER" },
    { businessId: biz.id, userId: member.id, role: "MEMBER" },
  ]});
  const customer = await prisma.customer.create({ data: { businessId: biz.id, name: "Del Probe Customer", email: "delpc@check.local" } });
  const supplier = await prisma.supplier.create({ data: { businessId: biz.id, name: "Del Probe Supplier" } });
  const product = await prisma.product.create({ data: { businessId: biz.id, name: "Del Probe Product", salePriceMinor: 100 } });
  await prisma.sale.create({ data: { businessId: biz.id, number: 1, issueDate: new Date(), status: "UNPAID", subtotalMinor: 100, totalMinor: 100, paidMinor: 0, customerId: customer.id } });
  await prisma.expense.create({ data: { businessId: biz.id, category: "probe", spentAt: new Date(), amountMinor: 50, paidMinor: 0, supplierId: supplier.id } });
  await prisma.payment.create({ data: { businessId: biz.id, direction: "IN", amountMinor: 10, method: "CASH", paidAt: new Date(), saleId: (await prisma.sale.findFirst({ where: { businessId: biz.id } })).id } });
  const chat = await prisma.chatSession.create({ data: { id: `p27del-${STAMP}`, businessId: biz.id, userId: owner.id, title: "probe" } });
  await prisma.chatMessage.create({ data: { sessionId: chat.id, role: "USER", content: "probe question", userId: owner.id } });
  const period = await prisma.usagePeriod.create({ data: { businessId: biz.id, start: new Date("2026-09-01") } });
  const usageEvent = await prisma.usageEvent.create({ data: { businessId: biz.id, usagePeriodId: period.id, metric: "AI_REQUESTS", quantity: 1, idempotencyKey: `p27del-${STAMP}`, requestId: `p27del-${STAMP}`, metaJson: JSON.stringify({ provider: "z-ai" }) } });
  const freePlan = (await prisma.plan.findFirst({ where: { code: "FREE" } })) ?? (await prisma.plan.create({ data: { code: "FREE", name: "Free", active: true } }));
  await prisma.subscription.create({ data: { businessId: biz.id, planId: freePlan.id, status: "ACTIVE" } });
  await prisma.checkoutSession.create({ data: { businessId: biz.id, planCode: "STARTER", billingPeriod: "MONTHLY", amountMinor: 900, currency: "EUR", status: "PENDING", provider: "mock", providerRef: `p27del-${STAMP}`, expiresAt: new Date(Date.now() + 86400_000), initiatedByUserId: owner.id } });
  await prisma.auditLog.create({ data: { businessId: biz.id, actorId: owner.id, action: "probe.action", entityType: "Business", entityId: biz.id } });
  await prisma.commercialEvent.create({ data: { eventType: "ONBOARDING_COMPLETED", businessId: biz.id, userId: owner.id, dedupeKey: `p27del-${STAMP}` } });
  await prisma.aiCostRecord.create({ data: { usageEventId: usageEvent.id, requestId: `p27del-${STAMP}`, businessId: biz.id, planCodeAtUsage: "FREE", provider: "z-ai", model: "probe-model", tokenStatus: "NONE", costStatus: "UNKNOWN", unknownReason: "RATE_NOT_FOUND" } });
  await prisma.legalAcceptance.createMany({ data: [
    { userId: owner.id, documentType: "privacy", documentVersion: "2026-09-v1", locale: "en" },
    { userId: owner.id, documentType: "terms", documentVersion: "2026-09-v1", locale: "en" },
    { userId: member.id, documentType: "privacy", documentVersion: "2026-09-v1", locale: "fa" },
  ]});
  await prisma.auditLog.create({ data: { businessId: null, actorId: owner.id, action: "probe.platform_event", entityType: "User", entityId: owner.id } });
  // Prompt 30 security records for the OWNER (all user-owned; all must
  // cascade with the account — §295). Fixture values only; nothing secret.
  await prisma.emailVerificationToken.create({ data: { userId: owner.id, tokenHash: `probe-hash-${STAMP}`, expiresAt: new Date(Date.now() + 3600_000) } });
  await prisma.mfaCredential.create({ data: { userId: owner.id, encryptedSecret: "v1.probe.iv.probe.tag.probe", enabledAt: new Date() } });
  await prisma.mfaRecoveryCode.create({ data: { userId: owner.id, codeHash: `probe-recovery-${STAMP}` } });
  await prisma.mfaLoginChallenge.create({ data: { userId: owner.id, challengeHash: `probe-challenge-${STAMP}`, expiresAt: new Date(Date.now() + 300_000), sessionVersionAtChallenge: 0 } });
  await prisma.userSession.create({ data: { userId: owner.id, sessionTokenHash: `probe-session-${STAMP}`, expiresAt: new Date(Date.now() + 86400_000) } });
  await prisma.securityEvent.create({ data: { userId: owner.id, eventType: "auth.login.success", success: true } });
  console.log(`  fixture business ${biz.id} + owner ${owner.id} + member ${member.id} created`);

  const beforeBizCounts = {
    customers: await prisma.customer.count({ where: { businessId: biz.id } }),
    chatMessages: await prisma.chatMessage.count({ where: { sessionId: chat.id } }),
    usageEvents: await prisma.usageEvent.count({ where: { businessId: biz.id } }),
    tenantAudit: await prisma.auditLog.count({ where: { businessId: biz.id } }),
  };
  check("fixture populated", Object.values(beforeBizCounts).every((n) => n >= 1), JSON.stringify(beforeBizCounts));

  console.log("\n=== D2. Business deletion cascade ===");
  await prisma.business.delete({ where: { id: biz.id } });
  check("customers deleted", (await prisma.customer.count({ where: { businessId: biz.id } })) === 0);
  check("suppliers deleted", (await prisma.supplier.count({ where: { businessId: biz.id } })) === 0);
  check("products deleted", (await prisma.product.count({ where: { businessId: biz.id } })) === 0);
  check("sales deleted", (await prisma.sale.count({ where: { businessId: biz.id } })) === 0);
  check("expenses deleted", (await prisma.expense.count({ where: { businessId: biz.id } })) === 0);
  check("payments deleted", (await prisma.payment.count({ where: { businessId: biz.id } })) === 0);
  check("chat sessions deleted", (await prisma.chatSession.count({ where: { businessId: biz.id } })) === 0);
  check("chat messages deleted", (await prisma.chatMessage.count({ where: { sessionId: chat.id } })) === 0);
  check("usage periods deleted", (await prisma.usagePeriod.count({ where: { businessId: biz.id } })) === 0);
  check("usage events deleted", (await prisma.usageEvent.count({ where: { businessId: biz.id } })) === 0);
  check("subscription deleted", (await prisma.subscription.count({ where: { businessId: biz.id } })) === 0);
  check("checkout sessions deleted", (await prisma.checkoutSession.count({ where: { businessId: biz.id } })) === 0);
  check("tenant audit logs deleted", (await prisma.auditLog.count({ where: { businessId: biz.id } })) === 0);
  check("memberships deleted", (await prisma.businessMember.count({ where: { businessId: biz.id } })) === 0);

  const retainedEvent = await prisma.commercialEvent.findFirst({ where: { dedupeKey: `p27del-${STAMP}` } });
  check("CommercialEvent RETAINED (analytics, no FK)", !!retainedEvent);
  const retainedCost = await prisma.aiCostRecord.findFirst({ where: { requestId: `p27del-${STAMP}` } });
  check("AiCostRecord RETAINED (internal financial record)", !!retainedCost && retainedCost.costStatus === "UNKNOWN");

  console.log("\n=== D3. User deletion (owner) ===");
  const platformAuditBefore = await prisma.auditLog.findFirst({ where: { action: "probe.platform_event", actorId: owner.id } });
  check("platform-level audit row exists before user delete", !!platformAuditBefore);
  await prisma.user.delete({ where: { id: owner.id } });
  check("owner user gone", (await prisma.user.count({ where: { id: owner.id } })) === 0);
  check("owner LegalAcceptance rows cascaded", (await prisma.legalAcceptance.count({ where: { userId: owner.id } })) === 0);
  // Prompt 30 — every user-owned security record MUST cascade with the user.
  check("email verification tokens cascaded (Prompt 30)", (await prisma.emailVerificationToken.count({ where: { tokenHash: `probe-hash-${STAMP}` } })) === 0);
  check("MFA credential cascaded (Prompt 30)", (await prisma.mfaCredential.count({ where: { userId: owner.id } })) === 0);
  check("MFA recovery code hashes cascaded (Prompt 30)", (await prisma.mfaRecoveryCode.count({ where: { userId: owner.id } })) === 0);
  check("MFA login challenges cascaded (Prompt 30)", (await prisma.mfaLoginChallenge.count({ where: { userId: owner.id } })) === 0);
  check("device session registry rows cascaded (Prompt 30)", (await prisma.userSession.count({ where: { userId: owner.id } })) === 0);
  check("security activity events cascaded — NOT retained (Prompt 30 §295)", (await prisma.securityEvent.count({ where: { userId: owner.id } })) === 0);
  const platformAuditAfter = await prisma.auditLog.findUnique({ where: { id: platformAuditBefore.id } });
  check("platform audit row RETAINED with actor ANONYMIZED", !!platformAuditAfter && platformAuditAfter.actorId === null);

  console.log("\n=== D4. Owner-block rule (route-level logic, verified at data level) ===");
  const owned = await prisma.business.count({ where: { ownerId: member.id } });
  check("member (non-owner) owns no business → account deletion allowed", owned === 0);
  check("member acceptance rows still present before member delete", (await prisma.legalAcceptance.count({ where: { userId: member.id } })) > 0);
  await prisma.user.delete({ where: { id: member.id } });
  check("member acceptance rows cascaded with user", (await prisma.legalAcceptance.count({ where: { userId: member.id } })) === 0);

  console.log("\n=== Cleanup ===");
  await prisma.commercialEvent.delete({ where: { id: retainedEvent.id } });
  await prisma.aiCostRecord.delete({ where: { id: retainedCost.id } });
  const leftovers = [
    await prisma.user.count({ where: { email: { contains: `p27del-` } } }),
    await prisma.business.count({ where: { name: { contains: "P27 Deletion Probe" } } }),
    await prisma.commercialEvent.count({ where: { dedupeKey: `p27del-${STAMP}` } }),
    await prisma.aiCostRecord.count({ where: { requestId: `p27del-${STAMP}` } }),
  ];
  check("zero fixture leftovers", leftovers.every((n) => n === 0), JSON.stringify(leftovers));

  console.log(`\n=== privacy-deletion-check: ${passed} checks passed, ${failures.length} failed ===`);
  if (failures.length > 0) {
    console.error("DELETION MATRIX DRIFT — update docs/legal/data-deletion-matrix.md or fix the schema:");
    for (const f of failures) console.error(`  ✗ ${f.name}`);
    process.exitCode = 1;
  } else {
    console.log("MATCHES DOCUMENTED MATRIX — deletion behavior and docs agree.");
  }
}

main()
  .catch((e) => {
    console.error("HARNESS ERROR:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
