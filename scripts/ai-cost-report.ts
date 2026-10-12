#!/usr/bin/env bun
/**
 * scripts/ai-cost-report.ts — Prompt 26 (§50/§51/§52/§57/§58/§59/§60/§72/§110).
 *
 * P46-API RECOVERY NOTE: rebuilt against the CURRENT src/lib/ai/cost API.
 * - Top-line figures come from getAiCostHealth(windowDays); per-dimension
 *   breakdowns from getAiCostBreakdown(windowDays); UNKNOWN diagnostics from
 *   getUnknownCostGroups(windowDays); plan economics from
 *   getPlanAiEconomics(planCode, billingPeriod, {currency}) (status-gated,
 *   label "AI_CONTRIBUTION" — never "profit").
 * - The old aggregateAiCost / costByProvider-Model-Plan-Business /
 *   getPlanEconomicsReport / getPlanCostExposure / simulatePlanScenario /
 *   utc* helpers no longer exist.
 *   Local pure UTC helpers provide the windows; custom --from/--to windows
 *   (the module is day-window based, §96) are served by bounded read-only
 *   groupBy queries with the SAME documented integer formulas (currencies
 *   never mixed §62; coverage bps = round(known/attributable × 10000) §47).
 * - Money display uses the current primitives: formatNanoMinor (minor-unit
 *   string) and a local pure-integer major-string helper (display ONLY §22).
 * - Exposure (§44/§106) is re-expressed honestly from the CURRENT guard
 *   configuration: without a configured ceiling the exposure stays UNKNOWN;
 *   with one, the per-currency KNOWN totals are shown against it.
 * - --simulate re-expresses the §103-§105 analytical scenario with the
 *   current per-1K money primitives (multiplyRateByTokens/divideBy1000):
 *   pure, labeled ANALYTICAL SCENARIO, never persisted.
 *
 * PLATFORM-SENSITIVE internal operator report (§73): AI usage, KNOWN cost,
 * coverage, observed unit costs — by period/provider/model/plan/business.
 * READ-ONLY (§132): this script never mutates data, never "repairs", never
 * fabricates a number. UNKNOWN cost is reported as UNKNOWN (§18).
 *
 * No raw prompts. No raw AI responses. Business rows are identified by
 * business id (internal tool, §51/§52).
 *
 * Usage (server-only is pulled transitively by the economics/pricing imports
 * — always use the established shim preload):
 *   PRISMA_QUIET=1 bun --preload ./scripts/lib/register-server-only-shim.ts scripts/ai-cost-report.ts \
 *                  [--period today|7d|30d|month|prev-month]
 *                  [--from YYYY-MM-DD --to YYYY-MM-DD]   (UTC dates; exact window, read-only aggregation)
 *                  [--group provider|model|plan|business] (repeatable, default: provider+model+plan)
 *                  [--csv path/to/file.csv]               (§72 export)
 *                  [--economics EUR]                      (§81 plan AI economics, status-gated)
 *                  [--simulate '{"revenueMinor":1900,...}'] (§103/§105 ANALYTICAL SCENARIO, per-1K rates)
 *                  [--exposure]                           (§44/§106 exposure vs configured guard ceiling)
 *
 * Exit codes: 0 ok · 2 usage error.
 */

import { db } from "@/lib/db";
import {
  getAiCostHealth,
  getAiCostBreakdown,
  getUnknownCostGroups,
  getPlanAiEconomics,
  getAiCostConfig,
  multiplyRateByTokens,
  addNanoMinor,
  formatNanoMinor,
  NANO_MINOR_PER_MINOR,
} from "@/lib/ai/cost";
import type { AiCostAggregateRow } from "@/lib/ai/cost/economics";

// ---------------------------------------------------------------------------
// Local pure UTC window helpers (the module no longer exports utc* helpers).
// ---------------------------------------------------------------------------

type CostWindow = { from: Date; to: Date };

function utcDayBounds(now = new Date()): CostWindow {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { from: new Date(start), to: new Date(start + 86_400_000) };
}

/** [today-(days-1) 00:00 UTC, tomorrow 00:00 UTC) — inclusive of today. */
function utcLastDays(days: number, now = new Date()): CostWindow {
  const tomorrow = utcDayBounds(now).to.getTime();
  return { from: new Date(tomorrow - days * 86_400_000), to: new Date(tomorrow) };
}

function utcCalendarMonth(now = new Date()): CostWindow {
  const from = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  return { from: new Date(from), to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
}

function utcPreviousCalendarMonth(now = new Date()): CostWindow {
  const from = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  return { from: new Date(from), to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) };
}

function windowDaysCeil(w: CostWindow): number {
  return Math.max(1, Math.ceil((w.to.getTime() - w.from.getTime()) / 86_400_000));
}

/** Display-only major-units string from nano-minor (pure integer string
 *  manipulation — never accounting, §22; 1 major = 100 minor = 1e8 nano). */
function nanoMinorToMajorString(value: bigint): string {
  if (value < 0n) throw new Error("negative nano-minor value");
  const major = value / 100_000_000n;
  const frac = (value % 100_000_000n).toString().padStart(8, "0");
  return `${major}.${frac}`;
}

/** Integer basis points with ROUND_HALF_UP — the module's documented §47 formula. */
function coverageBps(known: bigint, attributable: bigint): number {
  if (attributable <= 0n) return 0;
  return Number((known * 10_000n + attributable / 2n) / attributable);
}

// ---------------------------------------------------------------------------
// Aggregation — period windows use the module DTOs; custom windows use the
// same bounded, read-only groupBy with the documented formulas.
// ---------------------------------------------------------------------------

type AggRow = {
  key: string;
  knownCostNanoMinorByCurrency: Record<string, string>;
  knownRecords: number;
  unknownRecords: number;
  requests: number;
  tokens: bigint;
  coverageBps: number;
};

function aggregateDim(
  groupBy: "provider" | "model" | "planCodeAtUsage" | "businessId",
  window: CostWindow,
): Promise<AggRow[]> {
  return db.aiCostRecord.groupBy({
    by: [groupBy, "currency", "costStatus"],
    where: { createdAt: { gte: window.from, lt: window.to } },
    _sum: { costNanoMinor: true, totalTokens: true },
    _count: { _all: true },
  }).then((rows) => {
    const map = new Map<string, AggRow>();
    for (const r of rows) {
      const key = r[groupBy] ?? "UNKNOWN";
      let entry = map.get(key);
      if (!entry) {
        entry = { key, knownCostNanoMinorByCurrency: {}, knownRecords: 0, unknownRecords: 0, requests: 0, tokens: 0n, coverageBps: 0 };
        map.set(key, entry);
      }
      entry.requests += r._count._all;
      if (r.costStatus === "KNOWN") {
        entry.knownRecords += r._count._all;
        if (r.currency) {
          const prev = BigInt(entry.knownCostNanoMinorByCurrency[r.currency] ?? "0");
          entry.knownCostNanoMinorByCurrency[r.currency] = (prev + (r._sum.costNanoMinor ?? 0n)).toString();
        }
      } else {
        entry.unknownRecords += r._count._all;
      }
      if (r._sum.totalTokens) entry.tokens += BigInt(r._sum.totalTokens);
    }
    const out = [...map.values()];
    for (const row of out) row.coverageBps = coverageBps(BigInt(row.knownRecords), BigInt(row.knownRecords + row.unknownRecords));
    return out.sort((a, b) => b.requests - a.requests);
  });
}

function toAggRows(rows: AiCostAggregateRow[]): AggRow[] {
  return rows.map((r) => ({ ...r }));
}

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

function currencyCostString(byCurrency: Record<string, string>): string {
  const currencies = Object.keys(byCurrency);
  return currencies.length > 0
    ? currencies.map((c) => `${c} ${nanoMinorToMajorString(BigInt(byCurrency[c]))}`).join(" + ")
    : "UNKNOWN";
}

function printAggregates(label: string, rows: AggRow[]) {
  console.log(`\n== ${label} ==`);
  if (rows.length === 0) {
    console.log("  (no cost records in window)");
    return;
  }
  for (const row of rows) {
    console.log(
      `  ${row.key}: requests=${row.requests} records=${row.knownRecords + row.unknownRecords} (known=${row.knownRecords}, unknown=${row.unknownRecords}) coverage=${row.coverageBps}bps knownCost=${currencyCostString(row.knownCostNanoMinorByCurrency)}`,
    );
    // Observed unit cost per KNOWN record, per currency (never mixed, §38).
    for (const [c, total] of Object.entries(row.knownCostNanoMinorByCurrency)) {
      const knownB = BigInt(row.knownRecords);
      if (knownB > 0n) {
        const perReq = BigInt(total) / knownB; // floor — KNOWN sample only (§38)
        console.log(`      observedKnownCost/request (${c}): ${nanoMinorToMajorString(perReq)}`);
      }
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
  const days = windowDaysCeil(window);
  console.log(`AI COST REPORT (read-only) — window UTC ${window.from.toISOString()} → ${window.to.toISOString()} (≈${days}d)`);

  if (!args.from || !args.to) {
    // Period mode — the module's day-window DTOs are the operator surface.
    const health = await getAiCostHealth(days);
    console.log(`\n== Usage (authoritative UsageEvent, COMMITTED) ==`);
    console.log(`  completeTokenUsageEvents=${health.completeTokenUsageEvents}  attributableCostRecords=${health.aiUsageEvents} (documented 1:1 projection §48)`);
    console.log(`\n== Cost ledger (AiCostRecord) ==`);
    console.log(
      `  records=${health.knownRecords + health.unknownRecords} known=${health.knownRecords} unknown=${health.unknownRecords}`,
    );
    console.log(
      `  costCoverage=${health.costCoverageBps}bps tokenCoverage=${health.tokenCoverageBps}bps (unknown share is NEVER zero-filled, §37)`,
    );
    const currencies = Object.keys(health.knownCostNanoMinorByCurrency);
    if (currencies.length === 0) {
      console.log("  knownCost: UNKNOWN (no verified provider rate configured — a valid state, §122)");
    } else {
      for (const c of currencies) {
        console.log(`  knownCost(${c})=${nanoMinorToMajorString(BigInt(health.knownCostNanoMinorByCurrency[c]))} nano-minor`);
      }
    }
    console.log(`  rates: verified=${health.verifiedRates} unverified=${health.unverifiedRates} · openAnomalies=${health.openAnomalies} · guard=${health.guardStatus}`);

    const breakdown = await getAiCostBreakdown(days);
    const groups = args.groups.length > 0 ? args.groups : ["provider", "model", "plan"];
    for (const g of groups) {
      if (g === "provider") printAggregates("By provider", toAggRows(breakdown.byProvider));
      else if (g === "model") printAggregates("By model", toAggRows(breakdown.byModel));
      else if (g === "plan") printAggregates("By plan at usage (§53/§54)", toAggRows(breakdown.byPlan));
      else if (g === "business") printAggregates("By business (§51/§52 — internal only)", toAggRows(breakdown.byBusiness));
      else throw new Error(`unknown --group ${g}`);
    }

    const unknownGroups = await getUnknownCostGroups(days);
    if (unknownGroups.groups.length > 0) {
      console.log(`\n== UNKNOWN-cost groups (top ${unknownGroups.groups.length}, §49) ==`);
      for (const g of unknownGroups.groups.slice(0, 20)) {
        console.log(`  ${g.provider} / ${g.model} / reason=${g.reason ?? "-"} / plan=${g.planCode} / business=${g.businessId}: ${g.count}`);
      }
    }
  } else {
    // Custom exact window — bounded read-only aggregation with the same
    // documented formulas (module DTOs are day-window based, §96).
    console.log("  (exact --from/--to window: bounded read-only aggregation, module day-window DTOs not applicable)");
    const totals = await db.aiCostRecord.groupBy({
      by: ["currency", "costStatus"],
      where: { createdAt: { gte: window.from, lt: window.to } },
      _sum: { costNanoMinor: true, totalTokens: true },
      _count: { _all: true },
    });
    let known = 0;
    let unknown = 0;
    const knownByCurrency: Record<string, bigint> = {};
    for (const r of totals) {
      if (r.costStatus === "KNOWN") {
        known += r._count._all;
        if (r.currency) knownByCurrency[r.currency] = (knownByCurrency[r.currency] ?? 0n) + (r._sum.costNanoMinor ?? 0n);
      } else {
        unknown += r._count._all;
      }
    }
    console.log(`\n== Cost ledger (AiCostRecord) ==`);
    console.log(`  records=${known + unknown} known=${known} unknown=${unknown} costCoverage=${coverageBps(BigInt(known), BigInt(known + unknown))}bps`);
    const currencies = Object.keys(knownByCurrency);
    if (currencies.length === 0) {
      console.log("  knownCost: UNKNOWN (no verified provider rate configured — a valid state, §122)");
    } else {
      for (const c of currencies) console.log(`  knownCost(${c})=${nanoMinorToMajorString(knownByCurrency[c])} nano-minor`);
    }

    const groups = args.groups.length > 0 ? args.groups : ["provider", "model", "plan"];
    for (const g of groups) {
      const dim = g === "plan" ? "planCodeAtUsage" : g === "business" ? "businessId" : (g as "provider" | "model");
      if (g !== "provider" && g !== "model" && g !== "plan" && g !== "business") throw new Error(`unknown --group ${g}`);
      printAggregates(g === "plan" ? "By plan at usage (§53/§54)" : g === "business" ? "By business (§51/§52 — internal only)" : `By ${g}`, await aggregateDim(dim, window));
    }
  }

  // §81 — plan AI economics, status-gated, labeled AI_CONTRIBUTION (§43).
  if (args.economics) {
    const currency = args.economics.trim().toUpperCase();
    console.log(`\n== Plan AI economics (revenue currency ${currency}, PricingService-authoritative, §34) ==`);
    const plans = await db.plan.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" }, select: { code: true } });
    for (const plan of plans) {
      for (const period of ["MONTHLY", "YEARLY"] as const) {
        const row = await getPlanAiEconomics(plan.code, period, { currency, windowDays: days });
        const priceStr =
          row.priceMinor != null && row.priceCurrency != null
            ? formatNanoMinor(BigInt(row.priceMinor) * NANO_MINOR_PER_MINOR)
            : "UNKNOWN (not purchasable / no book)";
        console.log(
          `  ${row.planCode} (${row.billingPeriod}): status=${row.status} price=${priceStr} sample=${row.sampleSize} costCoverage=${row.costCoverageBps}bps`,
        );
        const costEntries = Object.entries(row.knownCostNanoMinorByCurrency);
        if (costEntries.length > 0) {
          console.log(`    knownAiCost (NO FX across currencies, §32): ${costEntries.map(([c, v]) => `${c} ${nanoMinorToMajorString(BigInt(v))}`).join(", ")}`);
        }
        if (row.status === "COMPARABLE") {
          console.log(
            `    aiContribution=${row.contributionMinor} ${row.costCurrency} minor · aiContributionMargin=${row.contributionMarginBps}bps · negative=${row.negativeContribution}`,
          );
        }
        console.log(`    [${row.label} — never net/company profit, §51/§115]`);
      }
    }
  }

  // §44/§106 — plan cost exposure (UNKNOWN unless a safe ceiling is configured).
  if (args.exposure) {
    console.log(`\n== Plan cost exposure (§44/§106 — UNKNOWN unless a safe ceiling is configured) ==`);
    const config = getAiCostConfig();
    const ceiling = config.guardMaxPeriodCostNanoMinor;
    const plans = await db.plan.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" }, select: { code: true } });
    const planRows = await db.aiCostRecord.groupBy({
      by: ["planCodeAtUsage", "currency"],
      where: { costStatus: "KNOWN", createdAt: { gte: window.from, lt: window.to } },
      _sum: { costNanoMinor: true },
    });
    for (const plan of plans) {
      const rows = planRows.filter((r) => r.planCodeAtUsage === plan.code);
      const knownStr =
        rows.length > 0
          ? rows.map((r) => `${r.currency ?? "-"} ${nanoMinorToMajorString(r._sum.costNanoMinor ?? 0n)}`).join(" + ")
          : "none observed";
      if (ceiling === null) {
        console.log(`  ${plan.code}: UNKNOWN (no AI_COST_GUARD_MAX_PERIOD_COST_NANO_MINOR configured — never invented, §106). Known in window: ${knownStr}`);
      } else {
        console.log(`  ${plan.code}: ceiling=${ceiling.toString()} nano-minor (guard window ${config.guardWindowDays}d). Known in window: ${knownStr}`);
      }
    }
  }

  // §103/§104/§105 — analytical scenario, clearly labeled, never persisted.
  // Re-expressed with the current per-1K money primitives (the module's
  // simulatePlanScenario no longer exists): every product is a single final
  // ROUND_HALF_UP in integers — no floats anywhere (§19/§20).
  if (args.simulate) {
    const input = JSON.parse(args.simulate) as {
      revenueMinor: number;
      currency: string;
      aiRequests: number;
      tokensPerRequest: number;
      inputSharePpm: number;
      inputRateNanoMinorPer1K: string;
      outputRateNanoMinorPer1K: string;
    };
    if (
      !Number.isSafeInteger(input.revenueMinor) ||
      input.revenueMinor < 0 ||
      !Number.isSafeInteger(input.aiRequests) ||
      input.aiRequests < 0 ||
      !Number.isSafeInteger(input.tokensPerRequest) ||
      input.tokensPerRequest < 0 ||
      !Number.isSafeInteger(input.inputSharePpm) ||
      input.inputSharePpm < 0 ||
      input.inputSharePpm > 1_000_000
    ) {
      console.error("invalid --simulate input (safe non-negative integers required, inputSharePpm ≤ 1e6)");
      process.exit(2);
    }
    // Token split must be EXACT for the scenario to be honest: integer floor
    // on the input share, output = remainder (the two always sum to the
    // requested tokensPerRequest — nothing invented).
    const inTokens = (BigInt(input.tokensPerRequest) * BigInt(input.inputSharePpm)) / 1_000_000n;
    const outTokens = BigInt(input.tokensPerRequest) - inTokens;
    const perRequestCost = addNanoMinor(
      multiplyRateByTokens(inTokens, BigInt(input.inputRateNanoMinorPer1K)),
      multiplyRateByTokens(outTokens, BigInt(input.outputRateNanoMinorPer1K)),
    );
    const scenarioAiCostNanoMinor = perRequestCost * BigInt(input.aiRequests);
    const revenueNanoMinor = BigInt(input.revenueMinor) * NANO_MINOR_PER_MINOR;
    const contribution = revenueNanoMinor - scenarioAiCostNanoMinor; // may be negative
    console.log(`\n== ANALYTICAL SCENARIO (§103/§104 — hypothetical input, NEVER persisted) ==`);
    console.log(`  revenue=${nanoMinorToMajorString(revenueNanoMinor)} ${input.currency} (${input.revenueMinor} minor)`);
    console.log(`  tokensPerRequest=${input.tokensPerRequest} (in ${inTokens} / out ${outTokens} @ inputSharePpm=${input.inputSharePpm})`);
    console.log(`  scenarioAiCost=${nanoMinorToMajorString(scenarioAiCostNanoMinor)} ${input.currency} (${input.aiRequests} × ${nanoMinorToMajorString(perRequestCost)})`);
    console.log(`  aiContribution=${contribution < 0n ? "-" : ""}${nanoMinorToMajorString(contribution < 0n ? -contribution : contribution)} ${input.currency} (AI-ONLY, never net profit §105)`);
    console.log(`  aiOnlyBreakeven(max AI cost/customer)=${nanoMinorToMajorString(revenueNanoMinor)} ${input.currency} (§105)`);
    if (perRequestCost > 0n) {
      console.log(`  breakevenRequests=${(revenueNanoMinor / perRequestCost).toString()} (floor, per-request cost ${perRequestCost.toString()} nano-minor)`);
    } else {
      console.log(`  breakevenRequests=n/a (zero per-request cost)`);
    }
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
    const header = "createdAt,provider,model,plan,currency,inputTokens,outputTokens,totalTokens,tokenStatus,costStatus,costNanoMinor,costMinor";
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
        r.costNanoMinor != null ? formatNanoMinor(r.costNanoMinor) : "",
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
