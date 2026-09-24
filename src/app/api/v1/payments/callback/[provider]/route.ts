/**
 * GET /api/v1/payments/callback/[provider] — provider redirect return (Prompt 23 §18/§19).
 *
 * The URL a REDIRECT-based provider sends the user back to after the
 * provider-hosted payment page. SECURITY MODEL:
 *
 * - NO session auth — the caller is the PROVIDER's browser redirect.
 * - Query values (Zarinpal: Authority / Status) are UNTRUSTED: they only
 *   LOCATE the internal attempt. `Status=OK` alone NEVER marks success —
 *   the outcome comes exclusively from server-side verification (§19/§20).
 * - The response is a 302 to the in-app return page built from the
 *   CONFIGURED base URL (never from the request Host header, §104) — there
 *   is no open-redirect surface: the destination is always internal.
 * - Unknown provider / unparseable callback / unknown reference → a
 *   uniform redirect to the return page without a session id (no probing
 *   oracle — a forged Authority and a garbage Authority look the same).
 *
 * This endpoint is deliberately separate from the webhook route: webhooks
 * are server-to-server POSTs with signature verification; this is a USER's
 * browser arriving from the provider (no secrets, no trust).
 */
import { NextRequest, NextResponse } from "next/server";
import { handleProviderCallback } from "@/lib/payments/service";
import { validatePaymentConfig } from "@/lib/payments/config";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

function redirectBack(sessionId: string | null): NextResponse {
  // §41 — the return page verifies; it never asserts success on its own.
  // Destination is always the app root — no open-redirect surface (§104).
  const base = validatePaymentConfig().baseUrl || "http://localhost:3000";
  const target = new URL("/", base);
  if (sessionId) target.searchParams.set("payment_return", sessionId);
  return NextResponse.redirect(target.toString(), { status: 302 });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
): Promise<NextResponse> {
  const { provider } = await params;

  // Modest per-IP limit — this route triggers at most ONE bounded provider
  // verification per hit; generous enough for real user flows (§60).
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rl = rateLimit(`payments:callback:${ip}`, 30, 60_000);
  if (!rl.allowed) {
    return redirectBack(null);
  }

  let sessionId: string | null = null;
  try {
    const outcome = await handleProviderCallback(provider, req.nextUrl.searchParams);
    sessionId = outcome.found ? (outcome.sessionId ?? null) : null;
  } catch {
    // Never leak adapter internals to the browser (§56) — uniform redirect.
    sessionId = null;
  }

  return redirectBack(sessionId);
}
