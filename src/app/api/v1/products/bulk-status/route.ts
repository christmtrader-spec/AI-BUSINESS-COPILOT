/**
 * POST /api/v1/products/bulk-status — bulk activate/deactivate (R61-6).
 *
 * Body: { ids: string[] (1..200), isActive: boolean }.
 * Permission: data:write (same law as single-product PATCH). Rate limited.
 * Tenant law: the updateMany matches id AND businessId — a forged id from
 * another tenant simply doesn't match (A01/A02 by construction).
 * Audit: ONE entry (product.bulk_status) with the honest matched count —
 * per-product rows would flood the log for no forensic gain.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const BULK_MAX = 200;

const bulkSchema = z.object({
  ids: z.array(z.string().trim().min(1)).min(1).max(BULK_MAX),
  isActive: z.boolean(),
});

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const limit = rateLimit(`products-bulk:${ctx.userId}`, 20, 60_000);
  if (!limit.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many bulk operations. Try again shortly.", {
      retryAfterMs: limit.retryAfterMs,
    });
  }

  const input = await parseBody(req, bulkSchema);
  const uniqueIds = [...new Set(input.ids)];
  if (uniqueIds.length === 0) {
    throw new ApiError(422, "VALIDATION_ERROR", "No product ids provided.", { field: "ids" });
  }

  const result = await db.$transaction(async (tx) => {
    const updated = await tx.product.updateMany({
      where: { id: { in: uniqueIds }, businessId: ctx.businessId, deletedAt: null },
      data: { isActive: input.isActive },
    });
    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "product.bulk_status",
        entityType: "Product",
        entityId: null,
        after: {
          requested: uniqueIds.length,
          matched: updated.count,
          isActive: input.isActive,
        },
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
    return updated;
  });

  return ok({ matched: result.count, requested: uniqueIds.length, isActive: input.isActive });
});
