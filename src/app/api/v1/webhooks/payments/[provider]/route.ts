/**
 * POST /api/v1/webhooks/payments/[provider] — gateway callback (Prompt 22).
 *
 * NO session auth — this endpoint is called by payment providers. Trust is
 * established EXCLUSIVELY by per-provider signature verification over the
 * RAW request body (timing-safe HMAC + timestamp tolerance); anything that
 * fails verification is a 401 with a body that reveals nothing.
 *
 * Behavior:
 * - unknown/disabled provider slug → 404 (the route genuinely doesn't exist)
 * - verification failure → 401 (gateways retry; probes learn nothing)
 * - verified event → idempotent fulfillment (eventId dedupe + terminal
 *   state guards + idempotent plan change); ALWAYS 200 for verified
 *   deliveries so gateways stop retrying
 */
import { NextRequest, NextResponse } from "next/server";
import { route } from "@/lib/api-helpers";
import { findProvider } from "@/lib/payments/registry";
import { fulfillWebhook } from "@/lib/payments/service";
import { WebhookVerificationError } from "@/lib/payments/types";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export const POST = route(
  async (req: NextRequest, { params }: { params: Promise<{ provider: string }> }) => {
    const { provider: slug } = await params;
    const provider = findProvider(slug);
    if (!provider) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: "Not found." } },
        { status: 404 },
      );
    }

    // Generous per-IP limit — gateways legitimately burst on retries.
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const rl = rateLimit(`webhook:payments:${ip}`, 120, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { ok: false, error: { code: "RATE_LIMITED", message: "Too many requests." } },
        { status: 429 },
      );
    }

    // The RAW body is what the provider signed — never a re-serialization.
    const rawBody = await req.text();

    let event;
    try {
      event = provider.verifyWebhook(rawBody, req.headers);
    } catch (error) {
      if (error instanceof WebhookVerificationError) {
        return NextResponse.json(
          { ok: false, error: { code: "WEBHOOK_UNVERIFIED", message: "Verification failed." } },
          { status: 401 },
        );
      }
      throw error;
    }

    const result = await fulfillWebhook(provider.slug, event);
    return NextResponse.json({ ok: true, data: result }, { status: 200 });
  },
);
