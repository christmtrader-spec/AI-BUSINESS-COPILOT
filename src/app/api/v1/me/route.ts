/**
 * GET   /api/v1/me — caller profile.
 * PATCH /api/v1/me — update profile (name, locale preference).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  locale: z.enum(["en", "fa"]).optional(),
});

export const GET = route(async () => {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!session || !userId) {
    throw new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, locale: true, createdAt: true },
  });
  if (!user) throw new ApiError(404, "NOT_FOUND", "Account not found.");

  return ok(user);
});

export const PATCH = route(async (req: NextRequest) => {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!session || !userId) {
    throw new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  }

  const input = await parseBody(req, updateSchema);

  const user = await db.user.update({
    where: { id: userId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
    },
    select: { id: true, name: true, email: true, locale: true, createdAt: true },
  });

  return ok(user);
});
