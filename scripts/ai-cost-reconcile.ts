#!/usr/bin/env bun
/**
 * scripts/ai-cost-reconcile.ts — Prompt 26 (§69/§70/§71/§133).
 *
 * P46-API RECOVERY NOTE: rebuilt against the CURRENT src/lib/ai/cost API.
 * - attributeAiCostSafe no longer exists: attributeAiCost itself never throws
 *   (§29 failure boundary) and returns the AttributeAiCostResult union.
 * - The ledger now ships its own reconciliation (reconcileAiCosts §41-§43,
 *   with re-validation §186 and compare-and-update §187), so PASS 2 DELEGATES
 *   to it instead of re-implementing the upgrade loop. Rates are per-1K
 *   nano-minor (inputRateNanoMinorPer1K); money helpers are
 *   multiplyRateByTokens/addNanoMinor (the old tokensTimesRate/assertNanoMinor
 *   are gone). utcLastDays is no longer exported → local pure UTC helper.
 *
 * Controlled reconciliation, TWO passes:
 *
 * PASS 1 — MISSING ATTRIBUTION (§68/§69): committed AI operations with NO
 *   cost record yet (e.g. usage that predates the attribution hooks) get one
 *   created via the SAME idempotent ledger service, using the usage time for
 *   rate selection. Genuine provider-reported tokens are recovered from the
 *   AI_TOKENS usage event (the authoritative record the route wrote); when
 *   they are absent the record is honestly UNKNOWN (TOKENS_MISSING) — tokens
 *   are NEVER invented. Operations with a rate ACTIVE AT USAGE TIME become
 *   KNOWN; everything else becomes an honest UNKNOWN record.
 *
 * PASS 2 — UPGRADE (§69/§70/§41-§43): existing UNKNOWN records whose token
 *   snapshot is COMPLETE and for which a rate is ACTIVE AT THE USAGE TIME are
 *   upgraded to KNOWN — never today's price (§13/§63). Delegated to
 *   reconcileAiCosts: dry-run performs NO mutation (§42), apply re-validates
 *   every record itself (§186) and uses compare-and-update semantics (§187);
 *   KNOWN records are NEVER rewritten (§44).
 *
 * HARD SAFETY RULES:
 * - DRY RUN BY DEFAULT (§71/§133): without --apply NOTHING is mutated.
 * - Requires explicit typed confirmation for mutation: --apply --confirm RECONCILE.
 * - Historical usage is NEVER rewritten (§69) — only cost attribution is ADDED.
 * - PARTIAL/TOTAL_ONLY token data is NEVER priced (no invented splits, §22/§23).
 * - Periods before the rate's effectiveFrom stay UNKNOWN (§70).
 *
 * Usage:
 *   PRISMA_QUIET=1 bun scripts/ai-cost-reconcile.ts                    # dry run (default)
 *   PRISMA_QUIET=1 bun scripts/ai-cost-reconcile.ts --apply --confirm RECONCILE
 *   PRISMA_QUIET=1 bun scripts/ai-cost-reconcile.ts [--days 30] [--environment TEST|PRODUCTION]
 */

import { db } from "@/lib/db";
import { reconcileAiCosts, attributeAiCost } from "@/lib/ai/cost/ledger";
import type { AttributeAiCostResult, NormalizedTokenUsage } from "@/lib/ai/cost/ledger";
import { isAiCostEnvironment, type AiCostEnvironment } from "@/lib/ai/cost/rates";

/** Local pure UTC window (module no longer exports utcLastDays): [today-N
 *  days 00:00 UTC, tomorrow 00:00 UTC) — inclusive of today, bounded. */
function utcLastDays(days: number, now = new Date()): { from: Date; to: Date } {
  const tomorrowStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 86_400_000;
  return { from: new Date(tomorrowStart - days * 86_400_000), to: new Date(tomorrowStart) };
}

/** Genuine provider-reported token recovery (§37): sanitize, never invent.
 *  Implausible values (negative/fractional/huge/non-finite) → null → the
 *  record stays UNKNOWN instead of being priced on guessed numbers. */
function usageFromTokenMeta(metaJson: string | null): NormalizedTokenUsage | null {
  if (!metaJson) return null;
  try {
    const meta = JSON.parse(metaJson) as Record<string, unknown>;
    const sanitize = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10_000_000 ? Math.round(v) : null;
    return {
      inputTokens: sanitize(meta.inputTokens),
      outputTokens: sanitize(meta.outputTokens),
      totalTokens: sanitize(meta.totalTokens),
    };
  } catch {
    return null; // corrupted meta → leave UNKNOWN (never guess)
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const confirmIdx = argv.indexOf("--confirm");
  const confirm = confirmIdx > 0 ? argv[confirmIdx + 1] : undefined;
  const daysIdx = argv.indexOf("--days");
  const days = daysIdx > 0 ? Math.max(1, Number(argv[daysIdx + 1]) || 30) : 30;
  const envIdx = argv.indexOf("--environment");
  const environmentRaw = envIdx > 0 ? argv[envIdx + 1] : "PRODUCTION";
  const environment: AiCostEnvironment = isAiCostEnvironment(environmentRaw) ? environmentRaw : "PRODUCTION";
  if (!isAiCostEnvironment(environmentRaw)) {
    console.error(`invalid --environment "${environmentRaw}" (must be TEST or PRODUCTION)`);
    process.exit(2);
  }

  if (apply && confirm !== "RECONCILE") {
    console.error("Mutation requires explicit confirmation: --apply --confirm RECONCILE (§133). Nothing was changed.");
    process.exit(2);
  }

  const window = utcLastDays(days);
  console.log(
    `AI COST RECONCILIATION — ${apply ? "APPLY" : "DRY RUN (default, §71)"} · environment=${environment} · last ${days}d UTC`,
  );

  // ------------------------------------------------------------------------
  // PASS 1 — missing attribution (§68/§69/§70): committed operations with no
  // cost record. The idempotent ledger service performs the writes (or would
  // perform them — the dry-run only counts and prints what it would do).
  // ------------------------------------------------------------------------
  const requestEvents = await db.usageEvent.findMany({
    where: { metric: "AI_REQUESTS", status: "COMMITTED", createdAt: { gte: window.from, lt: window.to } },
    select: { businessId: true, requestId: true, createdAt: true },
    take: 1000, // bounded scan (§151) — raise deliberately if a backlog is expected
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
    let unknown = 0;
    let skipped = 0;
    let failed = 0;
    for (const p of pending) {
      // Recover the genuine tokens the route recorded (§37) — attributeAiCost
      // never throws (§29); every outcome is honest and idempotent (§31).
      const tokenEvent = await db.usageEvent.findFirst({
        where: { businessId: p.businessId, requestId: p.requestId, metric: "AI_TOKENS" },
        select: { metaJson: true },
      });
      const outcome: AttributeAiCostResult = await attributeAiCost({
        businessId: p.businessId,
        requestId: p.requestId,
        provider: "z-ai", // the only provider this integration records (§94)
        model: null, // honesty law §81/§82 — no invented model identifier
        usage: usageFromTokenMeta(tokenEvent?.metaJson ?? null),
        usageTimestamp: p.createdAt, // usage time — never today's price (§13/§63)
        environment,
      });
      switch (outcome.outcome) {
        case "KNOWN":
          created += 1;
          known += 1;
          break;
        case "UNKNOWN":
          created += 1;
          unknown += 1;
          break;
        case "NO_USAGE_EVENT":
        case "ALREADY_KNOWN":
        case "ALREADY_UNKNOWN":
          skipped += 1;
          break;
        case "FAILED":
          failed += 1;
          console.error(`    attribution failed for ${p.businessId}/${p.requestId}: ${outcome.error}`);
          break;
      }
    }
    console.log(
      `  APPLIED: ${created} attribution(s) created (${known} KNOWN, ${unknown} honestly UNKNOWN — no rate active at usage time; ${skipped} skipped/idempotent, ${failed} failed).`,
    );
  } else if (pending.length > 0) {
    for (const p of pending.slice(0, 10)) {
      console.log(`    would attribute: business ${p.businessId} request ${p.requestId} (usage at ${p.createdAt.toISOString()})`);
    }
    if (pending.length > 10) console.log(`    … and ${pending.length - 10} more`);
  }

  // ------------------------------------------------------------------------
  // PASS 2 — upgrade pass (§41-§43/§69/§70): DELEGATED to the ledger's own
  // reconcileAiCosts. Dry-run reports per-class eligibility with NO mutation
  // (§42); apply re-validates every record (§186) and is compare-and-update
  // safe (§187). KNOWN records are never rewritten (§44).
  // ------------------------------------------------------------------------
  const report = await reconcileAiCosts({
    dryRun: !apply,
    environment,
    windowDays: days,
    limit: 500,
  });
  console.log(`\n  PASS 2 — UNKNOWN-record upgrade (${report.mode}, window ${report.boundedWindow.from} → ${report.boundedWindow.to}):`);
  console.log(`    candidate UNKNOWN records            : ${report.candidateRecordCount}`);
  console.log(`    complete-token records               : ${report.tokenComplete}`);
  console.log(`    incomplete-token (never priced §22/§23): ${report.tokenIncomplete}`);
  console.log(`    rate FOUND at usage time             : ${report.rateFound}`);
  console.log(`    rate MISSING at usage time (§70)     : ${report.rateMissing}`);
  console.log(`    ambiguous rates (conflicts §105)     : ${report.conflicts}`);
  console.log(`    currency mismatch (never mixed §62)  : ${report.currencyMismatch}`);
  console.log(`    eligible / ${apply ? "updated" : "would update"}                          : ${report.eligibleRecords} / ${apply ? report.updatedCount : report.wouldUpdateCount}`);

  if (!apply) {
    console.log("\nDRY RUN — nothing was mutated (§71). Re-run with --apply --confirm RECONCILE to perform both passes.");
  } else {
    console.log(`APPLIED (pass 2): ${report.updatedCount} record(s) upgraded UNKNOWN → KNOWN. Historical usage was not rewritten (§69).`);
  }

  await db.$disconnect();
}

main().catch(async (error) => {
  console.error("ai-cost-reconcile failed:", error);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
