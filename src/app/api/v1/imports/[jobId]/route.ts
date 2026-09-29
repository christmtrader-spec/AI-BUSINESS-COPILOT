/**
 * GET /api/v1/imports/[jobId] — import preview/status (Prompt 31 §87).
 * Returns status, dataset, row counts, mapping status and a bounded error
 * summary. NEVER raw row contents, passwords or secrets (§87/§321/§322).
 * The jobId is an identifier, NOT a credential (§14/§15) — membership and
 * role are re-checked on every read.
 */
import { NextRequest } from "next/server";
import { ApiError, ok, route } from "@/lib/api-helpers";
import { getAuthContext } from "@/lib/tenant";
import { getImportJob, assertImportRole } from "@/lib/data-portability/import-service";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, params: { params: Promise<{ jobId: string }> }) => {
  const ctx = await getAuthContext(req);
  assertImportRole(ctx);
  const { jobId } = await params.params;
  if (!/^[a-z0-9]{20,40}$/i.test(jobId)) {
    throw new ApiError(404, "IMPORT_NOT_FOUND", "Import job not found.");
  }
  const job = await getImportJob(ctx.businessId, jobId);
  return ok(job);
});
