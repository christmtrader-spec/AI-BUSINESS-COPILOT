/**
 * GET  /api/v1/customers — list (search + pagination, soft-delete aware).
 * POST /api/v1/customers — create (data:write, audited, plan-limited).
 *
 * Prompt 20: creation is gated by the CUSTOMERS_MAX entitlement (§27/§32).
 * The limit check + count + create happen inside ONE serializable
 * transaction so two concurrent requests can never both pass the limit
 * boundary (§112 — SQLite single-writer makes this atomic; distributed
 * locking is out of scope by design). Soft-deleted customers do NOT count
 * toward the limit (§105/§106 policy, documented in entitlements.md).
 * Existing customers are grandfathered on downgrade — never deleted.
 */
import { NextRequest } from "next/server";
import { ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { listParams, partyCreateSchema } from "@/lib/schemas";
import { assertWithinLimitIn, getEntitlementContextTx } from "@/lib/billing";
import { dispatchWebhooks } from "@/lib/webhooks";

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
    db.customer.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.customer.count({ where }),
  ]);

  return ok({ items, total, page, pageSize });
});

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "data:write");

  const input = await parseBody(req, partyCreateSchema);

  const customer = await db.$transaction(
    async (tx) => {
      // Billing gate (§27): fresh entitlement read + usage count INSIDE the
      // creation transaction — race-safe on SQLite (single writer).
      const bctx = await getEntitlementContextTx(tx, ctx.businessId);
      const usage = await tx.customer.count({
        where: { businessId: ctx.businessId, deletedAt: null },
      });
      assertWithinLimitIn(bctx, "CUSTOMERS_MAX", usage);

      const created = await tx.customer.create({
        data: { ...input, businessId: ctx.businessId },
      });
      await audit(
        {
          businessId: ctx.businessId,
          actorId: ctx.userId,
          action: "customer.create",
          entityType: "Customer",
          entityId: created.id,
          after: created,
          ip: req.headers.get("x-forwarded-for"),
          userAgent: req.headers.get("user-agent"),
        },
        tx,
      );
      return created;
    },
    { isolationLevel: "Serializable" },
  );

  // §W — fire-and-forget AFTER commit; a webhook can never break a customer.
  void dispatchWebhooks(ctx.businessId, "customer.created", {
    id: customer.id,
    name: customer.name,
    email: customer.email ?? null,
    phone: customer.phone ?? null,
  });

  return ok(customer, 201);
});
