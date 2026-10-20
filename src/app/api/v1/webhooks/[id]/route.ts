/**
 * PATCH  /api/v1/webhooks/[id] — pause/resume an endpoint or rotate its
 *        subscription (events) / target URL. The signing secret is NEVER
 *        changed here (rotation = delete + recreate, honest and simple).
 * DELETE /api/v1/webhooks/[id] — permanently delete an endpoint and its
 *        delivery ledger (cascade), audited.
 *
 * Permission: settings:manage (both). Rate limited. Audited.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { WEBHOOK_EVENTS, guardWebhookUrl, isWebhookEvent } from "@/lib/webhooks";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({
    active: z.boolean().optional(),
    url: z.string().trim().min(8).max(500).optional(),
    events: z
      .array(z.string())
      .min(1)
      .max(WEBHOOK_EVENTS.length)
      .refine((arr) => arr.every((e) => isWebhookEvent(e)), {
        message: "Unknown webhook event",
      })
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Empty update" });

async function loadOwned(id: string, businessId: string) {
  const endpoint = await db.webhookEndpoint.findFirst({
    where: { id, businessId },
    select: { id: true, url: true, events: true, active: true },
  });
  if (!endpoint) {
    throw new ApiError(404, "WEBHOOK_NOT_FOUND", "Webhook endpoint not found.");
  }
  return endpoint;
}

export const PATCH = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:manage");

  const limit = rateLimit(`webhooks-patch:${ctx.userId}`, 30, 60_000);
  if (!limit.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many updates. Try again shortly.", {
      retryAfterMs: limit.retryAfterMs,
    });
  }

  const existing = await loadOwned(id, ctx.businessId);

  const input = await parseBody(req, patchSchema);

  const data: { active?: boolean; url?: string; events?: string } = {};
  if (typeof input.active === "boolean") data.active = input.active;
  if (input.events) data.events = [...new Set(input.events)].join(",");
  if (input.url) {
    const guard = guardWebhookUrl(input.url);
    if (!guard.ok) {
      const message =
        guard.reason === "INSECURE_SCHEME"
          ? "Webhook URLs must use HTTPS."
          : guard.reason === "PRIVATE_HOST"
            ? "Private and internal network addresses are not allowed."
            : "That does not look like a valid URL.";
      throw new ApiError(422, `WEBHOOK_${guard.reason}`, message);
    }
    data.url = guard.url;
  }

  const updated = await db.$transaction(async (tx) => {
    const endpoint = await tx.webhookEndpoint.update({
      where: { id: existing.id },
      data: {
        ...data,
        // A manual resume or target change resets the failure streak —
        // the operator acted, so the auto-disable verdict is stale.
        ...(input.url !== undefined || input.active === true
          ? { failureCount: 0 }
          : {}),
      },
      select: { id: true, url: true, events: true, active: true },
    });
    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "webhook.update",
        entityType: "WebhookEndpoint",
        entityId: endpoint.id,
        before: { url: existing.url, events: existing.events, active: existing.active },
        after: { url: endpoint.url, events: endpoint.events, active: endpoint.active },
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
    return endpoint;
  });

  return ok(updated);
});

export const DELETE = route(async (req: NextRequest, { params }: RouteParams) => {
  const { id } = await params;
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:manage");

  const limit = rateLimit(`webhooks-delete:${ctx.userId}`, 30, 60_000);
  if (!limit.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many updates. Try again shortly.", {
      retryAfterMs: limit.retryAfterMs,
    });
  }

  const existing = await loadOwned(id, ctx.businessId);

  await db.$transaction(async (tx) => {
    await tx.webhookEndpoint.delete({ where: { id: existing.id } });
    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "webhook.delete",
        entityType: "WebhookEndpoint",
        entityId: existing.id,
        before: { url: existing.url, events: existing.events, active: existing.active },
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
  });

  return ok({ id: existing.id, deleted: true });
});
