/**
 * POST /api/v1/exports/[jobId]/cancel — cancel a QUEUED export job
 * (Prompt 31 §29/§178/§329). Completed files are NOT revoked by cancel —
 * they simply expire on schedule (§29).
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext } from "@/lib/tenant";
import { cancelExportJob } from "@/lib/data-portability/export-service";

export const dynamic = "force-dynamic";

export const POST = route(async (req: NextRequest, params: { params: Promise<{ jobId: string }> }) => {
  const ctx = await getAuthContext(req);
  const { jobId } = await params.params;
  if (!/^[a-z0-9]{20,40}$/i.test(jobId)) {
    throw new ApiError(404, "EXPORT_NOT_FOUND", "Export job not found.");
  }
  const job = await cancelExportJob(ctx, jobId, { requestId: req.headers.get("x-request-id") ?? "" });
  return ok(job);
});
