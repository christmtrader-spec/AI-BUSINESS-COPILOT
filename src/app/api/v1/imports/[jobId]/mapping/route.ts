/**
 * POST /api/v1/imports/[jobId]/mapping — submit the validated field
 * mapping (Prompt 31 §88). The server validates the mapping against the
 * per-dataset allowlist (§70) — the browser can never send a raw Prisma
 * field name (§69) or a forbidden identity/security/billing field
 * (§291-§296). No database mutation (§60).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { setImportMapping, assertImportRole } from "@/lib/data-portability/import-service";
import { DUPLICATE_MODES } from "@/lib/data-portability/import-catalog";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  // source column -> target field ("" = not mapped); targets validated
  // against the import catalog inside the service.
  mapping: z.record(z.string().max(200), z.string().max(60)),
  duplicateMode: z.enum(DUPLICATE_MODES).default("SKIP"),
});

export const POST = route(async (req: NextRequest, params: { params: Promise<{ jobId: string }> }) => {
  const ctx = await getAuthContext(req);
  assertImportRole(ctx);
  const { jobId } = await params.params;
  if (!/^[a-z0-9]{20,40}$/i.test(jobId)) {
    throw new ApiError(404, "IMPORT_NOT_FOUND", "Import job not found.");
  }

  const limit = rateLimit(`imports-mapping:${ctx.businessId}:${ctx.userId}`, 30, 60 * 60_000);
  if (!limit.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please slow down.");
  }

  const input = await parseBody(req, bodySchema);
  const job = await setImportMapping(ctx, jobId, input, { requestId: req.headers.get("x-request-id") ?? "" });
  return ok(job);
});
