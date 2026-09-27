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

export const dynamic = "force-dynamic";

const registerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email(),
  // Single source of truth for the password policy (Prompt 18 §6).
  password: passwordSchema,
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

  // Funnel: SIGNUP_COMPLETED (once per user). Analytics are fire-safe —
  // a failure here must never fail the signup itself.
  void recordCommercialEvent({
    eventType: "SIGNUP_COMPLETED",
    userId: user.id,
    dedupeKey: `signup:${user.id}`,
  });

  return ok({ user }, 201);
});
