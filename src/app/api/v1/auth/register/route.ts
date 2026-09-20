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

export const dynamic = "force-dynamic";

const registerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email(),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(200)
    .regex(/[a-zA-Z]/, "Password must contain a letter")
    .regex(/[0-9]/, "Password must contain a number"),
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

  return ok({ user }, 201);
});
