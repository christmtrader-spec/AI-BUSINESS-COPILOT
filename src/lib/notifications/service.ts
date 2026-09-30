import "server-only";
import { db } from "@/lib/db";
import { logError, logInfo } from "@/lib/observability/logger";
import { OPERATIONAL_EVENTS } from "@/lib/observability/events";
import { NOTIFICATION_CATALOG, type NotificationType } from "./catalog";
import { sanitizeNotificationData, NotificationDataViolation } from "./dedupe";
import { resolveChannelDecision, isEmailRecipientEligible, optionalEmailFlooded } from "./policies";
import { resolvePreferenceEnabled } from "./preferences";
import { dispatchEmailDelivery } from "./dispatcher";

/**
 * notify() — the single entry point for notification creation (§71).
 *
 * Pipeline (§71):
 *   1. validate type against the closed catalog
 *   2. validate data against the per-type schema (§354 — a notification with
 *      missing required data is rejected BEFORE persistence; no malformed
 *      email can ever be rendered from it)
 *   3. sanitize data (forbidden keys, size cap — §26/§231)
 *   4. dedupe on (recipient, type, sourceEventId) via the DB unique index
 *      (§28/§30) — an API/domain retry can never flood the user
 *   5. resolve channel policies server-side (§10/§18 — the browser is never
 *      the authority; mandatory channels ignore preferences entirely)
 *   6. create the Notification + per-channel Delivery rows in ONE
 *      transaction (§73 — durable PENDING rows exist before any send)
 *   7. dispatch EMAIL only AFTER the creating transaction commits (§74/§358)
 *   8. record the outcome on the delivery row (SENT/FAILED)
 *
 * TRANSACTION BOUNDARY (§72/§136): a notification failure must NEVER break
 * a domain transaction. All domain call sites use `notifyFailSafe`, which
 * catches everything and records a safe operational log. Mandatory security
 * notifications are also fire-safe (§139): a failed in-app write never
 * rolls back the security mutation that produced it — the mandatory EMAIL
 * channel provides redundancy.
 */

export class NotificationCreateError extends Error {
  constructor(
    public readonly code:
      | "NOTIFICATION_TYPE_UNKNOWN"
      | "NOTIFICATION_DATA_INVALID"
      | "NOTIFICATION_RECIPIENT_UNKNOWN",
    public readonly status: number,
  ) {
    super(code);
    this.name = "NotificationCreateError";
  }
}

export type NotifyInput = {
  /** Recipient — resolved SERVER-SIDE by the caller from session/domain data (§19). */
  userId: string;
  /** Business context when the notification is business-scoped (§20). */
  businessId?: string | null;
  type: NotificationType;
  /** Server-generated idempotency key (§29) — REQUIRED for event-derived types. */
  sourceEventId: string;
  /** Schema-validated safe data (§23). */
  data?: Record<string, unknown>;
  /** Request correlation for observability only (§309). */
  requestId?: string | null;
};

export type NotifyResult = {
  created: boolean;
  duplicate: boolean;
  notificationId: string | null;
};

/** Recipient projection loaded once per notify() call. */
type RecipientInfo = {
  email: string;
  emailVerifiedAt: Date | null;
  locale: "en" | "fa";
};

export async function notify(input: NotifyInput): Promise<NotifyResult> {
  const entry = NOTIFICATION_CATALOG[input.type]; // TS-narrowed; runtime guard below
  if (!entry) {
    throw new NotificationCreateError("NOTIFICATION_TYPE_UNKNOWN", 422);
  }
  if (!input.userId || typeof input.userId !== "string" || input.userId.length > 64) {
    throw new NotificationCreateError("NOTIFICATION_RECIPIENT_UNKNOWN", 422);
  }
  if (!input.sourceEventId || typeof input.sourceEventId !== "string" || input.sourceEventId.length > 300) {
    throw new NotificationCreateError("NOTIFICATION_DATA_INVALID", 422);
  }

  // 2+3 — per-type schema validation then defense-in-depth sanitization.
  let validated: Record<string, unknown> | null = null;
  if (input.data !== undefined && input.data !== null) {
    const parsed = entry.dataSchema.safeParse(input.data);
    if (!parsed.success) {
      throw new NotificationCreateError("NOTIFICATION_DATA_INVALID", 422);
    }
    try {
      validated = sanitizeNotificationData(parsed.data as Record<string, unknown>);
    } catch (error) {
      if (error instanceof NotificationDataViolation) {
        throw new NotificationCreateError("NOTIFICATION_DATA_INVALID", 422);
      }
      throw error;
    }
  }

  // Recipient (§48 — email resolved server-side from User).
  const user = await db.user.findUnique({
    where: { id: input.userId },
    select: { email: true, emailVerifiedAt: true, locale: true },
  });
  if (!user) {
    throw new NotificationCreateError("NOTIFICATION_RECIPIENT_UNKNOWN", 422);
  }
  const recipient: RecipientInfo = {
    email: user.email,
    emailVerifiedAt: user.emailVerifiedAt,
    locale: user.locale === "fa" ? "fa" : "en",
  };

  // 5 — channel decisions (server-authoritative).
  const inAppDecision = resolveChannelDecision(entry, "IN_APP", null);
  const emailDecision = resolveChannelDecision(
    entry,
    "EMAIL",
    entry.channels.EMAIL === "IF_ENABLED"
      ? await resolvePreferenceEnabled(input.userId, input.type, "EMAIL")
      : null,
  );
  const emailEligible = isEmailRecipientEligible(entry, recipient.emailVerifiedAt);
  const emailFlooded =
    emailDecision.deliver && !emailDecision.mandatory && (await optionalEmailFlooded(input.userId));

  const emailDeliver =
    emailDecision.deliver && emailEligible.eligible && !emailFlooded;
  const emailSkipCode = !emailDecision.deliver
    ? emailDecision.reason === "POLICY_NEVER"
      ? "POLICY_NEVER"
      : "PREFERENCE_DISABLED"
    : !emailEligible.eligible
      ? "RECIPIENT_UNVERIFIED"
      : emailFlooded
        ? "FLOOD_LIMIT"
        : null;

  const expiresAt =
    entry.expiresAfterDays !== null
      ? new Date(Date.now() + entry.expiresAfterDays * 86_400_000)
      : null;

  // 6 — notification + delivery rows committed together (§73).
  let notificationId: string;
  try {
    const created = await db.$transaction(async (tx) => {
      const notification = await tx.notification.create({
        data: {
          userId: input.userId,
          businessId: input.businessId ?? null,
          type: entry.type,
          category: entry.category,
          priority: entry.priority,
          severity: entry.severity,
          titleKey: entry.titleKey,
          bodyKey: entry.bodyKey,
          dataJson: validated ? JSON.stringify(validated) : null,
          actionRoute: entry.actionRoute,
          sourceEventId: input.sourceEventId,
          expiresAt,
        },
      });
      if (inAppDecision.deliver) {
        // The persisted row IS the in-app delivery (§34) — recorded as SENT.
        await tx.notificationDelivery.create({
          data: {
            notificationId: notification.id,
            channel: "IN_APP",
            status: "SENT",
            attemptCount: 1,
            lastAttemptAt: new Date(),
            sentAt: new Date(),
          },
        });
      }
      if (entry.channels.EMAIL !== "NEVER") {
        // §32/§142 — the EMAIL delivery row ALWAYS exists (PENDING when it
        // will dispatch, SKIPPED with the normalized reason otherwise) so
        // the per-notification channel decision is fully auditable.
        await tx.notificationDelivery.create({
          data: {
            notificationId: notification.id,
            channel: "EMAIL",
            status: emailDeliver ? "PENDING" : "SKIPPED",
            failureCode: emailDeliver ? null : emailSkipCode,
          },
        });
      }
      return notification;
    });
    notificationId = created.id;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      // 4 — dedupe hit: the same logical event already notified (§28/§305).
      const existing = await db.notification.findFirst({
        where: {
          userId: input.userId,
          type: input.type,
          sourceEventId: input.sourceEventId,
        },
        select: { id: true },
      });
      return { created: false, duplicate: true, notificationId: existing?.id ?? null };
    }
    throw error;
  }

  // 7+8 — EMAIL dispatch strictly after commit (§74/§75/§358). Fire-safe:
  // dispatchEmailDelivery never throws into the domain path (§137).
  if (emailDeliver) {
    const delivery = await db.notificationDelivery.findFirst({
      where: { notificationId, channel: "EMAIL", status: "PENDING" },
      select: { id: true },
    });
    if (delivery) {
      await dispatchEmailDelivery(delivery.id, input.requestId ?? null);
    }
  }

  logInfo(OPERATIONAL_EVENTS.notificationCreated, {
    notificationId,
    type: input.type,
    requestId: input.requestId ?? undefined,
  });
  return { created: true, duplicate: false, notificationId };
}

/**
 * notifyFailSafe — the ONLY form domain call sites may use (§29/§30/§136/
 * §138/§356). A notification failure is logged as a safe operational event
 * (no payload, §133) and never propagates: a failed notification can never
 * roll back a successful sale, password change, subscription update, etc.
 */
export async function notifyFailSafe(input: NotifyInput): Promise<NotifyResult | null> {
  try {
    return await notify(input);
  } catch (error) {
    logError(OPERATIONAL_EVENTS.notificationCreateFailed, {
      type: input.type,
      code: error instanceof NotificationCreateError ? error.code : "UNKNOWN",
      error: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
}
