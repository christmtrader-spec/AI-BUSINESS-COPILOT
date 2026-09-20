/**
 * GET  /api/v1/suppliers — list (search + pagination, soft-delete aware).
 * POST /api/v1/suppliers — create (data:write, audited).
 */
import { NextRequest } from "next/server";
import { ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { listParams, partyCreateSchema } from "@/lib/schemas";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:read");

  const { q, page, pageSize } = listParams(new URL(req.url));
  const where = {
    businessId: ctx.businessId,
    deletedAt: null,
    ...(q
      ? {
          OR: [
            { name: { contains: q } },
            { phone: { contains: q } },
            { email: { contains: q } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    db.supplier.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.supplier.count({ where }),
  ]);

  return ok({ items, total, page, pageSize });
});

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const input = await parseBody(req, partyCreateSchema);

  const supplier = await db.$transaction(async (tx) => {
    const created = await tx.supplier.create({
      data: { ...input, businessId: ctx.businessId },
    });
    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "supplier.create",
        entityType: "Supplier",
        entityId: created.id,
        after: created,
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
    return created;
  });

  return ok(supplier, 201);
});
