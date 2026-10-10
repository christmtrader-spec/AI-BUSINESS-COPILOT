#!/usr/bin/env bun
/**
 * scripts/ai-cost-reconcile.ts — Prompt 26 (§69/§70/§71/§133).
 *
 * Controlled reconciliation, TWO passes:
 *
 * PASS 1 — MISSING ATTRIBUTION (§68/§69): committed AI operations with NO
 *   cost record yet (e.g. usage that predates the attribution hooks) get one
 *   created via the SAME idempotent ledger service, using the usage-time for
 *   rate selection. Operations with a verified rate ACTIVE AT USAGE TIME
 *   become KNOWN; everything else becomes an honest UNKNOWN record.
 *
 * PASS 2 — UPGRADE (§69/§70): existing UNKNOWN records whose token data is
 *   COMPLETE and for which a verified rate is ACTIVE AT THE USAGE TIME are
 *   upgraded to KNOWN — never today's price (§13/§63).
 *
 * HARD SAFETY RULES:
 * - DRY RUN BY DEFAULT (§71/§133): without --apply NOTHING is mutated.
 * - Requires explicit typed confirmation for mutation: --apply --confirm RECONCILE.
 * - Only UNKNOWN records are upgraded; KNOWN records are NEVER touched (§62/§128).
 * - Historical usage is NEVER rewritten (§69) — only cost attribution is ADDED.
 * - PARTIAL/TOTAL_ONLY token data is NEVER priced (no invented splits, §22/§23).
 * - Periods before the rate's effectiveFrom stay UNKNOWN (§70) — the dry-run
 *   reports per-record eligibility first.
 *
 * Usage:
 *   PRISMA_QUIET=1 bun scripts/ai-cost-reconcile.ts                    # dry run (default)
 *   PRISMA_QUIET=1 bun scripts/ai-cost-reconcile.ts --apply --confirm RECONCILE
 *   PRISMA_QUIET=1 bun scripts/ai-cost-reconcile.ts [--days 30] [--environment TEST]
 */

import { db } from "@/lib/db";
import { resolveAiCostRate, type AiCostEnvironment } from "@/lib/ai/cost/rates";
import { tokensTimesRate, addNanoMinor, assertNanoMinor } from "@/lib/ai/cost/money";
import { attributeAiCost } from "@/lib/ai/cost/ledger";
import { utcLastDays } from "@/lib/ai/cost/economics";

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const confirmIdx = argv.indexOf("--confirm");
  const confirm = confirmIdx > 0 ? argv[confirmIdx + 1] : undefined;
  const daysIdx = argv.indexOf("--days");
  const days = daysIdx > 0 ? Math.max(1, Number(argv[daysIdx + 1]) || 30) : 30;
  const envIdx = argv.indexOf("--environment");
  const environment = (envIdx > 0 ? argv[envIdx + 1] : "PRODUCTION") as AiCostEnvironment;

  if (apply && confirm !== "RECONCILE") {
    console.error("Mutation requires explicit confirmation: --apply --confirm RECONCILE (§133). Nothing was changed.");
    process.exit(2);
  }

  const window = utcLastDays(days);
  console.log(
    `AI COST RECONCILIATION — ${apply ? "APPLY" : "DRY RUN (default, §71)"} · environment=${environment} · last ${days}d UTC`,
  );

  const unknownRecords = await db.aiCostRecord.findMany({
    where: { costStatus: "UNKNOWN", createdAt: { gte: window.from, lt: window.to } },
    select: {
      id: true,
      businessId: true,
      requestId: true,
      usageEventId: true,
      provider: true,
      model: true,
      tokenStatus: true,
      unknownReason: true,
      createdAt: true,
    },
  });

  let upgradable = 0;
  let noRateAtUsageTime = 0;
  let incompleteTokens = 0;
  const plan: Array<{ id: string; costNanoMinor: bigint; rateVersion: string; currency: string; at: Date }> = [];

  for (const record of unknownRecords) {
    if (record.tokenStatus !== "COMPLETE") {
      incompleteTokens += 1;
      continue; // §22/§23 — never invent the missing dimension
    }
    // Usage time = the anchor event's createdAt (§13 — rate ACTIVE WHEN THE
    // USAGE OCCURRED). Tokens: prefer the AI_TOKENS event of this operation.
    const [anchor, tokenEvent] = await Promise.all([
      db.usageEvent.findUnique({ where: { id: record.usageEventId }, select: { createdAt: true } }),
      db.usageEvent.findFirst({
        where: { businessId: record.businessId, requestId: record.requestId, metric: "AI_TOKENS" },
        select: { metaJson: true, createdAt: true },
      }),
    ]);
    const at = tokenEvent?.createdAt ?? anchor?.createdAt ?? record.createdAt;
    const rate = await resolveAiCostRate(record.provider, record.model, at, environment);
    if (!rate) {
      noRateAtUsageTime += 1;
      continue;
    }
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    if (tokenEvent?.metaJson) {
      try {
        const meta = JSON.parse(tokenEvent.metaJson) as Record<string, unknown>;
        const sanitize = (v: unknown) =>
          typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10_000_000 ? Math.round(v) : null;
        inputTokens = sanitize(meta.inputTokens);
        outputTokens = sanitize(meta.outputTokens);
      } catch {
        // corrupted meta → leave UNKNOWN (never guess)
      }
    }
    if (inputTokens == null || outputTokens == null) {
      incompleteTokens += 1;
      continue;
    }
    const inputCost = tokensTimesRate(inputTokens, rate.inputRateNanoMinorPerToken);
    const outputCost = tokensTimesRate(outputTokens, rate.outputRateNanoMinorPerToken);
    const total = addNanoMinor(inputCost, outputCost);
    assertNanoMinor(total, "cost");
    plan.push({ id: record.id, costNanoMinor: total, rateVersion: rate.version, currency: rate.currency, at });
    upgradable += 1;
  }

  console.log(`  UNKNOWN records scanned : ${unknownRecords.length}`);
  console.log(`  upgradable (COMPLETE tokens + rate at usage time): ${upgradable}`);
  console.log(`  not upgradable — no rate ACTIVE at the usage time (§70): ${noRateAtUsageTime}`);
  console.log(`  not upgradable — incomplete token data (never fabricated, §22/§23): ${incompleteTokens}`);

  if (upgradable > 0) {
    console.log("\nPlanned upgrades (usage-event time honored, §63):");
    for (const p of plan.slice(0, 20)) {
      console.log(`  record ${p.id}: ${p.currency} ${p.costNanoMinor.toString()} nano-minor @ ${p.rateVersion} (usage at ${p.at.toISOString()})`);
    }
    if (plan.length > 20) console.log(`  … and ${plan.length - 20} more`);
  }

  // ------------------------------------------------------------------------
  // PASS 1 — missing attribution (§68/§69/§70): committed operations with no
  // cost record. The idempotent ledger service performs the writes (or would
  // perform them — the dry-run only counts).
  // ------------------------------------------------------------------------
  const requestEvents = await db.usageEvent.findMany({
    where: { metric: "AI_REQUESTS", status: "COMMITTED", createdAt: { gte: window.from, lt: window.to } },
    select: { businessId: true, requestId: true, createdAt: true },
  });
  const seen = new Set<string>();
  const pending: Array<{ businessId: string; requestId: string; createdAt: Date }> = [];
  for (const e of requestEvents) {
    const key = `${e.businessId}:${e.requestId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const has = await db.aiCostRecord.findUnique({
      where: { businessId_requestId: { businessId: e.businessId, requestId: e.requestId } },
      select: { id: true },
    });
    if (!has) pending.push({ businessId: e.businessId, requestId: e.requestId, createdAt: e.createdAt });
  }
  console.log(`\n  PASS 1 — committed operations WITHOUT any cost record: ${pending.length}`);
  if (apply) {
    let created = 0;
    let known = 0;
    for (const p of pending) {
      const outcome = await attributeAiCost({
        businessId: p.businessId,
        requestId: p.requestId,
        provider: "z-ai", // the only provider this integration records (§94)
        at: p.createdAt, // usage time — never today's price (§13/§63)
        environment,
      });
      if (outcome.attributed) {
        created += 1;
        if (outcome.costStatus === "KNOWN") known += 1;
      }
    }
    console.log(`  APPLIED: ${created} attribution(s) created (${known} KNOWN, ${created - known} honestly UNKNOWN — no rate active at usage time).`);
  } else if (pending.length > 0) {
    for (const p of pending.slice(0, 10)) {
      console.log(`    would attribute: business ${p.businessId} request ${p.requestId} (usage at ${p.createdAt.toISOString()})`);
    }
    if (pending.length > 10) console.log(`    … and ${pending.length - 10} more`);
  }

  if (!apply) {
    console.log("\nDRY RUN — nothing was mutated (§71). Re-run with --apply --confirm RECONCILE to perform both passes.");
  } else {
    let updated = 0;
    for (const p of plan) {
      const res = await db.aiCostRecord.updateMany({
        where: { id: p.id, costStatus: "UNKNOWN" }, // guarded: never touch KNOWN (§62/§128)
        data: {
          costStatus: "KNOWN",
          costNanoMinor: p.costNanoMinor,
          rateVersion: p.rateVersion,
          currency: p.currency,
          unknownReason: null,
          updatedAt: new Date(),
        },
      });
      updated += res.count;
    }
    console.log(`APPLIED (pass 2): ${updated} record(s) upgraded UNKNOWN → KNOWN. Historical usage was not rewritten (§69).`);
  }

  await db.$disconnect();
}

main().catch(async (error) => {
  console.error("ai-cost-reconcile failed:", error);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
