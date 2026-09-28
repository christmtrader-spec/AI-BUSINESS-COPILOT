/**
 * POST /api/v1/platform/payments/[id]/investigation (Prompt 28 §32).
 *
 * Safe investigation workflow: the operator records a reason, a review
 * status and a bounded internal note. The record lives in
 * CheckoutSession.metaJson under `platformReview` (merged — existing
 * metadata is preserved). AMOUNT / CURRENCY / providerRef / signature /
 * verified provider evidence are structurally UNMODIFIABLE here: the
 * request schema simply has no such field (§32/§81).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { route } from "@/lib/api-helpers";
import { assertPlatformReauth, getPlatformContext, platformError, requirePlatformPermission } from "@/lib/platform/auth";
import { parsePlatformBody, platformOk } from "@/lib/platform/http";
import { platformAudit, requestIdOf } from "@/lib/platform/audit";
import { rateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/api-helpers";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const REVIEW_STATUSES = ["OPEN", "UNDER_REVIEW", "RESOLVED"] as const;

const bodySchema = z.object({
  reason: z.string().trim().min(3).max(300),
  reviewStatus: z.enum(REVIEW_STATUSES),
  note: z.string().trim().max(500).optional(),
  password: z.string().min(1).max(200).optional(),
});

export const POST = route(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getPlatformContext(req);
  requirePlatformPermission(ctx, "platform:payments:reconcile");
  const { id } = await params;
  const body = await parsePlatformBody(req, bodySchema);

  const rl = rateLimit(`platform:${ctx.operatorId}:payment-investigation`, 15, 15 * 60_000);
  if (!rl.allowed) {
    throw platformError(429, "PLATFORM_INVALID_OPERATION", "Too many attempts. Try again later.");
  }

  await assertPlatformReauth(ctx, body.password);

  const session = await db.checkoutSession.findUnique({
    where: { id },
    select: { id: true, businessId: true, status: true, metaJson: true },
  });
  if (!session) {
    throw platformError(404, "PLATFORM_INVALID_OPERATION", "Payment session not found.");
  }

  // Merge — never destroy existing metadata.
  let existingMeta: Record<string, unknown> = {};
  if (session.metaJson) {
    try {
      existingMeta = JSON.parse(session.metaJson) as Record<string, unknown>;
    } catch {
      existingMeta = {};
    }
  }
  const review = {
    ...(typeof existingMeta.platformReview === "object" && existingMeta.platformReview !== null
      ? (existingMeta.platformReview as Record<string, unknown>)
      : {}),
    reviewStatus: body.reviewStatus,
    note: body.note ?? null,
    updatedByOperatorId: ctx.operatorId,
    updatedAt: new Date().toISOString(),
  };
  const nextMeta = { ...existingMeta, platformReview: review };

  const requestId = requestIdOf(req);
  await db.$transaction(async (tx) => {
    await tx.checkoutSession.update({
      where: { id: session.id },
      data: { metaJson: JSON.stringify(nextMeta) },
    });
    await platformAudit(
      {
        operatorId: ctx.operatorId,
        operatorRole: ctx.role,
        action: "payment.investigation_recorded",
        entityType: "CheckoutSession",
        entityId: session.id,
        targetBusinessId: session.businessId,
        reason: body.reason,
        after: { reviewStatus: body.reviewStatus },
        requestId,
        ip: getClientIp(req),
        userAgent: req.headers.get("user-agent"),
      },
      tx as Parameters<typeof platformAudit>[1],
    );
  });

  return platformOk({ recorded: true, reviewStatus: body.reviewStatus, requestId });
});
