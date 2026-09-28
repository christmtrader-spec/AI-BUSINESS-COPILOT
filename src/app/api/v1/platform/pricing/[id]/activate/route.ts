/**
 * POST /api/v1/platform/pricing/[id]/activate — explicit PriceBook
 * activation (§36/§94). Validated by the PricingService (rows, currency,
 * window, overlap), requires reauthentication + reason, audited.
 * Reversible ONLY by activating another version (§36) — there is no
 * silent deactivation path.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { route } from "@/lib/api-helpers";
import { assertPlatformReauth, getPlatformContext, platformError, requirePlatformPermission } from "@/lib/platform/auth";
import { parsePlatformBody, platformOk } from "@/lib/platform/http";
import { platformAudit, requestIdOf } from "@/lib/platform/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-helpers";
import { activatePriceBook } from "@/lib/payments/pricing-service";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  reason: z.string().trim().min(3).max(300),
  password: z.string().min(1).max(200).optional(),
});

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:pricing:manage");
  const { id } = await params;
  const body = await parsePlatformBody(req, bodySchema);

  const rl = rateLimit(`platform:${ctx.operatorId}:pricebook-activate`, 10, 15 * 60_000);
  if (!rl.allowed) {
    throw platformError(429, "PLATFORM_INVALID_OPERATION", "Too many attempts. Try again later.");
  }

  await assertPlatformReauth(ctx, body.password);

  const requestId = requestIdOf(req);
  const activated = await activatePriceBook(id, { actorId: ctx.userId });

  await platformAudit({
    operatorId: ctx.operatorId,
    operatorRole: ctx.role,
    action: "pricing.book_activated",
    entityType: "PriceBook",
    entityId: activated.id,
    reason: body.reason,
    after: {
      code: activated.code,
      version: activated.version,
      currency: activated.currency,
      active: activated.active,
    },
    requestId,
    ip: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });

  return platformOk({ priceBook: activated, requestId });
});
