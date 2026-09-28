/**
 * Platform DTOs + serializers — Prompt 28 (§37/§70/§83).
 *
 * HARD RULE: platform API responses are built here through EXPLICIT field
 * lists — a raw Prisma object is never serialized to an operator client.
 * Every serializer below is the allowlist; anything not listed does not
 * leave the server (passwordHash, tokens, secrets and raw AI transcripts
 * can never leak because they are simply not part of these DTOs).
 */
import type {
  AiCostRate,
  AiCostRecord,
  AiCostAnomaly,
  PlatformAuditLog,
  PlatformOperator,
  PriceBook,
  PlanPrice,
  Subscription,
} from "@prisma/client";
import { formatNanoMinor } from "@/lib/ai/cost/money";

/* ------------------------------- businesses ------------------------------- */

export type PlatformBusinessDTO = {
  id: string;
  name: string;
  slug: string;
  currencyCode: string;
  locale: string;
  timezone: string;
  ownerId: string;
  ownerEmail: string | null;
  ownerName: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
};

export function platformBusinessDto(
  b: {
    id: string;
    name: string;
    slug: string;
    currencyCode: string;
    locale: string;
    timezone: string;
    ownerId: string;
    createdAt: Date;
    updatedAt: Date;
  },
  owner: { email: string; name: string | null } | null,
  memberCount: number,
): PlatformBusinessDTO {
  return {
    id: b.id,
    name: b.name,
    slug: b.slug,
    currencyCode: b.currencyCode,
    locale: b.locale,
    timezone: b.timezone,
    ownerId: b.ownerId,
    ownerEmail: owner?.email ?? null,
    ownerName: owner?.name ?? null,
    memberCount,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

/* --------------------------------- users ---------------------------------- */

export type PlatformUserDTO = {
  id: string;
  name: string | null;
  email: string;
  locale: string;
  createdAt: string;
  updatedAt: string;
  sessionVersion: number;
  ownedBusinessCount: number;
  membershipCount: number;
  isPlatformOperator: boolean;
};

export function platformUserDto(
  u: {
    id: string;
    name: string | null;
    email: string;
    locale: string;
    createdAt: Date;
    updatedAt: Date;
    sessionVersion: number;
  },
  counts: { ownedBusinesses: number; memberships: number },
  isPlatformOperator: boolean,
): PlatformUserDTO {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    locale: u.locale,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
    sessionVersion: u.sessionVersion,
    ownedBusinessCount: counts.ownedBusinesses,
    membershipCount: counts.memberships,
    isPlatformOperator,
  };
}

/* ----------------------------- subscriptions ------------------------------ */

export type PlatformSubscriptionDTO = {
  id: string;
  businessId: string;
  businessName: string;
  status: string;
  billingPeriod: string;
  planCode: string;
  planName: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialStart: string | null;
  trialEnd: string | null;
  createdAt: string;
  updatedAt: string;
};

export function platformSubscriptionDto(
  s: Subscription & { plan: { code: string; name: string }; business: { name: string } },
): PlatformSubscriptionDTO {
  return {
    id: s.id,
    businessId: s.businessId,
    businessName: s.business.name,
    status: s.status,
    billingPeriod: s.billingPeriod,
    planCode: s.plan.code,
    planName: s.plan.name,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    currentPeriodStart: s.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
    trialStart: s.trialStart?.toISOString() ?? null,
    trialEnd: s.trialEnd?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/* -------------------------------- payments -------------------------------- */

export type PlatformPaymentDTO = {
  kind: "checkout_session" | "payment_transaction" | "processed_webhook_event";
  id: string;
  checkoutSessionId?: string;
  businessId: string | null;
  businessName: string | null;
  planCode: string | null;
  provider: string;
  providerRef?: string | null;
  status: string;
  amountMinor: number | null;
  currency: string | null;
  reconciliationReason?: string | null;
  initiatedByEmail?: string | null;
  processedAt?: string | null;
  expiresAt?: string | null;
  createdAt: string;
};

/* --------------------------------- pricing -------------------------------- */

export type PlatformPriceBookDTO = {
  id: string;
  code: string;
  version: string;
  currency: string;
  active: boolean;
  currentlyEffective: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  description: string;
  prices: Array<{
    planCode: string;
    billingPeriod: string;
    amountMinor: number;
    active: boolean;
  }>;
};

export function platformPriceBookDto(
  book: PriceBook & { prices: PlanPrice[] },
  now = new Date(),
): PlatformPriceBookDTO {
  const from = book.effectiveFrom.getTime();
  const to = book.effectiveTo?.getTime() ?? Number.POSITIVE_INFINITY;
  const t = now.getTime();
  return {
    id: book.id,
    code: book.code,
    version: book.version,
    currency: book.currency,
    active: book.active,
    currentlyEffective: book.active && from <= t && t < to,
    effectiveFrom: book.effectiveFrom.toISOString(),
    effectiveTo: book.effectiveTo?.toISOString() ?? null,
    description: book.description,
    prices: book.prices.map((p) => ({
      planCode: p.planCode,
      billingPeriod: p.billingPeriod,
      amountMinor: p.amountMinor,
      active: p.active,
    })),
  };
}

/* -------------------------------- AI cost --------------------------------- */

export type PlatformAiCostRateDTO = {
  id: string;
  provider: string;
  model: string;
  currency: string;
  version: string;
  inputRateNanoMinorPer1K: string;
  outputRateNanoMinorPer1K: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  active: boolean;
  environment: string;
  verified: boolean;
  verifiedAt: string | null;
  verifiedBy: string | null;
  hasSourceReference: boolean;
  createdAt: string;
};

export function platformAiCostRateDto(r: AiCostRate): PlatformAiCostRateDTO {
  return {
    id: r.id,
    provider: r.provider,
    model: r.model,
    currency: r.currency,
    version: r.version,
    inputRateNanoMinorPer1K: r.inputRateNanoMinorPer1K.toString(),
    outputRateNanoMinorPer1K: r.outputRateNanoMinorPer1K.toString(),
    effectiveFrom: r.effectiveFrom.toISOString(),
    effectiveTo: r.effectiveTo?.toISOString() ?? null,
    active: r.active,
    environment: r.environment,
    verified: r.verifiedAt != null && r.verifiedBy != null,
    verifiedAt: r.verifiedAt?.toISOString() ?? null,
    verifiedBy: r.verifiedBy,
    hasSourceReference: !!r.sourceReference,
    createdAt: r.createdAt.toISOString(),
  };
}

export type PlatformAiCostRecordDTO = {
  id: string;
  businessId: string;
  requestId: string;
  planCodeAtUsage: string;
  provider: string;
  model: string;
  currency: string | null;
  rateVersion: string | null;
  environment: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  tokenStatus: string;
  costStatus: string;
  /** KNOWN → serialized nano-minor; UNKNOWN → always null (never 0, §47). */
  costNanoMinor: string | null;
  costDisplayMinor: string | null;
  unknownReason: string | null;
  createdAt: string;
};

export function platformAiCostRecordDto(r: AiCostRecord): PlatformAiCostRecordDTO {
  return {
    id: r.id,
    businessId: r.businessId,
    requestId: r.requestId,
    planCodeAtUsage: r.planCodeAtUsage,
    provider: r.provider,
    model: r.model,
    currency: r.currency,
    rateVersion: r.rateVersion,
    environment: r.environment,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    totalTokens: r.totalTokens,
    tokenStatus: r.tokenStatus,
    costStatus: r.costStatus,
    costNanoMinor:
      r.costStatus === "KNOWN" && r.costNanoMinor != null ? r.costNanoMinor.toString() : null,
    costDisplayMinor:
      r.costStatus === "KNOWN" && r.costNanoMinor != null && r.currency
        ? formatNanoMinor(r.costNanoMinor)
        : null,
    unknownReason: r.unknownReason,
    createdAt: r.createdAt.toISOString(),
  };
}

export type PlatformAiCostAnomalyDTO = {
  id: string;
  type: string;
  severity: string;
  businessId: string | null;
  provider: string | null;
  model: string | null;
  windowStart: string;
  windowEnd: string;
  metric: string;
  baseline: string | null;
  currentValue: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export function platformAiCostAnomalyDto(a: AiCostAnomaly): PlatformAiCostAnomalyDTO {
  return {
    id: a.id,
    type: a.type,
    severity: a.severity,
    businessId: a.businessId,
    provider: a.provider,
    model: a.model,
    windowStart: a.windowStart.toISOString(),
    windowEnd: a.windowEnd.toISOString(),
    metric: a.metric,
    baseline: a.baseline,
    currentValue: a.currentValue,
    status: a.status,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

/* --------------------------------- audit ---------------------------------- */

export type PlatformAuditDTO = {
  id: string;
  operatorId: string | null;
  operatorRole: string | null;
  operatorEmail: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  targetUserId: string | null;
  targetBusinessId: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  requestId: string | null;
  ip: string | null;
  createdAt: string;
};

export function platformAuditDto(
  row: PlatformAuditLog,
  operatorEmail: string | null,
): PlatformAuditDTO {
  const parse = (json: string | null): unknown => {
    if (!json) return null;
    try {
      return JSON.parse(json);
    } catch {
      return null;
    }
  };
  return {
    id: row.id,
    operatorId: row.operatorId,
    operatorRole: row.operatorRole,
    operatorEmail,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    targetUserId: row.targetUserId,
    targetBusinessId: row.targetBusinessId,
    reason: row.reason,
    before: parse(row.beforeJson),
    after: parse(row.afterJson),
    requestId: row.requestId,
    ip: row.ip,
    createdAt: row.createdAt.toISOString(),
  };
}

/* -------------------------------- operators ------------------------------- */

export type PlatformOperatorDTO = {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  role: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export function platformOperatorDto(
  o: PlatformOperator & { user: { email: string; name: string | null } },
): PlatformOperatorDTO {
  return {
    id: o.id,
    userId: o.userId,
    email: o.user.email,
    name: o.user.name,
    role: o.role,
    active: o.active,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
  };
}
