/**
 * POST /api/v1/platform/payments/[id]/reverify (Prompt 28 §31).
 *
 * Calls the EXISTING provider verification abstraction (verifyCheckoutSession)
 * — the provider remains AUTHORITATIVE. The operator can NEVER set
 * SUCCEEDED/FAILED/CANCELED directly (§31/§33/§81): there is no request
 * field that could influence the outcome, and no generic result-forcing
 * endpoint exists anywhere in the app (the static scanner enforces this,
 * §127/§131).
 * Requires platform:payments:reverify, a reason, reauthentication (§56),
 * is rate-limited (§57) and audited (§34).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { route } from "@/lib/api-helpers";
import { assertPlatformReauth, getPlatformContext, platformError, requirePlatformPermission } from "@/lib/platform/auth";
import { parsePlatformBody, platformOk } from "@/lib/platform/http";
import { platformAudit, requestIdOf } from "@/lib/platform/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { verifyCheckoutSession } from "@/lib/payments/service";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  reason: z.string().trim().min(3).max(300),
  password: z.string().min(1).max(200).optional(),
});

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:payments:reverify");
  const { id } = await params;
  const body = await parsePlatformBody(req, bodySchema);

  const rl = rateLimit(`platform:${ctx.operatorId}:payment-reverify`, 10, 15 * 60_000);
  if (!rl.allowed) {
    throw platformError(429, "PLATFORM_INVALID_OPERATION", "Too many attempts. Try again later.");
  }

  await assertPlatformReauth(ctx, body.password);

  const session = await db.checkoutSession.findUnique({
    where: { id },
    select: { id: true, businessId: true, provider: true, status: true, amountMinor: true, currency: true },
  });
  if (!session) {
    throw platformError(404, "PLATFORM_INVALID_OPERATION", "Payment session not found.");
  }

  const requestId = requestIdOf(req);
  // Provider-authoritative verification — unknown provider / terminal
  // states surface as structured errors from the service itself.
  const outcome = await verifyCheckoutSession(session.businessId, session.id);

  await platformAudit({
    operatorId: ctx.operatorId,
    operatorRole: ctx.role,
    action: "payment.reverified",
    entityType: "CheckoutSession",
    entityId: session.id,
    targetBusinessId: session.businessId,
    reason: body.reason,
    before: { status: session.status },
    after: {
      status: outcome.session.status,
      verification: outcome.verification,
      provider: session.provider,
    },
    requestId,
    ip: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
  });

  return platformOk({
    verification: outcome.verification,
    session: {
      id: outcome.session.id,
      status: outcome.session.status,
      provider: outcome.session.provider,
      amountMinor: outcome.session.amountMinor,
      currency: outcome.session.currency,
      reconciliationReason: outcome.session.reconciliationReason,
    },
    requestId,
  });
});
