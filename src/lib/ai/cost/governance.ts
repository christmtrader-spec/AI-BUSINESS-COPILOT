/**
 * AI cost governance — Prompt 26 §64-§74/§117-§124.
 *
 * Conservative anomaly detection + the optional request-level COST GUARD.
 *
 * Non-negotiables:
 * - UNKNOWN cost is neither 0 nor ∞: it can NEVER trigger a block — only a
 *   governance alert (§68).
 * - The guard is configuration-controlled and DISABLED by default (§66);
 *   it may only decide with verified cost data (§67/§71).
 * - Fail-open on monitoring failure (§69/§124): an economics query error
 *   must never become an AI-wide outage.
 * - No automatic suspension of users/businesses/subscriptions ever happens
 *   here (§121/§180) — anomalies are operator signals only.
 * - All scans are bounded by windows and limits (§189).
 */

import { db } from "@/lib/db";
import { getAiCostConfig } from "./config";
import { toBigIntSafe } from "./money";

export type AnomalyType =
  | "SPIKE_USAGE"
  | "SPIKE_TOKENS"
  | "SPIKE_COST"
  | "HIGH_UNKNOWN_RATIO"
  | "RATE_MISSING"
  | "BUSINESS_CONCENTRATION";

export type AnomalySeverity = "INFO" | "WARNING" | "CRITICAL";
export const ANOMALY_STATUSES = ["OPEN", "ACKNOWLEDGED", "RESOLVED"] as const;
export type AnomalyStatus = (typeof ANOMALY_STATUSES)[number];

/** Integer basis-point ratio (1 bp = 0.01%) — no floats. */
function bps(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return 0;
  return Number((numerator * 10_000n + denominator / 2n) / denominator);
}

function severityFor(current: bigint, baseline: bigint): AnomalySeverity {
  // Documented ladder: ≥2× WARNING, ≥5× CRITICAL (vs the configured margin).
  const margin = bps(current - baseline, baseline);
  if (margin >= 40_000) return "CRITICAL"; // 5×
  if (margin >= 10_000) return "WARNING"; // 2×
  return "INFO";
}

/** Persist one anomaly idempotently per (type, window, scope). */
async function emitAnomaly(input: {
  type: AnomalyType;
  severity: AnomalySeverity;
  businessId?: string | null;
  provider?: string | null;
  model?: string | null;
  windowStart: Date;
  windowEnd: Date;
  metric: string;
  baseline: string | null;
  currentValue: string | null;
  status?: AnomalyStatus;
}): Promise<boolean> {
  try {
    const dedupeKey = [
      input.businessId ?? "global",
      input.provider ?? "-",
      input.model ?? "-",
      input.windowStart.toISOString().slice(0, 10),
      input.windowEnd.toISOString().slice(0, 10),
    ].join("|");
    await db.aiCostAnomaly.upsert({
      where: { type_dedupeKey: { type: input.type, dedupeKey } },
      create: { ...input, dedupeKey, status: input.status ?? "OPEN" },
      update: {
        severity: input.severity,
        baseline: input.baseline,
        currentValue: input.currentValue,
        // An existing ACKNOWLEDGED/RESOLVED row is NOT reopened by a
        // re-detection of the same window (operator decision stands).
      },
    });
    return true;
  } catch (error) {
    console.error("[ai-cost] anomaly emission failed:", error);
    return false;
  }
}

export type DetectionReport = {
  windowDays: number;
  baselineInsufficient: boolean;
  anomaliesDetected: number;
  detail: Array<{ type: AnomalyType; severity: AnomalySeverity; metric: string; current: string; baseline: string }>;
};

/**
 * Conservative spike detection: current window vs the PREVIOUS comparable
 * window (§118). Requires a minimum baseline volume (§117) — otherwise the
 * report says INSUFFICIENT history and fabricates nothing.
 */
export async function detectAiCostAnomalies(windowDays?: number): Promise<DetectionReport> {
  const config = getAiCostConfig();
  const days = windowDays ?? config.anomalyWindowDays;
  const now = new Date();
  const curStart = new Date(now.getTime() - days * 86_400_000);
  const prevStart = new Date(curStart.getTime() - days * 86_400_000);

  const report: DetectionReport = { windowDays: days, baselineInsufficient: false, anomaliesDetected: 0, detail: [] };

  // --- volume + tokens + unknown ratio (usage-fact based) ---
  const [curRequests, prevRequests] = await Promise.all([
    db.usageEvent.count({ where: { metric: "AI_REQUESTS", status: "COMMITTED", createdAt: { gte: curStart, lte: now } } }),
    db.usageEvent.count({ where: { metric: "AI_REQUESTS", status: "COMMITTED", createdAt: { gte: prevStart, lt: curStart } } }),
  ]);

  if (prevRequests < config.anomalyMinBaselineCount) {
    report.baselineInsufficient = true;
    return report; // INSUFFICIENT_HISTORY — never fabricate a baseline (§117)
  }

  const curReqB = BigInt(curRequests);
  const prevReqB = BigInt(prevRequests);
  const marginNum = (config.spikeMarginBps / 10_000) * 10_000; // reuse config below

  if (curReqB > prevReqB + (prevReqB * BigInt(config.spikeMarginBps)) / 10_000n) {
    const severity = severityFor(curReqB, prevReqB);
    await emitAnomaly({
      type: "SPIKE_USAGE",
      severity,
      windowStart: curStart,
      windowEnd: now,
      metric: "ai_requests",
      baseline: prevRequests.toString(),
      currentValue: curRequests.toString(),
    });
    report.anomaliesDetected++;
    report.detail.push({ type: "SPIKE_USAGE", severity, metric: "ai_requests", current: curRequests.toString(), baseline: prevRequests.toString() });
  }
  void marginNum;

  // Tokens (from the usage ledger quantities).
  const [curTokens, prevTokens] = await Promise.all([
    db.usageEvent.aggregate({ where: { metric: "AI_TOKENS", status: "COMMITTED", createdAt: { gte: curStart, lte: now } }, _sum: { quantity: true } }),
    db.usageEvent.aggregate({ where: { metric: "AI_TOKENS", status: "COMMITTED", createdAt: { gte: prevStart, lt: curStart } }, _sum: { quantity: true } }),
  ]);
  const curTokB = BigInt(curTokens._sum.quantity ?? 0);
  const prevTokB = BigInt(prevTokens._sum.quantity ?? 0);
  if (prevTokB > 0n && curTokB > prevTokB + (prevTokB * BigInt(config.spikeMarginBps)) / 10_000n) {
    const severity = severityFor(curTokB, prevTokB);
    await emitAnomaly({
      type: "SPIKE_TOKENS",
      severity,
      windowStart: curStart,
      windowEnd: now,
      metric: "ai_tokens",
      baseline: prevTokB.toString(),
      currentValue: curTokB.toString(),
    });
    report.anomaliesDetected++;
    report.detail.push({ type: "SPIKE_TOKENS", severity, metric: "ai_tokens", current: curTokB.toString(), baseline: prevTokB.toString() });
  }

  // Known-cost spike per currency (currencies never mixed — §62).
  const curCost = await db.aiCostRecord.groupBy({
    by: ["currency"],
    where: { costStatus: "KNOWN", createdAt: { gte: curStart, lte: now } },
    _sum: { costNanoMinor: true },
  });
  const prevCost = await db.aiCostRecord.groupBy({
    by: ["currency"],
    where: { costStatus: "KNOWN", createdAt: { gte: prevStart, lt: curStart } },
    _sum: { costNanoMinor: true },
  });
  const prevByCur = new Map(prevCost.map((r) => [r.currency ?? "-", r._sum.costNanoMinor ?? 0n]));
  for (const r of curCost) {
    const cur = r._sum.costNanoMinor ?? 0n;
    const prev = prevByCur.get(r.currency ?? "-") ?? 0n;
    if (prev > 0n && cur > prev + (prev * BigInt(config.spikeMarginBps)) / 10_000n) {
      const severity = severityFor(cur, prev);
      await emitAnomaly({
        type: "SPIKE_COST",
        severity,
        windowStart: curStart,
        windowEnd: now,
        metric: `known_cost_nano_minor:${r.currency ?? "-"}`,
        baseline: prev.toString(),
        currentValue: cur.toString(),
      });
      report.anomaliesDetected++;
      report.detail.push({ type: "SPIKE_COST", severity, metric: `cost:${r.currency}`, current: cur.toString(), baseline: prev.toString() });
    }
  }

  // High unknown-cost ratio (governance ALERT — never a guard block, §68).
  const [knownCount, unknownCount] = await Promise.all([
    db.aiCostRecord.count({ where: { costStatus: "KNOWN", createdAt: { gte: curStart, lte: now } } }),
    db.aiCostRecord.count({ where: { costStatus: "UNKNOWN", createdAt: { gte: curStart, lte: now } } }),
  ]);
  const unknownBps = bps(BigInt(unknownCount), BigInt(knownCount + unknownCount));
  const thresholdBps = Math.min(Math.max(config.minCostCoverageBps, 0), 10_000);
  if (knownCount + unknownCount >= config.anomalyMinBaselineCount && unknownBps > 10_000 - thresholdBps) {
    await emitAnomaly({
      type: "HIGH_UNKNOWN_RATIO",
      severity: "WARNING",
      windowStart: curStart,
      windowEnd: now,
      metric: "unknown_ratio_bps",
      baseline: (10_000 - thresholdBps).toString(),
      currentValue: unknownBps.toString(),
    });
    report.anomaliesDetected++;
    report.detail.push({ type: "HIGH_UNKNOWN_RATIO", severity: "WARNING", metric: "unknown_ratio_bps", current: unknownBps.toString(), baseline: (10_000 - thresholdBps).toString() });
  }

  return report;
}

// ---------------------------------------------------------------------------
// Cost guard (§66-§71) — optional, config-driven, fail-open, verified-data-only
// ---------------------------------------------------------------------------

export type CostGuardDecision = {
  decision: "ALLOW" | "BLOCK";
  reasons: string[];
  /** Always false when the guard is disabled (§66 default). */
  blocked: boolean;
  failOpenTriggered: boolean;
};

/**
 * The ONLY sanctioned request-level cost gate. Call at the AI execution
 * boundary (route pipeline) — never from React (§70). Semantics:
 * - guard disabled → ALLOW (no evaluation, no queries).
 * - verified period/business/request ceilings may BLOCK.
 * - UNKNOWN cost never blocks (§68) — it is an alert, not a number.
 * - internal failure → fail-open (or fail-closed ONLY when explicitly
 *   configured via AI_COST_GUARD_FAIL_OPEN=false, §69).
 */
export async function assertAiCostGuard(params: {
  businessId?: string;
  /** Pre-flight estimate — only usable with a VERIFIED rate (§71). */
  estimatedRequestCostNanoMinor?: bigint;
  currency?: string;
} = {}): Promise<CostGuardDecision> {
  const config = getAiCostConfig();
  const allow: CostGuardDecision = { decision: "ALLOW", reasons: [], blocked: false, failOpenTriggered: false };
  if (!config.guardEnabled) return allow;

  try {
    const reasons: string[] = [];
    const now = new Date();
    const from = new Date(now.getTime() - config.guardWindowDays * 86_400_000);
    const maxCurrencyGroups = config.guardMaxCurrencyGroups;

    // Global verified period cost, per currency (never mixed). Distinct
    // currencies are few in practice — the bound is enforced in JS (Prisma
    // groupBy requires orderBy when take is used).
    const periodAll = await db.aiCostRecord.groupBy({
      by: ["currency"],
      where: { costStatus: "KNOWN", createdAt: { gte: from, lte: now } },
      _sum: { costNanoMinor: true },
    });
    const period = periodAll
      .sort((a, b) => {
        const av = a._sum.costNanoMinor ?? 0n;
        const bv = b._sum.costNanoMinor ?? 0n;
        return bv > av ? 1 : bv < av ? -1 : 0;
      })
      .slice(0, maxCurrencyGroups);
    if (config.guardMaxPeriodCostNanoMinor !== null) {
      const ceiling = config.guardMaxPeriodCostNanoMinor;
      for (const row of period) {
        const total = row._sum.costNanoMinor ?? 0n;
        if (total > ceiling) {
          reasons.push(`PERIOD_COST_CEILING:${row.currency}:${total.toString()}`);
        }
      }
    }

    // Per-business verified period cost.
    if (params.businessId && config.guardMaxPeriodCostNanoMinor !== null) {
      const bizTotal = await db.aiCostRecord.aggregate({
        where: { costStatus: "KNOWN", businessId: params.businessId, createdAt: { gte: from, lte: now } },
        _sum: { costNanoMinor: true },
      });
      const total = bizTotal._sum.costNanoMinor ?? 0n;
      if (total > config.guardMaxPeriodCostNanoMinor) {
        reasons.push(`BUSINESS_COST_CEILING:${total.toString()}`);
      }
    }

    // Request-level ceiling (preflight estimate from a VERIFIED rate only).
    if (
      config.guardMaxRequestCostNanoMinor !== null &&
      params.estimatedRequestCostNanoMinor !== undefined &&
      params.currency
    ) {
      const est = params.estimatedRequestCostNanoMinor;
      if (est > config.guardMaxRequestCostNanoMinor) {
        reasons.push(`REQUEST_COST_CEILING:${params.currency}:${est.toString()}`);
      }
    }

    if (reasons.length > 0) {
      console.error("[ai-cost] GUARD BLOCK:", reasons.join(" · "));
      return { decision: "BLOCK", reasons, blocked: true, failOpenTriggered: false };
    }
    return allow;
  } catch (error) {
    // Monitoring failure (§69/§124): fail open unless explicitly configured
    // to fail closed — analytics must never become an AI outage.
    console.error("[ai-cost] guard monitoring failed:", error);
    if (config.guardFailOpen) {
      return { decision: "ALLOW", reasons: [], blocked: false, failOpenTriggered: true };
    }
    return { decision: "BLOCK", reasons: ["GUARD_MONITORING_FAILED_FAIL_CLOSED"], blocked: true, failOpenTriggered: false };
  }
}

/** Safe big-int serialization helper for guard/anomaly logging (§89). */
export function serializeNanoMinor(value: bigint | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const safe = toBigIntSafe(value);
  return safe === null ? null : safe.toString();
}
