#!/usr/bin/env bun
/**
 * scripts/ai-cost-report.ts — Prompt 26 (§50/§51/§52/§57/§58/§59/§60/§72/§110).
 *
 * PLATFORM-SENSITIVE internal operator report (§73): AI usage, KNOWN cost,
 * coverage, observed unit costs — by period/provider/model/plan/business.
 * READ-ONLY (§132): this script never mutates data, never "repairs", never
 * fabricates a number. UNKNOWN cost is reported as UNKNOWN (§18).
 *
 * No raw prompts. No raw AI responses. Business rows are identified by
 * business id (internal tool, §51/§52).
 *
 * Usage:
 *   PRISMA_QUIET=1 bun scripts/ai-cost-report.ts [--period today|7d|30d|month|prev-month]
 *                  [--from YYYY-MM-DD --to YYYY-MM-DD]   (UTC, inclusive-exclusive)
 *                  [--group provider|model|plan|business] (repeatable, default: provider+model+plan)
 *                  [--csv path/to/file.csv]               (§72 export)
 *                  [--economics EUR]                      (§81 plan unit economics + margin)
 *                  [--simulate '{"revenueMinor":1900,...}'] (§103/§104 ANALYTICAL SCENARIO)
 *                  [--exposure]                           (§44/§106 plan cost exposure)
 *
 * Exit codes: 0 ok · 2 usage error.
 */

import { db } from "@/lib/db";
import {
  aggregateAiCost,
  costByProvider,
  costByModel,
  costByPlan,
  costByBusiness,
  getPlanEconomicsReport,
  getPlanCostExposure,
  simulatePlanScenario,
  utcCalendarMonth,
  utcDayBounds,
  utcLastDays,
  utcPreviousCalendarMonth,
  type CostWindow,
} from "@/lib/ai/cost";
import { formatNanoMinor, nanoMinorToMajorString } from "@/lib/ai/cost/money";

function parseArgs(argv: string[]) {
  const args: {
    period?: string;
    from?: string;
    to?: string;
    groups: string[];
    csv?: string;
    economics?: string;
    simulate?: string;
    exposure: boolean;
  } = { groups: [], exposure: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--period") args.period = argv[++i];
    else if (a === "--from") args.from = argv[++i];
    else if (a === "--to") args.to = argv[++i];
    else if (a === "--group") args.groups.push(argv[++i]);
    else if (a === "--csv") args.csv = argv[++i];
    else if (a === "--economics") args.economics = argv[++i];
    else if (a === "--simulate") args.simulate = argv[++i];
    else if (a === "--exposure") args.exposure = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function resolveWindow(args: ReturnType<typeof parseArgs>): CostWindow {
  const now = new Date();
  if (args.from && args.to) {
    const from = new Date(`${args.from}T00:00:00.000Z`);
    const to = new Date(`${args.to}T00:00:00.000Z`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
      throw new Error("invalid --from/--to range (UTC dates, from < to)");
    }
    return { from, to }; // §60 — UTC boundaries only
  }
  switch (args.period) {
    case undefined:
    case "7d":
      return utcLastDays(7, now);
    case "today":
      return utcDayBounds(now);
    case "30d":
      return utcLastDays(30, now);
    case "month":
      return utcCalendarMonth(now);
    case "prev-month":
      return utcPreviousCalendarMonth(now);
    default:
      throw new Error(`unknown --period: ${args.period}`);
  }
}

function printAggregates(label: string, rows: Awaited<ReturnType<typeof costByProvider>>) {
  console.log(`\n== ${label} ==`);
  if (rows.length === 0) {
    console.log("  (no cost records in window)");
    return;
  }
  for (const row of rows) {
    const currencies = Object.keys(row.knownCostNanoByCurrency);
    const costStr =
      currencies.length > 0
        ? currencies.map((c) => formatNanoMinor(row.knownCostNanoByCurrency[c], c, 6)).join(" + ")
        : "UNKNOWN";
    console.log(
      `  ${row.key}: records=${row.knownCostRecords + row.unknownCostRecords} (known=${row.knownCostRecords}, unknown=${row.unknownCostRecords}) coverage=${row.costCoveragePercent ?? "n/a"}% knownCost=${costStr}`,
    );
    for (const [c, v] of Object.entries(row.observedKnownCostPerRequestNano)) {
      if (v != null) console.log(`      observedKnownCost/request (${c}): ${nanoMinorToMajorString(v)}`);
    }
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    console.error("see header of scripts/ai-cost-report.ts for usage");
    process.exit(2);
  }
  const window = resolveWindow(args);
  console.log(`AI COST REPORT (read-only) — window UTC ${window.from.toISOString()} → ${window.to.toISOString()}`);

  const agg = await aggregateAiCost(window);
  console.log(`\n== Usage (authoritative UsageEvent, COMMITTED) ==`);
  console.log(`  AI_REQUESTS=${agg.aiRequests}  AI_MESSAGES=${agg.aiMessages}  AI_TOKENS=${agg.aiTokens}`);
  console.log(`\n== Cost ledger (AiCostRecord) ==`);
  console.log(
    `  records=${agg.costRecords} known=${agg.knownCostRecords} unknown=${agg.unknownCostRecords} pendingAttribution=${agg.pendingAttribution}`,
  );
  console.log(
    `  costCoverage=${agg.costCoveragePercent == null ? "n/a (no usage)" : `${agg.costCoveragePercent}%`} (unknown share is NEVER zero-filled, §37)`,
  );
  const currencies = Object.keys(agg.knownCostNanoByCurrency);
  if (currencies.length === 0) {
    console.log("  knownCost: UNKNOWN (no verified provider rate configured — a valid state, §122)");
  } else {
    for (const c of currencies) {
      console.log(`  knownCost(${c})=${nanoMinorToMajorString(agg.knownCostNanoByCurrency[c])}`);
      const perReq = agg.observedKnownCostPerRequestNano[c];
      const per1K = agg.observedKnownCostPer1KTokensNano[c];
      if (perReq != null) console.log(`  observedKnownCost/request(${c})=${nanoMinorToMajorString(perReq)}  (KNOWN sample only, §38)`);
      if (per1K != null) console.log(`  observedKnownCost/1K tokens(${c})=${nanoMinorToMajorString(per1K)}`);
    }
  }

  const groups = args.groups.length > 0 ? args.groups : ["provider", "model", "plan"];
  for (const g of groups) {
    if (g === "provider") printAggregates("By provider", await costByProvider(window));
    else if (g === "model") printAggregates("By model", await costByModel(window));
    else if (g === "plan") printAggregates("By plan at usage (§53/§54)", await costByPlan(window));
    else if (g === "business") printAggregates("By business (§51/§52 — internal only)", await costByBusiness(window));
    else throw new Error(`unknown --group ${g}`);
  }

  // §81 — plan unit economics with explicit AI-contribution labeling (§43).
  if (args.economics) {
    const currency = args.economics.trim().toUpperCase();
    console.log(`\n== Plan unit economics (revenue currency ${currency}, PriceBook-authoritative, §34) ==`);
    const rows = await getPlanEconomicsReport(currency, { window });
    for (const row of rows) {
      const priceStr =
        row.price.priceKind === "FREE"
          ? "0 (FREE)"
          : row.price.priceKind === "PRICEBOOK" && row.price.amountMinor != null
            ? formatNanoMinor(BigInt(row.price.amountMinor) * 1_000_000n, row.price.priceCurrency ?? currency, 4)
            : "UNKNOWN";
      console.log(
        `  ${row.planCode} (${row.billingPeriod}): price=${priceStr} knownCostReq=${row.knownCostRequests} unknownCostReq=${row.unknownCostRequests} coverage=${row.costCoveragePercent ?? "n/a"}%`,
      );
      console.log(`    marginStatus=${row.marginStatus}  [${row.label}]`);
      if (row.knownAiCostNano != null) console.log(`    knownAiCost=${nanoMinorToMajorString(row.knownAiCostNano)} ${row.revenueCurrency}`);
      if (Object.keys(row.knownAiCostNanoOtherCurrencies).length > 0) {
        console.log(`    knownAiCost other currencies (NO FX, §32): ${Object.entries(row.knownAiCostNanoOtherCurrencies).map(([c, v]) => `${c} ${nanoMinorToMajorString(v)}`).join(", ")}`);
      }
      if (row.aiContributionNano != null) console.log(`    aiContribution=${nanoMinorToMajorString(row.aiContributionNano)} ${row.revenueCurrency}`);
      if (row.aiContributionMarginPercent != null) console.log(`    aiContributionMargin=${(row.aiContributionMarginPercent / 10_000).toFixed(2)}%`);
    }
  }

  // §44/§106 — plan cost exposure (UNKNOWN unless a safe ceiling exists).
  if (args.exposure) {
    console.log(`\n== Plan cost exposure (§44/§106 — UNKNOWN unless a safe ceiling is configured) ==`);
    const plans = await db.plan.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" }, select: { code: true } });
    for (const plan of plans) {
      const exposure = await getPlanCostExposure(plan.code);
      console.log(
        `  ${plan.code}: ${exposure.exposure === "KNOWN" ? `KNOWN ${formatNanoMinor(exposure.maxAiCostNanoMinor, exposure.currency, 6)} [${exposure.basis}]` : `UNKNOWN (${exposure.reason})`}`,
      );
    }
  }

  // §103/§104/§105 — analytical scenario, clearly labeled, never persisted.
  if (args.simulate) {
    const input = JSON.parse(args.simulate) as {
      revenueMinor: number;
      currency: string;
      aiRequests: number;
      tokensPerRequest: number;
      inputSharePpm: number;
      inputRateNanoMinorPerToken: string;
      outputRateNanoMinorPerToken: string;
    };
    const result = simulatePlanScenario({
      revenueMinor: input.revenueMinor,
      currency: input.currency,
      aiRequests: input.aiRequests,
      tokensPerRequest: input.tokensPerRequest,
      inputSharePpm: input.inputSharePpm,
      inputRateNanoMinorPerToken: BigInt(input.inputRateNanoMinorPerToken),
      outputRateNanoMinorPerToken: BigInt(input.outputRateNanoMinorPerToken),
    });
    console.log(`\n== ${result.scenario} ==`);
    console.log(`  revenue=${nanoMinorToMajorString(result.revenueNanoMinor)} ${result.currency}`);
    console.log(`  scenarioAiCost=${nanoMinorToMajorString(result.scenarioAiCostNanoMinor)} ${result.currency}`);
    console.log(`  aiContribution=${nanoMinorToMajorString(result.aiContributionNanoMinor)} ${result.currency}`);
    if (result.aiContributionMarginPercent != null) {
      console.log(`  aiContributionMargin=${(result.aiContributionMarginPercent / 10_000).toFixed(2)}%`);
    }
    console.log(`  aiOnlyBreakeven(max AI cost/customer)=${nanoMinorToMajorString(result.aiOnlyBreakevenNanoMinor)} ${result.currency} (§105)`);
    console.log(`  breakevenRequests=${result.breakevenRequests?.toString() ?? "n/a"}`);
  }

  // §72 — CSV export: period/provider/model/plan/currency/tokens/cost/coverage.
  if (args.csv) {
    const records = await db.aiCostRecord.findMany({
      where: { createdAt: { gte: window.from, lt: window.to } },
      select: {
        createdAt: true,
        provider: true,
        model: true,
        planCodeAtUsage: true,
        currency: true,
        inputTokens: true,
        outputTokens: true,
        totalTokens: true,
        costStatus: true,
        costNanoMinor: true,
        tokenStatus: true,
      },
      orderBy: { createdAt: "asc" },
      // §111 — bounded query; raise deliberately if the window is huge.
      take: 200_000,
    });
    const header = "createdAt,provider,model,plan,currency,inputTokens,outputTokens,totalTokens,tokenStatus,costStatus,costNanoMinor,costMajor";
    const lines = records.map((r) =>
      [
        r.createdAt.toISOString(),
        r.provider,
        r.model,
        r.planCodeAtUsage,
        r.currency ?? "",
        r.inputTokens,
        r.outputTokens,
        r.totalTokens,
        r.tokenStatus,
        r.costStatus,
        r.costNanoMinor != null ? r.costNanoMinor.toString() : "",
        r.costNanoMinor != null && r.currency ? nanoMinorToMajorString(r.costNanoMinor) : "",
      ].join(","),
    );
    const { writeFileSync } = await import("node:fs");
    writeFileSync(args.csv, [header, ...lines].join("\n") + "\n", "utf8");
    console.log(`\nCSV exported: ${args.csv} (${records.length} rows — no prompts/responses/secrets, §72)`);
  }

  await db.$disconnect();
}

main().catch(async (error) => {
  console.error("ai-cost-report failed:", error);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
