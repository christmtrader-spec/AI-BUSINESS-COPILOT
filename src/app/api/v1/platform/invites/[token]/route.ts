/**
 * /api/v1/platform/invites/[token] — anonymous-with-token operator invite
 * redemption (R67, §161 pattern: the token IS the authorization).
 *
 * GET  — preview: what role, who invited, until when, and whether the email
 *        already has an account (binds the password field semantics — the
 *        holder already knows the email; no OTHER existence oracle).
 * POST — redeem: single-use, transactional exactly-once claim; NEW accounts
 *        set their first password, EXISTING accounts prove control with the
 *        CURRENT password. Rate-limited per IP+token; every failure records
 *        a SecurityEvent (fixed vocabulary); the token is NEVER stored in
 *        any log, audit, or event payload (§14).
 */
import { NextRequest } from "next/server";
import { route, ApiError, ok } from "@/lib/api-helpers";
import { parsePlatformBody } from "@/lib/platform/http";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import {
  operatorInvitePreviewDto,
  operatorInviteRedeemSchema,
  redeemOperatorInvite,
} from "@/lib/platform/operator-invites";
import { platformAudit } from "@/lib/platform/audit";
import {
  boundUserAgent,
  hashIp,
  recordSecurityEvent,
  SECURITY_EVENTS,
} from "@/lib/auth/security-events/service";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ token: string }> };

function redeemRateLimit(req: NextRequest, token: string) {
  const ip = getClientIp(req);
  return rateLimit(`platform-invite:${ip ?? "unknown"}:${token.slice(0, 12)}`, 10, 10 * 60_000);
}

function throwRateLimited(): never {
  throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Please wait and try again.");
}

export const GET = route(async (req: NextRequest, { params }: RouteParams) => {
  const { token } = await params;

  const rl = redeemRateLimit(req, token);
  if (!rl.allowed) {
    throwRateLimited();
  }

  const invite = await db.platformOperatorInvite.findUnique({
    where: { token },
    select: {
      email: true, name: true, role: true, expiresAt: true,
      acceptedAt: true, revokedAt: true,
      createdBy: { select: { name: true, email: true } },
    },
  });
  // Invalid token → honest 404 (rate-limit still bounds guessing).
  if (!invite) {
    throw new ApiError(404, "PLATFORM_INVITE_INVALID", "This invitation link is not valid.");
  }

  const account = await db.user.findUnique({
    where: { email: invite.email },
    select: { id: true },
  });

  return ok({ invite: operatorInvitePreviewDto(invite, account !== null) });
});

export const POST = route(async (req: NextRequest, { params }: RouteParams) => {
  const { token } = await params;
  const ip = getClientIp(req);
  const ua = req.headers.get("user-agent");

  const rl = redeemRateLimit(req, token);
  if (!rl.allowed) {
    throwRateLimited();
  }

  const body = await parsePlatformBody(req, operatorInviteRedeemSchema);

  try {
    const result = await redeemOperatorInvite(token, body, { ip, userAgent: ua });

    // Durable security activity (fixed vocabulary; never the token §14).
    await recordSecurityEvent({
      eventType: SECURITY_EVENTS.operatorInviteAccepted,
      userId: result.userId,
      ip,
      userAgent: ua,
      success: true,
      reasonCode: null,
    });
    // System-level audit (operatorId null = anonymous-with-token actor;
    // the invite row id is the linkage, NOT the token).
    const inviteRow = await db.platformOperatorInvite.findUnique({
      where: { token },
      select: { id: true, email: true, role: true },
    });
    if (inviteRow) {
      await platformAudit({
        operatorId: null,
        operatorRole: null,
        action: "platform.operator_invite_accepted",
        entityType: "PlatformOperatorInvite",
        entityId: inviteRow.id,
        targetUserId: result.userId,
        reason: null,
        after: { email: inviteRow.email, role: inviteRow.role, accountCreated: result.accountCreated },
        ip,
        userAgent: ua,
      });
    }

    return ok({
      accepted: true,
      role: result.role,
      accountCreated: result.accountCreated,
    });
  } catch (err) {
    // Record the failure (fixed vocabulary; no token, no password §14/§90).
    await recordSecurityEvent({
      eventType: SECURITY_EVENTS.operatorInviteRedeemFailed,
      userId: null,
      ip,
      userAgent: ua,
      success: false,
      reasonCode: err instanceof ApiError ? err.code : null,
    });
    throw err;
  }
});
