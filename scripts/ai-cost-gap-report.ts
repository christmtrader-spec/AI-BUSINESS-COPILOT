#!/usr/bin/env bun
/**
 * scripts/ai-cost-gap-report.ts — Prompt 26 (§65).
 *
 * P46-API RECOVERY NOTE: rewritten against the CURRENT src/lib/ai/cost API.
 * utcLastDays is no longer exported from "@/lib/ai/cost" → a local, pure UTC
 * helper provides the bounded window. The ledger's unknown-reason vocabulary
 * was renamed in the current API (NO_TOKEN_USAGE → TOKENS_MISSING,
 * NO_VERIFIED_RATE → RATE_NOT_FOUND) — the gap counters match the CURRENT
 * vocabulary (model UNKNOWN is exported as UNKNOWN_MODEL, same string).
 *
 * DIAGNOSTIC report of every cost-attribution gap. It MUST NOT fabricate
 * corrections (§65): it only makes the gaps visible so an operator can act
 * (configure a verified rate, investigate token-usage absence, or run the
 * reconciliation dry-run).
 *
 * Gaps reported:
 *  1. AI requests with NO token usage (provider reported nothing).
 *  2. Token usage with NO verified cost rate (UNKNOWN by design, §17).
 *  3. Cost records MISSING usage linkage (integrity anomaly).
 *  4. Unknown model attribution (model = UNKNOWN, §94).
 *  5. Unknown provider attribution (provider missing/blank).
 *  6. Unknown cost currency (KNOWN record without currency — impossible by
 *     construction; reported loudly if it ever appears).
 *
 * READ-ONLY (§132). Usage: PRISMA_QUIET=1 bun scripts/ai-cost-gap-report.ts [--days 30]
 */

import { db } from "@/lib/db";
import { UNKNOWN_MODEL } from "@/lib/ai/cost/rates";

/** Local pure UTC window (module no longer exports utcLastDays): [today-N
 *  days 00:00 UTC, tomorrow 00:00 UTC) — inclusive of today, bounded. */
function utcLastDays(days: number, now = new Date()): { from: Date; to: Date } {
  const tomorrowStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 86_400_000;
  return { from: new Date(tomorrowStart - days * 86_400_000), to: new Date(tomorrowStart) };
}

async function main() {
  const daysIdx = process.argv.indexOf("--days");
  const days = daysIdx > 0 ? Math.max(1, Number(process.argv[daysIdx + 1]) || 30) : 30;
  const window = utcLastDays(days);
  console.log(`AI COST GAP REPORT (read-only, diagnostic — §65) — last ${days}d UTC (${window.from.toISOString()} → ${window.to.toISOString()})`);

  // Anchor events of every cost record in the window.
  const records = await db.aiCostRecord.findMany({
    where: { createdAt: { gte: window.from, lt: window.to } },
    select: {
      id: true,
      businessId: true,
      requestId: true,
      usageEventId: true,
      provider: true,
      model: true,
      currency: true,
      costStatus: true,
      unknownReason: true,
      tokenStatus: true,
    },
  });
  const anchorIds = records.map((r) => r.usageEventId);
  const anchors = await db.usageEvent.findMany({
    where: { id: { in: anchorIds } },
    select: { id: true, metric: true, requestId: true, businessId: true },
  });
  const anchorById = new Map(anchors.map((a) => [a.id, a]));

  // Token events by (businessId, requestId) for linkage analysis.
  const requestIds = [...new Set(records.map((r) => r.requestId))];
  const tokenEvents = await db.usageEvent.findMany({
    where: { metric: "AI_TOKENS", requestId: { in: requestIds }, createdAt: { gte: window.from, lt: window.to } },
    select: { id: true, businessId: true, requestId: true },
  });
  const tokenEventKey = new Set(tokenEvents.map((t) => `${t.businessId}:${t.requestId}`));

  // All committed AI_REQUESTS events in the window (the usage denominator).
  const requestEvents = await db.usageEvent.findMany({
    where: { metric: "AI_REQUESTS", status: "COMMITTED", createdAt: { gte: window.from, lt: window.to } },
    select: { id: true, businessId: true, requestId: true },
  });
  const attributedKeys = new Set(records.map((r) => `${r.businessId}:${r.requestId}`));

  let noTokenUsage = 0;
  let noVerifiedRate = 0;
  let missingLinkage = 0;
  let unknownModel = 0;
  let unknownProvider = 0;
  let unknownCurrency = 0;
  let anchoredToRequestsInsteadOfTokens = 0;

  for (const r of records) {
    const anchor = anchorById.get(r.usageEventId);
    if (!anchor) missingLinkage += 1; // §65-3: cost record without a resolvable usage anchor
    if (anchor && anchor.metric === "AI_REQUESTS" && tokenEventKey.has(`${r.businessId}:${r.requestId}`)) {
      anchoredToRequestsInsteadOfTokens += 1; // tokens exist now; the record predates them
    }
    if (r.costStatus !== "KNOWN") {
      // Current reason vocabulary (TOKENS_MISSING / RATE_NOT_FOUND); the old
      // NO_TOKEN_USAGE / NO_VERIFIED_RATE names no longer exist in the ledger.
      if (r.unknownReason === "TOKENS_MISSING" || r.tokenStatus === "NONE") noTokenUsage += 1;
      else if (r.unknownReason === "RATE_NOT_FOUND") noVerifiedRate += 1;
    }
    if (r.model === UNKNOWN_MODEL) unknownModel += 1;
    if (!r.provider || r.provider.trim() === "") unknownProvider += 1;
    if (r.costStatus === "KNOWN" && !r.currency) unknownCurrency += 1;
  }

  const pendingAttribution = requestEvents.filter((e) => !attributedKeys.has(`${e.businessId}:${e.requestId}`)).length;

  console.log(`
== Gaps in the cost ledger (window records: ${records.length}) ==`);
  console.log(`  1. AI requests with NO token usage        : ${noTokenUsage}  (provider reported nothing — §65-1)`);
  console.log(`  2. Token usage with NO verified rate      : ${noVerifiedRate}  (UNKNOWN by design until the operator configures one — §65-2/§122)`);
  console.log(`  3. Cost records missing usage linkage     : ${missingLinkage}  (integrity anomaly — investigate, §65-3)`);
  console.log(`     …records anchored to AI_REQUESTS while an AI_TOKENS event now exists: ${anchoredToRequestsInsteadOfTokens}`);
  console.log(`  4. Unknown model attribution              : ${unknownModel}  (§94 — the integration does not expose a model id)`);
  console.log(`  5. Unknown provider attribution           : ${unknownProvider}`);
  console.log(`  6. KNOWN cost records with unknown currency: ${unknownCurrency}  (must be 0)`);
  console.log(`
== Attribution coverage ==`);
  console.log(`  Committed AI_REQUESTS without ANY cost record : ${pendingAttribution}  (attribution pending — retriable, §68)`);
  console.log(`
This report NEVER fabricates corrections (§65). Run scripts/ai-cost-reconcile.ts (DRY RUN by default, §71) for the safe backfill view.`);
  await db.$disconnect();
}

main().catch(async (error) => {
  console.error("ai-cost-gap-report failed:", error);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
