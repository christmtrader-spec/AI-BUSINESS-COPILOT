import "server-only";
import { z } from "zod";
import type {
  ActionRoute,
  ChannelPolicySet,
  NotificationCategory,
  NotificationPriority,
  NotificationSeverity,
} from "./types";

/**
 * NOTIFICATION CATALOG — Prompt 32 §5/§36/§170.
 *
 * THE closed directory of notification types. Every value that can ever be
 * persisted in `Notification.type` is validated against this catalog; there
 * is no dynamic template registration and no client-supplied type (§36/§187).
 *
 * Catalog law (§5): only event types backed by REAL product events are
 * listed. Deliberately ABSENT (documented in docs/product/notification-matrix.md):
 *  - BILLING_TRIAL_ENDING — no scheduler/background worker exists; inventing
 *    a request-time reminder is out of scope (§85).
 *  - BILLING_PAYMENT_REQUIRES_ACTION / RECONCILIATION_REQUIRED — platform-
 *    internal states with no customer-visible product surface (§89).
 *  - AI_COST_UNKNOWN / AI_COST_GOVERNANCE_WARNING — AI COST is platform data;
 *    tenant-visible cost notifications are prohibited (§80).
 *  - SECURITY_SESSION_REVOKED (single other-device revoke) — noise avoidance
 *    is the documented policy (§97); global sign-out is covered by
 *    SECURITY_SESSIONS_SIGNED_OUT.
 */

export const NOTIFICATION_TYPES = [
  "SECURITY_PASSWORD_CHANGED",
  "SECURITY_PASSWORD_RESET_COMPLETED",
  "SECURITY_EMAIL_VERIFIED",
  "SECURITY_MFA_ENABLED",
  "SECURITY_MFA_DISABLED",
  "SECURITY_NEW_LOGIN",
  "SECURITY_SESSIONS_SIGNED_OUT",
  "BILLING_TRIAL_STARTED",
  "BILLING_TRIAL_ENDED",
  "BILLING_SUBSCRIPTION_CHANGED",
  "BILLING_PAYMENT_SUCCEEDED",
  "BILLING_PAYMENT_FAILED",
  "AI_USAGE_LIMIT_NEAR",
  "AI_USAGE_LIMIT_REACHED",
  "BUSINESS_EXPORT_COMPLETED",
  "BUSINESS_EXPORT_FAILED",
  "BUSINESS_IMPORT_COMPLETED",
  "BUSINESS_IMPORT_FAILED",
  "SYSTEM_ANNOUNCEMENT",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export function isNotificationType(value: unknown): value is NotificationType {
  return (
    typeof value === "string" &&
    (NOTIFICATION_TYPES as readonly string[]).includes(value)
  );
}

/* ------------------------------ data schemas ------------------------------ */
/* Per-type STRICT schemas (§23/§24/§172/§355). notify() validates every data
 * object against its type's schema BEFORE persistence; unknown keys are
 * stripped, oversized payloads are rejected (§231/§346). Values are safe
 * primitives only — never nested arbitrary objects (§24). */

const isoTimestamp = z.string().datetime({ offset: true }).max(40);
const boundedText = (max: number) => z.string().max(max);
const boundedInt = (max: number) => z.number().int().min(0).max(max);
const minorAmount = z.number().int().min(0).max(1_000_000_000_000);
const currencyCode = z.string().regex(/^[A-Z]{3}$/);

export type NotificationCatalogEntry = {
  type: NotificationType;
  category: NotificationCategory;
  priority: NotificationPriority;
  severity: NotificationSeverity;
  /** Per-channel delivery policy (§10): ALWAYS | IF_ENABLED | NEVER. */
  channels: ChannelPolicySet;
  /**
   * MANDATORY (§11): at least one channel is ALWAYS-delivered and user
   * preferences cannot disable it. Derived invariant — validated by
   * scripts/notification-catalog-check.mjs (§171).
   */
  mandatory: boolean;
  /** Whether user preferences may control the optional channels (§61). */
  preferenceAvailable: boolean;
  titleKey: string;
  bodyKey: string;
  emailTemplateKey: string;
  dataSchema: z.ZodTypeAny;
  /** Server-generated allowlisted CTA (§102/§103) — never client-supplied. */
  actionRoute: ActionRoute | null;
  /** Ephemeral notifications auto-hide after N days (§57); null = never. */
  expiresAfterDays: number | null;
  /** Default for the OPTIONAL email channel when no user preference exists (§17/§159). */
  emailDefaultEnabled: boolean;
  /** Documented event source (§434). */
  source: string;
  /** Documented dedupe semantics (§29/§30/§434). */
  dedupe: string;
};

const alwaysInAppEmail: ChannelPolicySet = { IN_APP: "ALWAYS", EMAIL: "ALWAYS" };
const inAppAlwaysEmailOptional: ChannelPolicySet = { IN_APP: "ALWAYS", EMAIL: "IF_ENABLED" };

export const NOTIFICATION_CATALOG: Record<NotificationType, NotificationCatalogEntry> = {
  /* ------------------------------- SECURITY ------------------------------- */
  SECURITY_PASSWORD_CHANGED: {
    type: "SECURITY_PASSWORD_CHANGED",
    category: "SECURITY",
    priority: "HIGH",
    severity: "INFO",
    channels: alwaysInAppEmail,
    mandatory: true,
    preferenceAvailable: false,
    titleKey: "items.SECURITY_PASSWORD_CHANGED.title",
    bodyKey: "items.SECURITY_PASSWORD_CHANGED.body",
    emailTemplateKey: "items.SECURITY_PASSWORD_CHANGED.email",
    dataSchema: z.object({ changedAt: isoTimestamp }),
    actionRoute: "security",
    expiresAfterDays: null,
    emailDefaultEnabled: true,
    source: "POST /api/v1/auth/password-change (successful password change, §91)",
    dedupe: "security:<SecurityEventId>",
  },
  SECURITY_PASSWORD_RESET_COMPLETED: {
    type: "SECURITY_PASSWORD_RESET_COMPLETED",
    category: "SECURITY",
    priority: "HIGH",
    severity: "INFO",
    channels: alwaysInAppEmail,
    mandatory: true,
    preferenceAvailable: false,
    titleKey: "items.SECURITY_PASSWORD_RESET_COMPLETED.title",
    bodyKey: "items.SECURITY_PASSWORD_RESET_COMPLETED.body",
    emailTemplateKey: "items.SECURITY_PASSWORD_RESET_COMPLETED.email",
    dataSchema: z.object({ completedAt: isoTimestamp }),
    actionRoute: "security",
    expiresAfterDays: null,
    emailDefaultEnabled: true,
    source: "POST /api/v1/auth/password-reset/confirm (successful reset, §92)",
    dedupe: "security:<SecurityEventId>",
  },
  SECURITY_EMAIL_VERIFIED: {
    type: "SECURITY_EMAIL_VERIFIED",
    category: "SECURITY",
    priority: "NORMAL",
    severity: "SUCCESS",
    channels: { IN_APP: "ALWAYS", EMAIL: "NEVER" },
    mandatory: true,
    preferenceAvailable: false,
    titleKey: "items.SECURITY_EMAIL_VERIFIED.title",
    bodyKey: "items.SECURITY_EMAIL_VERIFIED.body",
    emailTemplateKey: "items.SECURITY_EMAIL_VERIFIED.email",
    dataSchema: z.object({ verifiedAt: isoTimestamp }),
    actionRoute: "security",
    expiresAfterDays: null,
    emailDefaultEnabled: false,
    source: "POST /api/v1/auth/email-verification/confirm (§95 — in-app only, no redundant email)",
    dedupe: "security:<SecurityEventId>",
  },
  SECURITY_MFA_ENABLED: {
    type: "SECURITY_MFA_ENABLED",
    category: "SECURITY",
    priority: "HIGH",
    severity: "SUCCESS",
    channels: alwaysInAppEmail,
    mandatory: true,
    preferenceAvailable: false,
    titleKey: "items.SECURITY_MFA_ENABLED.title",
    bodyKey: "items.SECURITY_MFA_ENABLED.body",
    emailTemplateKey: "items.SECURITY_MFA_ENABLED.email",
    dataSchema: z.object({ enabledAt: isoTimestamp }),
    actionRoute: "security",
    expiresAfterDays: null,
    emailDefaultEnabled: true,
    source: "POST /api/v1/me/security/mfa/setup/confirm (§93)",
    dedupe: "security:<SecurityEventId>",
  },
  SECURITY_MFA_DISABLED: {
    type: "SECURITY_MFA_DISABLED",
    category: "SECURITY",
    priority: "CRITICAL",
    severity: "WARNING",
    channels: alwaysInAppEmail,
    mandatory: true,
    preferenceAvailable: false,
    titleKey: "items.SECURITY_MFA_DISABLED.title",
    bodyKey: "items.SECURITY_MFA_DISABLED.body",
    emailTemplateKey: "items.SECURITY_MFA_DISABLED.email",
    dataSchema: z.object({ disabledAt: isoTimestamp }),
    actionRoute: "security",
    expiresAfterDays: null,
    emailDefaultEnabled: true,
    source: "POST /api/v1/me/security/mfa/disable (§94)",
    dedupe: "security:<SecurityEventId>",
  },
  SECURITY_NEW_LOGIN: {
    type: "SECURITY_NEW_LOGIN",
    category: "SECURITY",
    priority: "NORMAL",
    severity: "INFO",
    channels: inAppAlwaysEmailOptional,
    mandatory: true,
    preferenceAvailable: true,
    titleKey: "items.SECURITY_NEW_LOGIN.title",
    bodyKey: "items.SECURITY_NEW_LOGIN.body",
    emailTemplateKey: "items.SECURITY_NEW_LOGIN.email",
    dataSchema: z.object({
      loginAt: isoTimestamp,
      device: boundedText(120),
    }),
    actionRoute: "security",
    expiresAfterDays: 30,
    emailDefaultEnabled: true,
    source: "login completion (safe device label — never IP/geo/session secret, §96)",
    dedupe: "login:<UserSessionId>",
  },
  SECURITY_SESSIONS_SIGNED_OUT: {
    type: "SECURITY_SESSIONS_SIGNED_OUT",
    category: "SECURITY",
    priority: "NORMAL",
    severity: "INFO",
    channels: { IN_APP: "ALWAYS", EMAIL: "NEVER" },
    mandatory: true,
    preferenceAvailable: false,
    titleKey: "items.SECURITY_SESSIONS_SIGNED_OUT.title",
    bodyKey: "items.SECURITY_SESSIONS_SIGNED_OUT.body",
    emailTemplateKey: "items.SECURITY_SESSIONS_SIGNED_OUT.email",
    dataSchema: z.object({
      signedOutAt: isoTimestamp,
      sessionCount: boundedInt(1000),
    }),
    actionRoute: "security",
    expiresAfterDays: 30,
    emailDefaultEnabled: false,
    source: "POST /api/v1/me/security/sessions/revoke-all (§97 — in-app only, avoid noise)",
    dedupe: "security:<SecurityEventId>",
  },

  /* ------------------------------- BILLING -------------------------------- */
  BILLING_TRIAL_STARTED: {
    type: "BILLING_TRIAL_STARTED",
    category: "BILLING",
    priority: "NORMAL",
    severity: "SUCCESS",
    channels: inAppAlwaysEmailOptional,
    mandatory: true,
    preferenceAvailable: true,
    titleKey: "items.BILLING_TRIAL_STARTED.title",
    bodyKey: "items.BILLING_TRIAL_STARTED.body",
    emailTemplateKey: "items.BILLING_TRIAL_STARTED.email",
    dataSchema: z.object({
      planName: boundedText(120),
      trialEndDate: isoTimestamp,
    }),
    actionRoute: "billing",
    expiresAfterDays: null,
    emailDefaultEnabled: true,
    source: "SubscriptionEvent TRIAL_STARTED (state transition — never a UI click, §84)",
    dedupe: "subscription:<SubscriptionEventId>",
  },
  BILLING_TRIAL_ENDED: {
    type: "BILLING_TRIAL_ENDED",
    category: "BILLING",
    priority: "NORMAL",
    severity: "INFO",
    channels: inAppAlwaysEmailOptional,
    mandatory: true,
    preferenceAvailable: true,
    titleKey: "items.BILLING_TRIAL_ENDED.title",
    bodyKey: "items.BILLING_TRIAL_ENDED.body",
    emailTemplateKey: "items.BILLING_TRIAL_ENDED.email",
    dataSchema: z.object({
      planName: boundedText(120),
      endedAt: isoTimestamp,
    }),
    actionRoute: "billing",
    expiresAfterDays: null,
    emailDefaultEnabled: true,
    source: "SubscriptionEvent TRIAL_ENDED / EXPIRED (§86)",
    dedupe: "subscription:<SubscriptionEventId>",
  },
  BILLING_SUBSCRIPTION_CHANGED: {
    type: "BILLING_SUBSCRIPTION_CHANGED",
    category: "BILLING",
    priority: "NORMAL",
    severity: "INFO",
    channels: inAppAlwaysEmailOptional,
    mandatory: true,
    preferenceAvailable: true,
    titleKey: "items.BILLING_SUBSCRIPTION_CHANGED.title",
    bodyKey: "items.BILLING_SUBSCRIPTION_CHANGED.body",
    emailTemplateKey: "items.BILLING_SUBSCRIPTION_CHANGED.email",
    dataSchema: z.object({
      planName: boundedText(120),
      change: z.enum([
        "plan_changed",
        "canceled",
        "reactivated",
        "paused",
        "resumed",
        "expired",
      ]),
      changedAt: isoTimestamp,
    }),
    actionRoute: "billing",
    expiresAfterDays: null,
    emailDefaultEnabled: true,
    source: "SubscriptionEvent PLAN_CHANGED/CANCELED/REACTIVATED/PAUSED/RESUMED/EXPIRED (§90 — no operator identity)",
    dedupe: "subscription:<SubscriptionEventId>",
  },
  BILLING_PAYMENT_SUCCEEDED: {
    type: "BILLING_PAYMENT_SUCCEEDED",
    category: "BILLING",
    priority: "NORMAL",
    severity: "SUCCESS",
    channels: inAppAlwaysEmailOptional,
    mandatory: true,
    preferenceAvailable: true,
    titleKey: "items.BILLING_PAYMENT_SUCCEEDED.title",
    bodyKey: "items.BILLING_PAYMENT_SUCCEEDED.body",
    emailTemplateKey: "items.BILLING_PAYMENT_SUCCEEDED.email",
    dataSchema: z.object({
      amountMinor: minorAmount,
      currency: currencyCode,
      paidAt: isoTimestamp,
    }),
    actionRoute: "billing",
    expiresAfterDays: null,
    emailDefaultEnabled: true,
    source: "provider-authoritative payment verification ONLY — never PENDING/RECONCILIATION (§87)",
    dedupe: "payment:<CheckoutSessionId>:SUCCEEDED",
  },
  BILLING_PAYMENT_FAILED: {
    type: "BILLING_PAYMENT_FAILED",
    category: "BILLING",
    priority: "HIGH",
    severity: "ERROR",
    channels: inAppAlwaysEmailOptional,
    mandatory: true,
    preferenceAvailable: true,
    titleKey: "items.BILLING_PAYMENT_FAILED.title",
    bodyKey: "items.BILLING_PAYMENT_FAILED.body",
    emailTemplateKey: "items.BILLING_PAYMENT_FAILED.email",
    dataSchema: z.object({
      amountMinor: minorAmount,
      currency: currencyCode,
      failedAt: isoTimestamp,
    }),
    actionRoute: "billing",
    expiresAfterDays: null,
    emailDefaultEnabled: true,
    source: "provider-reported genuine failure — reason never fabricated (§88)",
    dedupe: "payment:<CheckoutSessionId>:FAILED",
  },

  /* --------------------------------- AI ----------------------------------- */
  AI_USAGE_LIMIT_NEAR: {
    type: "AI_USAGE_LIMIT_NEAR",
    category: "AI",
    priority: "NORMAL",
    severity: "WARNING",
    channels: inAppAlwaysEmailOptional,
    mandatory: true,
    preferenceAvailable: true,
    titleKey: "items.AI_USAGE_LIMIT_NEAR.title",
    bodyKey: "items.AI_USAGE_LIMIT_NEAR.body",
    emailTemplateKey: "items.AI_USAGE_LIMIT_NEAR.email",
    dataSchema: z.object({
      used: boundedInt(1_000_000_000),
      limit: boundedInt(1_000_000_000),
      periodEnd: isoTimestamp,
      percent: z.number().int().min(50).max(99),
    }),
    actionRoute: "usage",
    expiresAfterDays: 60,
    emailDefaultEnabled: true,
    source: "UsageService meter crossing the configured near-limit percent (§81 — no provider cost)",
    dedupe: "usage:<businessId>:<periodEnd>:AI_MESSAGES:NEAR — one per usage period (§83)",
  },
  AI_USAGE_LIMIT_REACHED: {
    type: "AI_USAGE_LIMIT_REACHED",
    category: "AI",
    priority: "HIGH",
    severity: "WARNING",
    channels: inAppAlwaysEmailOptional,
    mandatory: true,
    preferenceAvailable: true,
    titleKey: "items.AI_USAGE_LIMIT_REACHED.title",
    bodyKey: "items.AI_USAGE_LIMIT_REACHED.body",
    emailTemplateKey: "items.AI_USAGE_LIMIT_REACHED.email",
    dataSchema: z.object({
      used: boundedInt(1_000_000_000),
      limit: boundedInt(1_000_000_000),
      periodEnd: isoTimestamp,
    }),
    actionRoute: "usage",
    expiresAfterDays: 60,
    emailDefaultEnabled: true,
    source: "UsageService counter reaching the plan quota (§82 — safe usage info only)",
    dedupe: "usage:<businessId>:<periodEnd>:AI_MESSAGES:REACHED — one per usage period (§83)",
  },

  /* ------------------------------- BUSINESS ------------------------------- */
  BUSINESS_EXPORT_COMPLETED: {
    type: "BUSINESS_EXPORT_COMPLETED",
    category: "BUSINESS",
    priority: "LOW",
    severity: "SUCCESS",
    channels: inAppAlwaysEmailOptional,
    mandatory: true,
    preferenceAvailable: true,
    titleKey: "items.BUSINESS_EXPORT_COMPLETED.title",
    bodyKey: "items.BUSINESS_EXPORT_COMPLETED.body",
    emailTemplateKey: "items.BUSINESS_EXPORT_COMPLETED.email",
    dataSchema: z.object({
      datasets: z.array(boundedText(40)).max(16),
      recordCount: boundedInt(10_000_000),
      expiresAt: isoTimestamp.nullable(),
    }),
    actionRoute: "data",
    expiresAfterDays: 30,
    emailDefaultEnabled: true,
    source: "DataExportJob COMPLETED — after file + checksum verification (§100/§328)",
    dedupe: "export:<DataExportJobId>",
  },
  BUSINESS_EXPORT_FAILED: {
    type: "BUSINESS_EXPORT_FAILED",
    category: "BUSINESS",
    priority: "NORMAL",
    severity: "ERROR",
    channels: inAppAlwaysEmailOptional,
    mandatory: true,
    preferenceAvailable: true,
    titleKey: "items.BUSINESS_EXPORT_FAILED.title",
    bodyKey: "items.BUSINESS_EXPORT_FAILED.body",
    emailTemplateKey: "items.BUSINESS_EXPORT_FAILED.email",
    dataSchema: z.object({
      reason: z.enum(["EXPORT_LIMIT_EXCEEDED", "EXPORT_GENERATION_FAILED"]),
    }),
    actionRoute: "data",
    expiresAfterDays: 30,
    emailDefaultEnabled: true,
    source: "DataExportJob FAILED (stable safe failure code only, §101/§330)",
    dedupe: "export:<DataExportJobId>",
  },
  BUSINESS_IMPORT_COMPLETED: {
    type: "BUSINESS_IMPORT_COMPLETED",
    category: "BUSINESS",
    priority: "NORMAL",
    severity: "SUCCESS",
    channels: inAppAlwaysEmailOptional,
    mandatory: true,
    preferenceAvailable: true,
    titleKey: "items.BUSINESS_IMPORT_COMPLETED.title",
    bodyKey: "items.BUSINESS_IMPORT_COMPLETED.body",
    emailTemplateKey: "items.BUSINESS_IMPORT_COMPLETED.email",
    dataSchema: z.object({
      dataset: boundedText(40),
      created: boundedInt(10_000_000),
      updated: boundedInt(10_000_000),
      skipped: boundedInt(10_000_000),
      failed: boundedInt(10_000_000),
    }),
    actionRoute: "data",
    expiresAfterDays: 30,
    emailDefaultEnabled: true,
    source: "DataImportJob COMPLETED — after DB commit (§98/§329)",
    dedupe: "import:<DataImportJobId>",
  },
  BUSINESS_IMPORT_FAILED: {
    type: "BUSINESS_IMPORT_FAILED",
    category: "BUSINESS",
    priority: "NORMAL",
    severity: "ERROR",
    channels: inAppAlwaysEmailOptional,
    mandatory: true,
    preferenceAvailable: true,
    titleKey: "items.BUSINESS_IMPORT_FAILED.title",
    bodyKey: "items.BUSINESS_IMPORT_FAILED.body",
    emailTemplateKey: "items.BUSINESS_IMPORT_FAILED.email",
    dataSchema: z.object({
      dataset: boundedText(40),
      reason: z.enum(["IMPORT_COMMIT_FAILED", "IMPORT_VALIDATION_FAILED", "IMPORT_FILE_CHANGED"]),
    }),
    actionRoute: "data",
    expiresAfterDays: 30,
    emailDefaultEnabled: true,
    source: "DataImportJob FAILED (safe failure summary, §99/§330)",
    dedupe: "import:<DataImportJobId>",
  },

  /* -------------------------------- SYSTEM -------------------------------- */
  SYSTEM_ANNOUNCEMENT: {
    type: "SYSTEM_ANNOUNCEMENT",
    category: "SYSTEM",
    priority: "LOW",
    severity: "INFO",
    channels: { IN_APP: "ALWAYS", EMAIL: "IF_ENABLED" },
    mandatory: true,
    preferenceAvailable: true,
    titleKey: "items.SYSTEM_ANNOUNCEMENT.title",
    bodyKey: "items.SYSTEM_ANNOUNCEMENT.body",
    emailTemplateKey: "items.SYSTEM_ANNOUNCEMENT.email",
    dataSchema: z.object({
      message: boundedText(500),
    }),
    actionRoute: "dashboard",
    expiresAfterDays: 90,
    emailDefaultEnabled: false,
    source: "authorized platform operator service ONLY — no customer-controlled creation (§154/§155)",
    dedupe: "announcement:<operatorMessageId>",
  },
};

/** The typed list, in catalog order (stable for UI + tests). */
export const NOTIFICATION_TYPE_LIST: readonly NotificationCatalogEntry[] =
  NOTIFICATION_TYPES.map((type) => NOTIFICATION_CATALOG[type]);
