/**
 * Usage metering service — Prompt 21 (§34/§63/§66/§67/§68).
 *
 * Server-side, authoritative consumption metering for metered SaaS metrics.
 * The client is NEVER the source of truth (§3): quantities are decided by
 * the server, counters live in the database, and every enforcement path
 * runs inside a Serializable transaction.
 *
 * Separation of concepts (§4):
 * - RESOURCE limits (customers/products/team/businesses) stay DERIVED from
 *   authoritative tables in service.ts (Prompt 20) — never duplicated here
 *   (§5/§33).
 * - CONSUMPTION metrics accumulate per USAGE PERIOD aligned with the
 *   subscription billing period (§7/§37). No cron resets (§10/§43): when a
 *   billing period rolls over, the next metered operation simply resolves
 *   to a NEW UsagePeriod row (lazy + race-safe, §76) while historical
 *   periods are retained (§101).
 *
 * AI metering semantics (§12/§13/§45/§46/§47/§48):
 * - ONE user Copilot message that enters the pipeline = 1 × AI_MESSAGES and
 *   1 × AI_REQUESTS. Internal snapshot/tool computations are NOT provider
 *   calls and never meter; stream chunks never meter; loading chat history
 *   never meters.
 * - Strategy = count-before-provider-call + release-on-failure (§20/§21,
 *   adapted to this codebase's single-call provider architecture):
 *     meter (atomic, quota-checked) → call provider → success: charge stands
 *     (tokens recorded when the provider reports them) / failure: released.
 * - IDEMPOTENCY (§17/§18): every logical operation carries a requestId
 *   (server-generated UUID, or client-supplied UUID validated server-side).
 *   UsageEvent uniqueness on (businessId, metric, idempotencyKey) makes a
 *   network retry NEVER double-charge: a replayed requestId whose prior
 *   event is COMMITTED proceeds unmetered; one whose prior event was
 *   RELEASED re-meters (the replacement execution actually runs). Abuse is
 *   bounded by the existing per-user rate limits.
 * - FAIL-CLOSED (§24/§68): if usage state cannot be read/written, metered
 *   premium AI operations fail with BILLING_UNAVAILABLE — they never
 *   degrade into unlimited access. Core (non-metered) business features do
 *   not touch this service and keep working.
 * - NO MONEY (§62/§104): usage is never priced here; quantities are stored
 *   so a future payment phase can interpret them without changing meaning
 *   (§105).
 */
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import {
  BillingError,
  usageLimitReachedError,
} from "./errors";
import { getEntitlementContext, getEntitlementContextTx, getLimitIn } from "./service";
import { periodEnd, type BillingPeriod } from "./state-machine";
import type { EntitlementContext, SubscriptionDto } from "./service";
import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Per-business metering queue (single-node SQLite concurrency boundary)
// ---------------------------------------------------------------------------

/**
 * SQLite allows exactly ONE writer at a time, and this deployment is a
 * single Next.js node over one SQLite file (documented boundary, Prompt 20
 * §112). Ten simultaneous interactive transactions all racing for the write
 * lock degrade catastrophically (engine-level lock queueing measured at
 * ~55s under burst), so metering SERIALIZES per business at the application
 * level instead: every transaction stays short, the burst resolves in
 * milliseconds, and the §82 invariant (never exceed the quota) holds
 * deterministically. Cross-process access (CLI tooling) still relies on the
 * database's own write lock — both paths use guarded atomic updates.
 * Multi-node deployments would replace SQLite with a real RDBMS — out of
 * scope by design.
 */
const meterQueues = new Map<string, Promise<unknown>>();

async function withBusinessLock<T>(businessId: string, task: () => Promise<T>): Promise<T> {
  const prev = meterQueues.get(businessId) ?? Promise.resolve();
  const run = prev.then(
    () => task(),
    () => task(),
  );
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  meterQueues.set(businessId, tail);
  try {
    return await run;
  } finally {
    if (meterQueues.get(businessId) === tail) meterQueues.delete(businessId);
  }
}

// ---------------------------------------------------------------------------
// Metrics (§11/§25) — constants, never scattered string literals
// ---------------------------------------------------------------------------

export const USAGE_METRICS = ["AI_REQUESTS", "AI_MESSAGES", "AI_TOKENS"] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

/**
 * Which LIMIT entitlement caps each metric. AI_TOKENS is deliberately NOT
 * mapped: provider token usage is RECORDED when genuinely reported (§14)
 * but never quota-enforced in this phase (no fabricated limits — §66).
 */
export const METRIC_ENTITLEMENT: Partial<Record<UsageMetric, "AI_REQUESTS_MAX" | "AI_MESSAGES_MAX">> = {
  AI_REQUESTS: "AI_REQUESTS_MAX",
  AI_MESSAGES: "AI_MESSAGES_MAX",
};

/** Metrics metered together for one AI operation (enforced quotas). */
const AI_OPERATION_METRICS = ["AI_MESSAGES", "AI_REQUESTS"] as const;

// ---------------------------------------------------------------------------
// Warning thresholds (§53) — centralized, never hard-coded per component
// ---------------------------------------------------------------------------

export const USAGE_WARNING_PERCENT = 75;
export const USAGE_CRITICAL_PERCENT = 90;

export type UsageLevel = "ok" | "warning" | "critical" | "reached";

export function usageLevel(percentageUsed: number | null): UsageLevel {
  if (percentageUsed === null) return "ok"; // unlimited — never "reached" (§64)
  if (percentageUsed >= 100) return "reached";
  if (percentageUsed >= USAGE_CRITICAL_PERCENT) return "critical";
  if (percentageUsed >= USAGE_WARNING_PERCENT) return "warning";
  return "ok";
}

// ---------------------------------------------------------------------------
// Usage period resolution (§7/§8/§37/§42)
// ---------------------------------------------------------------------------

export type UsagePeriodBounds = { start: Date; end: Date | null };

/**
 * Derive the CURRENT usage-period boundaries from a subscription DTO.
 * Pure function (unit-testable, `now` injectable):
 * - period still running → exactly the subscription's billing period;
 * - period over (expired / grace passed → FREE fallback) → the billing
 *   cadence rolls forward deterministically (UTC, month-end clamped via
 *   periodEnd) until the window contains `now`. No cron, no timezone
 *   dependence (§37/§43).
 */
export function usagePeriodBounds(
  subscription: Pick<SubscriptionDto, "currentPeriodStart" | "currentPeriodEnd" | "billingPeriod">,
  now: Date = new Date(),
): UsagePeriodBounds {
  const start = subscription.currentPeriodStart ? new Date(subscription.currentPeriodStart) : now;
  const end = subscription.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null;
  if (end && end.getTime() > now.getTime()) return { start, end };

  // Period over: continue the cadence from where it stopped. Cycle guard
  // bounds the loop (240 months = 20 years) against pathological data.
  const period: BillingPeriod = subscription.billingPeriod;
  let cursor = end ?? start;
  let guard = 0;
  while (guard++ < 240) {
    const candidateEnd = periodEnd(cursor, period);
    if (candidateEnd.getTime() > now.getTime()) return { start: cursor, end: candidateEnd };
    cursor = candidateEnd;
  }
  return { start: cursor, end: periodEnd(cursor, period) };
}

function boundsKey(businessId: string, start: Date) {
  return { businessId_start: { businessId, start } } as const;
}

/**
 * Find-or-create the UsagePeriod for the given bounds INSIDE the caller's
 * transaction. Race-safe: two concurrent creators collide on the unique
 * (businessId, start) index; the loser refetches (§76/§72).
 */
async function ensureUsagePeriodTx(
  tx: Tx,
  businessId: string,
  bounds: UsagePeriodBounds,
  subscriptionId: string | null,
) {
  const existing = await tx.usagePeriod.findUnique({ where: boundsKey(businessId, bounds.start) });
  if (existing) return existing;
  try {
    return await tx.usagePeriod.create({
      data: {
        businessId,
        subscriptionId,
        start: bounds.start,
        end: bounds.end,
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await tx.usagePeriod.findUnique({ where: boundsKey(businessId, bounds.start) });
    if (!raced) throw error;
    return raced;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

// ---------------------------------------------------------------------------
// Counter primitives — guarded atomic moves (§28/§68)
// ---------------------------------------------------------------------------

/**
 * Increment a counter by `quantity`, respecting `limit` (null = unlimited).
 * The guarded UPDATE (used < limit ⇒ used+quantity ≤ limit for quantity 1)
 * is a single atomic SQL statement; the create path covers the first use
 * and races on the unique (period, metric) index. Throws the structured
 * USAGE_LIMIT_REACHED error when the quota would be exceeded.
 */
async function bumpCounterTx(
  tx: Tx,
  usagePeriodId: string,
  metric: UsageMetric,
  quantity: number,
  limit: number | null,
  periodEndIso: string | null,
): Promise<void> {
  if (limit === null) {
    const bumped = await tx.usageCounter.updateMany({
      where: { usagePeriodId, metric },
      data: { used: { increment: quantity } },
    });
    if (bumped.count === 0) {
      try {
        await tx.usageCounter.create({ data: { usagePeriodId, metric, used: quantity } });
        return;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const raced = await tx.usageCounter.updateMany({
          where: { usagePeriodId, metric },
          data: { used: { increment: quantity } },
        });
        if (raced.count === 0) throw new BillingError("BILLING_UNAVAILABLE", "Usage counter is unavailable.");
      }
    }
    return;
  }

  const bumped = await tx.usageCounter.updateMany({
    where: { usagePeriodId, metric, used: { lt: limit } },
    data: { used: { increment: quantity } },
  });
  if (bumped.count > 0) return;

  // Either the counter is missing (first use) or the quota is exhausted.
  const existing = await tx.usageCounter.findUnique({
    where: { usagePeriodId_metric: { usagePeriodId, metric } },
  });
  if (!existing) {
    if (quantity > limit) {
      throw usageLimitReachedError(metric, limit, 0, periodEndIso);
    }
    try {
      await tx.usageCounter.create({ data: { usagePeriodId, metric, used: quantity } });
      return;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Lost a create race — fall through to the guarded re-check below.
    }
  }
  const current = existing?.used ?? 0;
  const after = await tx.usageCounter.updateMany({
    where: { usagePeriodId, metric, used: { lte: limit - quantity } },
    data: { used: { increment: quantity } },
  });
  if (after.count === 0) {
    throw usageLimitReachedError(metric, limit, Math.max(current, limit), periodEndIso);
  }
}

/**
 * Decrement a counter (release path) — guarded so it can never go negative
 * (§28). Returns the post-release value, or null when no counter row exists.
 */
async function releaseCounterTx(
  tx: Tx,
  usagePeriodId: string,
  metric: UsageMetric,
  quantity: number,
): Promise<number | null> {
  const existing = await tx.usageCounter.findUnique({
    where: { usagePeriodId_metric: { usagePeriodId, metric } },
  });
  if (!existing) return null;
  const next = Math.max(0, existing.used - quantity);
  await tx.usageCounter.update({ where: { id: existing.id }, data: { used: next } });
  return next;
}

// ---------------------------------------------------------------------------
// AI operation metering (§12/§13/§17/§18/§20/§21/§49)
// ---------------------------------------------------------------------------

export type AiMeteringResult = {
  requestId: string;
  /** true when at least one metric was newly charged by THIS call. */
  charged: boolean;
  /** true when the requestId was already metered (idempotent replay). */
  replay: boolean;
  period: { start: string; end: string | null };
  /** Post-metering state per enforced metric (for structured responses). */
  metrics: Record<
    string,
    { used: number; limit: number | null; remaining: number | null }
  >;
};

/**
 * Meter ONE logical AI operation (1 × AI_MESSAGES + 1 × AI_REQUESTS) for
 * the business's current usage period. Runs in ONE Serializable
 * transaction (SQLite serializes writers — the concurrency boundary, §112):
 * entitlements → period → idempotency gate → guarded counter bump.
 *
 * Throws:
 * - 422 USAGE_LIMIT_REACHED (structured §23 body) when an enforced quota
 *   is exhausted — NO usage is consumed by the rejected attempt (§49).
 * - 503 BILLING_UNAVAILABLE when usage state cannot be resolved (fail
 *   closed, §24/§68).
 */
export async function meterAiOperation(
  businessId: string,
  requestId: string,
  opts: { tx?: Tx; meta?: Record<string, unknown> } = {},
): Promise<AiMeteringResult> {
  const run = async (tx: Tx): Promise<AiMeteringResult> => {
    // Entitlement context (lazy subscription ensure inside; effective plan
    // resolution handles expiry/trial/cancellation fallbacks — §17/§40/§41).
    let ctx: EntitlementContext;
    try {
      ctx = await getEntitlementContextTx(tx, businessId);
    } catch (error) {
      if (error instanceof BillingError) throw error;
      console.error("[usage] entitlement resolution failed:", error);
      throw new BillingError("BILLING_UNAVAILABLE", "Usage state is temporarily unavailable. Please try again.");
    }

    const bounds = usagePeriodBounds(ctx.subscription);
    const period = await ensureUsagePeriodTx(tx, businessId, bounds, ctx.subscription.id);
    const periodEndIso = bounds.end ? bounds.end.toISOString() : null;

    const limits: Record<string, number | null> = {};
    const metrics: AiMeteringResult["metrics"] = {};
    let charged = false;
    let replay = true;

    for (const metric of AI_OPERATION_METRICS) {
      const code = METRIC_ENTITLEMENT[metric];
      const limit = code ? getLimitIn(ctx, code) : 0; // unknown → fail closed (0)
      limits[metric] = limit;

      // Idempotency gate FIRST (§17/§18): the unique event row decides
      // whether this logical operation has already been metered.
      const existing = await tx.usageEvent.findUnique({
        where: {
          businessId_metric_idempotencyKey: {
            businessId,
            metric,
            idempotencyKey: `${requestId}:${metric}`,
          },
        },
      });

      if (!existing) {
        await tx.usageEvent.create({
          data: {
            businessId,
            usagePeriodId: period.id,
            metric,
            quantity: 1,
            status: "COMMITTED",
            requestId,
            idempotencyKey: `${requestId}:${metric}`,
            ...(opts.meta ? { metaJson: JSON.stringify(opts.meta) } : {}),
          },
        });
        await bumpCounterTx(tx, period.id, metric, 1, limit, periodEndIso);
        charged = true;
        replay = false;
      } else if (existing.status === "RELEASED") {
        // A previous attempt failed before provider acceptance and was
        // released. This retry REPLACES it: re-charge optimistically (and
        // release again if the replacement also fails). Never double-charges
        // the successful original (§17/§49).
        await tx.usageEvent.update({
          where: { id: existing.id },
          data: { status: "COMMITTED", usagePeriodId: period.id },
        });
        await bumpCounterTx(tx, period.id, metric, 1, limit, periodEndIso);
        charged = true;
        replay = false;
      }
      // else: prior event COMMITTED → skip (duplicate submission continues
      // unmetered — the original operation already paid).

      const counter = await tx.usageCounter.findUnique({
        where: { usagePeriodId_metric: { usagePeriodId: period.id, metric } },
      });
      const used = counter?.used ?? 0;
      metrics[metric] = {
        used,
        limit,
        remaining: limit === null ? null : Math.max(0, limit - used),
      };
    }

    return {
      requestId,
      charged,
      replay,
      period: { start: bounds.start.toISOString(), end: periodEndIso },
      metrics,
    };
  };

  if (opts.tx) return run(opts.tx);
  // Serialize per business (see withBusinessLock) — burst-safe quota
  // enforcement on single-node SQLite (§19/§82/§112).
  try {
    const result = await withBusinessLock(businessId, () =>
      db.$transaction(run, {
        isolationLevel: "Serializable",
        timeout: 30_000,
        maxWait: 5_000,
      }),
    );
    // Prompt 32 §81/§82 — AI usage threshold notifications (NEAR/REACHED,
    // one per usage period). Strictly AFTER the metering commit (§332);
    // fire-safe — a notification failure never affects metering (§30).
    // The NEAR threshold is the EXISTING §53 configuration (75% warning) —
    // the notification layer never invents its own quota math (§431).
    if (result.charged && !result.replay) {
      const messages = result.metrics.AI_MESSAGES;
      if (messages && typeof messages.used === "number" && typeof messages.limit === "number") {
        const { notifyAiUsageThreshold } = await import("@/lib/notifications");
        notifyAiUsageThreshold({
          businessId,
          periodEndIso: result.period.end ?? "",
          used: messages.used,
          limit: messages.limit,
          nearPercent: USAGE_WARNING_PERCENT,
        });
      }
    }
    return result;
  } catch (error) {
    if (error instanceof BillingError) throw error;
    console.error("[usage] metering failed:", error);
    // Fail closed (§24/§68): metered premium AI never degrades into
    // unlimited access on infrastructure failure.
    throw new BillingError("BILLING_UNAVAILABLE", "Usage state is temporarily unavailable. Please try again.");
  }
}

/**
 * Release a previously metered AI operation (provider never accepted it —
 * §20/§49): decrements the counters and marks the events RELEASED.
 * Idempotent (§48): releasing twice is a no-op; guarded decrements keep
 * counters non-negative (§28). Best-effort by callers — a release failure
 * must never mask the original error; it is logged and audited instead.
 */
export async function releaseAiOperation(
  businessId: string,
  requestId: string,
  opts: { reason?: string } = {},
): Promise<boolean> {
  try {
    return await db.$transaction(
      async (tx) => {
        const events = await tx.usageEvent.findMany({
          where: { businessId, requestId, status: "COMMITTED", metric: { in: [...AI_OPERATION_METRICS] } },
        });
        if (events.length === 0) return false;
        for (const event of events) {
          const metric = event.metric as UsageMetric;
          const next = await releaseCounterTx(tx, event.usagePeriodId, metric, event.quantity);
          if (next === null) {
            // Counter missing while a COMMITTED event exists — an integrity
            // anomaly; report loudly, never silently "fix" (§50/§103).
            console.error(`[usage] integrity: counter missing for ${businessId}/${metric} during release`);
          }
          await tx.usageEvent.update({
            where: { id: event.id },
            data: {
              status: "RELEASED",
              ...(opts.reason ? { metaJson: JSON.stringify({ reason: opts.reason }) } : {}),
            },
          });
        }
        await audit({
          businessId,
          action: "usage.ai_released",
          entityType: "UsageEvent",
          entityId: requestId,
          after: { requestId, reason: opts.reason ?? "provider-not-accepted", metrics: events.map((e) => e.metric) },
        }, tx);
        return true;
      },
      { isolationLevel: "Serializable", timeout: 15_000, maxWait: 5_000 },
    );
  } catch (error) {
    // Release is a reconciliation best-effort: log loudly, never throw into
    // the user-facing error path (the original failure takes precedence).
    console.error("[usage] release failed (counter may be over-stated):", error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Token recording (§14/§15/§30/§60) — only authoritative provider values
// ---------------------------------------------------------------------------

export type AiProviderUsage = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
};

const MAX_TOKEN_QUANTITY = 10_000_000; // sane upper bound (§58)

function sanitizeTokenCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const int = Math.round(value);
  if (int > MAX_TOKEN_QUANTITY) return null; // implausible → ignore, never fabricate
  return int;
}

/**
 * Record provider-reported token usage for an already-metered AI operation.
 * ONLY genuine provider values are stored (§14): if the provider exposes
 * nothing usable, this is a no-op and usage stays unknown (never estimated,
 * never fabricated). AI_TOKENS is recorded, not enforced (§66) — it carries
 * no quota and exists so future cost computation can interpret quantities
 * without changing their meaning (§105).
 */
export async function recordAiTokenUsage(
  businessId: string,
  requestId: string,
  usage: AiProviderUsage | null | undefined,
  providerMeta: { provider?: string; model?: string } = {},
): Promise<boolean> {
  if (!usage) return false;
  const inputTokens = sanitizeTokenCount(usage.inputTokens);
  const outputTokens = sanitizeTokenCount(usage.outputTokens);
  const totalTokens =
    sanitizeTokenCount(usage.totalTokens) ??
    (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  if (totalTokens === null || totalTokens <= 0) return false;

  try {
    const created = await db.$transaction(
      async (tx) => {
        const ctx = await getEntitlementContextTx(tx, businessId);
        const bounds = usagePeriodBounds(ctx.subscription);
        const period = await ensureUsagePeriodTx(tx, businessId, bounds, ctx.subscription.id);

        const meta: Record<string, unknown> = { ...providerMeta };
        if (inputTokens !== null) meta.inputTokens = inputTokens;
        if (outputTokens !== null) meta.outputTokens = outputTokens;
        meta.totalTokens = totalTokens;

        // Idempotency gate — a replayed requestId never double-counts tokens.
        const existing = await tx.usageEvent.findUnique({
          where: {
            businessId_metric_idempotencyKey: {
              businessId,
              metric: "AI_TOKENS",
              idempotencyKey: `${requestId}:AI_TOKENS`,
            },
          },
        });
        if (existing) return false;
        await tx.usageEvent.create({
          data: {
            businessId,
            usagePeriodId: period.id,
            metric: "AI_TOKENS",
            quantity: totalTokens,
            status: "COMMITTED",
            requestId,
            idempotencyKey: `${requestId}:AI_TOKENS`,
            metaJson: JSON.stringify(meta),
          },
        });
        await bumpCounterTx(tx, period.id, "AI_TOKENS", totalTokens, null, null);
        return true;
      },
      { isolationLevel: "Serializable", timeout: 30_000, maxWait: 5_000 },
    );
    // Propagate the transaction's verdict — a duplicate must report false.
    return created === true;
  } catch (error) {
    // Token recording is observational — never break the AI response path.
    console.error("[usage] token recording failed:", error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Usage summary (§63/§64/§94) — powers the Settings → Subscription → Usage UI
// ---------------------------------------------------------------------------

export type UsageMetricSummary = {
  metric: UsageMetric;
  used: number;
  /** null = unlimited / not limited (never a fake giant number, §64). */
  limit: number | null;
  remaining: number | null;
  percentageUsed: number | null;
  level: UsageLevel;
};

export type UsageSummary = {
  planCode: string;
  entitled: boolean;
  status: string;
  period: { start: string; end: string | null };
  metrics: Record<UsageMetric, UsageMetricSummary>;
};

/**
 * Read-only usage summary for the CURRENT usage period. Uses the 15s
 * entitlement cache (UI read only, §67) — enforcement always re-checks
 * server-side. Creates nothing: zero usage before the first metered
 * operation is reported from computed bounds (§76 lazy initialization).
 */
export async function getUsageSummary(businessId: string): Promise<UsageSummary> {
  const ctx = await getEntitlementContext(businessId);
  const bounds = usagePeriodBounds(ctx.subscription);

  const period = await db.usagePeriod.findUnique({
    where: boundsKey(businessId, bounds.start),
    include: { counters: true },
  });
  const counterByMetric = new Map(period?.counters.map((c) => [c.metric, c.used]) ?? []);

  const summarize = (metric: UsageMetric, limit: number | null): UsageMetricSummary => {
    const used = counterByMetric.get(metric) ?? 0;
    const remaining = limit === null ? null : Math.max(0, limit - used);
    // Unlimited → null percentage (§64); a 0-limit plan shows 100% reached.
    const percentageUsed =
      limit === null ? null : limit <= 0 ? (used > 0 ? 100 : null) : Math.min(100, Math.round((used / limit) * 100));
    return { metric, used, limit, remaining, percentageUsed, level: usageLevel(percentageUsed) };
  };

  return {
    planCode: ctx.subscription.effectivePlanCode,
    entitled: ctx.subscription.entitled,
    status: ctx.subscription.status,
    period: { start: bounds.start.toISOString(), end: bounds.end ? bounds.end.toISOString() : null },
    metrics: {
      AI_REQUESTS: summarize("AI_REQUESTS", getLimitIn(ctx, "AI_REQUESTS_MAX")),
      AI_MESSAGES: summarize("AI_MESSAGES", getLimitIn(ctx, "AI_MESSAGES_MAX")),
      AI_TOKENS: summarize("AI_TOKENS", null),
    },
  };
}

// ---------------------------------------------------------------------------
// Usage history (read-only, tenant-scoped) — retention-friendly (§101)
// ---------------------------------------------------------------------------

export type UsagePeriodHistoryItem = {
  id: string;
  start: string;
  end: string | null;
  createdAt: string;
  counters: Array<{ metric: string; used: number }>;
};

/** Historical usage periods for the business, newest first (capped). */
export async function listUsagePeriods(
  businessId: string,
  take = 12,
): Promise<UsagePeriodHistoryItem[]> {
  const rows = await db.usagePeriod.findMany({
    where: { businessId },
    orderBy: { start: "desc" },
    take,
    include: { counters: true },
  });
  return rows.map((row) => ({
    id: row.id,
    start: row.start.toISOString(),
    end: row.end?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    counters: row.counters.map((c) => ({ metric: c.metric, used: c.used })),
  }));
}
