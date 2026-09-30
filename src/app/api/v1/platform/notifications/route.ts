/**
 * GET /api/v1/platform/notifications — READ-ONLY platform diagnostics
 * (Prompt 32 §257/§259/§262/§379). Counts, top failed notification types
 * and catalog/template health. NO message bodies, NO raw provider output,
 * NO internal storage paths (§259/§262). Gated by `platform:system:read`.
 */
import { ok, route } from "@/lib/api-helpers";
import { getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { platformAudit } from "@/lib/platform/audit";
import {
  platformDeliverySummary,
  notificationCatalogHealth,
  reapStaleEmailDeliveries,
} from "@/lib/notifications";
import { notificationEmailTransportConfigured } from "@/lib/notifications/config";
import { notificationEmailMaxAttempts, notificationRetentionDays } from "@/lib/notifications/config";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const ctx = await getPlatformContext();
  requirePlatformPermission(ctx, "platform:system:read");

  // Opportunistic stale-delivery recovery makes the diagnostics view the
  // single safe place where stuck rows are reconciled (§146/§308) — it only
  // MARKS rows FAILED, never resends (§365: no mass retry).
  const reaped = await reapStaleEmailDeliveries();

  const [delivery, catalog] = await Promise.all([
    platformDeliverySummary(),
    Promise.resolve(notificationCatalogHealth()),
  ]);

  await platformAudit({
    operatorId: ctx.operatorId,
    operatorRole: ctx.role,
    action: "platform.notifications.diagnostics_viewed",
    entityType: "NotificationPlatform",
    entityId: null,
    after: { reaped },
  });

  return ok({
    delivery,
    catalog,
    emailTransport: {
      // Safe readiness state only — never provider details (§259).
      configured: notificationEmailTransportConfigured(),
      maxAttempts: notificationEmailMaxAttempts(),
    },
    cleanup: {
      retentionDays: notificationRetentionDays(),
    },
  });
});
