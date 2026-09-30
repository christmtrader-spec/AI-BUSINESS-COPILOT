import "server-only";
import { db } from "@/lib/db";
import { NOTIFICATION_CATALOG, type NotificationCatalogEntry } from "./catalog";
import { notificationActiveDeliveryLimit } from "./config";
import type { NotificationChannel } from "./types";

/**
 * Delivery policy resolution — Prompt 32 §10/§11/§14/§17/§18/§49.
 *
 * RESOLUTION ORDER (§18):
 *   Catalog channel policy
 *     → ALWAYS            → deliver (mandatory; preferences are IGNORED)
 *     → NEVER             → no delivery (channel not part of this type)
 *     → IF_ENABLED        → user preference row ?? catalog default
 *
 * The browser is NEVER the final authority (§18): preference rows are only
 * writable through the guarded preferences API, and mandatory channels skip
 * preference resolution entirely (§14/§62).
 */

export type ChannelDecision =
  | { deliver: true; mandatory: true }
  | { deliver: true; mandatory: false }
  | { deliver: false; reason: "POLICY_NEVER" }
  | { deliver: false; reason: "PREFERENCE_DISABLED" };

/**
 * Decide whether `channel` should deliver for the catalog entry, given the
 * user's explicit preference row (or null when unset).
 */
export function resolveChannelDecision(
  entry: NotificationCatalogEntry,
  channel: NotificationChannel,
  preferenceEnabled: boolean | null,
): ChannelDecision {
  const policy = entry.channels[channel];
  if (policy === "ALWAYS") return { deliver: true, mandatory: true };
  if (policy === "NEVER") return { deliver: false, reason: "POLICY_NEVER" };
  const enabled = preferenceEnabled ?? entry.emailDefaultEnabled;
  return enabled
    ? { deliver: true, mandatory: false }
    : { deliver: false, reason: "PREFERENCE_DISABLED" };
}

/**
 * EMAIL eligibility (§48/§49). The recipient address is ALWAYS resolved
 * server-side from User.email — never from a request (§48).
 *
 * Documented policy (§49): MANDATORY security emails go to the account's
 * address even when it is not yet verified (the address IS the login
 * identity — security state changes must reach the account holder).
 * OPTIONAL emails are sent only to VERIFIED addresses.
 */
export function isEmailRecipientEligible(
  entry: NotificationCatalogEntry,
  emailVerifiedAt: Date | null,
): { eligible: boolean; reason?: "RECIPIENT_UNVERIFIED" } {
  if (entry.channels.EMAIL === "ALWAYS") return { eligible: true };
  if (!emailVerifiedAt) return { eligible: false, reason: "RECIPIENT_UNVERIFIED" };
  return { eligible: true };
}

/**
 * Flood protection (§246): when a user already has too many PENDING email
 * deliveries, OPTIONAL emails are skipped (in-app always created).
 * MANDATORY security email bypasses the cap (§139/§321).
 */
export async function optionalEmailFlooded(userId: string): Promise<boolean> {
  const pending = await db.notificationDelivery.count({
    where: { channel: "EMAIL", status: "PENDING", notification: { userId } },
  });
  return pending >= notificationActiveDeliveryLimit();
}
