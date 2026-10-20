/**
 * GET  /api/v1/businesses — businesses the caller belongs to (with role).
 * POST /api/v1/businesses — create a business; caller becomes OWNER (A01).
 *
 * Prompt 20: creation is gated by BUSINESSES_MAX (§30/§107) — counted as
 * businesses the user OWNS (ownerId = user); staff memberships never
 * count. The gate + count + create + the business's own FREE subscription
 * all happen inside ONE serializable transaction, so every business is
 * born with a valid subscription (§13: no business is ever left without
 * a well-defined entitlement state).
 */
import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { db } from "@/lib/db";
import { authOptions } from "@/lib/auth";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { audit } from "@/lib/audit";
import { findCurrency } from "@/lib/currencies";
import { rateLimit } from "@/lib/rate-limit";
import { assertFreshSession } from "@/lib/auth-security";
import { assertWithinBusinessesLimitTx, ensureSubscription, recordCommercialEvent } from "@/lib/billing";
import { ensureBillingCatalog } from "@/lib/billing/self-heal";

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
  // Prompt 18 §16 freshness gate — a JWT stamped before a password
  // change/reset or a platform security invalidation can never list
  // memberships (r28: this route previously bypassed the checkpoint).
  const userId = await assertFreshSession(await getServerSession(authOptions));

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
        vatEnabled: m.business.vatEnabled,
        vatRateBp: m.business.vatRateBp,
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
  // Prompt 18 §16 freshness gate (r28 hardening).
  const userId = await assertFreshSession(await getServerSession(authOptions));

  // Prompt 30 §10/§120 — REQUIRED-mode email verification gate.
  const { assertEmailVerifiedForCommercialAction } = await import(
    "@/lib/auth/email-verification/gate"
  );
  await assertEmailVerifiedForCommercialAction(userId);

  // Audit hardening: bound business creation per user (in-memory MVP limiter).
  const rl = rateLimit(`business:create:${userId}`, 5, 60 * 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many businesses created. Please try again later.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const input = await parseBody(req, createSchema);

  const currency = findCurrency(input.currencyCode);
  if (!currency) {
    throw new ApiError(422, "INVALID_CURRENCY", "Unsupported currency code.");
  }

  // Permanent fix: a missing/wiped billing catalog (environmental damage —
  // the DB snapshot reverts repeatedly dropped Plan/…/PlanPrice) must NEVER
  // surface as BILLING_UNAVAILABLE on business creation. Restore the
  // canonical catalog first: a cheap read-only no-op when healthy, an
  // idempotent create-missing-only re-seed when wiped. VALUE-level catalog
  // corruption is deliberately NOT auto-repaired — the gate inside the
  // transaction below still fails closed with the honest controlled error
  // (P51-R1-FINAL §2 contract preserved).
  try {
    await ensureBillingCatalog("business-create");
  } catch {
    // Catalog health is re-evaluated authoritatively by the gate inside the
    // transaction; a failed heal surfaces through it honestly (fail-closed).
  }

  const business = await db.$transaction(
    async (tx) => {
      // Billing gate (§30/§107): businesses the user OWNS vs the effective
      // BUSINESSES_MAX (max across owned businesses' plans, FREE fallback).
      await assertWithinBusinessesLimitTx(tx, userId);

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

      // §13: every business is born with a deterministic FREE subscription,
      // created inside this same transaction.
      await ensureSubscription(created.id, { actorId: userId, source: "business-create", tx });

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
    },
    // Prompt 26 note: SQLite serializes writers — the cost-attribution and
    // conversion-event writes add light contention to this Serializable
    // transaction, so it needs the SAME explicit timeout the Prompt-21
    // metering transactions use (default 5s proved too tight, P2028).
    { isolationLevel: "Serializable", timeout: 30_000, maxWait: 5_000 },
  );

  // Funnel: BUSINESS_CREATED (once per business, fire-safe analytics).
  void recordCommercialEvent({
    eventType: "BUSINESS_CREATED",
    userId,
    businessId: business.id,
    dedupeKey: `business:${business.id}`,
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
