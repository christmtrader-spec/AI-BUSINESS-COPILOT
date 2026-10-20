/**
 * GET  /api/v1/api-keys — list the business's API keys (metadata only —
 *      the plaintext key is NEVER retrievable).
 * POST /api/v1/api-keys — create a key. The response contains the plaintext
 *      key EXACTLY ONCE; the DB stores only its SHA-256 hash (§F8).
 *
 * Permission: settings:manage (OWNER/ADMIN). Rate limited. Audited.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { generateApiKey, serializeApiKeyScopes, apiKeyMonthlyQuota } from "@/lib/api-keys";
import { isValidApiKeyScopeList } from "@/lib/api-key-scopes";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  // R61-3 — optional closed-set scope list. Missing/empty → ["read"]
  // (legacy full access). Unknown tokens → 422 (never silently widened).
  scopes: z.array(z.string().trim().min(1).max(24)).max(4).optional(),
});

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:read");

  const keys = await db.apiKey.findMany({
    where: { businessId: ctx.businessId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      prefix: true,
      scopes: true,
      lastUsedAt: true,
      requestCount: true,
      periodCount: true,
      revokedAt: true,
      createdAt: true,
      createdBy: { select: { name: true, email: true } },
    },
  });

  return ok({ items: keys, quotaMonthly: apiKeyMonthlyQuota() });
});

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:manage");

  const limit = rateLimit(`api-keys-create:${ctx.userId}`, 10, 60 * 60_000);
  if (!limit.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many keys created recently.", {
      retryAfterMs: limit.retryAfterMs,
    });
  }

  const input = await parseBody(req, createSchema);

  // A sane ceiling per business — runaway key farms are a support hazard.
  const activeCount = await db.apiKey.count({
    where: { businessId: ctx.businessId, revokedAt: null },
  });
  if (activeCount >= 10) {
    throw new ApiError(
      422,
      "API_KEY_LIMIT_REACHED",
      "Revoke an existing key before creating a new one (max 10 active keys).",
    );
  }

  const { plaintext, prefix, keyHash } = generateApiKey();

  // Scope normalization (R61-3): every token must be in the closed set;
  // storing the canonical serialized form (deduped, ordered, no blanks).
  const requestedScopes = input.scopes ?? ["read"];
  if (!isValidApiKeyScopeList(requestedScopes)) {
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "scopes must be a non-empty list of known scopes: read, read:customers, read:products, read:sales.",
      { field: "scopes" },
    );
  }
  const scopes = serializeApiKeyScopes(requestedScopes as readonly string[]);

  const created = await db.$transaction(async (tx) => {
    const key = await tx.apiKey.create({
      data: {
        businessId: ctx.businessId,
        createdById: ctx.userId,
        name: input.name,
        prefix,
        keyHash,
        scopes,
      },
      select: {
        id: true,
        name: true,
        prefix: true,
        scopes: true,
        createdAt: true,
      },
    });
    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "api_key.create",
        entityType: "ApiKey",
        entityId: key.id,
        after: { name: key.name, prefix: key.prefix, scopes: key.scopes },
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
    return key;
  });

  // The ONLY response that ever contains the plaintext.
  return ok({ ...created, key: plaintext }, 201);
});
