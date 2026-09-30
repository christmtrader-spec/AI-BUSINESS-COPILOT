import "server-only";
import { db } from "@/lib/db";
import { logError, logInfo } from "@/lib/observability/logger";
import { OPERATIONAL_EVENTS, type OperationalEvent } from "@/lib/observability/events";
import { NOTIFICATION_CATALOG, isNotificationType, type NotificationType } from "./catalog";
import { notificationEmailMaxAttempts, notificationStaleDeliveryMinutes } from "./config";
import { emailChannel } from "./channels";
import type { DeliveryFailureCode } from "./types";

/**
 * Email delivery dispatcher — Prompt 32 §44/§45/§73/§142/§143/§145/§146/§358.
 *
 * Order guarantee (§358): Notification + Delivery=PENDING are COMMITTED
 * before any send attempt (never "email sent but row rolled back").
 *
 * Concurrency (§145): the PENDING → PROCESSING claim is an ATOMIC guarded
 * update — two processes can never send the same delivery simultaneously
 * on this single-node deployment.
 *
 * Crash recovery (§146/§360): deliveries stuck in PROCESSING are marked
 * FAILED (STALE_PROCESSING) — they are NEVER blindly resent (no true
 * provider-level exactly-once exists, §147). A platform operator may retry
 * a FAILED optional email explicitly, accepting the documented duplicate
 * risk (§260/§262).
 */

/** Safe operational log (§131) — ids/type/status only, never payloads. */
function logDelivery(
  event: OperationalEvent,
  fields: {
    deliveryId: string;
    notificationId: string;
    type: NotificationType;
    status: string;
    failureCode?: string;
    durationMs?: number;
    requestId?: string;
  },
): void {
  logInfo(event, fields);
}

/**
 * Claim one delivery atomically: PENDING → PROCESSING (§359). Returns null
 * when the row was already claimed, canceled or is unknown.
 */
async function claimDelivery(deliveryId: string): Promise<{ notificationId: string; attemptCount: number } | null> {
  const claimed = await db.notificationDelivery.updateMany({
    where: { id: deliveryId, status: "PENDING", channel: "EMAIL" },
    data: {
      status: "PROCESSING",
      attemptCount: { increment: 1 },
      lastAttemptAt: new Date(),
    },
  });
  if (claimed.count === 0) return null;
  const row = await db.notificationDelivery.findUnique({
    where: { id: deliveryId },
    select: { notificationId: true, attemptCount: true },
  });
  return row ? { notificationId: row.notificationId, attemptCount: row.attemptCount } : null;
}

/**
 * Dispatch one committed EMAIL delivery. Fire-safe: every failure path
 * resolves to a terminal delivery state — it never throws into the domain
 * flow that triggered the notification (§137).
 */
export async function dispatchEmailDelivery(deliveryId: string, requestId?: string | null): Promise<void> {
  const startedAt = Date.now();
  try {
    const claimed = await claimDelivery(deliveryId);
    if (!claimed) return; // already claimed/terminal — another path owns it

    const delivery = await db.notificationDelivery.findUnique({
      where: { id: deliveryId },
      include: {
        notification: {
          select: { id: true, userId: true, type: true, dataJson: true, actionRoute: true },
        },
      },
    });
    if (!delivery) return;
    if (!isNotificationType(delivery.notification.type)) {
      await db.notificationDelivery.update({
        where: { id: deliveryId },
        data: { status: "FAILED", failedAt: new Date(), failureCode: "UNKNOWN" },
      });
      return;
    }
    const type = delivery.notification.type as NotificationType;

    let data: Record<string, unknown> | null = null;
    if (delivery.notification.dataJson) {
      try {
        data = JSON.parse(delivery.notification.dataJson) as Record<string, unknown>;
      } catch {
        data = null;
      }
    }

    const user = await db.user.findUnique({
      where: { id: delivery.notification.userId },
      select: { email: true, emailVerifiedAt: true, locale: true },
    });
    if (!user) {
      await db.notificationDelivery.update({
        where: { id: deliveryId },
        data: { status: "FAILED", failedAt: new Date(), failureCode: "INVALID_RECIPIENT" },
      });
      logDelivery(OPERATIONAL_EVENTS.notificationDeliveryFailed, {
        deliveryId, notificationId: delivery.notification.id, type, status: "FAILED",
        failureCode: "INVALID_RECIPIENT", durationMs: Date.now() - startedAt, requestId: requestId ?? undefined,
      });
      return;
    }

    const maxAttempts = notificationEmailMaxAttempts();
    if (claimed.attemptCount > maxAttempts) {
      // Attempt cap (§45/§361) — terminal failure, operational log emitted.
      await db.notificationDelivery.update({
        where: { id: deliveryId },
        data: { status: "FAILED", failedAt: new Date(), failureCode: "ATTEMPTS_EXHAUSTED" },
      });
      logDelivery(OPERATIONAL_EVENTS.notificationDeliveryExhausted, {
        deliveryId, notificationId: delivery.notification.id, type, status: "FAILED",
        failureCode: "ATTEMPTS_EXHAUSTED", durationMs: Date.now() - startedAt, requestId: requestId ?? undefined,
      });
      return;
    }

    const result = await emailChannel.deliver({
      notificationId: delivery.notification.id,
      deliveryId,
      type,
      data,
      recipient: {
        userId: delivery.notification.userId,
        email: user.email,
        emailVerifiedAt: user.emailVerifiedAt,
        locale: user.locale === "fa" ? "fa" : "en",
      },
      // The email renderer resolves the CTA URL itself from trusted config.
      actionUrl: null,
    });

    if (result.outcome === "SENT") {
      await db.notificationDelivery.update({
        where: { id: deliveryId },
        data: {
          status: "SENT",
          sentAt: new Date(),
          providerMessageId: result.providerMessageId,
          failureCode: null,
        },
      });
      logDelivery(OPERATIONAL_EVENTS.notificationDeliverySent, {
        deliveryId, notificationId: delivery.notification.id, type, status: "SENT",
        durationMs: Date.now() - startedAt, requestId: requestId ?? undefined,
      });
    } else {
      await db.notificationDelivery.update({
        where: { id: deliveryId },
        data: { status: "FAILED", failedAt: new Date(), failureCode: result.failureCode },
      });
      logDelivery(OPERATIONAL_EVENTS.notificationDeliveryFailed, {
        deliveryId, notificationId: delivery.notification.id, type, status: "FAILED",
        failureCode: result.failureCode, durationMs: Date.now() - startedAt, requestId: requestId ?? undefined,
      });
    }
  } catch (error) {
    // The dispatcher itself must never crash the caller (§137/§307).
    logError(OPERATIONAL_EVENTS.notificationDeliveryDispatchError, {
      deliveryId,
      error: error instanceof Error ? error.name : "unknown",
    });
    try {
      await db.notificationDelivery.updateMany({
        where: { id: deliveryId, status: "PROCESSING" },
        data: { status: "FAILED", failedAt: new Date(), failureCode: "UNKNOWN" },
      });
    } catch {
      /* secondary failure already logged above */
    }
  }
}

/**
 * Platform operator retry (§260) — ONLY for FAILED email deliveries whose
 * notification type has an OPTIONAL (preference-controlled) email channel.
 * MANDATORY security emails are never resent through this path (§260/§261:
 * no reset link/MFA code/recovery code can ever flow through a retry).
 */
export async function retryFailedEmailDelivery(deliveryId: string): Promise<
  { retried: true } | { retried: false; code: "NOT_FOUND" | "NOT_FAILED" | "MANDATORY_CHANNEL" | "ATTEMPTS_EXHAUSTED" }
> {
  const delivery = await db.notificationDelivery.findUnique({
    where: { id: deliveryId },
    include: { notification: { select: { type: true } } },
  });
  if (!delivery) return { retried: false, code: "NOT_FOUND" };
  if (delivery.status !== "FAILED" || delivery.channel !== "EMAIL") {
    return { retried: false, code: "NOT_FAILED" };
  }
  if (!isNotificationType(delivery.notification.type)) {
    return { retried: false, code: "NOT_FAILED" };
  }
  const entry = NOTIFICATION_CATALOG[delivery.notification.type as NotificationType];
  if (entry.channels.EMAIL === "ALWAYS") {
    return { retried: false, code: "MANDATORY_CHANNEL" };
  }
  if (delivery.attemptCount >= notificationEmailMaxAttempts()) {
    return { retried: false, code: "ATTEMPTS_EXHAUSTED" };
  }
  // Back to PENDING (FAILED → PROCESSING is valid per §143; we re-queue
  // through the standard claim so the attempt counter stays authoritative).
  await db.notificationDelivery.updateMany({
    where: { id: deliveryId, status: "FAILED", channel: "EMAIL" },
    data: { status: "PENDING", failureCode: null },
  });
  await dispatchEmailDelivery(deliveryId);
  return { retried: true };
}

/**
 * Stale PROCESSING recovery (§146/§308/§360): rows stuck longer than the
 * configured threshold are marked FAILED (STALE_PROCESSING). Never resent
 * automatically. Returns the number of recovered rows (operational metric).
 */
export async function reapStaleEmailDeliveries(): Promise<number> {
  const cutoff = new Date(Date.now() - notificationStaleDeliveryMinutes() * 60_000);
  const reaped = await db.notificationDelivery.updateMany({
    where: {
      channel: "EMAIL",
      status: "PROCESSING",
      lastAttemptAt: { lt: cutoff },
    },
    data: { status: "FAILED", failedAt: new Date(), failureCode: "STALE_PROCESSING" },
  });
  if (reaped.count > 0) {
    logInfo(OPERATIONAL_EVENTS.notificationDeliveryStaleReaped, { count: reaped.count });
  }
  return reaped.count;
}

export type PlatformDeliverySummary = {
  total: number;
  pending: number;
  processing: number;
  sent: number;
  failed: number;
  skipped: number;
  topFailedTypes: { type: string; count: number }[];
};

/**
 * Read-only platform diagnostics (§257/§259/§262/§264) — counts and
 * normalized failure codes ONLY. Message bodies and provider details are
 * never included (§259/§262).
 */
export async function platformDeliverySummary(): Promise<PlatformDeliverySummary> {
  const [total, pending, processing, sent, failed, skipped] = await Promise.all([
    db.notificationDelivery.count(),
    db.notificationDelivery.count({ where: { status: "PENDING" } }),
    db.notificationDelivery.count({ where: { status: "PROCESSING" } }),
    db.notificationDelivery.count({ where: { status: "SENT" } }),
    db.notificationDelivery.count({ where: { status: "FAILED" } }),
    db.notificationDelivery.count({ where: { status: "SKIPPED" } }),
  ]);
  // Top failed TYPES (operator-facing) — from notifications joined on failed deliveries.
  const failedRows = await db.notificationDelivery.findMany({
    where: { status: "FAILED" },
    select: { notification: { select: { type: true } } },
    take: 1000,
  });
  const typeCounts = new Map<string, number>();
  for (const row of failedRows) {
    if (!row.notification?.type) continue;
    typeCounts.set(row.notification.type, (typeCounts.get(row.notification.type) ?? 0) + 1);
  }
  const topFailedTypes = [...typeCounts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);
  return {
    total,
    pending,
    processing,
    sent,
    failed,
    skipped,
    topFailedTypes,
  };
}

/** Re-exported failure-code type for platform diagnostics consumers. */
export type { DeliveryFailureCode };
