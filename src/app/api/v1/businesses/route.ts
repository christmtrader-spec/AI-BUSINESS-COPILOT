/**
 * GET  /api/v1/businesses — businesses the caller belongs to (with role).
 * POST /api/v1/businesses — create a business; caller becomes OWNER (A01).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { db } from "@/lib/db";
import { authOptions } from "@/lib/auth";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { findCurrency } from "@/lib/currencies";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  currencyCode: z.string().trim().length(3),
  currencySymbol: z.string().trim().min(1).max(8).optional(),
  decimalPrecision: z.number().int().min(0).max(4).optional(),
  locale: z.enum(["en", "fa"]).default("en"),
  timezone: z.string().trim().min(1).max(64).default("UTC"),
});

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${base || "business"}-${rand}`;
}

export const GET = route(async () => {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!session || !userId) {
    throw new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  }

  const memberships = await db.businessMember.findMany({
    where: { userId },
    include: { business: { include: { _count: { select: { members: true } } } } },
    orderBy: { createdAt: "asc" },
  });

  return ok(
    memberships.map((m) => ({
      business: {
        id: m.business.id,
        name: m.business.name,
        slug: m.business.slug,
        currencyCode: m.business.currencyCode,
        currencySymbol: m.business.currencySymbol,
        decimalPrecision: m.business.decimalPrecision,
        locale: m.business.locale,
        timezone: m.business.timezone,
        ownerId: m.business.ownerId,
        memberCount: m.business._count.members,
        createdAt: m.business.createdAt,
        updatedAt: m.business.updatedAt,
      },
      role: m.role,
      memberId: m.id,
    })),
  );
});

export const POST = route(async (req: NextRequest) => {
  const session = await getServerSession(authOptions);
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!session || !userId) {
    throw new ApiError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  }

  const input = await parseBody(req, createSchema);

  const currency = findCurrency(input.currencyCode);
  if (!currency) {
    throw new ApiError(422, "INVALID_CURRENCY", "Unsupported currency code.");
  }

  const business = await db.$transaction(async (tx) => {
    const created = await tx.business.create({
      data: {
        name: input.name,
        slug: slugify(input.name),
        currencyCode: currency.code,
        currencySymbol: input.currencySymbol ?? currency.symbol,
        decimalPrecision: input.decimalPrecision ?? currency.precision,
        locale: input.locale,
        timezone: input.timezone,
        ownerId: userId,
        members: {
          create: { userId, role: "OWNER" },
        },
      },
    });

    await audit(
      {
        businessId: created.id,
        actorId: userId,
        action: "business.create",
        entityType: "Business",
        entityId: created.id,
        after: { name: created.name, currencyCode: created.currencyCode },
      },
      tx,
    );

    return created;
  });

  return ok(
    {
      business: {
        id: business.id,
        name: business.name,
        slug: business.slug,
        currencyCode: business.currencyCode,
        currencySymbol: business.currencySymbol,
        decimalPrecision: business.decimalPrecision,
        locale: business.locale,
        timezone: business.timezone,
        ownerId: business.ownerId,
        createdAt: business.createdAt,
        updatedAt: business.updatedAt,
      },
      role: "OWNER",
    },
    201,
  );
});
