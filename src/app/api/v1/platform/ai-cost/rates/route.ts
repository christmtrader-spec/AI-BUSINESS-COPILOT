/**
 * /api/v1/platform/ai-cost/rates — AI cost rate administration (§40-§44).
 *
 * GET  — paginated internal listing (platform:ai-cost:read).
 * POST — create a rate version (platform:ai-cost:manage). A PRODUCTION
 *        rate requires sourceReference + verifiedBy evidence (§41):
 *        verifiedAt is SERVER-generated immediately after creation via the
 *        existing verifyAiCostRate service. NO fake Z-AI rate is seeded
 *        anywhere (§42); TEST rates use environment=TEST with synthetic
 *        values.
 * Reuse law: createAiCostRate / verifyAiCostRate / listAiCostRates from
 * src/lib/ai/cost — this route only adds authorization, validation and
 * platform audit (§53).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { route, ApiError } from "@/lib/api-helpers";
import { assertPlatformReauth, getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { pageMeta, parsePagination, parsePlatformBody, platformOk, queryFilter } from "@/lib/platform/http";
import { platformAudit, requestIdOf } from "@/lib/platform/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-helpers";
import {
  createAiCostRate,
  verifyAiCostRate,
  listAiCostRates,
  AiCostRateError,
  type AiCostEnvironment,
} from "@/lib/ai/cost/rates";
import { platformAiCostRateDto } from "@/lib/platform/serializers";

export const dynamic = "force-dynamic";

function toApiError(error: unknown): never {
  if (error instanceof AiCostRateError) {
    throw new ApiError(422, "PLATFORM_AI_RATE_INVALID", error.message, { reason: error.code });
  }
  throw error as Error;
}

export const GET = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:ai-cost:read");

  const sp = req.nextUrl.searchParams;
  const p = parsePagination(sp);
  const environment = queryFilter(sp, "environment", 12);
  const provider = queryFilter(sp, "provider", 32);
  const activeOnly = sp.get("activeOnly") === "true";

  const { rates, total } = await listAiCostRates({
    provider,
    ...(environment === "TEST" || environment === "PRODUCTION"
      ? { environment: environment as AiCostEnvironment }
      : {}),
    activeOnly,
    limit: p.pageSize,
    offset: p.skip,
  });

  return platformOk({
    rates: rates.map((r) => ({
      ...r,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
    })),
    page: pageMeta(p, total),
  });
});

const bodySchema = z.object({
  provider: z.string().trim().min(1).max(64),
  model: z.string().trim().min(1).max(128),
  currency: z.string().trim().length(3),
  version: z.string().trim().min(2).max(64),
  inputRateNanoMinorPer1K: z.string().regex(/^\d+$/, "input rate must be a non-negative integer string"),
  outputRateNanoMinorPer1K: z.string().regex(/^\d+$/, "output rate must be a non-negative integer string"),
  effectiveFrom: z.string().datetime({ offset: true }),
  effectiveTo: z.string().datetime({ offset: true }).nullable().optional(),
  environment: z.enum(["TEST", "PRODUCTION"]),
  sourceReference: z.string().trim().max(512).optional(),
  verifiedBy: z.string().trim().max(128).optional(),
  reason: z.string().trim().min(3).max(300),
  password: z.string().min(1).max(200).optional(),
});

export const POST = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:ai-cost:manage");
  const body = await parsePlatformBody(req, bodySchema);

  const rl = rateLimit(`platform:${ctx.operatorId}:ai-rate-create`, 10, 15 * 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "PLATFORM_INVALID_OPERATION", "Too many attempts. Try again later.");
  }

  await assertPlatformReauth(ctx, body.password);

  // Provider PRICING currency is an ISO 4217 code in its own right — it is
  // NEVER assumed equal to a business/settlement currency (Prompt 26 §24),
  // so the settlement-currency allowlist deliberately does NOT apply here.
  // The service re-validates exhaustively (INVALID_CURRENCY, §7).
  const currency = body.currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ApiError(422, "PLATFORM_AI_RATE_INVALID", "Currency must be an ISO 4217 code.", {
      field: "currency",
    });
  }

  // §41 — production verification evidence is REQUIRED at creation.
  if (body.environment === "PRODUCTION" && !body.verifiedBy) {
    throw new ApiError(422, "PLATFORM_AI_RATE_INVALID", "A PRODUCTION rate requires verifiedBy.", {
      field: "verifiedBy",
    });
  }
  if (body.environment === "PRODUCTION" && !body.sourceReference) {
    throw new ApiError(422, "PLATFORM_AI_RATE_INVALID", "A PRODUCTION rate requires sourceReference.", {
      field: "sourceReference",
    });
  }

  const requestId = requestIdOf(req);
  let dto;
  try {
    const created = await createAiCostRate({
      provider: body.provider.toLowerCase(),
      model: body.model,
      currency,
      version: body.version,
      inputRateNanoMinorPer1K: body.inputRateNanoMinorPer1K,
      outputRateNanoMinorPer1K: body.outputRateNanoMinorPer1K,
      effectiveFrom: new Date(body.effectiveFrom),
      effectiveTo: body.effectiveTo ? new Date(body.effectiveTo) : null,
      environment: body.environment,
      sourceReference: body.sourceReference ?? null,
      actorId: ctx.userId,
    });
    if (body.environment === "PRODUCTION") {
      // §41 — verifiedAt is server-generated NOW (never client-supplied).
      dto = await verifyAiCostRate(
        created.id,
        { verifiedBy: body.verifiedBy!, sourceReference: body.sourceReference! },
        { actorId: ctx.userId },
      );
    } else {
      dto = created;
    }
  } catch (error) {
    toApiError(error);
  }

  await platformAudit({
    operatorId: ctx.operatorId,
    operatorRole: ctx.role,
    action: "ai_cost.rate_created",
    entityType: "AiCostRate",
    entityId: dto.id,
    reason: body.reason,
    after: {
      provider: dto.provider,
      model: dto.model,
      currency: dto.currency,
      version: dto.version,
      environment: dto.environment,
      verified: dto.verification.state === "VERIFIED",
    },
    requestId,
    ip: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });

  return platformOk({ rate: platformAiCostRateDtoFields(dto), requestId }, 201);
});

/** Adapter: service DTO → platform DTO (verification union flattened). */
function platformAiCostRateDtoFields(dto: Awaited<ReturnType<typeof createAiCostRate>>) {
  return platformAiCostRateDto({
    id: dto.id,
    provider: dto.provider,
    model: dto.model,
    currency: dto.currency,
    version: dto.version,
    inputRateNanoMinorPer1K: BigInt(dto.inputRateNanoMinorPer1K),
    outputRateNanoMinorPer1K: BigInt(dto.outputRateNanoMinorPer1K),
    effectiveFrom: new Date(dto.effectiveFrom),
    effectiveTo: dto.effectiveTo ? new Date(dto.effectiveTo) : null,
    active: dto.active,
    environment: dto.environment,
    verifiedAt: dto.verification.state === "VERIFIED" ? new Date(dto.verification.verifiedAt) : null,
    verifiedBy: dto.verification.state === "VERIFIED" ? dto.verification.verifiedBy : null,
    sourceReference: dto.verification.state === "VERIFIED" ? dto.verification.sourceReference : null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}
