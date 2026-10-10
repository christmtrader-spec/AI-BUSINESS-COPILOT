#!/usr/bin/env bun
/**
 * scripts/ai-cost-consistency.ts — Prompt 26 (§66).
 *
 * UsageEvent ↔ AiCostRecord consistency audit (read-only, §132):
 *   1. Every COMMITTED AI_REQUESTS event has EXACTLY ONE cost attribution
 *      or is listed as PENDING (§68) — no duplicates (§20).
 *   2. Every AiCostRecord anchors to an EXISTING UsageEvent of the SAME
 *      business (no orphan cost records — §66).
 *   3. RELEASED usage has NO cost record (nothing consumed → nothing owed).
 *   4. KNOWN records always carry rateVersion + currency + non-negative
 *      amount; UNKNOWN records never carry an amount (§18).
 *   5. Token arithmetic: totalTokens == inputTokens + outputTokens for
 *      COMPLETE records.
 *   6. Every KNOWN record's rate version still exists (history is never
 *      rewritten — §12/§14).
 *
 * Exit: 0 = consistent · 1 = discrepancies found (investigate — this is an
 * audit tool, NOT a repair tool).
 */

import { db } from "@/lib/db";
import { utcLastDays } from "@/lib/ai/cost";

async function main() {
  const daysIdx = process.argv.indexOf("--days");
  const days = daysIdx > 0 ? Math.max(1, Number(process.argv[daysIdx + 1]) || 30) : 30;
  const window = utcLastDays(days);
  console.log(`AI COST CONSISTENCY AUDIT (read-only — §66) — last ${days}d UTC`);

  const problems: string[] = [];

  const [requestEvents, records] = await Promise.all([
    db.usageEvent.findMany({
      where: { metric: "AI_REQUESTS", createdAt: { gte: window.from, lt: window.to } },
      select: { id: true, businessId: true, requestId: true, status: true },
    }),
    db.aiCostRecord.findMany({
      where: { createdAt: { gte: window.from, lt: window.to } },
      select: {
        id: true,
        businessId: true,
        requestId: true,
        usageEventId: true,
        costStatus: true,
        currency: true,
        rateVersion: true,
        rateId: true,
        costNanoMinor: true,
        inputTokens: true,
        outputTokens: true,
        totalTokens: true,
        tokenStatus: true,
      },
    }),
  ]);

  // 2. Orphan cost records (anchor missing or cross-business).
  const anchorIds = [...new Set(records.map((r) => r.usageEventId))];
  const anchors = await db.usageEvent.findMany({
    where: { id: { in: anchorIds } },
    select: { id: true, businessId: true, requestId: true, metric: true, status: true },
  });
  const anchorById = new Map(anchors.map((a) => [a.id, a]));
  for (const r of records) {
    const anchor = anchorById.get(r.usageEventId);
    if (!anchor) problems.push(`ORPHAN_COST_RECORD ${r.id}: anchor usage event ${r.usageEventId} not found`);
    else if (anchor.businessId !== r.businessId) {
      problems.push(`CROSS_TENANT_LINK ${r.id}: record business ${r.businessId} anchors to event of ${anchor.businessId}`);
    }
    // 3. RELEASED usage must have no cost record.
    if (anchor && anchor.status === "RELEASED") {
      problems.push(`COST_FOR_RELEASED_USAGE ${r.id}: usage event ${anchor.id} is RELEASED`);
    }
    // 4. Status/amount invariants.
    if (r.costStatus === "KNOWN") {
      if (!r.rateVersion || !r.currency || r.costNanoMinor == null) {
        problems.push(`MALFORMED_KNOWN_RECORD ${r.id}: KNOWN without rateVersion/currency/amount`);
      } else if (r.costNanoMinor < 0n) {
        problems.push(`NEGATIVE_COST ${r.id}: ${r.costNanoMinor}`); // §126/§127
      }
    } else if (r.costStatus === "UNKNOWN") {
      if (r.costNanoMinor != null) problems.push(`UNKNOWN_WITH_AMOUNT ${r.id}: UNKNOWN records must not carry an amount (§18)`);
      if (r.currency != null && r.rateVersion != null) problems.push(`UNKNOWN_WITH_RATE ${r.id}: UNKNOWN record carries rate attribution`);
    } else {
      problems.push(`BAD_COST_STATUS ${r.id}: ${r.costStatus}`);
    }
    // 5. Token arithmetic on COMPLETE records.
    if (r.tokenStatus === "COMPLETE" && r.inputTokens + r.outputTokens !== r.totalTokens) {
      problems.push(`TOKEN_ARITHMETIC ${r.id}: in(${r.inputTokens}) + out(${r.outputTokens}) != total(${r.totalTokens})`);
    }
  }

  // 1. Exactly-one attribution per committed request (dedupe by business+request).
  const committed = requestEvents.filter((e) => e.status === "COMMITTED");
  const recordKeys = new Map<string, number>();
  for (const r of records) {
    const key = `${r.businessId}:${r.requestId}`;
    recordKeys.set(key, (recordKeys.get(key) ?? 0) + 1);
  }
  let pending = 0;
  const uniqueCommitted = new Set<string>();
  for (const e of committed) {
    const key = `${e.businessId}:${e.requestId}`;
    if (uniqueCommitted.has(key)) continue; // multiple metrics/events of one op
    uniqueCommitted.add(key);
    const count = recordKeys.get(key) ?? 0;
    if (count === 0) pending += 1; // §68 — attribution pending (retriable)
    else if (count > 1) problems.push(`DUPLICATE_COST_RECORDS ${key}: ${count} records for one logical operation (§20)`);
  }
  const released = requestEvents.filter((e) => e.status === "RELEASED");
  for (const e of released) {
    const count = records.filter((r) => r.businessId === e.businessId && r.requestId === e.requestId).length;
    if (count > 0) problems.push(`COST_FOR_RELEASED_REQUEST ${e.businessId}:${e.requestId}: ${count} record(s)`);
  }

  // 6. Rate versions still exist.
  const knownWithRate = records.filter((r) => r.costStatus === "KNOWN" && r.rateVersion);
  const rateVersions = [...new Set(knownWithRate.map((r) => r.rateVersion as string))];
  const rates = await db.aiCostRate.findMany({
    where: { version: { in: rateVersions } },
    select: { version: true },
  });
  const existingVersions = new Set(rates.map((r) => r.version));
  for (const r of knownWithRate) {
    if (!existingVersions.has(r.rateVersion as string)) {
      problems.push(`MISSING_RATE_VERSION ${r.id}: version ${r.rateVersion} vanished (history must never be rewritten — §12)`);
    }
  }

  console.log(`  committed AI operations (unique): ${uniqueCommitted.size}`);
  console.log(`  cost records: ${records.length} · attributed: ${uniqueCommitted.size - pending} · pending: ${pending}`);
  if (problems.length === 0) {
    console.log("RESULT: CONSISTENT ✓");
    await db.$disconnect();
    process.exit(0);
  }
  console.error(`RESULT: ${problems.length} DISCREPANC(IES):`);
  for (const p of problems.slice(0, 100)) console.error(`  - ${p}`);
  if (problems.length > 100) console.error(`  … and ${problems.length - 100} more`);
  await db.$disconnect();
  process.exit(1);
}

main().catch(async (error) => {
  console.error("ai-cost-consistency failed:", error);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
