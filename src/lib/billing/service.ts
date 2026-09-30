/**
 * Billing service layer — Prompt 20 (§22/§47/§48/§66/§67/§68/§111).
 *
 * The ONLY sanctioned path to subscription state. Billing logic must never
 * leak into components, routes, or random utilities — every route goes
 * through these functions:
 *
 *   authenticated user → membership (tenant.ts) → businessId
 *     → getEntitlementContext / hasEntitlement / assertFeatureAccess
 *     → assertWithinLimit(usage counted inside the same transaction)
 *     → changePlan / cancelSubscription / reactivateSubscription / trials
 *
 * Authority rules:
 * - Server state is authoritative; nothing here reads client input except
 *   validated plan codes (§23/§24).
 * - Subscription mutation methods are TRANSACTIONAL and write the matching
 *   SubscriptionEvent in the SAME transaction (§47).
 * - Mutations are IDEMPOTENT where repetition is plausible — cancel twice
 *   never writes two contradictory events (§48).
 * - Premium feature gates always verify against a FRESH read (§111);
 *   the short-lived in-memory cache (§67) serves UI read endpoints only
 *   and is invalidated on every mutation.
 * - Billing lookup FAILURE fails closed with BILLING_UNAVAILABLE (§68) —
 *   it never degrades into unlimited access (§93).
 */
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import type { Prisma } from "@prisma/client";
import {
  ENTITLEMENTS,
  ENTITLEMENT_CODES,
  FREE_PLAN_CODE,
  isEntitlementCode,
  type EntitlementCode,
  type EntitlementType,
  type EntitlementUnit,
  type PlanCode,
} from "./catalog";
import {
  BillingError,
  limitReachedError,
} from "./errors";
import {
  VALID_TRANSITIONS,
  asSubscriptionStatus,
  decidePlan,
  isBillingPeriod,
  isValidTransition,
  periodEnd,
  type BillingPeriod,
  type SubscriptionEventType,
  type SubscriptionStatus,
} from "./state-machine";

type Tx = Prisma.TransactionClient;

/**
 * Prompt 32 §72/§76/§84 — post-commit billing notification queue.
 * Domain transaction → commit → notification (NEVER inside the tx): each
 * mutation collects the durable SubscriptionEvent ids it created and the
 * mapper runs only after `db.$transaction` has resolved successfully. A
 * rolled-back transaction therefore emits NO notification (the event rows
 * it queued are discarded with it).
 */
type PendingBillingNotification = {
  eventId: string;
  type: SubscriptionEventType;
  toPlanCode: string | null;
};

function flushBillingNotifications(
  businessId: string,
  queue: readonly PendingBillingNotification[],
): void {
  if (queue.length === 0) return;
  void (async () => {
    const { notifySubscriptionEvent } = await import("@/lib/notifications");
    for (const item of queue) {
      notifySubscriptionEvent({
        businessId,
        eventId: item.eventId,
        type: item.type,
        toPlanCode: item.toPlanCode,
      });
    }
  })();
}

// ---------------------------------------------------------------------------
// Public DTOs (serialized for API responses — dates as ISO strings)
// ---------------------------------------------------------------------------

export type PlanDto = {
  id: string;
  code: string;
  name: string;
  description: string;
  sortOrder: number;
  isPublic: boolean;
};

export type SubscriptionDto = {
  id: string;
  businessId: string;
  status: SubscriptionStatus;
  billingPeriod: BillingPeriod;
  plan: PlanDto;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialStart: string | null;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Plan whose entitlements ACTUALLY apply (expiry → FREE fallback, §13). */
  effectivePlanCode: string;
  /** True when paid-plan features are live (TRIALING/ACTIVE/PAST_DUE/CANCELED-in-grace). */
  entitled: boolean;
  inTrial: boolean;
};

export type ResolvedEntitlement = {
  code: EntitlementCode;
  type: EntitlementType;
  unit: EntitlementUnit | null;
  /** LIMIT: numeric limit or null = UNLIMITED. BOOLEAN: the flag. */
  value: number | null | boolean;
  description: string;
};

export type EntitlementContext = {
  businessId: string;
  subscription: SubscriptionDto;
  entitlements: Record<EntitlementCode, ResolvedEntitlement>;
};

export type SubscriptionEventDto = {
  id: string;
  type: SubscriptionEventType;
  fromStatus: string | null;
  toStatus: string | null;
  fromPlanCode: string | null;
  toPlanCode: string | null;
  data: unknown;
  actor: { name: string | null; email: string } | null;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Internal cache (§67) — UI reads only; mutations invalidate (§111)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 15_000;
const cache = new Map<string, { at: number; ctx: EntitlementContext }>();

export function invalidateBillingCache(businessId?: string): void {
  if (businessId) cache.delete(businessId);
  else cache.clear();
}

// ---------------------------------------------------------------------------
// Row → DTO helpers
// ---------------------------------------------------------------------------

type SubRow = Prisma.SubscriptionGetPayload<{ include: { plan: true } }>;

function planDto(plan: SubRow["plan"]): PlanDto {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    description: plan.description,
    sortOrder: plan.sortOrder,
    isPublic: plan.isPublic,
  };
}

function subscriptionDto(sub: SubRow, effectivePlanCode: string, entitled: boolean): SubscriptionDto {
  return {
    id: sub.id,
    businessId: sub.businessId,
    status: asSubscriptionStatus(sub.status),
    billingPeriod: isBillingPeriod(sub.billingPeriod) ? sub.billingPeriod : "MONTHLY",
    plan: planDto(sub.plan),
    currentPeriodStart: sub.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
    trialStart: sub.trialStart?.toISOString() ?? null,
    trialEnd: sub.trialEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    canceledAt: sub.canceledAt?.toISOString() ?? null,
    endedAt: sub.endedAt?.toISOString() ?? null,
    createdAt: sub.createdAt.toISOString(),
    updatedAt: sub.updatedAt.toISOString(),
    effectivePlanCode,
    entitled,
    inTrial: sub.status === "TRIALING" && !!sub.trialEnd && sub.trialEnd.getTime() > Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Core loaders (fail-closed, §68)
// ---------------------------------------------------------------------------

async function loadSubscription(tx: Tx | typeof db, businessId: string): Promise<SubRow> {
  return tx.subscription.findUnique({
    where: { businessId },
    include: { plan: true },
  }) as Promise<SubRow>;
}

/**
 * Get-or-create the deterministic FREE subscription for a business
 * (§13/§14/§118). Idempotent, transactional, auditable — used at business
 * creation, by the seed backfill and as the lazy safety net on read.
 */
export async function ensureSubscription(
  businessId: string,
  opts: { actorId?: string | null; source?: string; tx?: Tx } = {},
): Promise<SubRow> {
  const run = async (tx: Tx): Promise<SubRow> => {
    const existing = await loadSubscription(tx, businessId);
    if (existing) return existing;

    const business = await tx.business.findUnique({ where: { id: businessId } });
    if (!business) {
      throw new ApiError(403, "FORBIDDEN", "You do not have access to this business.");
    }

    const free = await tx.plan.findUnique({ where: { code: FREE_PLAN_CODE } });
    if (!free || !free.active) {
      // Catalog corruption — fail closed loudly, never invent entitlements.
      throw new BillingError("BILLING_UNAVAILABLE", "Billing catalog is not initialized.");
    }

    const now = new Date();
    const created = await tx.subscription.create({
      data: {
        businessId,
        planId: free.id,
        status: "ACTIVE",
        billingPeriod: "MONTHLY",
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd(now, "MONTHLY"),
      },
      include: { plan: true },
    });
    await tx.subscriptionEvent.create({
      data: {
        businessId,
        subscriptionId: created.id,
        type: "CREATED",
        toStatus: "ACTIVE",
        toPlanCode: free.code,
        dataJson: JSON.stringify({ source: opts.source ?? "ensure" }),
        actorId: opts.actorId ?? null,
      },
    });
    await audit(
      {
        businessId,
        actorId: opts.actorId ?? null,
        action: "billing.subscription_created",
        entityType: "Subscription",
        entityId: created.id,
        after: { planCode: free.code, status: "ACTIVE", source: opts.source ?? "ensure" },
      },
      tx,
    );
    return created as SubRow;
  };

  if (opts.tx) return run(opts.tx);
  return db.$transaction(run, { isolationLevel: "Serializable" });
}

/**
 * Lazy expiry (§17/§91): when a read finds a subscription whose grace/
 * trial/period has passed, transition it to EXPIRED with an event —
 * transactional, only if still in an expirable state.
 */
async function expireSubscriptionIfDue(sub: SubRow): Promise<SubRow> {
  const decision = decidePlan(sub);
  if (!("expired" in decision) || !decision.expired) return sub;

  const updated = await db.$transaction(
    async (tx) => {
      const current = await loadSubscription(tx, sub.businessId);
      if (!current) return current;
      const re = decidePlan(current);
      if (!("expired" in re) || !re.expired) return current;
      const row = await tx.subscription.update({
        where: { id: current.id },
        data: { status: "EXPIRED", endedAt: new Date() },
        include: { plan: true },
      });
      const expiredEventId = await tx.subscriptionEvent.create({
        data: {
          businessId: current.businessId,
          subscriptionId: current.id,
          type: "EXPIRED",
          fromStatus: current.status,
          toStatus: "EXPIRED",
          fromPlanCode: current.plan.code,
        },
        select: { id: true },
      });
      await audit(
        {
          businessId: current.businessId,
          action: "billing.subscription_expired",
          entityType: "Subscription",
          entityId: current.id,
          before: { status: current.status },
          after: { status: "EXPIRED" },
        },
        tx,
      );
      return { row, expiredEventId: expiredEventId.id, planCode: current.plan.code };
    },
    { isolationLevel: "Serializable" },
  );
  invalidateBillingCache(sub.businessId);
  if (updated && typeof updated === "object" && "expiredEventId" in updated) {
    // Prompt 32 §86 — EXPIRED is a customer-visible state (post-commit).
    flushBillingNotifications(sub.businessId, [
      { eventId: updated.expiredEventId, type: "EXPIRED", toPlanCode: updated.planCode },
    ]);
  }
  return updated && typeof updated === "object" && "row" in updated ? updated.row : updated;
}

/**
 * Resolve the effective plan for a subscription row (§17 + §13 fallback).
 * Returns the plan whose entitlements apply.
 */
async function resolveEffectivePlan(sub: SubRow, tx: Tx | typeof db) {
  const decision = decidePlan(sub);
  if (decision.kind === "own-plan") return { plan: sub.plan, entitled: true };
  const free = await tx.plan.findUnique({ where: { code: FREE_PLAN_CODE } });
  if (!free) {
    throw new BillingError("BILLING_UNAVAILABLE", "Billing catalog is not initialized.");
  }
  return { plan: free, entitled: decision.entitled };
}

/** Resolve a plan's full entitlement map (fail-closed on corruption). */
function entitlementsFromRows(
  rows: Array<{ entitlement: { code: string; type: string; unit: string | null; description: string }; value: number | null; boolValue: boolean }>,
): Record<EntitlementCode, ResolvedEntitlement> {
  const map = {} as Record<EntitlementCode, ResolvedEntitlement>;
  // Fail-closed defaults first (§68/§93): a MISSING catalog row can never
  // behave as "allowed/unlimited". The seed guarantees completeness; if a
  // row is missing anyway the gate blocks loudly.
  for (const spec of ENTITLEMENTS) {
    map[spec.code] = {
      code: spec.code,
      type: spec.type,
      unit: spec.unit,
      value: spec.type === "LIMIT" ? 0 : false,
      description: spec.description,
    };
  }
  for (const row of rows) {
    if (!isEntitlementCode(row.entitlement.code)) continue;
    const spec = ENTITLEMENTS.find((s) => s.code === row.entitlement.code)!;
    map[spec.code] = {
      code: spec.code,
      type: spec.type,
      unit: spec.unit,
      value:
        spec.type === "LIMIT"
          ? row.value // number, or null = UNLIMITED
          : row.boolValue,
      description: spec.description,
    };
  }
  return map;
}

/** Fresh (uncached) entitlement context — the gate-enforcement loader. */
export async function getEntitlementContextFresh(businessId: string): Promise<EntitlementContext> {
  try {
    let sub = await loadSubscription(db, businessId);
    if (!sub) {
      sub = await ensureSubscription(businessId, { source: "lazy-backfill" });
      invalidateBillingCache(businessId);
    }
    sub = await expireSubscriptionIfDue(sub);
    const { plan, entitled } = await resolveEffectivePlan(sub, db);
    const rows = await db.planEntitlement.findMany({
      where: { planId: plan.id },
      include: { entitlement: true },
    });
    return {
      businessId,
      subscription: subscriptionDto(sub, plan.code, entitled),
      entitlements: entitlementsFromRows(rows),
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.error("[billing] context lookup failed:", error);
    throw new BillingError("BILLING_UNAVAILABLE", "Billing state is temporarily unavailable. Please try again.");
  }
}

/** Same as getEntitlementContextFresh but inside an existing transaction. */
export async function getEntitlementContextTx(tx: Tx, businessId: string): Promise<EntitlementContext> {
  let sub = await loadSubscription(tx, businessId);
  if (!sub) {
    sub = await ensureSubscription(businessId, { source: "lazy-backfill", tx });
  }
  const { plan, entitled } = await resolveEffectivePlan(sub, tx);
  const rows = await tx.planEntitlement.findMany({
    where: { planId: plan.id },
    include: { entitlement: true },
  });
  return {
    businessId,
    subscription: subscriptionDto(sub, plan.code, entitled),
    entitlements: entitlementsFromRows(rows),
  };
}

/** Cached context for UI read endpoints (§67); 15s TTL, mutation-invalidated. */
export async function getEntitlementContext(businessId: string): Promise<EntitlementContext> {
  const hit = cache.get(businessId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.ctx;
  const ctx = await getEntitlementContextFresh(businessId);
  cache.set(businessId, { at: Date.now(), ctx });
  return ctx;
}

// ---------------------------------------------------------------------------
// Pure checks over a resolved context (unit-testable, no DB)
// ---------------------------------------------------------------------------

export function hasEntitlementIn(ctx: EntitlementContext, code: EntitlementCode): boolean {
  const e = ctx.entitlements[code];
  return e !== undefined && e.type === "BOOLEAN" && e.value === true;
}

export function getLimitIn(ctx: EntitlementContext, code: EntitlementCode): number | null {
  const e = ctx.entitlements[code];
  if (!e || e.type !== "LIMIT") return 0; // unknown/misconfigured → fail closed
  return e.value === null ? null : (e.value as number);
}

/** §25/§27 — throws the structured error; `currentUsage` counted by caller. */
export function assertWithinLimitIn(
  ctx: EntitlementContext,
  code: EntitlementCode,
  currentUsage: number,
): void {
  const limit = getLimitIn(ctx, code);
  if (limit === null) return; // unlimited (e.g. ENTERPRISE)
  if (currentUsage >= limit) throw limitReachedError(code, limit, currentUsage);
}

// ---------------------------------------------------------------------------
// Convenience wrappers (non-tx paths)
// ---------------------------------------------------------------------------

export async function getBusinessSubscription(businessId: string): Promise<SubscriptionDto> {
  return (await getEntitlementContext(businessId)).subscription;
}

export async function getBusinessPlan(businessId: string): Promise<PlanDto> {
  return (await getEntitlementContext(businessId)).subscription.plan;
}

export async function getEntitlements(businessId: string): Promise<ResolvedEntitlement[]> {
  return Object.values((await getEntitlementContext(businessId)).entitlements);
}

export async function hasEntitlement(businessId: string, code: EntitlementCode): Promise<boolean> {
  return hasEntitlementIn(await getEntitlementContextFresh(businessId), code);
}

export async function getLimit(businessId: string, code: EntitlementCode): Promise<number | null> {
  return getLimitIn(await getEntitlementContextFresh(businessId), code);
}

/** Premium feature gate — ALWAYS a fresh server-side check (§111). */
export async function assertFeatureAccess(businessId: string, code: EntitlementCode): Promise<void> {
  const ctx = await getEntitlementContextFresh(businessId);
  if (!hasEntitlementIn(ctx, code)) {
    throw new BillingError(
      "ENTITLEMENT_NOT_AVAILABLE",
      "This feature is not available on the current plan.",
      { feature: code, planCode: ctx.subscription.effectivePlanCode, upgradeAvailable: true },
    );
  }
}

// ---------------------------------------------------------------------------
// Usage counting (§105/§106 — documented counting policies)
// ---------------------------------------------------------------------------

export async function countEntitlementUsage(
  businessId: string,
  ownerId: string,
  codes: readonly EntitlementCode[],
): Promise<Record<string, { used: number; limit: number | null }>> {
  const ctx = await getEntitlementContext(businessId);
  const out: Record<string, { used: number; limit: number | null }> = {};
  for (const code of codes) {
    const limit = getLimitIn(ctx, code);
    let used = 0;
    switch (code) {
      case "CUSTOMERS_MAX":
        used = await db.customer.count({ where: { businessId, deletedAt: null } });
        break;
      case "PRODUCTS_MAX":
        // Deactivation (isActive=false) is a catalog state, NOT deletion —
        // both count (documented in entitlements.md).
        used = await db.product.count({ where: { businessId, deletedAt: null } });
        break;
      case "TEAM_MEMBERS_MAX":
        // Active memberships only; owner included (§108); pending invites
        // never count (§31).
        used = await db.businessMember.count({ where: { businessId } });
        break;
      case "BUSINESSES_MAX":
        // Businesses the user OWNS (§107) — staff memberships don't count.
        used = await db.business.count({ where: { ownerId } });
        break;
      default:
        used = 0;
    }
    out[code] = { used, limit };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Business-creation limit (§30/§107) — a USER-level check
// ---------------------------------------------------------------------------

/**
 * BUSINESSES_MAX is special: it caps how many businesses a USER may OWN,
 * so it cannot be read from one business's subscription. Deterministic
 * policy (documented in entitlements.md): the effective limit is the
 * MAXIMUM BUSINESSES_MAX across the plans of businesses the user already
 * owns — upgrading any owned business lifts the cap; a user with no
 * businesses gets the FREE limit. Count + check run inside the caller's
 * transaction (race-safe on SQLite, §112).
 */
export async function assertWithinBusinessesLimitTx(tx: Tx, userId: string): Promise<void> {
  const owned = await tx.business.findMany({
    where: { ownerId: userId },
    select: {
      subscription: {
        include: {
          plan: { include: { planEntitlements: { include: { entitlement: true } } } },
        },
      },
    },
  });

  let limit = 0;
  for (const b of owned) {
    const sub = b.subscription;
    if (!sub) continue; // grandfathered mid-backfill rows contribute nothing
    const row = sub.plan.planEntitlements.find((pe) => pe.entitlement.code === "BUSINESSES_MAX");
    if (!row) continue; // fail-closed: corrupt plan contributes nothing
    const planLimit = row.value; // null = unlimited
    if (planLimit === null) return; // any unlimited plan lifts the cap
    limit = Math.max(limit, planLimit);
  }
  if (limit === 0) {
    // No owned business (or none with a valid subscription) → FREE limit.
    const free = await tx.plan.findUnique({
      where: { code: FREE_PLAN_CODE },
      include: { planEntitlements: { include: { entitlement: true } } },
    });
    const row = free?.planEntitlements.find((pe) => pe.entitlement.code === "BUSINESSES_MAX");
    limit = row?.value ?? 0;
  }

  if (owned.length >= limit) {
    throw limitReachedError("BUSINESSES_MAX", limit, owned.length);
  }
}

// ---------------------------------------------------------------------------
// Subscription mutations (transactional + evented + audited, §41/§44/§45/§47)
// ---------------------------------------------------------------------------

export type SubscriptionMutationResult = {
  subscription: SubscriptionDto;
  /** false when the call was an idempotent no-op (§48). */
  changed: boolean;
};

function assertTransition(from: SubscriptionStatus, to: SubscriptionStatus): void {
  if (from === to) return;
  if (!isValidTransition(from, to)) {
    throw new BillingError(
      "INVALID_SUBSCRIPTION_STATE",
      `Transition ${from} → ${to} is not allowed.`,
      { from, to, allowed: VALID_TRANSITIONS[from] },
    );
  }
}

async function eventAndAudit(
  tx: Tx,
  input: {
    businessId: string;
    subscriptionId: string;
    type: SubscriptionEventType;
    fromStatus?: string | null;
    toStatus?: string | null;
    fromPlanCode?: string | null;
    toPlanCode?: string | null;
    data?: Record<string, unknown>;
    actorId?: string | null;
    auditAction: string;
    auditBefore?: unknown;
    auditAfter?: unknown;
  },
): Promise<string> {
  const created = await tx.subscriptionEvent.create({
    data: {
      businessId: input.businessId,
      subscriptionId: input.subscriptionId,
      type: input.type,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      fromPlanCode: input.fromPlanCode ?? null,
      toPlanCode: input.toPlanCode ?? null,
      dataJson: input.data ? JSON.stringify(input.data) : null,
      actorId: input.actorId ?? null,
    },
    select: { id: true },
  });
  await audit(
    {
      businessId: input.businessId,
      actorId: input.actorId ?? null,
      action: input.auditAction,
      entityType: "Subscription",
      entityId: input.subscriptionId,
      before: input.auditBefore,
      after: input.auditAfter,
    },
    tx,
  );
  // Prompt 32 — the durable event row id feeds the post-commit notification
  // mapper (§72: domain transaction → commit → notification; the caller
  // flushes AFTER this transaction resolves, §332).
  return created.id;
}

/**
 * Internal plan change (§41/§43/§82/§83): validates the target plan,
 * verifies state transitions, records PLAN_CHANGED (+ REACTIVATED when it
 * doubles as reactivation), all in ONE transaction. NO money changes hands
 * and NOTHING is labeled as payment (§83). Downgrades never delete data —
 * they only cap future growth (§42).
 */
export async function changePlan(
  businessId: string,
  targetPlanCode: string,
  opts: { actorId?: string | null; source?: string } = {},
): Promise<SubscriptionMutationResult> {
  const billingNotifyQueue: PendingBillingNotification[] = [];
  const result = await db.$transaction(
    async (tx) => {
      let sub = await loadSubscription(tx, businessId);
      if (!sub) throw new BillingError("SUBSCRIPTION_NOT_FOUND", "No subscription exists for this business.");

      const target = await tx.plan.findUnique({ where: { code: targetPlanCode } });
      if (!target || !target.active) {
        throw new BillingError("INVALID_PLAN", "The requested plan does not exist or is inactive.", {
          planCode: targetPlanCode,
        });
      }

      if (sub.planId === target.id) {
        // §48 idempotency — same plan → no event, no mutation.
        return { sub, changed: false as const };
      }

      const fromStatus = asSubscriptionStatus(sub.status);
      const wasCanceled = fromStatus === "CANCELED";
      const reactivating = wasCanceled || fromStatus === "EXPIRED" || fromStatus === "PAUSED";
      // Any plan change re-engages the subscription (a deliberate renewal
      // decision by an authorized user — never automatic, §45).
      assertTransition(fromStatus, "ACTIVE");

      if (reactivating) {
        billingNotifyQueue.push({
          eventId: await eventAndAudit(tx, {
            businessId,
            subscriptionId: sub.id,
            type: "REACTIVATED",
            fromStatus,
            toStatus: "ACTIVE",
            fromPlanCode: sub.plan.code,
            toPlanCode: target.code,
            actorId: opts.actorId ?? null,
            auditAction: "billing.subscription_reactivated",
            auditBefore: { status: fromStatus, planCode: sub.plan.code },
            auditAfter: { status: "ACTIVE", planCode: target.code },
          }),
          type: "REACTIVATED",
          toPlanCode: target.code,
        });
      }

      const now = new Date();
      const period =
        sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() > now.getTime()
          ? { start: sub.currentPeriodStart ?? now, end: sub.currentPeriodEnd }
          : { start: now, end: periodEnd(now, (isBillingPeriod(sub.billingPeriod) ? sub.billingPeriod : "MONTHLY") as BillingPeriod) };

      const updated = await tx.subscription.update({
        where: { id: sub.id },
        data: {
          planId: target.id,
          status: "ACTIVE",
          cancelAtPeriodEnd: false,
          canceledAt: null,
          endedAt: null,
          currentPeriodStart: period.start,
          currentPeriodEnd: period.end,
        },
        include: { plan: true },
      });

      billingNotifyQueue.push({
        eventId: await eventAndAudit(tx, {
          businessId,
          subscriptionId: sub.id,
          type: "PLAN_CHANGED",
          fromStatus,
          toStatus: "ACTIVE",
          fromPlanCode: sub.plan.code,
          toPlanCode: target.code,
          data: { source: opts.source ?? "settings" },
          actorId: opts.actorId ?? null,
          auditAction: "billing.plan_changed",
          auditBefore: { planCode: sub.plan.code, status: fromStatus },
          auditAfter: { planCode: target.code, status: "ACTIVE" },
        }),
        type: "PLAN_CHANGED",
        toPlanCode: target.code,
      });

      return { sub: updated as SubRow, changed: true as const };
    },
    { isolationLevel: "Serializable" },
  );

  invalidateBillingCache(businessId);
  flushBillingNotifications(businessId, billingNotifyQueue);
  return {
    subscription: subscriptionDto(result.sub, result.sub.plan.code, true),
    changed: result.changed,
  };
}

/**
 * Cancellation (§44): sets cancelAtPeriodEnd + status CANCELED — access
 * continues until currentPeriodEnd, then lazy expiry moves it to EXPIRED.
 * Idempotent (§48): a second cancel is a no-op. Data is never touched.
 */
export async function cancelSubscription(
  businessId: string,
  opts: { actorId?: string | null } = {},
): Promise<SubscriptionMutationResult> {
  const billingNotifyQueue: PendingBillingNotification[] = [];
  const result = await db.$transaction(
    async (tx) => {
      const sub = await loadSubscription(tx, businessId);
      if (!sub) throw new BillingError("SUBSCRIPTION_NOT_FOUND", "No subscription exists for this business.");

      const fromStatus = asSubscriptionStatus(sub.status);
      if (fromStatus === "CANCELED" && sub.cancelAtPeriodEnd) {
        return { sub, changed: false as const };
      }
      assertTransition(fromStatus, "CANCELED");

      const updated = await tx.subscription.update({
        where: { id: sub.id },
        data: { status: "CANCELED", cancelAtPeriodEnd: true, canceledAt: new Date() },
        include: { plan: true },
      });
      billingNotifyQueue.push({
        eventId: await eventAndAudit(tx, {
          businessId,
          subscriptionId: sub.id,
          type: "CANCELED",
          fromStatus,
          toStatus: "CANCELED",
          fromPlanCode: sub.plan.code,
          actorId: opts.actorId ?? null,
          auditAction: "billing.subscription_canceled",
          auditBefore: { status: fromStatus, planCode: sub.plan.code },
          auditAfter: { status: "CANCELED", cancelAtPeriodEnd: true },
        }),
        type: "CANCELED",
        toPlanCode: sub.plan.code,
      });
      return { sub: updated as SubRow, changed: true as const };
    },
    { isolationLevel: "Serializable" },
  );
  invalidateBillingCache(businessId);
  flushBillingNotifications(businessId, billingNotifyQueue);
  const decision = decidePlan(result.sub);
  return {
    subscription: subscriptionDto(
      result.sub,
      decision.kind === "own-plan" ? result.sub.plan.code : FREE_PLAN_CODE,
      decision.entitled,
    ),
    changed: result.changed,
  };
}

/**
 * Reactivation (§45): only a CANCELED subscription with remaining grace can
 * return to ACTIVE. EXPIRED requires the explicit changePlan renewal path.
 * Idempotent: reactivating an ACTIVE subscription is a no-op.
 */
export async function reactivateSubscription(
  businessId: string,
  opts: { actorId?: string | null } = {},
): Promise<SubscriptionMutationResult> {
  const billingNotifyQueue: PendingBillingNotification[] = [];
  const result = await db.$transaction(
    async (tx) => {
      const sub = await loadSubscription(tx, businessId);
      if (!sub) throw new BillingError("SUBSCRIPTION_NOT_FOUND", "No subscription exists for this business.");

      const fromStatus = asSubscriptionStatus(sub.status);
      if (fromStatus === "ACTIVE") return { sub, changed: false as const };
      // §45/§46: reactivation is ONLY the CANCELED → ACTIVE path (undo the
      // cancellation while the period still runs). An EXPIRED subscription
      // returns exclusively through changePlan — a deliberate, authorized
      // renewal — and PAUSED resumes through a dedicated admin flow that
      // does not exist yet. Arbitrary hopping is refused.
      if (fromStatus === "EXPIRED" || fromStatus === "PAUSED") {
        throw new BillingError(
          "INVALID_SUBSCRIPTION_STATE",
          "This subscription state cannot be reactivated. Use a plan change to renew.",
          { from: fromStatus, allowed: VALID_TRANSITIONS[fromStatus] },
        );
      }
      assertTransition(fromStatus, "ACTIVE");

      const updated = await tx.subscription.update({
        where: { id: sub.id },
        data: { status: "ACTIVE", cancelAtPeriodEnd: false, canceledAt: null, endedAt: null },
        include: { plan: true },
      });
      billingNotifyQueue.push({
        eventId: await eventAndAudit(tx, {
          businessId,
          subscriptionId: sub.id,
          type: "REACTIVATED",
          fromStatus,
          toStatus: "ACTIVE",
          fromPlanCode: sub.plan.code,
          actorId: opts.actorId ?? null,
          auditAction: "billing.subscription_reactivated",
          auditBefore: { status: fromStatus },
          auditAfter: { status: "ACTIVE" },
        }),
        type: "REACTIVATED",
        toPlanCode: sub.plan.code,
      });
      return { sub: updated as SubRow, changed: true as const };
    },
    { isolationLevel: "Serializable" },
  );
  invalidateBillingCache(businessId);
  flushBillingNotifications(businessId, billingNotifyQueue);
  return {
    subscription: subscriptionDto(result.sub, result.sub.plan.code, true),
    changed: result.changed,
  };
}

/**
 * Pause (Prompt 28 §25) — the ACTIVE → PAUSED path the state machine has
 * always declared (nothing set PAUSED before Prompt 28). Operator-only in
 * practice: the caller (platform API) enforces platform authorization;
 * the SERVICE enforces the domain invariants:
 *  - only ACTIVE → PAUSED (state machine §46);
 *  - entitlements become unavailable the honest way — the effective plan
 *    falls back to FREE-level features via the standard decidePlan path
 *    (PAUSED is not an entitled status), data is never touched;
 *  - no payment success is fabricated, no checkout is created;
 *  - idempotent (§48): pausing a PAUSED subscription is a no-op;
 *  - the matching SubscriptionEvent (PAUSED) + tenant audit are written in
 *    the SAME transaction, and the entitlement cache is invalidated.
 */
export async function pauseSubscription(
  businessId: string,
  opts: { actorId?: string | null; source?: string; reason?: string } = {},
): Promise<SubscriptionMutationResult> {
  const billingNotifyQueue: PendingBillingNotification[] = [];
  const result = await db.$transaction(
    async (tx) => {
      const sub = await loadSubscription(tx, businessId);
      if (!sub) throw new BillingError("SUBSCRIPTION_NOT_FOUND", "No subscription exists for this business.");
      const fromStatus = asSubscriptionStatus(sub.status);
      if (fromStatus === "PAUSED") return { sub, changed: false as const };
      assertTransition(fromStatus, "PAUSED");

      const updated = await tx.subscription.update({
        where: { id: sub.id },
        data: { status: "PAUSED" },
        include: { plan: true },
      });
      billingNotifyQueue.push({
        eventId: await eventAndAudit(tx, {
          businessId,
          subscriptionId: sub.id,
          type: "PAUSED",
          fromStatus,
          toStatus: "PAUSED",
          fromPlanCode: sub.plan.code,
          data: { source: opts.source ?? "platform-admin", ...(opts.reason ? { reason: opts.reason.slice(0, 300) } : {}) },
          actorId: opts.actorId ?? null,
          auditAction: "billing.subscription_paused",
          auditBefore: { status: fromStatus, planCode: sub.plan.code },
          auditAfter: { status: "PAUSED" },
        }),
        type: "PAUSED",
        toPlanCode: sub.plan.code,
      });
      return { sub: updated as SubRow, changed: true as const };
    },
    { isolationLevel: "Serializable" },
  );
  invalidateBillingCache(businessId);
  flushBillingNotifications(businessId, billingNotifyQueue);
  const decision = decidePlan(result.sub);
  return {
    subscription: subscriptionDto(
      result.sub,
      decision.kind === "own-plan" ? result.sub.plan.code : FREE_PLAN_CODE,
      decision.entitled,
    ),
    changed: result.changed,
  };
}

/**
 * Resume (Prompt 28 §26) — the PAUSED → ACTIVE path. Only a PAUSED
 * subscription can resume (idempotent on ACTIVE), the event is RESUMED and
 * the entitlement cache is invalidated so paid features return instantly.
 */
export async function resumePausedSubscription(
  businessId: string,
  opts: { actorId?: string | null; source?: string; reason?: string } = {},
): Promise<SubscriptionMutationResult> {
  const billingNotifyQueue: PendingBillingNotification[] = [];
  const result = await db.$transaction(
    async (tx) => {
      const sub = await loadSubscription(tx, businessId);
      if (!sub) throw new BillingError("SUBSCRIPTION_NOT_FOUND", "No subscription exists for this business.");
      const fromStatus = asSubscriptionStatus(sub.status);
      if (fromStatus === "ACTIVE") return { sub, changed: false as const };
      assertTransition(fromStatus, "ACTIVE");

      const updated = await tx.subscription.update({
        where: { id: sub.id },
        data: { status: "ACTIVE" },
        include: { plan: true },
      });
      billingNotifyQueue.push({
        eventId: await eventAndAudit(tx, {
          businessId,
          subscriptionId: sub.id,
          type: "RESUMED",
          fromStatus,
          toStatus: "ACTIVE",
          fromPlanCode: sub.plan.code,
          data: { source: opts.source ?? "platform-admin", ...(opts.reason ? { reason: opts.reason.slice(0, 300) } : {}) },
          actorId: opts.actorId ?? null,
          auditAction: "billing.subscription_resumed",
          auditBefore: { status: fromStatus },
          auditAfter: { status: "ACTIVE" },
        }),
        type: "RESUMED",
        toPlanCode: sub.plan.code,
      });
      return { sub: updated as SubRow, changed: true as const };
    },
    { isolationLevel: "Serializable" },
  );
  invalidateBillingCache(businessId);
  flushBillingNotifications(businessId, billingNotifyQueue);
  return {
    subscription: subscriptionDto(result.sub, result.sub.plan.code, true),
    changed: result.changed,
  };
}

/**
 * Trial capability (§19) — domain support WITHOUT business policy: nothing
 * calls this automatically, there is no self-service UI, and the API
 * surface (POST /api/v1/billing/trial) is disabled unless the operator
 * explicitly enables it (BILLING_TRIALS_ENABLED=1). One trial per business
 * (trialStart must be null).
 */
export async function startTrial(
  businessId: string,
  days: number,
  opts: { actorId?: string | null; source?: string } = {},
): Promise<SubscriptionMutationResult> {
  const billingNotifyQueue: PendingBillingNotification[] = [];
  const result = await db.$transaction(
    async (tx) => {
      let sub = await loadSubscription(tx, businessId);
      if (!sub) {
        sub = await ensureSubscription(businessId, { tx, source: "trial" });
      }
      if (sub.trialStart) {
        throw new BillingError("BUSINESS_NOT_ELIGIBLE", "This business has already used its trial.");
      }
      const fromStatus = asSubscriptionStatus(sub.status);
      assertTransition(fromStatus, "TRIALING");

      const now = new Date();
      const trialEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      const updated = await tx.subscription.update({
        where: { id: sub.id },
        data: {
          status: "TRIALING",
          trialStart: now,
          trialEnd,
          cancelAtPeriodEnd: false,
          canceledAt: null,
        },
        include: { plan: true },
      });
      billingNotifyQueue.push({
        eventId: await eventAndAudit(tx, {
          businessId,
          subscriptionId: sub.id,
          type: "TRIAL_STARTED",
          fromStatus,
          toStatus: "TRIALING",
          fromPlanCode: sub.plan.code,
          data: { days, source: opts.source ?? "manual" },
          actorId: opts.actorId ?? null,
          auditAction: "billing.trial_started",
          auditAfter: { status: "TRIALING", trialEnd: trialEnd.toISOString() },
        }),
        type: "TRIAL_STARTED",
        toPlanCode: sub.plan.code,
      });
      return { sub: updated as SubRow, changed: true as const };
    },
    { isolationLevel: "Serializable" },
  );
  invalidateBillingCache(businessId);
  flushBillingNotifications(businessId, billingNotifyQueue);
  return {
    subscription: subscriptionDto(result.sub, result.sub.plan.code, true),
    changed: result.changed,
  };
}

/** End trial → ACTIVE (TRIAL_ENDED). Keeps the plan (no payment policy yet). */
export async function endTrial(
  businessId: string,
  opts: { actorId?: string | null } = {},
): Promise<SubscriptionMutationResult> {
  const billingNotifyQueue: PendingBillingNotification[] = [];
  const result = await db.$transaction(
    async (tx) => {
      const sub = await loadSubscription(tx, businessId);
      if (!sub) throw new BillingError("SUBSCRIPTION_NOT_FOUND", "No subscription exists for this business.");
      const fromStatus = asSubscriptionStatus(sub.status);
      if (fromStatus !== "TRIALING") {
        throw new BillingError("INVALID_SUBSCRIPTION_STATE", "The subscription is not in a trial.", {
          status: fromStatus,
        });
      }
      const updated = await tx.subscription.update({
        where: { id: sub.id },
        data: { status: "ACTIVE" },
        include: { plan: true },
      });
      billingNotifyQueue.push({
        eventId: await eventAndAudit(tx, {
          businessId,
          subscriptionId: sub.id,
          type: "TRIAL_ENDED",
          fromStatus,
          toStatus: "ACTIVE",
          fromPlanCode: sub.plan.code,
          actorId: opts.actorId ?? null,
          auditAction: "billing.trial_ended",
          auditBefore: { status: fromStatus },
          auditAfter: { status: "ACTIVE" },
        }),
        type: "TRIAL_ENDED",
        toPlanCode: sub.plan.code,
      });
      return { sub: updated as SubRow, changed: true as const };
    },
    { isolationLevel: "Serializable" },
  );
  invalidateBillingCache(businessId);
  flushBillingNotifications(businessId, billingNotifyQueue);
  return {
    subscription: subscriptionDto(result.sub, result.sub.plan.code, true),
    changed: result.changed,
  };
}

// ---------------------------------------------------------------------------
// Event history (§20/§62) — tenant-scoped, paginated
// ---------------------------------------------------------------------------

export async function listSubscriptionEvents(
  businessId: string,
  opts: { page?: number; pageSize?: number } = {},
): Promise<{ items: SubscriptionEventDto[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
  const [rows, total] = await Promise.all([
    db.subscriptionEvent.findMany({
      where: { businessId },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { actor: { select: { name: true, email: true } } },
    }),
    db.subscriptionEvent.count({ where: { businessId } }),
  ]);
  return {
    items: rows.map((r) => ({
      id: r.id,
      type: (isSubscriptionEventTypeSafe(r.type) ? r.type : "CREATED") as SubscriptionEventType,
      fromStatus: r.fromStatus,
      toStatus: r.toStatus,
      fromPlanCode: r.fromPlanCode,
      toPlanCode: r.toPlanCode,
      data: r.dataJson ? safeParse(r.dataJson) : null,
      actor: r.actor ? { name: r.actor.name, email: r.actor.email } : null,
      createdAt: r.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
  };
}

function isSubscriptionEventTypeSafe(value: string): boolean {
  return [
    "CREATED",
    "PLAN_CHANGED",
    "TRIAL_STARTED",
    "TRIAL_ENDED",
    "CANCELED",
    "REACTIVATED",
    "EXPIRED",
    "PAUSED",
    "RESUMED",
  ].includes(value);
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Re-exports (public surface of the billing domain)
// ---------------------------------------------------------------------------

export { ENTITLEMENT_CODES, FREE_PLAN_CODE } from "./catalog";
export type { EntitlementCode, PlanCode };
