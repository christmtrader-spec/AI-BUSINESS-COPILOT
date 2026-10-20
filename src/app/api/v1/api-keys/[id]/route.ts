/**
 * DELETE /api/v1/api-keys/[id] — revoke a key (immediate; soft-revoke via
 * revokedAt so request history stays auditable).
 *
 * Permission: settings:manage. Audited.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:manage");

  const key = await db.apiKey.findFirst({
    where: { id, businessId: ctx.businessId },
    select: { id: true, name: true, prefix: true, revokedAt: true },
  });
  if (!key) throw new ApiError(404, "NOT_FOUND", "API key not found.");
  if (key.revokedAt) {
    throw new ApiError(409, "ALREADY_REVOKED", "This API key is already revoked.");
  }

  await db.$transaction(async (tx) => {
    await tx.apiKey.update({
      where: { id: key.id },
      data: { revokedAt: new Date() },
    });
    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "api_key.revoke",
        entityType: "ApiKey",
        entityId: key.id,
        before: { name: key.name, prefix: key.prefix },
        after: { revoked: true },
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
  });

  return ok({ revoked: true });
});
