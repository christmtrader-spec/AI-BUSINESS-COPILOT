/**
 * AI cost rate resolution + management — Prompt 26 §4-§14/§32-§35.
 *
 * Rates are the ONLY source of provider cost truth. Rules baked in here:
 * - NO fuzzy matching: exact provider + exact model (or the explicit
 *   "DEFAULT" mapping) + exact currency + exact environment.
 * - Production attribution requires a VERIFIED rate (verifiedAt/By/
 *   sourceReference all present) — otherwise RATE_NOT_VERIFIED (§34).
 * - The usage TIMESTAMP decides the version — later rates never apply
 *   retroactively (§104).
 * - Overlapping active windows for the same (provider, model, currency,
 *   environment) are rejected at creation — ambiguity must be impossible
 *   (§11/§105). If data drift ever produces multiple candidates, resolution
 *   fails as AMBIGUOUS_RATE rather than picking one arbitrarily.
 * - Used rates are deactivated, never deleted (§12) — historical cost rows
 *   keep their own snapshot anyway.
 * - No provider pricing is invented, scraped or seeded here (§9/§126).
 */

import { db } from "@/lib/db";
import { toBigIntSafe, addNanoMinor, multiplyRateByTokens } from "./money";
import { audit } from "@/lib/audit";

export const AI_COST_ENVIRONMENTS = ["TEST", "PRODUCTION"] as const;
export type AiCostEnvironment = (typeof AI_COST_ENVIRONMENTS)[number];

/** Reserved explicit default-model mapping (§10/§33) — never a fuzzy match. */
export const DEFAULT_MODEL_MAPPING = "DEFAULT";
/** Honest model identifier when the provider reports nothing (§81/§127). */
export const UNKNOWN_MODEL = "UNKNOWN";

export function isAiCostEnvironment(value: unknown): value is AiCostEnvironment {
  return typeof value === "string" && (AI_COST_ENVIRONMENTS as readonly string[]).includes(value);
}

export type AiCostRateDTO = {
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
  environment: AiCostEnvironment;
  verification:
    | { state: "VERIFIED"; verifiedAt: string; verifiedBy: string; sourceReference: string }
    | { state: "UNVERIFIED" };
};

/** Explicit rate configuration state (§83) — never collapsed. */
export type AiCostRateState = "NOT_CONFIGURED" | "UNVERIFIED" | "VERIFIED" | "ACTIVE" | "INACTIVE";

export function rateStateOf(rate: {
  active: boolean;
  environment: AiCostEnvironment;
  verifiedAt: Date | null;
  verifiedBy: string | null;
  sourceReference: string | null;
}): AiCostRateState {
  if (!rate.active) return "INACTIVE";
  if (rate.environment === "PRODUCTION") {
    if (rate.verifiedAt && rate.verifiedBy && rate.sourceReference) return "VERIFIED";
    return "UNVERIFIED";
  }
  return "ACTIVE";
}

function toDto(rate: {
  id: string;
  provider: string;
  model: string;
  currency: string;
  version: string;
  inputRateNanoMinorPer1K: bigint;
  outputRateNanoMinorPer1K: bigint;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  active: boolean;
  environment: string;
  verifiedAt: Date | null;
  verifiedBy: string | null;
  sourceReference: string | null;
}): AiCostRateDTO {
  const env = isAiCostEnvironment(rate.environment) ? rate.environment : "TEST";
  return {
    id: rate.id,
    provider: rate.provider,
    model: rate.model,
    currency: rate.currency,
    version: rate.version,
    inputRateNanoMinorPer1K: rate.inputRateNanoMinorPer1K.toString(),
    outputRateNanoMinorPer1K: rate.outputRateNanoMinorPer1K.toString(),
    effectiveFrom: rate.effectiveFrom.toISOString(),
    effectiveTo: rate.effectiveTo?.toISOString() ?? null,
    active: rate.active,
    environment: env,
    verification:
      rate.verifiedAt && rate.verifiedBy && rate.sourceReference
        ? {
            state: "VERIFIED",
            verifiedAt: rate.verifiedAt.toISOString(),
            verifiedBy: rate.verifiedBy,
            sourceReference: rate.sourceReference,
          }
        : { state: "UNVERIFIED" },
  };
}

// ---------------------------------------------------------------------------
// Validation (§7) — server-side, exhaustive, structured rejections
// ---------------------------------------------------------------------------

export class AiCostRateError extends Error {
  constructor(
    public code:
      | "INVALID_PROVIDER"
      | "INVALID_MODEL"
      | "INVALID_CURRENCY"
      | "INVALID_ENVIRONMENT"
      | "INVALID_VERSION"
      | "INVALID_RATE"
      | "INVALID_EFFECTIVE_WINDOW"
      | "MISSING_SOURCE_REFERENCE"
      | "DUPLICATE_VERSION"
      | "OVERLAPPING_ACTIVE_RATE",
    message: string,
  ) {
    super(message);
    this.name = "AiCostRateError";
  }
}

const MAX_RATE_NANO_MINOR = 10n ** 18n; // 1e18 nano-minor = 1e12 minor units

function validateRateInputs(input: CreateAiCostRateInput): void {
  if (!input.provider || typeof input.provider !== "string" || input.provider.length > 64) {
    throw new AiCostRateError("INVALID_PROVIDER", "Provider is required (≤64 chars).");
  }
  if (!input.model || typeof input.model !== "string" || input.model.length > 128) {
    throw new AiCostRateError("INVALID_MODEL", "Model is required (≤128 chars).");
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) {
    throw new AiCostRateError("INVALID_CURRENCY", "Currency must be an ISO 4217 code.");
  }
  if (!isAiCostEnvironment(input.environment)) {
    throw new AiCostRateError("INVALID_ENVIRONMENT", "Environment must be TEST or PRODUCTION.");
  }
  if (!input.version || typeof input.version !== "string" || input.version.length > 64) {
    throw new AiCostRateError("INVALID_VERSION", "Version is required (≤64 chars, immutable).");
  }
  const inRate = toBigIntSafe(input.inputRateNanoMinorPer1K);
  const outRate = toBigIntSafe(input.outputRateNanoMinorPer1K);
  if (inRate === null || outRate === null || inRate > MAX_RATE_NANO_MINOR || outRate > MAX_RATE_NANO_MINOR) {
    throw new AiCostRateError(
      "INVALID_RATE",
      "Rates must be non-negative integers ≤ 1e18 nano-minor per 1K tokens (negative/NaN/Infinity rejected, §7/§164).",
    );
  }
  if (!(input.effectiveFrom instanceof Date) || Number.isNaN(input.effectiveFrom.getTime())) {
    throw new AiCostRateError("INVALID_EFFECTIVE_WINDOW", "effectiveFrom must be a valid date.");
  }
  if (
    input.effectiveTo !== null &&
    input.effectiveTo !== undefined &&
    (!(input.effectiveTo instanceof Date) ||
      Number.isNaN(input.effectiveTo.getTime()) ||
      input.effectiveTo.getTime() <= input.effectiveFrom.getTime())
  ) {
    throw new AiCostRateError(
      "INVALID_EFFECTIVE_WINDOW",
      "effectiveTo must be a valid date strictly after effectiveFrom (§11).",
    );
  }
  if (input.environment === "PRODUCTION") {
    const ref = input.sourceReference?.trim() ?? "";
    if (!ref) {
      throw new AiCostRateError(
        "MISSING_SOURCE_REFERENCE",
        "A PRODUCTION rate requires sourceReference evidence (verifiedBy/verifiedAt are set at verification, §8).",
      );
    }
    if (ref.length > 512) {
      throw new AiCostRateError("MISSING_SOURCE_REFERENCE", "sourceReference must be ≤512 chars (bounded, §100).");
    }
  }
}

export type CreateAiCostRateInput = {
  provider: string;
  model: string;
  currency: string;
  version: string;
  inputRateNanoMinorPer1K: bigint | number | string;
  outputRateNanoMinorPer1K: bigint | number | string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  environment: AiCostEnvironment;
  sourceReference?: string | null;
  /** Internal operator identity for the audit trail (§98). */
  actorId?: string | null;
};

/**
 * Create a rate version. Concurrency-safe (§188): the (provider, model,
 * currency, version, environment) unique constraint decides — a concurrent
 * duplicate creation surfaces as DUPLICATE_VERSION, never two rows.
 */
export async function createAiCostRate(input: CreateAiCostRateInput): Promise<AiCostRateDTO> {
  validateRateInputs(input);

  const dup = await db.aiCostRate.findUnique({
    where: {
      provider_model_currency_version_environment: {
        provider: input.provider,
        model: input.model,
        currency: input.currency,
        version: input.version,
        environment: input.environment,
      },
    },
    select: { id: true },
  });
  if (dup) throw new AiCostRateError("DUPLICATE_VERSION", "This rate version already exists (§5/§188).");

  // Overlap guard (§11): active windows for the same scope must not overlap.
  // Two windows [aFrom,aTo] and [bFrom,bTo] overlap iff aFrom < bTo(∞) AND
  // bFrom < aTo(∞) — expressed as two Prisma branches (no sentinel dates,
  // which SQLite/Prisma cannot serialize).
  const overlapWhere = input.effectiveTo
    ? {
        effectiveFrom: { lt: input.effectiveTo },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: input.effectiveFrom } }],
      }
    : {
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: input.effectiveFrom } }],
      };
  const overlapping = await db.aiCostRate.findFirst({
    where: {
      provider: input.provider,
      model: input.model,
      currency: input.currency,
      environment: input.environment,
      active: true,
      ...overlapWhere,
    },
    select: { id: true, version: true },
  });
  if (overlapping) {
    throw new AiCostRateError(
      "OVERLAPPING_ACTIVE_RATE",
      `An active rate window already exists (version ${overlapping.version}) — deactivate it first or open a new non-overlapping window (§11).`,
    );
  }

  const created = await db.aiCostRate.create({
    data: {
      provider: input.provider,
      model: input.model,
      currency: input.currency,
      version: input.version,
      inputRateNanoMinorPer1K: toBigIntSafe(input.inputRateNanoMinorPer1K)!,
      outputRateNanoMinorPer1K: toBigIntSafe(input.outputRateNanoMinorPer1K)!,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
      active: true,
      environment: input.environment,
      sourceReference:
        input.environment === "PRODUCTION" ? (input.sourceReference?.trim() ?? null) : (input.sourceReference?.trim() ?? null),
    },
  });

  // Audit trail (§98/§156) — no secrets, bounded fields.
  await audit({
    businessId: null,
    actorId: input.actorId ?? null,
    action: "ai_cost.rate_created",
    entityType: "AiCostRate",
    entityId: created.id,
    after: {
      provider: created.provider,
      model: created.model,
      currency: created.currency,
      version: created.version,
      environment: created.environment,
      effectiveFrom: created.effectiveFrom.toISOString(),
      sourceReference: created.sourceReference,
    },
  });

  return toDto(created);
}

/**
 * Production verification (§8/§99): all three evidence fields are required
 * together and recorded in the audit trail. Idempotent re-verification
 * updates the evidence (who/when/source may legitimately change).
 */
export async function verifyAiCostRate(
  rateId: string,
  evidence: { verifiedBy: string; sourceReference: string },
  opts: { actorId?: string | null } = {},
): Promise<AiCostRateDTO> {
  const verifiedBy = evidence.verifiedBy?.trim() ?? "";
  const sourceReference = evidence.sourceReference?.trim() ?? "";
  if (!verifiedBy || verifiedBy.length > 128) {
    throw new AiCostRateError("INVALID_VERSION", "verifiedBy is required (≤128 chars).");
  }
  if (!sourceReference || sourceReference.length > 512) {
    throw new AiCostRateError("MISSING_SOURCE_REFERENCE", "sourceReference is required (≤512 chars).");
  }
  const rate = await db.aiCostRate.findUnique({ where: { id: rateId } });
  if (!rate) throw new AiCostRateError("INVALID_PROVIDER", "Rate not found.");
  const verifiedAt = new Date();
  const updated = await db.aiCostRate.update({
    where: { id: rateId },
    data: { verifiedAt, verifiedBy, sourceReference },
  });
  await audit({
    businessId: null,
    actorId: opts.actorId ?? null,
    action: "ai_cost.rate_verified",
    entityType: "AiCostRate",
    entityId: rateId,
    after: {
      provider: updated.provider,
      model: updated.model,
      currency: updated.currency,
      version: updated.version,
      verifiedBy,
      verifiedAt: verifiedAt.toISOString(),
      sourceReference,
    },
  });
  return toDto(updated);
}

/**
 * Deactivate (never delete, §12): used rates must remain resolvable for
 * history even though they can no longer price new usage.
 */
export async function deactivateAiCostRate(
  rateId: string,
  opts: { actorId?: string | null } = {},
): Promise<AiCostRateDTO> {
  const rate = await db.aiCostRate.findUnique({ where: { id: rateId } });
  if (!rate) throw new AiCostRateError("INVALID_PROVIDER", "Rate not found.");
  const updated = await db.aiCostRate.update({ where: { id: rateId }, data: { active: false } });
  await audit({
    businessId: null,
    actorId: opts.actorId ?? null,
    action: "ai_cost.rate_deactivated",
    entityType: "AiCostRate",
    entityId: rateId,
    after: { provider: updated.provider, model: updated.model, version: updated.version },
  });
  return toDto(updated);
}

/** Paginated internal listing (§95 — never an unbounded findMany). */
export async function listAiCostRates(opts: {
  provider?: string;
  environment?: AiCostEnvironment;
  activeOnly?: boolean;
  limit?: number;
  offset?: number;
} = {}): Promise<{ rates: AiCostRateDTO[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where = {
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.environment ? { environment: opts.environment } : {}),
    ...(opts.activeOnly ? { active: true } : {}),
  };
  const [rows, total] = await Promise.all([
    db.aiCostRate.findMany({ where, orderBy: [{ provider: "asc" }, { model: "asc" }, { effectiveFrom: "desc" }], take: limit, skip: opts.offset ?? 0 }),
    db.aiCostRate.count({ where }),
  ]);
  return { rates: rows.map(toDto), total };
}

// ---------------------------------------------------------------------------
// Resolution (§32) — exact, time-aware, verification-gated
// ---------------------------------------------------------------------------

export type ResolvedAiCostRate = {
  rateId: string;
  provider: string;
  model: string;
  currency: string;
  version: string;
  environment: AiCostEnvironment;
  inputRateNanoMinorPer1K: bigint;
  outputRateNanoMinorPer1K: bigint;
  verified: boolean;
};

export type RateResolutionFailure =
  | "RATE_NOT_FOUND"
  | "MODEL_UNKNOWN"
  | "AMBIGUOUS_RATE"
  | "RATE_NOT_VERIFIED";

export type RateResolution =
  | { ok: true; rate: ResolvedAiCostRate }
  | { ok: false; reason: RateResolutionFailure; detail?: string };

/**
 * Resolve THE rate for a usage moment. Deterministic order:
 *   1. exact provider 2. exact model (else explicit DEFAULT mapping when
 *   legitimate §10) 3. exact currency (when provided; multiple candidate
 *   currencies otherwise resolve as AMBIGUOUS — the operator must either
 *   configure a single currency or pin one explicitly) 4. exact environment
 *   5. active 6. usageTimestamp inside [effectiveFrom, effectiveTo)
 *   7. verified when PRODUCTION. No fuzzy matching ever (§33).
 */
export async function resolveAiCostRate(params: {
  provider: string;
  model: string;
  currency?: string;
  environment: AiCostEnvironment;
  usageTimestamp: Date;
  requireVerified?: boolean;
}): Promise<RateResolution> {
  const { provider, model, currency, environment, usageTimestamp } = params;
  const requireVerified = params.requireVerified ?? environment === "PRODUCTION";

  const candidates = await db.aiCostRate.findMany({
    where: {
      provider,
      ...(currency ? { currency } : {}),
      environment,
      active: true,
      effectiveFrom: { lte: usageTimestamp },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: usageTimestamp } }],
    },
    orderBy: [{ effectiveFrom: "desc" }],
    take: 8, // bounded scan (§151) — enough to detect ambiguity
  });

  const exact = candidates.filter((c) => c.model === model);
  const fallback = model === UNKNOWN_MODEL ? candidates.filter((c) => c.model === DEFAULT_MODEL_MAPPING) : [];
  let usable = exact.length > 0 ? exact : fallback;

  // Currency disambiguation: without a pinned currency, only ONE distinct
  // pricing currency may be resolvable — otherwise the result would depend
  // on arbitrary row order (§62: currencies are never mixed implicitly).
  const currencies = new Set(usable.map((c) => c.currency));
  if (!currency && currencies.size > 1) {
    return { ok: false, reason: "AMBIGUOUS_RATE", detail: "Rates exist in multiple pricing currencies — pin the currency explicitly." };
  }

  if (usable.length === 0) {
    // Distinguish the honest reasons a cost cannot be computed (§18).
    if (model === UNKNOWN_MODEL && fallback.length === 0 && candidates.length === 0) {
      return { ok: false, reason: "RATE_NOT_FOUND" };
    }
    if (model === UNKNOWN_MODEL) {
      return { ok: false, reason: "MODEL_UNKNOWN", detail: "No explicit DEFAULT mapping policy applies (§106)." };
    }
    return { ok: false, reason: "RATE_NOT_FOUND" };
  }
  if (usable.length > 1) {
    return { ok: false, reason: "AMBIGUOUS_RATE", detail: `${usable.length} overlapping active rates (§105)` };
  }

  const rate = usable[0];
  const verified = !!(rate.verifiedAt && rate.verifiedBy && rate.sourceReference);
  if (environment === "PRODUCTION" && requireVerified && !verified) {
    return { ok: false, reason: "RATE_NOT_VERIFIED" };
  }

  return {
    ok: true,
    rate: {
      rateId: rate.id,
      provider: rate.provider,
      model: rate.model,
      currency: rate.currency,
      version: rate.version,
      environment,
      inputRateNanoMinorPer1K: rate.inputRateNanoMinorPer1K,
      outputRateNanoMinorPer1K: rate.outputRateNanoMinorPer1K,
      verified,
    },
  };
}

/** Exact cost arithmetic for a resolved rate (BigInt only — §19). */
export function computeCostNanoMinor(
  rate: ResolvedAiCostRate,
  inputTokens: bigint,
  outputTokens: bigint,
): bigint {
  const inputCost = multiplyRateByTokens(inputTokens, rate.inputRateNanoMinorPer1K);
  const outputCost = multiplyRateByTokens(outputTokens, rate.outputRateNanoMinorPer1K);
  return addNanoMinor(inputCost, outputCost);
}
