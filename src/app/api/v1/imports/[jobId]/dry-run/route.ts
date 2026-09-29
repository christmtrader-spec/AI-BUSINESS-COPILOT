/**
 * POST /api/v1/imports/[jobId]/dry-run — commit preview (Prompt 31 §90).
 * Produces would-create / would-skip / duplicate counts against CURRENT
 * business data. ZERO database mutation — createdAt/updatedAt/stock/
 * balances are untouched (§86/§285).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { dryRunImportJob, assertImportRole } from "@/lib/data-portability/import-service";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest, params: { params: Promise<{ jobId: string }> }) => {
  const ctx = await getAuthContext(req);
  assertImportRole(ctx);
  const { jobId } = await params.params;
  if (!/^[a-z0-9]{20,40}$/i.test(jobId)) {
    throw new ApiError(404, "IMPORT_NOT_FOUND", "Import job not found.");
  }

  const limit = rateLimit(`imports-dryrun:${ctx.businessId}:${ctx.userId}`, 30, 60 * 60_000);
  if (!limit.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please slow down.");
  }

  const result = await dryRunImportJob(ctx, jobId, { requestId: req.headers.get("x-request-id") ?? "" });
  return ok(result);
});
