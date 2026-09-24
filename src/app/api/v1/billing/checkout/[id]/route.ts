/**
 * GET /api/v1/billing/checkout/[id] — checkout session status.
 *
 * Membership-scoped (404 for other tenants' sessions — indistinguishable
 * from nonexistent). Applies LAZY EXPIRY (PENDING past expiresAt →
 * EXPIRED) and fulfillment AUTO-HEAL (SUCCEEDED without fulfilledAt →
 * idempotent plan change re-run).
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext } from "@/lib/tenant";
import { getCheckoutSession } from "@/lib/payments";

export const dynamic = "force-dynamic";

export const GET = route(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await getAuthContext(req);
    const { id } = await params;
    const session = await getCheckoutSession(ctx.businessId, id);
    return ok({ checkoutSession: session });
  },
);
