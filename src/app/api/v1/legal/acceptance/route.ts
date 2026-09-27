/**
 * Legal acceptance API — Prompt 27 (§162–§165).
 *
 * GET  /api/v1/legal/acceptance — the CURRENT authenticated user's own
 *      acceptance records. The userId is ALWAYS resolved from the session
 *      (§106) — client-provided identifiers are never trusted.
 *
 * POST /api/v1/legal/acceptance — record acceptance of the CURRENT versions.
 *      The server resolves both the userId (session) and the documentVersion
 *      (content registry) — the client may only name the documentType
 *      (§162/§163: no client version trust). Repeated acceptance of the same
 *      version is idempotent through the DB unique constraint (§164) and
 *      returns the existing record instead of duplicating it.
 *
 * Append-only: accepted records are never edited or deleted by this API.
 * Locale comes from the user's stored profile preference — server-derived,
 * not client-asserted.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { ApiError, getClientIp, ok, parseBody, route } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { assertFreshSession } from "@/lib/auth-security";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { ACCEPTED_DOC_TYPES, currentLegalVersions, isLegalDocType } from "@/content/legal/registry";

export const dynamic = "force-dynamic";

const acceptSchema = z.object({
  documentType: z.string().refine(isLegalDocType, "Unknown document type."),
});

export const GET = route(async () => {
  const session = await getServerSession(authOptions);
  const userId = await assertFreshSession(session);

  const records = await db.legalAcceptance.findMany({
    where: { userId }, // session-resolved — never a client parameter
    orderBy: { acceptedAt: "desc" },
    select: {
      documentType: true,
      documentVersion: true,
      locale: true,
      acceptedAt: true,
    },
  });

  return ok({ acceptances: records });
});

export const POST = route(async (req: NextRequest) => {
  const session = await getServerSession(authOptions);
  const userId = await assertFreshSession(session);

  const rl = rateLimit(`legal-accept:${userId}:${getClientIp(req)}`, 10, 60 * 60_000);
  if (!rl.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Please wait a moment.", {
      retryAfterMs: rl.retryAfterMs,
    });
  }

  const input = await parseBody(req, acceptSchema);
  // §162: only accepted contract types can be recorded here.
  if (!ACCEPTED_DOC_TYPES.includes(input.documentType)) {
    throw new ApiError(422, "NOT_ACCEPTABLE_TYPE", "This document type is not an accepted contract.");
  }

  // Server resolves the CURRENT version — the client cannot submit one (§163).
  const version = currentLegalVersions()[input.documentType];

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { locale: true },
  });
  if (!user) {
    throw new ApiError(401, "SESSION_INVALIDATED", "This session is no longer valid. Please sign in again.");
  }

  // Append-only + idempotent (§164/§54): if the row exists it is returned
  // untouched; otherwise it is created once. The flag is decided by whether
  // the record ALREADY existed — never by timestamp heuristics.
  const existing = await db.legalAcceptance.findUnique({
    where: {
      userId_documentType_documentVersion: {
        userId,
        documentType: input.documentType,
        documentVersion: version,
      },
    },
    select: { documentType: true, documentVersion: true, locale: true, acceptedAt: true },
  });

  const record =
    existing ??
    (await db.legalAcceptance.create({
      data: {
        userId,
        documentType: input.documentType,
        documentVersion: version,
        locale: user.locale === "fa" ? "fa" : "en",
        ip: getClientIp(req),
        userAgent: req.headers.get("user-agent")?.slice(0, 255) ?? null,
      },
      select: { documentType: true, documentVersion: true, locale: true, acceptedAt: true },
    }));

  return ok({ acceptance: record, alreadyAccepted: existing !== null });
});
