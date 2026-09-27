/**
 * GET /api/v1/legal/documents — minimal legal document metadata (Prompt 27
 * §160/§161). Used by the in-app settings Legal section to show the CURRENT
 * Terms/Privacy versions. Read-only, authenticated, and deliberately minimal:
 * only documentType / version / effectiveDate / lastUpdated leave the
 * boundary — never section content, never internal review markers.
 */
import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { ok, route } from "@/lib/api-helpers";
import { authOptions } from "@/lib/auth";
import { assertFreshSession } from "@/lib/auth-security";
import { LEGAL_DOCUMENTS, LEGAL_DOC_TYPES } from "@/content/legal/registry";

export const dynamic = "force-dynamic";

export const GET = route(async (_req: NextRequest) => {
  const session = await getServerSession(authOptions);
  await assertFreshSession(session); // account-scoped metadata

  return ok({
    documents: LEGAL_DOC_TYPES.map((type) => {
      const doc = LEGAL_DOCUMENTS[type];
      return {
        documentType: type,
        version: doc.version,
        // null = effective date not configured (never faked, §219).
        effectiveDate: doc.effectiveDate,
        lastUpdated: doc.lastUpdated,
      };
    }),
  });
});
