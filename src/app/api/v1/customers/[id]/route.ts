/**
 * PATCH  /api/v1/customers/[id] — update (data:write, audited).
 * DELETE /api/v1/customers/[id] — soft delete (data:write, audited).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { partyUpdateSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

async function loadCustomer(businessId: string, id: string) {
  const customer = await db.customer.findFirst({
    where: { id, businessId, deletedAt: null },
  });
  if (!customer) throw new ApiError(404, "NOT_FOUND", "Customer not found.");
  return customer;
}

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const before = await loadCustomer(ctx.businessId, id);
  const input = await parseBody(req, partyUpdateSchema);

  const updated = await db.$transaction(async (tx) => {
    const c = await tx.customer.update({ where: { id: before.id }, data: input });
    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "customer.update",
        entityType: "Customer",
        entityId: c.id,
        before,
        after: c,
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
    return c;
  });

  return ok(updated);
});

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const before = await loadCustomer(ctx.businessId, id);

  await db.$transaction(async (tx) => {
    await tx.customer.update({
      where: { id: before.id },
      data: { deletedAt: new Date() },
    });
    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "customer.delete",
        entityType: "Customer",
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
