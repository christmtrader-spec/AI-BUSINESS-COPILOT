/**
 * GET /api/v1/webhooks/[id]/deliveries — the recent delivery ledger for
 * ONE endpoint (newest first, bounded 20). Diagnostic, not a replay
 * queue: payloads are stored truncated (§W) and there is no retry.
 *
 * Permission: settings:read. Rate limited.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:read");

  const limit = rateLimit(`webhooks-deliveries:${ctx.userId}`, 60, 60_000);
  if (!limit.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests. Try again shortly.", {
      retryAfterMs: limit.retryAfterMs,
    });
  }

  const endpoint = await db.webhookEndpoint.findFirst({
    where: { id: id, businessId: ctx.businessId },
    select: { id: true },
  });
  if (!endpoint) {
    throw new ApiError(404, "WEBHOOK_NOT_FOUND", "Webhook endpoint not found.");
  }

  const items = await db.webhookDelivery.findMany({
    where: { endpointId: endpoint.id, businessId: ctx.businessId },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      event: true,
      status: true,
      ok: true,
      error: true,
      durationMs: true,
      createdAt: true,
    },
  });

  return ok({ items });
});
