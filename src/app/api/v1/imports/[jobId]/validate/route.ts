/**
 * POST /api/v1/imports/[jobId]/validate — row validation (Prompt 31 §89).
 * Parses the staged file and validates every mapped row SERVER-SIDE.
 * NO business-data mutation (§60); only the job's own counters advance.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { validateImportJob, assertImportRole } from "@/lib/data-portability/import-service";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest, params: { params: Promise<{ jobId: string }> }) => {
  const ctx = await getAuthContext(req);
  assertImportRole(ctx);
  const { jobId } = await params.params;
  if (!/^[a-z0-9]{20,40}$/i.test(jobId)) {
    throw new ApiError(404, "IMPORT_NOT_FOUND", "Import job not found.");
  }

  const limit = rateLimit(`imports-validate:${ctx.businessId}:${ctx.userId}`, 30, 60 * 60_000);
  if (!limit.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please slow down.");
  }

  const result = await validateImportJob(ctx, jobId, { requestId: req.headers.get("x-request-id") ?? "" });
  return ok(result);
});
