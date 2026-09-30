/**
 * POST /api/v1/platform/notifications/deliveries/[deliveryId]/retry —
 * platform operator retry for a FAILED OPTIONAL email delivery
 * (Prompt 32 §260). MANDATORY security emails are NEVER resent through
 * this path (§260/§261 — no reset link, MFA code or recovery code can ever
 * flow through a notification retry), the attempt cap is enforced (§361),
 * and every action is platform-audited (§314).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { platformAudit } from "@/lib/platform/audit";
import { retryFailedEmailDelivery } from "@/lib/notifications";

export const dynamic = "force-dynamic";

export const POST = route(
  async (_req: NextRequest, ctx: { params: Promise<{ deliveryId: string }> }) => {
    const platform = await getPlatformContext();
    // Operator-facing action (§258): support/super-admin roles only.
    requirePlatformPermission(platform, "platform:system:read");
    if (platform.role !== "PLATFORM_SUPER_ADMIN" && platform.role !== "PLATFORM_SUPPORT") {
      throw new ApiError(403, "PLATFORM_PERMISSION_DENIED", "Your operator role does not allow this action.", {
        permission: "platform:notifications:retry",
      });
    }

    const { deliveryId } = await ctx.params;
    if (!/^[a-zA-Z0-9_-]{10,64}$/.test(deliveryId)) {
      throw new ApiError(422, "VALIDATION_ERROR", "Invalid delivery id.");
    }

    const result = await retryFailedEmailDelivery(deliveryId);
    if (!result.retried) {
      throw new ApiError(409, `DELIVERY_RETRY_${result.code}`, "The delivery cannot be retried.", {
        code: result.code,
      });
    }

    await platformAudit({
      operatorId: platform.operatorId,
      operatorRole: platform.role,
      action: "platform.notifications.delivery_retried",
      entityType: "NotificationDelivery",
      entityId: deliveryId,
      after: { retried: true },
    });

    return ok({ retried: true });
  },
);
