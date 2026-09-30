import "server-only";
import { db } from "@/lib/db";
import { NOTIFICATION_CATALOG, NOTIFICATION_TYPE_LIST, type NotificationType } from "./catalog";
import { isNotificationChannel, type NotificationChannel } from "./types";

/**
 * User notification preferences — Prompt 32 §16/§17/§18/§60/§61/§62.
 *
 * - Preference rows are a per-user OVERRIDE of the catalog defaults (§17) —
 *   a row is written ONLY when the user explicitly changes a preference.
 * - userId comes EXCLUSIVELY from the authenticated session (§19) — the
 *   API layer passes it; request bodies can never target another user.
 * - MANDATORY channels reject disabling with NOTIFICATION_PREFERENCE_FORBIDDEN
 *   (§62) — user preferences can never override security delivery (§14).
 */

export class NotificationPreferenceError extends Error {
  constructor(
    public readonly code:
      | "NOTIFICATION_TYPE_UNKNOWN"
      | "NOTIFICATION_CHANNEL_UNSUPPORTED"
      | "NOTIFICATION_PREFERENCE_UNAVAILABLE"
      | "NOTIFICATION_PREFERENCE_FORBIDDEN",
    public readonly status: number,
  ) {
    super(code);
    this.name = "NotificationPreferenceError";
  }
}

export type EffectivePreference = {
  notificationType: NotificationType;
  channel: NotificationChannel;
  /** Whether the channel is user-controllable at all (§61). */
  overridable: boolean;
  /** For mandatory channels: always true and non-editable (§64). */
  mandatory: boolean;
  /** Catalog default (used when no explicit row exists). */
  defaultEnabled: boolean;
  /** The EFFECTIVE value (override ?? default). */
  enabled: boolean;
};

/**
 * Full effective preference map for the settings UI (§63). Rows are loaded
 * once and joined onto the catalog — never one query per type.
 */
export async function listEffectivePreferences(userId: string): Promise<EffectivePreference[]> {
  const rows = await db.notificationPreference.findMany({
    where: { userId },
    select: { notificationType: true, channel: true, enabled: true },
  });
  const overrides = new Map<string, boolean>();
  for (const row of rows) overrides.set(`${row.notificationType}:${row.channel}`, row.enabled);

  const result: EffectivePreference[] = [];
  for (const entry of NOTIFICATION_TYPE_LIST) {
    for (const channel of ["IN_APP", "EMAIL"] as const) {
      const policy = entry.channels[channel];
      if (policy === "NEVER") continue; // channel not part of this type — hidden
      const overridable = policy === "IF_ENABLED" && entry.preferenceAvailable;
      const key = `${entry.type}:${channel}`;
      result.push({
        notificationType: entry.type,
        channel,
        overridable,
        mandatory: policy === "ALWAYS",
        defaultEnabled:
          channel === "EMAIL" ? entry.emailDefaultEnabled : true,
        enabled: overridable
          ? (overrides.get(key) ?? (channel === "EMAIL" ? entry.emailDefaultEnabled : true))
          : true,
      });
    }
  }
  return result;
}

/**
 * Resolve the effective enabled flag for ONE channel — used by the
 * dispatcher. `null` preference lookup result means "no explicit row".
 */
export async function resolvePreferenceEnabled(
  userId: string,
  type: NotificationType,
  channel: NotificationChannel,
): Promise<boolean | null> {
  const row = await db.notificationPreference.findUnique({
    where: {
      userId_notificationType_channel: { userId, notificationType: type, channel },
    },
    select: { enabled: true },
  });
  return row?.enabled ?? null;
}

export type UpdatePreferenceInput = {
  notificationType: string;
  channel: string;
  enabled: boolean;
};

/**
 * Create/update ONE channel preference with full catalog validation (§61).
 * Throws `NotificationPreferenceError` (stable codes, §259) on:
 *  - unknown type            → NOTIFICATION_TYPE_UNKNOWN
 *  - unsupported channel     → NOTIFICATION_CHANNEL_UNSUPPORTED
 *  - mandatory / unavailable → NOTIFICATION_PREFERENCE_FORBIDDEN (§62)
 */
export async function updatePreference(
  userId: string,
  input: UpdatePreferenceInput,
): Promise<EffectivePreference> {
  if (!isNotificationChannel(input.channel)) {
    throw new NotificationPreferenceError("NOTIFICATION_CHANNEL_UNSUPPORTED", 422);
  }
  const channel = input.channel;
  const entry = isNotificationTypeString(input.notificationType)
    ? NOTIFICATION_CATALOG[input.notificationType]
    : null;
  if (!entry) {
    throw new NotificationPreferenceError("NOTIFICATION_TYPE_UNKNOWN", 422);
  }
  const policy = entry.channels[channel];
  if (policy === "NEVER") {
    throw new NotificationPreferenceError("NOTIFICATION_CHANNEL_UNSUPPORTED", 422);
  }
  if (policy === "ALWAYS" || !entry.preferenceAvailable) {
    // §62 — mandatory security communication cannot be disabled.
    throw new NotificationPreferenceError("NOTIFICATION_PREFERENCE_FORBIDDEN", 403);
  }

  await db.notificationPreference.upsert({
    where: {
      userId_notificationType_channel: { userId, notificationType: entry.type, channel },
    },
    create: { userId, notificationType: entry.type, channel, enabled: input.enabled },
    update: { enabled: input.enabled },
  });

  return {
    notificationType: entry.type,
    channel,
    overridable: true,
    mandatory: false,
    defaultEnabled: channel === "EMAIL" ? entry.emailDefaultEnabled : true,
    enabled: input.enabled,
  };
}

function isNotificationTypeString(value: string): value is NotificationType {
  return (NOTIFICATION_TYPE_LIST as readonly { type: string }[]).some(
    (entry) => entry.type === value,
  );
}
