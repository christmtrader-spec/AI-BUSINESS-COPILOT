/**
 * AI cost ledger — Prompt 26 §28-§31/§41-§45.
 *
 * attributeAiCost(): the ONLY writer of AiCostRecord. Consumes
 * provider-independent, normalized usage facts (the Prompt 21 ledger stays
 * the sole quota authority — §79) and attaches an honest cost state:
 *
 *   KNOWN   → costNanoMinor set (BigInt, exact arithmetic, rate snapshot)
 *   UNKNOWN → costNanoMinor NULL + stable unknownReason (NEVER 0, §163)
 *
 * FAILURE BOUNDARY (§29/§30): attribution NEVER throws into the AI response
 * path — a failure after a successful AI response is logged and the usage
 * remains recorded (reconciliation can visit it later, §41).
 *
 * IDEMPOTENCY (§15/§31): unique (usageEventId) and (businessId, requestId);
 * a replayed attribution returns the existing record without mutation.
 */

import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { getAiCostConfig } from "./config";
import {
  computeCostNanoMinor,
  resolveAiCostRate,
  UNKNOWN_MODEL,
  type AiCostEnvironment,
} from "./rates";
import { toBigIntSafe } from "./money";

export const TOKEN_STATUSES = ["COMPLETE", "PARTIAL", "TOTAL_ONLY", "NONE"] as const;
export type TokenStatus = (typeof TOKEN_STATUSES)[number];

export const COST_STATUSES = ["KNOWN", "UNKNOWN"] as const;
export type CostStatus = (typeof COST_STATUSES)[number];

export const UNKNOWN_REASONS = [
  "RATE_NOT_FOUND",
  "MODEL_UNKNOWN",
  "TOKENS_MISSING",
  "PARTIAL_TOKEN_DATA",
  "CURRENCY_NOT_CONFIGURED",
  "PROVIDER_NOT_CONFIGURED",
  "ENVIRONMENT_MISMATCH",
  "RATE_NOT_VERIFIED",
  "AMBIGUOUS_RATE",
] as const;
export type UnknownReason = (typeof UNKNOWN_REASONS)[number];

/** Normalized provider-independent token shape (§37). */
export type NormalizedTokenUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export type AttributeAiCostInput = {
  businessId: string;
  requestId: string;
  provider: string | null;
  model: string | null;
  usage: NormalizedTokenUsage | null;
  usagePeriodId?: string | null;
  /** Attribution environment — resolved from config when omitted. */
  environment?: AiCostEnvironment;
  /** Defaults to now(); injectable for deterministic tests. */
  usageTimestamp?: Date;
  /** Optional pinned pricing currency (disambiguates multi-currency rates). */
  currency?: string;
};

export type AttributeAiCostResult =
  | { outcome: "KNOWN"; recordId: string; costNanoMinor: bigint; currency: string; rateVersion: string }
  | { outcome: "UNKNOWN"; recordId: string; reason: UnknownReason }
  | { outcome: "NO_USAGE_EVENT" } // released/failed operation → no cost (§108)
  | { outcome: "ALREADY_KNOWN"; recordId: string }
  | { outcome: "ALREADY_UNKNOWN"; recordId: string; reason: string | null }
  | { outcome: "FAILED"; error: string }; // logged, never thrown (§29)

/** Derive the honest token status (§16/§38). */
export function deriveTokenStatus(u: NormalizedTokenUsage | null): TokenStatus {
  if (!u) return "NONE";
  const { inputTokens, outputTokens, totalTokens } = u;
  const hasSplit = inputTokens !== null && outputTokens !== null;
  if (hasSplit) return "COMPLETE";
  if (inputTokens !== null || outputTokens !== null) return "PARTIAL";
  if (totalTokens !== null) return "TOTAL_ONLY";
  return "NONE";
}

/**
 * Runtime attribution environment: explicit AI_COST_ENVIRONMENT wins;
 * otherwise PRODUCTION in production-like runtimes, TEST in development
 * (TEST and PRODUCTION rate domains stay completely separate, §6).
 */
export function attributionEnvironment(): AiCostEnvironment {
  const raw = process.env.AI_COST_ENVIRONMENT?.trim().toUpperCase();
  if (raw === "PRODUCTION" || raw === "TEST") return raw;
  return process.env.NODE_ENV === "production" ? "PRODUCTION" : "TEST";
}

/** The committed AI_REQUESTS event is the authoritative usage anchor. */
async function findAnchorUsageEvent(businessId: string, requestId: string) {
  return db.usageEvent.findFirst({
    where: { businessId, requestId, metric: "AI_REQUESTS", status: "COMMITTED" },
    select: { id: true, usagePeriodId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
}

async function planCodeAtUsage(businessId: string): Promise<string> {
  const sub = await db.subscription.findUnique({
    where: { businessId },
    include: { plan: { select: { code: true } } },
  });
  if (!sub) return "FREE";
  // Lazy trial expiry honesty: a TRIALING row past trialEnd behaves as FREE.
  if (
    sub.status === "TRIALING" &&
    sub.trialEnd &&
    sub.trialEnd.getTime() <= Date.now()
  ) {
    return "FREE";
  }
  return sub.plan.code;
}

/**
 * Attribute the cost of ONE accepted AI operation. Safe to call after every
 * successful provider response; also safe to call speculatively — a
 * released/absent usage event produces NO cost record (§108).
 */
export async function attributeAiCost(input: AttributeAiCostInput): Promise<AttributeAiCostResult> {
  try {
    const anchor = await findAnchorUsageEvent(input.businessId, input.requestId);
    if (!anchor) return { outcome: "NO_USAGE_EVENT" };

    // Idempotency gate FIRST (§31): a replayed attribution never mutates.
    const existing = await db.aiCostRecord.findUnique({
      where: { usageEventId: anchor.id },
      select: { id: true, costStatus: true, unknownReason: true },
    });
    if (existing) {
      return existing.costStatus === "KNOWN"
        ? { outcome: "ALREADY_KNOWN", recordId: existing.id }
        : { outcome: "ALREADY_UNKNOWN", recordId: existing.id, reason: existing.unknownReason };
    }

    const plan = await planCodeAtUsage(input.businessId);
    const usageTimestamp = input.usageTimestamp ?? anchor.createdAt ?? new Date();
    const environment = input.environment ?? attributionEnvironment();
    const tokenStatus = deriveTokenStatus(input.usage);

    // Provider/model honesty (§81/§82): only identifiers with evidence.
    const provider = input.provider?.trim() || null;
    const model = input.model?.trim() || null;
    const unknownReasons: UnknownReason[] = [];
    if (!provider) unknownReasons.push("PROVIDER_NOT_CONFIGURED");

    // The ledger consumes only real provider-reported tokens (§37): when the
    // split is missing, cost stays UNKNOWN (never interpolated, §40).
    let costNanoMinor: bigint | null = null;
    let rateSnapshot: {
      currency: string;
      rateId: string;
      rateVersion: string;
      environment: AiCostEnvironment;
      inputRate: bigint;
      outputRate: bigint;
    } | null = null;

    if (tokenStatus === "NONE") unknownReasons.push("TOKENS_MISSING");
    else if (tokenStatus !== "COMPLETE") unknownReasons.push("PARTIAL_TOKEN_DATA");

    if (tokenStatus === "COMPLETE" && provider) {
      const modelKey = model ?? UNKNOWN_MODEL;
      // §106: an unknown model is only priced through an EXPLICIT DEFAULT
      // mapping — resolveAiCostRate returns MODEL_UNKNOWN when no such
      // policy exists, so the honest reason flows from resolution itself.
      const resolution = await resolveAiCostRate({
        provider,
        model: modelKey,
        currency: input.currency,
        environment,
        usageTimestamp,
      });
      if (resolution.ok) {
        const rate = resolution.rate;
        rateSnapshot = {
          currency: rate.currency,
          rateId: rate.rateId,
          rateVersion: rate.version,
          environment: rate.environment,
          inputRate: rate.inputRateNanoMinorPer1K,
          outputRate: rate.outputRateNanoMinorPer1K,
        };
        if (environment === "PRODUCTION" && !rate.verified) {
          unknownReasons.push("RATE_NOT_VERIFIED");
        } else {
          // EXACT integer arithmetic only (§19).
          costNanoMinor = computeCostNanoMinor(
            rate,
            toBigIntSafe(input.usage!.inputTokens)!,
            toBigIntSafe(input.usage!.outputTokens)!,
          );
        }
      } else {
        unknownReasons.push(resolution.reason);
      }
    }

    const costStatus: CostStatus =
      costNanoMinor !== null && unknownReasons.length === 0 ? "KNOWN" : "UNKNOWN";
    const reason = unknownReasons[0] ?? null;

    const record = await db.aiCostRecord.create({
      data: {
        usageEventId: anchor.id,
        requestId: input.requestId,
        businessId: input.businessId,
        usagePeriodId: input.usagePeriodId ?? anchor.usagePeriodId,
        planCodeAtUsage: plan,
        provider: provider ?? "UNKNOWN",
        model: model ?? UNKNOWN_MODEL,
        currency: rateSnapshot?.currency ?? input.currency ?? null,
        rateId: rateSnapshot?.rateId ?? null,
        rateVersion: rateSnapshot?.rateVersion ?? null,
        environment: rateSnapshot?.environment ?? environment,
        inputRateNanoMinorPer1K: rateSnapshot?.inputRate ?? null,
        outputRateNanoMinorPer1K: rateSnapshot?.outputRate ?? null,
        inputTokens: input.usage?.inputTokens ?? null,
        outputTokens: input.usage?.outputTokens ?? null,
        totalTokens: input.usage?.totalTokens ?? null,
        tokenStatus,
        costStatus,
        costNanoMinor,
        unknownReason: reason,
      },
      select: { id: true, costNanoMinor: true, currency: true, rateVersion: true },
    });

    if (costStatus === "KNOWN") {
      return {
        outcome: "KNOWN",
        recordId: record.id,
        costNanoMinor: record.costNanoMinor!,
        currency: record.currency!,
        rateVersion: record.rateVersion!,
      };
    }
    return { outcome: "UNKNOWN", recordId: record.id, reason: reason! };
  } catch (error) {
    // FAILURE BOUNDARY (§29): log loudly, never throw into the AI path.
    console.error("[ai-cost] attribution failed (usage stays recorded):", error);
    return { outcome: "FAILED", error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Reconciliation (§41-§43/§103) — dry-run + apply, idempotent
// ---------------------------------------------------------------------------

export type ReconcileDryRunReport = {
  mode: "DRY_RUN" | "APPLY";
  candidateRecordCount: number;
  eligibleRecords: number;
  rateFound: number;
  rateMissing: number;
  tokenComplete: number;
  tokenIncomplete: number;
  currencyMismatch: number;
  conflicts: number;
  alreadyKnown: number;
  wouldUpdateCount: number;
  updatedCount: number;
  boundedWindow: { from: string; to: string };
};

function boundedWindow(days: number): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  return { from, to };
}

/**
 * Re-evaluate UNKNOWN cost records against (possibly newly verified) rates.
 * The record's createdAt is the documented usage-time proxy for effective-
 * window matching (records are written immediately after usage, §104).
 * Apply re-validates EVERY record itself — never trusts stale dry-run data
 * (§186) — and uses compare-and-update semantics so concurrent applies
 * cannot double-attribute (§187). KNOWN records are never rewritten (§44).
 */
export async function reconcileAiCosts(opts: {
  dryRun: boolean;
  environment?: AiCostEnvironment;
  windowDays?: number;
  limit?: number;
  actorId?: string | null;
}): Promise<ReconcileDryRunReport> {
  const config = getAiCostConfig();
  const windowDays = opts.windowDays ?? config.anomalyWindowDays;
  const { from, to } = boundedWindow(windowDays);
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const environment = opts.environment ?? attributionEnvironment();

  const candidates = await db.aiCostRecord.findMany({
    where: { costStatus: "UNKNOWN", createdAt: { gte: from, lte: to } },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      businessId: true,
      requestId: true,
      provider: true,
      model: true,
      currency: true,
      environment: true,
      inputTokens: true,
      outputTokens: true,
      totalTokens: true,
      tokenStatus: true,
      unknownReason: true,
      createdAt: true,
    },
  });

  const report: ReconcileDryRunReport = {
    mode: opts.dryRun ? "DRY_RUN" : "APPLY",
    candidateRecordCount: candidates.length,
    eligibleRecords: 0,
    rateFound: 0,
    rateMissing: 0,
    tokenComplete: 0,
    tokenIncomplete: 0,
    currencyMismatch: 0,
    conflicts: 0,
    alreadyKnown: 0,
    wouldUpdateCount: 0,
    updatedCount: 0,
    boundedWindow: { from: from.toISOString(), to: to.toISOString() },
  };

  for (const rec of candidates) {
    if (rec.tokenStatus === "COMPLETE") report.tokenComplete++;
    else report.tokenIncomplete++;
    if (rec.tokenStatus !== "COMPLETE") continue; // never invent tokens (§43)

    const provider = rec.provider && rec.provider !== "UNKNOWN" ? rec.provider : null;
    const model = rec.model && rec.model !== UNKNOWN_MODEL ? rec.model : null;
    if (!provider) {
      report.rateMissing++;
      continue;
    }

    const resolution = await resolveAiCostRate({
      provider,
      model: model ?? UNKNOWN_MODEL,
      environment: (rec.environment as AiCostEnvironment) ?? environment,
      usageTimestamp: rec.createdAt,
    });

    if (!resolution.ok) {
      if (resolution.reason === "AMBIGUOUS_RATE") report.conflicts++;
      else report.rateMissing++;
      continue;
    }
    report.rateFound++;

    const rate = resolution.rate;
    // Currency match (§103): the record snapshot currency (if any) must agree.
    if (rec.currency && rec.currency !== rate.currency) {
      report.currencyMismatch++;
      continue;
    }
    if (rate.environment === "PRODUCTION" && !rate.verified) {
      report.rateMissing++;
      continue;
    }

    report.eligibleRecords++;
    report.wouldUpdateCount++;
    if (opts.dryRun) continue; // no mutation (§42)

    // Re-validate state at write time: compare-and-update on costStatus
    // guards against a concurrent apply/reconciliation (§187).
    const cost = computeCostNanoMinor(
      rate,
      toBigIntSafe(rec.inputTokens)!,
      toBigIntSafe(rec.outputTokens)!,
    );
    const updated = await db.aiCostRecord.updateMany({
      where: { id: rec.id, costStatus: "UNKNOWN" },
      data: {
        costStatus: "KNOWN",
        costNanoMinor: cost,
        currency: rate.currency,
        rateId: rate.rateId,
        rateVersion: rate.version,
        environment: rate.environment,
        inputRateNanoMinorPer1K: rate.inputRateNanoMinorPer1K,
        outputRateNanoMinorPer1K: rate.outputRateNanoMinorPer1K,
        unknownReason: null,
      },
    });
    report.updatedCount += updated.count;
  }

  if (!opts.dryRun && report.updatedCount > 0) {
    await audit({
      businessId: null,
      actorId: opts.actorId ?? null,
      action: "ai_cost.reconciled",
      entityType: "AiCostRecord",
      entityId: null,
      after: {
        updatedCount: report.updatedCount,
        window: report.boundedWindow,
        environment,
      },
    });
  }
  return report;
}
