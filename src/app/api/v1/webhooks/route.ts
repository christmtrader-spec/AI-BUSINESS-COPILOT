/**
 * GET  /api/v1/webhooks — list the business's webhook endpoints (metadata
 *      only — the signing secret is NEVER retrievable).
 * POST /api/v1/webhooks — create an endpoint. The response contains the
 *      signing secret EXACTLY ONCE; the DB stores only its secret-box
 *      envelope (AES-256-GCM, §188-§197).
 *
 * Permission: settings:read (list) / settings:manage (create) — the same
 * law as the §F8 API-keys surface. Rate limited. Audited.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext, requirePermission } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import {
  WEBHOOK_EVENTS,
  WEBHOOK_MAX_ACTIVE,
  generateWebhookSecret,
  guardWebhookUrl,
  isWebhookEvent,
} from "@/lib/webhooks";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const eventsSchema = z
  .array(z.string())
  .min(1)
  .max(WEBHOOK_EVENTS.length)
  .refine((arr) => arr.every((e) => isWebhookEvent(e)), {
    message: "Unknown webhook event",
  })
  .transform((arr) => [...new Set(arr)]);

const createSchema = z.object({
  url: z.string().trim().min(8).max(500),
  events: eventsSchema,
});

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:read");

  const items = await db.webhookEndpoint.findMany({
    where: { businessId: ctx.businessId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      url: true,
      prefix: true,
      events: true,
      active: true,
      failureCount: true,
      lastStatus: true,
      lastDeliveryAt: true,
      createdAt: true,
      createdBy: { select: { name: true, email: true } },
    },
  });

  return ok({ items, allowedEvents: WEBHOOK_EVENTS });
});

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  requirePermission(ctx, "settings:manage");

  const limit = rateLimit(`webhooks-create:${ctx.userId}`, 10, 60 * 60_000);
  if (!limit.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many endpoints created recently.", {
      retryAfterMs: limit.retryAfterMs,
    });
  }

  const input = await parseBody(req, createSchema);

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

  const activeCount = await db.webhookEndpoint.count({
    where: { businessId: ctx.businessId, active: true },
  });
  if (activeCount >= WEBHOOK_MAX_ACTIVE) {
    throw new ApiError(
      422,
      "WEBHOOK_LIMIT_REACHED",
      `Delete or pause an existing endpoint first (max ${WEBHOOK_MAX_ACTIVE} active).`,
    );
  }

  const { plaintext, prefix, secretBox } = generateWebhookSecret();

  const created = await db.$transaction(async (tx) => {
    const endpoint = await tx.webhookEndpoint.create({
      data: {
        businessId: ctx.businessId,
        createdById: ctx.userId,
        url: guard.url,
        prefix,
        secretBox,
        events: input.events.join(","),
        active: true,
      },
    });
    await audit(
      {
        businessId: ctx.businessId,
        actorId: ctx.userId,
        action: "webhook.create",
        entityType: "WebhookEndpoint",
        entityId: endpoint.id,
        after: { url: endpoint.url, events: input.events },
        ip: req.headers.get("x-forwarded-for"),
        userAgent: req.headers.get("user-agent"),
      },
      tx,
    );
    return endpoint;
  });

  return ok(
    {
      id: created.id,
      url: created.url,
      prefix: created.prefix,
      events: created.events,
      // The plaintext secret exists EXACTLY ONCE — this response.
      secret: plaintext,
      createdAt: created.createdAt,
    },
    201,
  );
});
