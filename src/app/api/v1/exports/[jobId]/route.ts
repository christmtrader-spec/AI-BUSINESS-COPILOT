/**
 * GET /api/v1/exports/[jobId] — single export job status (Prompt 31 §27).
 * The jobId is an unguessable job identifier, NOT a credential (§14/§15):
 * every read re-checks membership + role against the live session.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext } from "@/lib/tenant";
import { getExportJob, assertExportRole } from "@/lib/data-portability/export-service";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, params: { params: Promise<{ jobId: string }> }) => {
  const ctx = await getAuthContext(req);
  assertExportRole(ctx);
  const { jobId } = await params.params;
  if (!/^[a-z0-9]{20,40}$/i.test(jobId)) {
    throw new ApiError(404, "EXPORT_NOT_FOUND", "Export job not found.");
  }
  const job = await getExportJob(ctx.businessId, jobId);
  return ok(job);
});
