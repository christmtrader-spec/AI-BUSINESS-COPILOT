/**
 * POST /api/v1/auth/register — create a user account (A14: validation,
 * bcrypt hashing, rate limiting). Does NOT auto-create a business;
 * onboarding does that after first sign-in.
 */
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError, getClientIp, ok, parseBody, route } from "@/lib/api-helpers";
import { rateLimit } from "@/lib/rate-limit";
import { passwordSchema } from "@/lib/auth-security";
import { recordCommercialEvent } from "@/lib/billing/events";
import { ACCEPTED_DOC_TYPES, currentLegalVersions } from "@/content/legal/registry";

export const dynamic = "force-dynamic";

const registerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email(),
  // Single source of truth for the password policy (Prompt 18 §6).
  password: passwordSchema,
  /**
   * Prompt 27 §53/§163 — explicit legal acceptance at signup. The product
   * UI (signup card) always requires an UNCHECKED-by-default checkbox before
   * submitting. The SERVER resolves the accepted document versions from the
   * content registry — the client never names a version. Optional at the API
   * boundary for backward compatibility with existing integrations; the
   * acceptance record is only written when BOTH contract documents are
   * explicitly accepted.
   */
  acceptedLegal: z
    .object({ terms: z.literal(true), privacy: z.literal(true) })
    .optional(),
});

export const POST = route(async (req: NextRequest) => {
  const rl = rateLimit(`register:${getClientIp(req)}`, 10, 15 * 60 * 1000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Please try again later.");
  }

  const input = await parseBody(req, registerSchema);

  const existing = await db.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw new ApiError(409, "EMAIL_TAKEN", "An account with this email already exists.");
  }

  const passwordHash = await bcrypt.hash(input.password, 12);
  const user = await db.user.create({
    data: {
      name: input.name,
      email: input.email,
      passwordHash,
      locale: "en",
    },
    select: { id: true, email: true, name: true },
  });

  // Prompt 27 §53/§54/§56/§163 — append-only acceptance records referencing
  // the CURRENT document versions (server-resolved; text is never stored).
  // Idempotent by unique(userId, documentType, documentVersion).
  if (input.acceptedLegal) {
    const versions = currentLegalVersions();
    // A freshly created user can have no prior acceptance rows, so no
    // duplicate handling is needed (unique constraint is the safety net).
    await db.legalAcceptance.createMany({
      data: ACCEPTED_DOC_TYPES.map((documentType) => ({
        userId: user.id,
        documentType,
        documentVersion: versions[documentType],
        locale: "en",
        ip: getClientIp(req),
        userAgent: req.headers.get("user-agent")?.slice(0, 255) ?? null,
      })),
    });
  }

  // Funnel: SIGNUP_COMPLETED (once per user). Analytics are fire-safe —
  // a failure here must never fail the signup itself.
  void recordCommercialEvent({
    eventType: "SIGNUP_COMPLETED",
    userId: user.id,
    dedupeKey: `signup:${user.id}`,
  });

  return ok({ user }, 201);
});
