/**
 * PATCH  /api/v1/suppliers/[id] — update (data:write, audited).
 * DELETE /api/v1/suppliers/[id] — soft delete (data:write, audited).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { partyUpdateSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

async function loadSupplier(businessId: string, id: string) {
  const supplier = await db.supplier.findFirst({
    where: { id, businessId, deletedAt: null },
  });
  if (!supplier) throw new ApiError(404, "NOT_FOUND", "Supplier not found.");
  return supplier;
}

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const before = await loadSupplier(ctx.businessId, id);
  const input = await parseBody(req, partyUpdateSchema);

  const updated = await db.$transaction(async (tx) => {
    const s = await tx.supplier.update({ where: { id: before.id }, data: input });
    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "supplier.update",
        entityType: "Supplier",
        entityId: s.id,
        before,
        after: s,
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
    return s;
  });

  return ok(updated);
});

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const before = await loadSupplier(ctx.businessId, id);

  await db.$transaction(async (tx) => {
    await tx.supplier.update({
      where: { id: before.id },
      data: { deletedAt: new Date() },
    });
    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "supplier.delete",
        entityType: "Supplier",
        entityId: before.id,
        before,
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
  });

  return ok({ deleted: true });
});
