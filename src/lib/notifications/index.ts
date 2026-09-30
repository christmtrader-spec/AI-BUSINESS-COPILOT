import "server-only";

/**
 * Notification platform public surface — Prompt 32.
 *
 * Domain call sites import ONLY from this index: `notifyFailSafe` (or a
 * mapper) + the preference/query helpers. Direct use of internals is
 * reserved for the API layer and scripts.
 */

export { notify, notifyFailSafe, NotificationCreateError } from "./service";
export type { NotifyInput, NotifyResult } from "./service";

export {
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_LIST,
  NOTIFICATION_CATALOG,
  isNotificationType,
} from "./catalog";
export type { NotificationType, NotificationCatalogEntry } from "./catalog";

export {
  listEffectivePreferences,
  updatePreference,
  NotificationPreferenceError,
} from "./preferences";
export type { EffectivePreference } from "./preferences";

export {
  listNotifications,
  unreadNotificationCount,
  markNotificationRead,
  markNotificationUnread,
  markAllNotificationsRead,
  archiveNotification,
} from "./dto";
export type { NotificationDTO, ListNotificationsResult } from "./dto";

export {
  dispatchEmailDelivery,
  retryFailedEmailDelivery,
  reapStaleEmailDeliveries,
  platformDeliverySummary,
} from "./dispatcher";
export type { PlatformDeliverySummary } from "./dispatcher";

export { pruneExpiredNotifications } from "./cleanup";
export type { PruneSummary } from "./cleanup";

export {
  notifyPasswordChanged,
  notifyPasswordResetCompleted,
  notifyEmailVerified,
  notifyMfaEnabled,
  notifyMfaDisabled,
  notifyNewLogin,
  notifySessionsSignedOut,
  notifySubscriptionEvent,
  notifyPaymentSucceeded,
  notifyPaymentFailed,
  notifyAiUsageThreshold,
  notifyExportCompleted,
  notifyExportFailed,
  notifyImportCompleted,
  notifyImportFailed,
  createSystemAnnouncement,
  notificationCatalogHealth,
} from "./event-mappers";

export {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_PRIORITIES,
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_CHANNELS,
  DELIVERY_STATUSES,
  isNotificationCategory,
  isNotificationPriority,
  isNotificationSeverity,
  isNotificationChannel,
  isDeliveryStatus,
  actionRoutePath,
} from "./types";
export type {
  NotificationCategory,
  NotificationPriority,
  NotificationSeverity,
  NotificationChannel,
  DeliveryStatus,
  ChannelPolicy,
  ActionRoute,
} from "./types";

export { sanitizeNotificationData, composeSourceEventId } from "./dedupe";
export {
  notificationEmailMaxAttempts,
  notificationRetentionDays,
  notificationSecurityRetentionDays,
  notificationMaxPageSize,
  notificationMaxDataBytes,
  notificationCleanupBatchSize,
  notificationStaleDeliveryMinutes,
  notificationActiveDeliveryLimit,
  notificationPollIntervalMs,
} from "./config";
export { renderNotificationForUser, renderNotificationEmailForUser } from "./templates";
