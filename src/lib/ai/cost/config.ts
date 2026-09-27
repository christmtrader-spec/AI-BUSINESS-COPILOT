/**
 * AI cost governance configuration — Prompt 26 §53/§66/§67/§113.
 *
 * THE single place cost-governance environment variables are read. Fail-safe
 * defaults everywhere:
 * - The COST GUARD is DISABLED by default (§66) and can only block with
 *   verified commercial data — never with fabricated thresholds.
 * - Economics thresholds are configuration-driven (§53/§113), server-side
 *   validated (no NaN/Infinity/negative/overflow — §182).
 * - NO provider rates ever appear here (§126 — configuration status over
 *   fake values).
 */

/** Basis points: 1 bp = 0.01% (exact integer ratio representation). */
export type Bps = number;

export type AiCostConfig = {
  /** Master switch for the request-level cost guard (§66 — default OFF). */
  guardEnabled: boolean;
  /** Guard policy when the monitoring subsystem itself fails (§69). */
  guardFailOpen: boolean;
  /** Max total verified cost (nano-minor, per currency) in the guard window. */
  guardMaxPeriodCostNanoMinor: bigint | null;
  /** Max verified cost per single request (nano-minor). */
  guardMaxRequestCostNanoMinor: bigint | null;
  /** Guard rolling window in days (bounded — never an all-time scan, §189). */
  guardWindowDays: number;
  /** Guard window hard cap in verified cost currency groups evaluated. */
  guardMaxCurrencyGroups: number;
  /** Minimum sample size for plan economics (§53). */
  minEconomicsSampleSize: number;
  /** Minimum cost coverage (basis points, e.g. 8000 = 80%) for economics (§113). */
  minCostCoverageBps: Bps;
  /** Anomaly spike sensitivity: current must exceed baseline × (1 + margin). */
  spikeMarginBps: Bps;
  /** Anomaly scan window (days) — bounded (§189). */
  anomalyWindowDays: number;
  /** Minimum baseline events required before a spike can be claimed (§117). */
  anomalyMinBaselineCount: number;
};

function readIntBps(raw: string | undefined, fallback: Bps, max: Bps): Bps {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > max) return fallback;
  return n;
}

function readNanoMinor(raw: string | undefined): bigint | null {
  if (!raw) return null;
  return toBigIntSafe(raw);
}

function readCount(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function readConfig(env: NodeJS.ProcessEnv = process.env): AiCostConfig {
  const guardEnabled = env.AI_COST_GUARD_ENABLED?.trim().toLowerCase() === "true";
  const guardFailOpen = env.AI_COST_GUARD_FAIL_OPEN?.trim().toLowerCase() !== "false"; // default fail-open (§69)
  return {
    guardEnabled,
    guardFailOpen,
    guardMaxPeriodCostNanoMinor: readNanoMinor(env.AI_COST_GUARD_MAX_PERIOD_COST_NANO_MINOR),
    guardMaxRequestCostNanoMinor: readNanoMinor(env.AI_COST_GUARD_MAX_REQUEST_COST_NANO_MINOR),
    guardWindowDays: readCount(env.AI_COST_GUARD_WINDOW_DAYS, 30, 1, 365),
    guardMaxCurrencyGroups: readCount(env.AI_COST_GUARD_MAX_CURRENCY_GROUPS, 8, 1, 64),
    minEconomicsSampleSize: readCount(env.MIN_ECONOMICS_SAMPLE_SIZE, 30, 1, 1_000_000),
    minCostCoverageBps: readIntBps(env.MIN_COST_COVERAGE_FOR_ECONOMICS, 8000, 10000),
    spikeMarginBps: readIntBps(env.AI_COST_SPIKE_MARGIN_BPS, 10_000, 1_000_000), // default +100%
    anomalyWindowDays: readCount(env.AI_COST_ANOMALY_WINDOW_DAYS, 7, 1, 90),
    anomalyMinBaselineCount: readCount(env.AI_COST_ANOMALY_MIN_BASELINE, 50, 1, 10_000_000),
  };
}

let cached: { at: number; value: AiCostConfig } | null = null;
const CACHE_MS = 15_000;

export function getAiCostConfig(): AiCostConfig {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const value = readConfig();
  cached = { at: now, value };
  return value;
}

/** Test seam — harnesses may clear the cache after manipulating env. */
export function resetAiCostConfigCache(): void {
  cached = null;
}

import { toBigIntSafe } from "./money";
