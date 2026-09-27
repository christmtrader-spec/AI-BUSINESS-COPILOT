/**
 * AI cost economics — Prompt 26 §46-§62/§112-§117.
 *
 * Aggregations over the AiCostRecord ledger + CONTRIBUTION economics per
 * plan. Hard rules:
 * - Currencies are NEVER summed across codes (§62): totals are per-currency
 *   maps; "EUR known cost + USD known cost" as one figure is impossible by
 *   construction.
 * - Coverage semantics are explicit and documented (§47/§48) — cost coverage
 *   is known cost RECORDS / attributable cost RECORDS; token coverage is
 *   complete-token usage events / AI usage events. Never mixed.
 * - Margin is computed in INTEGER basis points — no floating point (§191).
 * - Every plan economics result carries a STATUS; misleading numerics are
 *   null when the status says so (§52/§155).
 * - This is AI CONTRIBUTION (price − known AI cost), NEVER net/company
 *   profit (§51/§115) — salaries, servers, support, tax, marketing, FX and
 *   payment fees are not modeled.
 * - All reads are bounded by an explicit window (§96) and paginated where
 *   list-shaped (§95).
 */

import { db } from "@/lib/db";
import { getAiCostConfig } from "./config";
import { resolvePrice } from "@/lib/payments/pricing-service";
import { defaultSettlementCurrency } from "@/lib/payments/config";
import type { BillingPeriod } from "@/lib/billing/state-machine";

/** Exact basis-point ratio: round(numerator/denominator × 10000). */
function bps(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return 0;
  // Integer ROUND_HALF_UP to the nearest basis point.
  const scaled = (numerator * 10_000n + denominator / 2n) / denominator;
  return Number(scaled); // scale is ≤10000 — safe for Number (a count, not money)
}

function windowBounds(windowDays: number): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date(to.getTime() - windowDays * 86_400_000);
  return { from, to };
}

// ---------------------------------------------------------------------------
// Cost health (§112) — the honest top-line summary
// ---------------------------------------------------------------------------

export type AiCostHealthDTO = {
  windowDays: number;
  window: { from: string; to: string };
  /** Per-currency KNOWN totals (string nano-minor — never mixed, §62). */
  knownCostNanoMinorByCurrency: Record<string, string>;
  knownRecords: number;
  unknownRecords: number;
  attributableRecords: number;
  /** knownRecords / attributableRecords in basis points (explicit formula §47). */
  costCoverageBps: number;
  /** Complete-token usage events / AI usage events (explicit formula §48). */
  tokenCoverageBps: number;
  completeTokenUsageEvents: number;
  aiUsageEvents: number;
  verifiedRates: number;
  unverifiedRates: number;
  openAnomalies: number;
  /** "DISABLED" | "ENABLED" — the guard's configuration state, not a value. */
  guardStatus: "DISABLED" | "ENABLED";
  /** Honest economics availability per plan is separate (§114). */
};

export async function getAiCostHealth(windowDays = 30): Promise<AiCostHealthDTO> {
  const config = getAiCostConfig();
  const { from, to } = windowBounds(windowDays);

  const [byStatus, tokenAgg, rateCounts, openAnomalies] = await Promise.all([
    db.aiCostRecord.groupBy({
      by: ["costStatus"],
      where: { createdAt: { gte: from, lte: to } },
      _count: { _all: true },
    }),
    db.aiCostRecord.groupBy({
      by: ["tokenStatus"],
      where: { createdAt: { gte: from, lte: to } },
      _count: { _all: true },
    }),
    db.aiCostRate.groupBy({
      by: ["environment"],
      where: { active: true },
      _count: { _all: true },
    }),
    db.aiCostAnomaly.count({ where: { status: "OPEN" } }),
  ]);

  // Per-currency KNOWN totals via a bounded grouped query (no N+1, §151).
  const knownByCurrencyRows = await db.aiCostRecord.groupBy({
    by: ["currency"],
    where: { costStatus: "KNOWN", createdAt: { gte: from, lte: to }, currency: { not: null } },
    _sum: { costNanoMinor: true },
  });

  const knownRecords = byStatus.find((r) => r.costStatus === "KNOWN")?._count._all ?? 0;
  const unknownRecords = byStatus.find((r) => r.costStatus === "UNKNOWN")?._count._all ?? 0;
  const attributableRecords = knownRecords + unknownRecords;

  // Token coverage (§48): every ACCEPTED AI request carries exactly one
  // attributable cost record (the ledger is a 1:1 projection of committed
  // AI_REQUESTS usage events), so the documented denominator is ALL
  // attributable cost records — complete-token records / attributable
  // records. Never mixed with cost coverage (also records/records).
  const completeTokenUsage = await db.aiCostRecord.count({
    where: { tokenStatus: "COMPLETE", createdAt: { gte: from, lte: to } },
  });
  const aiUsageEvents = attributableRecords; // documented 1:1 projection

  const knownCostNanoMinorByCurrency: Record<string, string> = {};
  for (const row of knownByCurrencyRows) {
    if (!row.currency) continue;
    knownCostNanoMinorByCurrency[row.currency] = (row._sum.costNanoMinor ?? 0n).toString();
  }

  const prodRates = rateCounts.find((r) => r.environment === "PRODUCTION")?._count._all ?? 0;
  const verified = await db.aiCostRate.count({
    where: { active: true, environment: "PRODUCTION", verifiedAt: { not: null }, verifiedBy: { not: null }, sourceReference: { not: null } },
  });

  return {
    windowDays,
    window: { from: from.toISOString(), to: to.toISOString() },
    knownCostNanoMinorByCurrency,
    knownRecords,
    unknownRecords,
    attributableRecords,
    costCoverageBps: bps(BigInt(knownRecords), BigInt(attributableRecords)),
    tokenCoverageBps: bps(BigInt(completeTokenUsage), BigInt(aiUsageEvents)),
    completeTokenUsageEvents: completeTokenUsage,
    aiUsageEvents,
    verifiedRates: verified,
    unverifiedRates: prodRates - verified,
    openAnomalies,
    guardStatus: config.guardEnabled ? "ENABLED" : "DISABLED",
  };
}

// ---------------------------------------------------------------------------
// Aggregations (§46/§58-§61) — bounded, per-dimension, internal only
// ---------------------------------------------------------------------------

export type AiCostAggregateRow = {
  key: string;
  knownCostNanoMinorByCurrency: Record<string, string>;
  knownRecords: number;
  unknownRecords: number;
  requests: number;
  tokens: bigint;
  coverageBps: number;
};

async function aggregate(
  groupBy: "provider" | "model" | "planCodeAtUsage" | "businessId",
  from: Date,
  to: Date,
): Promise<AiCostAggregateRow[]> {
  const rows = await db.aiCostRecord.groupBy({
    by: [groupBy, "currency", "costStatus"],
    where: { createdAt: { gte: from, lte: to } },
    _sum: { costNanoMinor: true, totalTokens: true },
    _count: { _all: true },
  });

  const map = new Map<string, AiCostAggregateRow>();
  for (const r of rows) {
    const key = r[groupBy] ?? "UNKNOWN";
    let entry = map.get(key);
    if (!entry) {
      entry = {
        key,
        knownCostNanoMinorByCurrency: {},
        knownRecords: 0,
        unknownRecords: 0,
        requests: 0,
        tokens: 0n,
        coverageBps: 0,
      };
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
  for (const row of out) {
    row.coverageBps = bps(BigInt(row.knownRecords), BigInt(row.knownRecords + row.unknownRecords));
  }
  return out.sort((a, b2) => b2.requests - a.requests);
}

export type AiCostBreakdownDTO = {
  windowDays: number;
  window: { from: string; to: string };
  byProvider: AiCostAggregateRow[];
  byModel: AiCostAggregateRow[];
  byPlan: AiCostAggregateRow[];
  byBusiness: AiCostAggregateRow[];
};

/** Internal operator aggregation — NEVER serialized through tenant APIs. */
export async function getAiCostBreakdown(windowDays = 30): Promise<AiCostBreakdownDTO> {
  const { from, to } = windowBounds(windowDays);
  const [byProvider, byModel, byPlan, byBusiness] = await Promise.all([
    aggregate("provider", from, to),
    aggregate("model", from, to),
    aggregate("planCodeAtUsage", from, to),
    aggregate("businessId", from, to),
  ]);
  return { windowDays, window: { from: from.toISOString(), to: to.toISOString() }, byProvider, byModel, byPlan, byBusiness };
}

// ---------------------------------------------------------------------------
// UNKNOWN-cost diagnostic dataset (§49) — internal only, grouped, bounded
// ---------------------------------------------------------------------------

export type UnknownCostGroupDTO = {
  windowDays: number;
  groups: Array<{
    provider: string;
    model: string;
    reason: string | null;
    planCode: string;
    businessId: string;
    count: number;
  }>;
};

export async function getUnknownCostGroups(windowDays = 30): Promise<UnknownCostGroupDTO> {
  const { from, to } = windowBounds(windowDays);
  const rows = await db.aiCostRecord.groupBy({
    by: ["provider", "model", "unknownReason", "planCodeAtUsage", "businessId"],
    where: { costStatus: "UNKNOWN", createdAt: { gte: from, lte: to } },
    _count: { _all: true },
  });
  return {
    windowDays,
    groups: rows
      .map((r) => ({
        provider: r.provider,
        model: r.model,
        reason: r.unknownReason,
        planCode: r.planCodeAtUsage,
        businessId: r.businessId,
        count: r._count._all,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 200),
  };
}

// ---------------------------------------------------------------------------
// Plan economics (§50-§57/§114-§116) — status-gated, integer math
// ---------------------------------------------------------------------------

export type EconomicsStatus =
  | "COMPARABLE"
  | "NOT_COMPARABLE_CURRENCY"
  | "COST_UNKNOWN"
  | "PRICE_UNKNOWN"
  | "INSUFFICIENT_SAMPLE";

export type AIEconomicsDTO = {
  planCode: string;
  billingPeriod: BillingPeriod;
  status: EconomicsStatus;
  /** null unless the status permits honest numerics (§155). */
  priceMinor: number | null;
  priceCurrency: string | null;
  /** Known-cost total per currency (strings) — never cross-currency sums. */
  knownCostNanoMinorByCurrency: Record<string, string>;
  /** Dominant (single) cost currency when unambiguous, else null. */
  costCurrency: string | null;
  /** price − known attributable AI cost, in the SAME currency (§167). */
  contributionMinor: number | null;
  /** contribution / price in integer basis points — no floats (§191). */
  contributionMarginBps: number | null;
  sampleSize: number;
  costCoverageBps: number;
  negativeContribution: boolean;
  /** Honest label — the caller must display "AI contribution", not profit. */
  label: "AI_CONTRIBUTION";
};

/**
 * AI contribution economics for ONE plan + billing period.
 *
 * Gate order (§114):
 *   1. price resolvable via PricingService (else PRICE_UNKNOWN)
 *   2. sample ≥ MIN_ECONOMICS_SAMPLE_SIZE (else INSUFFICIENT_SAMPLE)
 *   3. cost coverage ≥ MIN_COST_COVERAGE_FOR_ECONOMICS (else COST_UNKNOWN)
 *      — with unknowns present, known-cost economics are still reported but
 *      explicitly flagged COST_UNKNOWN (§55)
 *   4. price currency == cost currency (else NOT_COMPARABLE_CURRENCY §167)
 */
export async function getPlanAiEconomics(
  planCode: string,
  billingPeriod: BillingPeriod,
  opts: { windowDays?: number; currency?: string } = {},
): Promise<AIEconomicsDTO> {
  const config = getAiCostConfig();
  const windowDays = opts.windowDays ?? (billingPeriod === "YEARLY" ? 365 : 30);
  const { from, to } = windowBounds(windowDays);

  const base: AIEconomicsDTO = {
    planCode,
    billingPeriod,
    status: "PRICE_UNKNOWN",
    priceMinor: null,
    priceCurrency: null,
    knownCostNanoMinorByCurrency: {},
    costCurrency: null,
    contributionMinor: null,
    contributionMarginBps: null,
    sampleSize: 0,
    costCoverageBps: 0,
    negativeContribution: false,
    label: "AI_CONTRIBUTION",
  };

  // 1. Price — ALWAYS from PricingService (§56), real stored rows (§57).
  let priceMinor: number | null = null;
  let priceCurrency: string | null = null;
  try {
    const resolved = await resolvePrice({
      planCode,
      billingPeriod,
      currency: opts.currency ?? defaultSettlementCurrency(),
    });
    priceMinor = resolved.amountMinor;
    priceCurrency = resolved.currency;
  } catch {
    return { ...base, status: "PRICE_UNKNOWN" };
  }

  // Cost records for this plan snapshot within the window.
  const rows = await db.aiCostRecord.groupBy({
    by: ["currency", "costStatus"],
    where: { planCodeAtUsage: planCode, createdAt: { gte: from, lte: to } },
    _sum: { costNanoMinor: true },
    _count: { _all: true },
  });

  let known = 0;
  let unknown = 0;
  const knownByCurrency = new Map<string, bigint>();
  for (const r of rows) {
    if (r.costStatus === "KNOWN") {
      known += r._count._all;
      if (r.currency) {
        const prev = knownByCurrency.get(r.currency) ?? 0n;
        knownByCurrency.set(r.currency, prev + (r._sum.costNanoMinor ?? 0n));
      }
    } else {
      unknown += r._count._all;
    }
  }
  const sampleSize = known + unknown;
  const coverageBps = bps(BigInt(known), BigInt(sampleSize));
  const knownCostNanoMinorByCurrency: Record<string, string> = {};
  for (const [cur, val] of knownByCurrency) knownCostNanoMinorByCurrency[cur] = val.toString();

  // 2. Sample threshold (§53/§54) — no fake 0%/100% display.
  if (sampleSize < config.minEconomicsSampleSize) {
    return {
      ...base,
      status: "INSUFFICIENT_SAMPLE",
      priceMinor,
      priceCurrency,
      knownCostNanoMinorByCurrency,
      sampleSize,
      costCoverageBps: coverageBps,
    };
  }

  // 3. Coverage threshold (§113) — below it the cost side is not trustworthy.
  if (coverageBps < config.minCostCoverageBps) {
    return {
      ...base,
      status: "COST_UNKNOWN",
      priceMinor,
      priceCurrency,
      knownCostNanoMinorByCurrency,
      sampleSize,
      costCoverageBps: coverageBps,
    };
  }

  // 4. Currency comparability (§167) — exactly one cost currency, equal to
  // the price currency. Mixed currencies are never compared.
  const currencies = [...knownByCurrency.keys()];
  if (currencies.length !== 1 || currencies[0] !== priceCurrency) {
    return {
      ...base,
      status: "NOT_COMPARABLE_CURRENCY",
      priceMinor,
      priceCurrency,
      knownCostNanoMinorByCurrency,
      sampleSize,
      costCoverageBps: coverageBps,
    };
  }

  const costNanoMinor = knownByCurrency.get(currencies[0]) ?? 0n;
  const priceNanoMinor = BigInt(priceMinor) * 1_000_000n; // minor → nano-minor (exact)
  const negative = costNanoMinor > priceNanoMinor;
  const contributionNanoMinor = priceNanoMinor - costNanoMinor; // may be negative
  // Convert nano-minor → minor with documented ROUND_HALF_UP (integer).
  const contributionMinorRaw =
    (contributionNanoMinor < 0n ? -1n : 1n) *
    ((contributionNanoMinor < 0n ? -contributionNanoMinor : contributionNanoMinor) + 500_000n) /
    1_000_000n;
  const contributionMinor = Number(contributionMinorRaw); // scale-safe: ≤ priceMinor magnitude
  // margin = contribution / price — integer basis points, half-up.
  const marginBps = bps(
    contributionNanoMinor < 0n ? -contributionNanoMinor : contributionNanoMinor,
    priceNanoMinor,
  ) * (contributionNanoMinor < 0n ? -1 : 1);

  return {
    ...base,
    status: "COMPARABLE",
    priceMinor,
    priceCurrency,
    knownCostNanoMinorByCurrency,
    costCurrency: currencies[0],
    contributionMinor,
    contributionMarginBps: marginBps,
    sampleSize,
    costCoverageBps: coverageBps,
    negativeContribution: negative || contributionMinor < 0,
  };
}
