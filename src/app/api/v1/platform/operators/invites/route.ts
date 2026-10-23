/**
 * /api/v1/platform/operators/invites — operator invitation management (R67).
 *
 * GET  — list invites (platform:operators:read).
 * POST — create an invite ("admin registration", §9/§61-safe): super admin
 *        ONLY, reauthentication (§56), mandatory reason, rate-limited,
 *        audited. The opaque token is returned EXACTLY ONCE in this
 *        response (display-once law §60) — it is a credential and is never
 *        stored in logs, audits, or list DTOs.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { route, ApiError } from "@/lib/api-helpers";
import { assertPlatformReauth, getPlatformContext, requirePlatformPermission } from "@/lib/platform/auth";
import { pageMeta, parsePagination, parsePlatformBody, platformOk } from "@/lib/platform/http";
import { platformAudit, requestIdOf } from "@/lib/platform/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { isOperatorManagerRole } from "@/lib/platform/rbac";
import {
  generateInviteToken,
  hashInviteToken,
  inviteExpiry,
  OPERATOR_INVITE_TTL_MS,
  operatorInviteDto,
  operatorInviteSchema,
} from "@/lib/platform/operator-invites";
import { recordSecurityEvent, SECURITY_EVENTS } from "@/lib/auth/security-events/service";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:operators:read");

  const p = parsePagination(req.nextUrl.searchParams);

  const [rows, total] = await Promise.all([
    db.platformOperatorInvite.findMany({
      orderBy: { createdAt: "desc" },
      take: p.pageSize,
      skip: p.skip,
      include: {
        createdBy: { select: { name: true, email: true } },
        acceptedUser: { select: { email: true } },
      },
    }),
    // Bounded count (§63) — full-table count is fine at operator-console
    // volumes.
    db.platformOperatorInvite.count(),
  ]);

  const status = req.nextUrl.searchParams.get("status");
  const invites = rows
    .map(operatorInviteDto)
    .filter((i) => (status && status !== "ALL" ? i.status === status : true));

  return platformOk({ invites, page: pageMeta(p, total) });
});

const createSchema = operatorInviteSchema.extend({
  password: z.string().min(1).max(200),
});

export const POST = route(async (req: NextRequest) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:operators:manage");
  if (!isOperatorManagerRole(ctx.role)) {
    throw new ApiError(403, "PLATFORM_PERMISSION_DENIED", "Only a super admin can manage operators.");
  }
  const body = await parsePlatformBody(req, createSchema);

  const rl = rateLimit(`platform:${ctx.operatorId}:operator-invite`, 10, 15 * 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "PLATFORM_INVALID_OPERATION", "Too many attempts. Try again later.");
  }

  await assertPlatformReauth(ctx, body.password);

  // An existing operator record makes the invite moot — refuse early with
  // an honest 409 (the inviter can pick another email instead).
  const existingUser = await db.user.findUnique({
    where: { email: body.email },
    select: { id: true },
  });
  if (existingUser) {
    const existingOperator = await db.platformOperator.findUnique({
      where: { userId: existingUser.id },
      select: { id: true },
    });
    if (existingOperator) {
      throw new ApiError(409, "PLATFORM_INVALID_OPERATION", "This account already has an operator record.");
    }
  }

  // One live PENDING invite per email is enough — a second would only
  // multiply leaked-link risk (§8 — minimize credential surfaces).
  const liveDuplicate = await db.platformOperatorInvite.findFirst({
    where: { email: body.email, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true },
  });
  if (liveDuplicate) {
    throw new ApiError(409, "PLATFORM_INVALID_OPERATION", "A pending invitation for this email already exists.");
  }

  const token = generateInviteToken();
  const requestId = requestIdOf(req);
  const created = await db.$transaction(async (tx) => {
    const invite = await tx.platformOperatorInvite.create({
      data: {
        // R69 F1 — the raw token is NEVER persisted; only its digest is.
        tokenHash: hashInviteToken(token),
        email: body.email,
        name: body.name,
        role: body.role,
        createdById: ctx.userId,
        expiresAt: inviteExpiry(),
      },
      include: {
        createdBy: { select: { name: true, email: true } },
        acceptedUser: { select: { email: true } },
      },
    });
    await platformAudit(
      {
        operatorId: ctx.operatorId,
        operatorRole: ctx.role,
        action: "platform.operator_invite_created",
        entityType: "PlatformOperatorInvite",
        entityId: invite.id,
        targetUserId: null,
        reason: body.reason,
        after: { email: body.email, role: body.role, expiresAt: invite.expiresAt.toISOString() },
        requestId,
        ip: getClientIp(req),
        userAgent: req.headers.get("user-agent"),
      },
      tx as Parameters<typeof platformAudit>[1],
    );
    return invite;
  });

  // Security activity (fixed vocabulary; the TOKEN is never recorded §14).
  await recordSecurityEvent({
    eventType: SECURITY_EVENTS.operatorInviteCreated,
    userId: null,
    ip: getClientIp(req),
    userAgent: req.headers.get("user-agent"),
    success: true,
    reasonCode: null,
  });

  // The ONE-TIME disclosure: token + ready-made redemption link. Everything
  // else (lists, detail, audits) carries the invite id only.
  return platformOk(
    {
      invite: operatorInviteDto(created),
      token,
      redemptionUrl: `#/platform-join/${token}`,
      expiresInHours: OPERATOR_INVITE_TTL_MS / (60 * 60 * 1000),
      requestId,
    },
    201,
  );
});
