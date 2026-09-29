/**
 * POST /api/v1/imports/[jobId]/cancel — cancel a not-yet-committed import
 * (Prompt 31 §177-analog for imports; staged file is deleted on cancel).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext } from "@/lib/tenant";
import { cancelImportJob, assertImportRole } from "@/lib/data-portability/import-service";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest, params: { params: Promise<{ jobId: string }> }) => {
  const ctx = await getAuthContext(req);
  assertImportRole(ctx);
  const { jobId } = await params.params;
  if (!/^[a-z0-9]{20,40}$/i.test(jobId)) {
    throw new ApiError(404, "IMPORT_NOT_FOUND", "Import job not found.");
  }
  const job = await cancelImportJob(ctx, jobId, { requestId: req.headers.get("x-request-id") ?? "" });
  return ok(job);
});
