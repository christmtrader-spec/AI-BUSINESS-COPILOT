/**
 * /api/v1/me/notification-preferences — GET the effective preference map
 * (Prompt 32 §60/§63) and PUT one channel preference (§61).
 *
 * Identity is ALWAYS the authenticated session user (§19) — the request
 * body can never carry a userId, mandatory flag or policy (§185). The PUT
 * validates the type/channel against the closed catalog and rejects
 * mandatory channels with NOTIFICATION_PREFERENCE_FORBIDDEN (§62).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { assertFreshSession } from "@/lib/auth-security";
import { rateLimit } from "@/lib/rate-limit";
import {
  listEffectivePreferences,
  updatePreference,
  NotificationPreferenceError,
} from "@/lib/notifications";

export const dynamic = "force-dynamic";

const putSchema = z.object({
  notificationType: z.string().min(4).max(64),
  channel: z.string().min(3).max(16),
  enabled: z.boolean(),
});

export const GET = route(async () => {
  const session = await getServerSession(authOptions);
  const userId = await assertFreshSession(session);

  const rl = rateLimit(`notif-pref-list:${userId}`, 30, 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please slow down.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const preferences = await listEffectivePreferences(userId);
  return ok({ preferences });
});

export const PUT = route(async (req: NextRequest) => {
  const session = await getServerSession(authOptions);
  const userId = await assertFreshSession(session);

  const rl = rateLimit(`notif-pref-put:${userId}`, 30, 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please slow down.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const input = await parseBody(req, putSchema);
  try {
    const preference = await updatePreference(userId, input);
    return ok({ preference });
  } catch (error) {
    if (error instanceof NotificationPreferenceError) {
      throw new ApiError(error.status, error.code, preferenceErrorMessage(error.code));
    }
    throw error;
  }
});

const MESSAGES: Record<NotificationPreferenceError["code"], string> = {
  NOTIFICATION_TYPE_UNKNOWN: "Unknown notification type.",
  NOTIFICATION_CHANNEL_UNSUPPORTED: "This channel is not available for the notification.",
  NOTIFICATION_PREFERENCE_UNAVAILABLE: "This notification cannot be configured.",
  NOTIFICATION_PREFERENCE_FORBIDDEN:
    "Security-critical notifications cannot be disabled.",
};

function preferenceErrorMessage(code: NotificationPreferenceError["code"]): string {
  return MESSAGES[code] ?? "The preference could not be updated.";
}
