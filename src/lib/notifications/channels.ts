import "server-only";
import { renderNotificationEmailForUser } from "./templates";
import { getEmailProvider } from "@/lib/email";
import type { DeliveryFailureCode } from "./types";
import type { NotificationType } from "./catalog";

/**
 * Notification channel adapters — Prompt 32 §9/§140/§141.
 *
 * A channel adapter hides transport details behind one small interface so
 * future PUSH/SMS adapters can be added WITHOUT changing domain events or
 * the notification service (§140). There are NO fake implementations for
 * unimplemented channels (§141).
 *
 * IN_APP is deliberately minimal: persisting the Notification row IS the
 * in-app delivery (§34) — the adapter exists so the dispatcher records a
 * uniform per-channel delivery trail (§32/§142).
 */

export type ChannelRecipient = {
  userId: string;
  email: string;
  emailVerifiedAt: Date | null;
  locale: "en" | "fa";
};

export type ChannelDeliveryInput = {
  notificationId: string;
  deliveryId: string;
  type: NotificationType;
  data: Record<string, unknown> | null;
  recipient: ChannelRecipient;
  /** Absolute URL for the email CTA (already allowlisted; null = no link). */
  actionUrl: string | null;
};

export type ChannelDeliveryOutcome =
  | { outcome: "SENT"; providerMessageId: string | null }
  | { outcome: "FAILED"; failureCode: DeliveryFailureCode };

export interface NotificationChannelAdapter {
  readonly channel: "IN_APP" | "EMAIL";
  deliver(input: ChannelDeliveryInput): Promise<ChannelDeliveryOutcome>;
}

/** In-app "transport": the persisted row is the delivery (§34). */
export const inAppChannel: NotificationChannelAdapter = {
  channel: "IN_APP",
  async deliver(): Promise<ChannelDeliveryOutcome> {
    return { outcome: "SENT", providerMessageId: null };
  },
};

/**
 * EMAIL transport — ALWAYS via the Prompt 29 EmailProvider (§33). Domain
 * code never touches SMTP directly (enforced by
 * scripts/notification-static-scan.mjs, §389).
 */
export const emailChannel: NotificationChannelAdapter = {
  channel: "EMAIL",
  async deliver(input: ChannelDeliveryInput): Promise<ChannelDeliveryOutcome> {
    let message;
    try {
      message = renderNotificationEmailForUser(input.type, input.data, input.recipient.locale);
    } catch {
      // A template failure must never crash dispatch — normalized code (§263).
      return { outcome: "FAILED", failureCode: "TEMPLATE" };
    }
    try {
      const provider = getEmailProvider();
      await provider.send({
        to: input.recipient.email,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      // The current EmailProvider contract returns void; providerMessageId
      // stays null until a future adapter surfaces one (§47).
      return { outcome: "SENT", providerMessageId: null };
    } catch (error) {
      return { outcome: "FAILED", failureCode: classifyEmailFailure(error) };
    }
  },
};

/**
 * Normalize an email transport error into the fixed failure vocabulary
 * (§263). Never stores or logs raw SMTP output (§130).
 */
export function classifyEmailFailure(error: unknown): DeliveryFailureCode {
  const raw = error instanceof Error ? `${error.name} ${error.message}`.toLowerCase() : "";
  if (raw.includes("email_transport_not_configured") || raw.includes("config")) return "SMTP_CONFIG";
  if (raw.includes("timeout") || raw.includes("timed out") || raw.includes("etimedout")) return "SMTP_TIMEOUT";
  if (raw.includes("auth") || raw.includes("535") || raw.includes("credentials")) return "SMTP_AUTH";
  if (raw.includes("econnrefused") || raw.includes("econnreset") || raw.includes("connect") || raw.includes("dns") || raw.includes("enotfound")) return "SMTP_CONNECTION";
  if (raw.includes("recipient") || raw.includes("550") || raw.includes("551") || raw.includes("553")) return "INVALID_RECIPIENT";
  return "UNKNOWN";
}
