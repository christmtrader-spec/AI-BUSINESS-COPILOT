/**
 * POST /api/v1/billing/checkout/[id]/verify — server-side payment
 * verification (Prompt 23 §20).
 *
 * Called by the payment return page (and by owners manually) after the
 * user comes back from a redirect-based provider. The BROWSER never
 * decides the outcome — this endpoint asks the PROVIDER, server-to-server,
 * and only a fully verified success (amount §21 + currency §22 + reference
 * §23) reaches the subscription activation (§48).
 *
 * Security:
 * - authenticated + business membership; OWNER/ADMIN only (mutation path)
 * - the session must belong to the caller's business (404 otherwise —
 *   indistinguishable from nonexistent, tenant isolation §115)
 * - rate limited 10/min per user — the browser may re-verify deliberately
 *   (§68: bounded, no uncontrolled provider request loops)
 * - safe responses only: normalized session state, no provider payloads
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { verifyCheckoutSession } from "@/lib/payments";

export const dynamic = "force-dynamic";

export const POST = route(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const ctx = await getAuthContext(req);
    requirePermission(ctx, "settings:manage");

    const rl = rateLimit(`billing:verify:${ctx.userId}`, 10, 60_000);
    if (!rl.allowed) {
      return ok({
        checkoutSession: null,
        verification: "RATE_LIMITED",
      });
    }

    const { id } = await params;
    const outcome = await verifyCheckoutSession(ctx.businessId, id);
    return ok(outcome);
  },
);
