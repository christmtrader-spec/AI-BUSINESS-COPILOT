import "server-only";
import { db } from "@/lib/db";
import { logError } from "@/lib/observability/logger";
import { OPERATIONAL_EVENTS } from "@/lib/observability/events";
import { NOTIFICATION_CATALOG, type NotificationType } from "./catalog";
import { composeSourceEventId } from "./dedupe";
import { notifyFailSafe } from "./service";
import type { NotifyResult } from "./service";
import { deviceLabelFromUserAgent } from "@/lib/auth/sessions/service";

/**
 * NOTIFICATION EVENT MAPPERS — Prompt 32 §76/§222/§223/§224/§434.
 *
 * One mapper per real product event. Design laws:
 *  - Mappers are called AFTER the domain mutation COMMITTED (§332) — never
 *    inside the domain transaction.
 *  - Mappers validate + bound event data BEFORE mapping (§224/§230); raw
 *    event payloads are never forwarded into dataJson (§229).
 *  - Every mapper is fire-safe (notifyFailSafe): a notification failure is
 *    logged and swallowed — never rolled back into the domain (§136).
 *  - The recipient is always resolved SERVER-SIDE (owner/userId from the
 *    domain row — never from a request).
 *  - Every dedupe key is composed from a DURABLE server identifier (§333).
 */

/* ------------------------------- SECURITY -------------------------------- */

/** Shared body for the security mutation mappers (§91-§95). */
function securityNotification(
  type: NotificationType,
  userId: string,
  sourceEventId: string,
  data: Record<string, unknown>,
): void {
  void notifyFailSafe({
    userId,
    type,
    sourceEventId,
    data,
    businessId: null,
  });
}

export function notifyPasswordChanged(userId: string, sourceEventId: string): void {
  securityNotification(
    "SECURITY_PASSWORD_CHANGED",
    userId,
    sourceEventId,
    { changedAt: new Date().toISOString() },
  );
}

export function notifyPasswordResetCompleted(userId: string, sourceEventId: string): void {
  securityNotification(
    "SECURITY_PASSWORD_RESET_COMPLETED",
    userId,
    sourceEventId,
    { completedAt: new Date().toISOString() },
  );
}

export function notifyEmailVerified(userId: string, sourceEventId: string): void {
  securityNotification(
    "SECURITY_EMAIL_VERIFIED",
    userId,
    sourceEventId,
    { verifiedAt: new Date().toISOString() },
  );
}

export function notifyMfaEnabled(userId: string, sourceEventId: string): void {
  securityNotification(
    "SECURITY_MFA_ENABLED",
    userId,
    sourceEventId,
    { enabledAt: new Date().toISOString() },
  );
}

export function notifyMfaDisabled(userId: string, sourceEventId: string): void {
  securityNotification(
    "SECURITY_MFA_DISABLED",
    userId,
    sourceEventId,
    { disabledAt: new Date().toISOString() },
  );
}

/**
 * New sign-in (§96) — safe device label ONLY: no full IP, no geolocation,
 * no session secret ever enters the notification.
 */
export function notifyNewLogin(
  userId: string,
  sessionId: string,
  userAgent: string | null,
  createdFrom: "login" | "assertion",
): void {
  const device =
    deviceLabelFromUserAgent(userAgent) ??
    (createdFrom === "assertion" ? "MFA sign-in" : "Unknown device");
  void notifyFailSafe({
    userId,
    type: "SECURITY_NEW_LOGIN",
    sourceEventId: composeSourceEventId("login", sessionId),
    data: { loginAt: new Date().toISOString(), device: device.slice(0, 120) },
  });
}

/** Global sign-out (§97) — in-app only, low noise. */
export function notifySessionsSignedOut(userId: string, sessionCount: number, sourceEventId: string): void {
  securityNotification(
    "SECURITY_SESSIONS_SIGNED_OUT",
    userId,
    sourceEventId,
    { signedOutAt: new Date().toISOString(), sessionCount: Math.max(0, Math.min(sessionCount, 1000)) },
  );
}

/* -------------------------------- BILLING -------------------------------- */

const SUBSCRIPTION_TYPE_TO_NOTIFICATION: Partial<
  Record<string, { type: NotificationType; change?: "plan_changed" | "canceled" | "reactivated" | "paused" | "resumed" | "expired" }>
> = {
  TRIAL_STARTED: { type: "BILLING_TRIAL_STARTED" },
  TRIAL_ENDED: { type: "BILLING_TRIAL_ENDED" },
  EXPIRED: { type: "BILLING_SUBSCRIPTION_CHANGED", change: "expired" },
  PLAN_CHANGED: { type: "BILLING_SUBSCRIPTION_CHANGED", change: "plan_changed" },
  CANCELED: { type: "BILLING_SUBSCRIPTION_CHANGED", change: "canceled" },
  REACTIVATED: { type: "BILLING_SUBSCRIPTION_CHANGED", change: "reactivated" },
  PAUSED: { type: "BILLING_SUBSCRIPTION_CHANGED", change: "paused" },
  RESUMED: { type: "BILLING_SUBSCRIPTION_CHANGED", change: "resumed" },
  // CREATED is deliberately unmapped: every business creation would emit a
  // notification (noise) — documented in docs/product/notification-matrix.md.
};

async function planDisplayName(planCode: string | null): Promise<string> {
  if (!planCode) return "";
  const plan = await db.plan.findUnique({ where: { code: planCode }, select: { name: true } });
  return plan?.name?.slice(0, 120) ?? planCode;
}

/**
 * Map one COMMITTED SubscriptionEvent (§84-§86/§90/§225). Caller passes the
 * durable event row id + the mapped fields; the mapper re-reads nothing it
 * does not need and never trusts a payload it has not validated (§224).
 * Recipient = the business OWNER (billing authority).
 */
export function notifySubscriptionEvent(input: {
  businessId: string;
  eventId: string;
  type: string;
  toPlanCode: string | null;
}): void {
  const mapping = SUBSCRIPTION_TYPE_TO_NOTIFICATION[input.type];
  if (!mapping) return; // unmapped (CREATED) — documented, not an error
  void (async () => {
    try {
      const business = await db.business.findUnique({
        where: { id: input.businessId },
        select: { ownerId: true },
      });
      if (!business) return;
      const planName = await planDisplayName(input.toPlanCode);
      const now = new Date().toISOString();
      if (mapping.type === "BILLING_TRIAL_STARTED") {
        // Trial end date comes from the subscription row (billing domain — §429).
        const subscription = await db.subscription.findUnique({
          where: { businessId: input.businessId },
          select: { trialEnd: true },
        });
        await notifyFailSafe({
          userId: business.ownerId,
          businessId: input.businessId,
          type: "BILLING_TRIAL_STARTED",
          sourceEventId: composeSourceEventId("subscription", input.eventId),
          data: {
            planName,
            trialEndDate: (subscription?.trialEnd ?? new Date()).toISOString(),
          },
        });
        return;
      }
      if (mapping.type === "BILLING_TRIAL_ENDED") {
        await notifyFailSafe({
          userId: business.ownerId,
          businessId: input.businessId,
          type: "BILLING_TRIAL_ENDED",
          sourceEventId: composeSourceEventId("subscription", input.eventId),
          data: { planName, endedAt: now },
        });
        return;
      }
      await notifyFailSafe({
        userId: business.ownerId,
        businessId: input.businessId,
        type: "BILLING_SUBSCRIPTION_CHANGED",
        sourceEventId: composeSourceEventId("subscription", input.eventId),
        data: { planName, change: mapping.change ?? "plan_changed", changedAt: now },
      });
    } catch (error) {
      logError("notification.mapper.subscription_failed", {
        eventId: input.eventId,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  })();
}

/**
 * Provider-authoritative payment outcomes ONLY (§87/§88/§226). Callers pass
 * the CheckoutSession snapshot fields (amount/currency already guarded by
 * the payment domain — never recomputed here, §431).
 */
export function notifyPaymentSucceeded(input: {
  businessId: string;
  checkoutSessionId: string;
  amountMinor: number;
  currency: string;
}): void {
  void (async () => {
    try {
      const business = await db.business.findUnique({
        where: { id: input.businessId },
        select: { ownerId: true },
      });
      if (!business) return;
      await notifyFailSafe({
        userId: business.ownerId,
        businessId: input.businessId,
        type: "BILLING_PAYMENT_SUCCEEDED",
        sourceEventId: composeSourceEventId("payment", input.checkoutSessionId, "SUCCEEDED"),
        data: {
          amountMinor: Math.max(0, Math.round(input.amountMinor)),
          currency: input.currency,
          paidAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      logError("notification.mapper.payment_failed_mapper_error", {
        sessionId: input.checkoutSessionId,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  })();
}

export function notifyPaymentFailed(input: {
  businessId: string;
  checkoutSessionId: string;
  amountMinor: number;
  currency: string;
}): void {
  void (async () => {
    try {
      const business = await db.business.findUnique({
        where: { id: input.businessId },
        select: { ownerId: true },
      });
      if (!business) return;
      await notifyFailSafe({
        userId: business.ownerId,
        businessId: input.businessId,
        type: "BILLING_PAYMENT_FAILED",
        sourceEventId: composeSourceEventId("payment", input.checkoutSessionId, "FAILED"),
        data: {
          amountMinor: Math.max(0, Math.round(input.amountMinor)),
          currency: input.currency,
          failedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      logError("notification.mapper.payment_failed_mapper_error", {
        sessionId: input.checkoutSessionId,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  })();
}

/* ---------------------------------- AI ------------------------------------ */

/**
 * AI usage threshold notifications (§81/§82/§83/§431). Called after a
 * successful meter commit; values come from UsageService counters — the
 * notification layer never computes usage independently. `nearPercent` is
 * passed by the caller from the EXISTING UsageService §53 configuration —
 * never re-derived here.
 * Dedupe: one NEAR + one REACHED per usage period (§83).
 */
export function notifyAiUsageThreshold(input: {
  businessId: string;
  periodEndIso: string;
  used: number;
  limit: number;
  nearPercent: number;
}): void {
  void (async () => {
    try {
      if (!Number.isFinite(input.limit) || input.limit <= 0) return; // unlimited — no alert
      const business = await db.business.findUnique({
        where: { id: input.businessId },
        select: { ownerId: true },
      });
      if (!business) return;
      const used = Math.max(0, Math.floor(input.used));
      const limit = Math.max(1, Math.floor(input.limit));
      const percent = Math.floor((used / limit) * 100);
      const periodKey = input.periodEndIso || "open";
      const nearPercent = Math.min(99, Math.max(50, Math.floor(input.nearPercent)));

      if (used >= limit) {
        await notifyFailSafe({
          userId: business.ownerId,
          businessId: input.businessId,
          type: "AI_USAGE_LIMIT_REACHED",
          sourceEventId: composeSourceEventId("usage", input.businessId, periodKey, "AI_MESSAGES", "REACHED"),
          data: { used, limit, periodEnd: input.periodEndIso },
        });
        return;
      }
      if (percent >= nearPercent) {
        await notifyFailSafe({
          userId: business.ownerId,
          businessId: input.businessId,
          type: "AI_USAGE_LIMIT_NEAR",
          sourceEventId: composeSourceEventId("usage", input.businessId, periodKey, "AI_MESSAGES", "NEAR"),
          data: { used, limit, periodEnd: input.periodEndIso, percent },
        });
      }
    } catch (error) {
      logError("notification.mapper.usage_failed", {
        businessId: input.businessId,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  })();
}

/* ------------------------------- BUSINESS -------------------------------- */

/**
 * Data-portability job outcomes (§98-§101). Wired ONLY when Prompt 31's
 * models exist (they do — DataExportJob/DataImportJob are live). Recipient
 * = the user who requested/committed the job (§100).
 */
export function notifyExportCompleted(input: {
  userId: string;
  businessId: string;
  jobId: string;
  datasets: string[];
  recordCount: number;
  expiresAt: Date | null;
}): void {
  void notifyFailSafe({
    userId: input.userId,
    businessId: input.businessId,
    type: "BUSINESS_EXPORT_COMPLETED",
    sourceEventId: composeSourceEventId("export", input.jobId),
    data: {
      datasets: input.datasets.slice(0, 16),
      recordCount: Math.max(0, Math.min(input.recordCount, 10_000_000)),
      expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
    },
  });
}

export function notifyExportFailed(input: {
  userId: string;
  businessId: string;
  jobId: string;
  reasonCode: "EXPORT_LIMIT_EXCEEDED" | "EXPORT_GENERATION_FAILED";
}): void {
  void notifyFailSafe({
    userId: input.userId,
    businessId: input.businessId,
    type: "BUSINESS_EXPORT_FAILED",
    sourceEventId: composeSourceEventId("export", input.jobId),
    data: { reason: input.reasonCode },
  });
}

export function notifyImportCompleted(input: {
  userId: string;
  businessId: string;
  jobId: string;
  dataset: string;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}): void {
  void notifyFailSafe({
    userId: input.userId,
    businessId: input.businessId,
    type: "BUSINESS_IMPORT_COMPLETED",
    sourceEventId: composeSourceEventId("import", input.jobId),
    data: {
      dataset: input.dataset.slice(0, 40),
      created: Math.max(0, Math.min(input.created, 10_000_000)),
      updated: Math.max(0, Math.min(input.updated, 10_000_000)),
      skipped: Math.max(0, Math.min(input.skipped, 10_000_000)),
      failed: Math.max(0, Math.min(input.failed, 10_000_000)),
    },
  });
}

export function notifyImportFailed(input: {
  userId: string;
  businessId: string;
  jobId: string;
  dataset: string;
  reasonCode: "IMPORT_COMMIT_FAILED" | "IMPORT_VALIDATION_FAILED" | "IMPORT_FILE_CHANGED";
}): void {
  void notifyFailSafe({
    userId: input.userId,
    businessId: input.businessId,
    type: "BUSINESS_IMPORT_FAILED",
    sourceEventId: composeSourceEventId("import", input.jobId),
    data: { dataset: input.dataset.slice(0, 40), reason: input.reasonCode },
  });
}

/* ------------------------- BUSINESS — CRM TASK (P37) ---------------------- */

/**
 * Prompt 37 (§48) — task ASSIGNED notification. Event-driven and immediate:
 * called by the task service strictly AFTER the create/update COMMIT
 * (§34/§35). The recipient is always the server-resolved
 * task.assignedToUserId (§198) — never a request value. Fire-safe (§36).
 * The sourceEventId is composed by the caller from (taskId, assigneeUserId,
 * updatedAt) per §179.
 */
export function notifyCrmTaskAssigned(input: {
  businessId: string;
  taskId: string;
  assigneeUserId: string;
  taskTitle: string;
  priority: string;
  contextType: "CUSTOMER" | "LEAD" | "OPPORTUNITY";
  contextTitle: string;
  dueAt: Date | null;
  businessTimezone: string;
  sourceEventId: string;
}): Promise<NotifyResult | null> {
  return notifyFailSafe({
    userId: input.assigneeUserId,
    businessId: input.businessId,
    type: "BUSINESS_CRM_TASK_ASSIGNED",
    sourceEventId: input.sourceEventId,
    data: {
      taskId: input.taskId,
      taskTitle: input.taskTitle.slice(0, 160),
      priority: input.priority,
      contextType: input.contextType,
      contextTitle: input.contextTitle.slice(0, 160),
      dueAt: input.dueAt ? input.dueAt.toISOString() : null,
      businessTimezone: input.businessTimezone.slice(0, 64),
    },
  });
}

/**
 * Prompt 37 (§49/§180) — DUE-SOON reminder. Time-driven: called ONLY by the
 * reminder processor. Deterministic source id from (taskId, dueAt,
 * assigneeUserId) — NO run timestamp, so repeated processor runs collapse
 * onto the same identity and dedupe (§27/§180).
 */
export function notifyCrmTaskDueSoon(input: {
  businessId: string;
  taskId: string;
  assigneeUserId: string;
  taskTitle: string;
  priority: string;
  contextType: "CUSTOMER" | "LEAD" | "OPPORTUNITY";
  contextTitle: string;
  dueAt: Date;
  reminderMinutesBefore: number;
  businessTimezone: string;
}): Promise<NotifyResult | null> {
  return notifyFailSafe({
    userId: input.assigneeUserId,
    businessId: input.businessId,
    type: "BUSINESS_CRM_TASK_DUE_SOON",
    sourceEventId: composeSourceEventId(
      "crm-task-due-soon",
      input.taskId,
      input.dueAt.toISOString(),
      input.assigneeUserId,
    ),
    data: {
      taskId: input.taskId,
      taskTitle: input.taskTitle.slice(0, 160),
      priority: input.priority,
      contextType: input.contextType,
      contextTitle: input.contextTitle.slice(0, 160),
      dueAt: input.dueAt.toISOString(),
      reminderMinutesBefore: input.reminderMinutesBefore,
      businessTimezone: input.businessTimezone.slice(0, 64),
    },
  });
}

/**
 * Prompt 37 (§50/§181) — OVERDUE notification. Time-driven: called ONLY by
 * the reminder processor. Same deterministic identity law as due-soon
 * (§28/§181). WARNING severity — never ERROR merely because a task is late
 * (§14); no shame language in templates (§54).
 */
export function notifyCrmTaskOverdue(input: {
  businessId: string;
  taskId: string;
  assigneeUserId: string;
  taskTitle: string;
  priority: string;
  contextType: "CUSTOMER" | "LEAD" | "OPPORTUNITY";
  contextTitle: string;
  dueAt: Date;
  businessTimezone: string;
}): Promise<NotifyResult | null> {
  return notifyFailSafe({
    userId: input.assigneeUserId,
    businessId: input.businessId,
    type: "BUSINESS_CRM_TASK_OVERDUE",
    sourceEventId: composeSourceEventId(
      "crm-task-overdue",
      input.taskId,
      input.dueAt.toISOString(),
      input.assigneeUserId,
    ),
    data: {
      taskId: input.taskId,
      taskTitle: input.taskTitle.slice(0, 160),
      priority: input.priority,
      contextType: input.contextType,
      contextTitle: input.contextTitle.slice(0, 160),
      dueAt: input.dueAt.toISOString(),
      businessTimezone: input.businessTimezone.slice(0, 64),
    },
  });
}

/* -------------------------------- SYSTEM --------------------------------- */

const MAX_ANNOUNCEMENT_RECIPIENTS = 50;

/**
 * SYSTEM_ANNOUNCEMENT — platform operator service ONLY (§154/§155).
 * Recipients are EXPLICIT user ids (never an audience query); the message
 * is bounded plain text that flows through the schema + sanitizer gates.
 * Returns the number of notifications accepted (dedupe collapses replays).
 */
export async function createSystemAnnouncement(input: {
  operatorId: string;
  recipientUserIds: string[];
  message: string;
}): Promise<{ accepted: number; rejected: number }> {
  const recipients = [...new Set(input.recipientUserIds)]
    .filter((id) => typeof id === "string" && /^[a-zA-Z0-9_-]{10,64}$/.test(id))
    .slice(0, MAX_ANNOUNCEMENT_RECIPIENTS);
  const message = input.message.trim().slice(0, 500);
  if (!message) return { accepted: 0, rejected: 0 };

  let accepted = 0;
  let rejected = 0;
  const sourceEventId = composeSourceEventId(
    "announcement",
    input.operatorId,
    String(Date.now()),
    message.slice(0, 24).replace(/\s+/g, "-"),
  );
  for (const userId of recipients) {
    const result = await notifyFailSafe({
      userId,
      type: "SYSTEM_ANNOUNCEMENT",
      sourceEventId,
      data: { message },
    });
    if (result !== null) accepted += 1;
    else rejected += 1;
  }
  return { accepted, rejected };
}

/** Catalog type count used by platform readiness (§266). */
export function notificationCatalogHealth(): {
  types: number;
  healthy: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  for (const entry of Object.values(NOTIFICATION_CATALOG)) {
    if (!entry.titleKey || !entry.bodyKey || !entry.emailTemplateKey) {
      issues.push(`${entry.type}: missing translation keys`);
    }
    const hasAlwaysChannel = Object.values(entry.channels).some((policy) => policy === "ALWAYS");
    if (entry.mandatory !== hasAlwaysChannel) {
      issues.push(`${entry.type}: mandatory flag contradicts channel policy`);
    }
  }
  return { types: Object.keys(NOTIFICATION_CATALOG).length, healthy: issues.length === 0, issues };
}
