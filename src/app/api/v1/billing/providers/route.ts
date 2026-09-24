/**
 * GET /api/v1/billing/providers — configured payment providers (Prompt 22).
 *
 * Informational: which providers exist in THIS environment and whether
 * they are usable. Never exposes keys, secrets or endpoints — only slugs,
 * display names and mode (SANDBOX/LIVE) so the UI can label the sandbox
 * honestly.
 */
import { NextRequest } from "next/server";
import { ok, route } from "@/lib/api-helpers";
import { getAuthContext } from "@/lib/tenant";
import { listProviders } from "@/lib/payments";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  await getAuthContext(req);
  return ok({ providers: listProviders() });
});
