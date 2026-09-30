/**
 * POST /api/v1/platform/notifications/announcements — SYSTEM_ANNOUNCEMENT
 * creation by an AUTHORIZED PLATFORM OPERATOR ONLY (Prompt 32 §154/§155).
 *
 * Guards:
 *  - platform authorization (PLATFORM_SUPER_ADMIN / PLATFORM_SUPPORT, §258)
 *  - EXPLICIT recipient user ids only — never an audience query (§155),
 *    bounded to 50 recipients per call
 *  - message is bounded plain text that flows through the per-type schema
 *    + sanitizer gates (§23/§24/§25) — no HTML, no markdown (§153)
 *  - platform-audited (§314)
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { platformAudit } from "@/lib/platform/audit";
import { createSystemAnnouncement } from "@/lib/notifications";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  recipientUserIds: z.array(z.string().min(10).max(64)).min(1).max(50),
  message: z.string().min(1).max(500),
});

export const POST = route(async (req: NextRequest) => {
  const platform = await getPlatformContext();
  requirePlatformPermission(platform, "platform:system:read");
  if (platform.role !== "PLATFORM_SUPER_ADMIN" && platform.role !== "PLATFORM_SUPPORT") {
    throw new ApiError(403, "PLATFORM_PERMISSION_DENIED", "Your operator role does not allow this action.", {
      permission: "platform:notifications:announce",
    });
  }

  const input = await parseBody(req, bodySchema);

  const result = await createSystemAnnouncement({
    operatorId: platform.operatorId,
    recipientUserIds: input.recipientUserIds,
    message: input.message,
  });

  await platformAudit({
    operatorId: platform.operatorId,
    operatorRole: platform.role,
    action: "platform.notifications.announcement_sent",
    entityType: "Notification",
    entityId: null,
    after: {
      recipients: result.accepted,
      rejected: result.rejected,
      messageLength: input.message.length,
    },
  });

  return ok(result);
});
