/**
 * GET /api/v1/exports/[jobId]/download — protected export download
 * (Prompt 31 §11/§15/§30/§31/§145/§168/§206/§262/§276).
 *
 * NEVER a public static asset: the artifact lives outside every web-served
 * directory; this route re-checks session, live membership, OWNER/ADMIN
 * role, job ownership, status and expiry, then verifies the whole-file
 * checksum before streaming. Headers: attachment + private, no-store +
 * nosniff. Cross-business download attempts are 404s (no existence leak).
 */
import { NextRequest } from "next/server";
import { ApiError, getClientIp, route } from "@/lib/api-helpers";
import { getAuthContext } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { downloadExport } from "@/lib/data-portability/export-service";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, params: { params: Promise<{ jobId: string }> }) => {
  const ctx = await getAuthContext(req);
  const { jobId } = await params.params;
  if (!/^[a-z0-9]{20,40}$/i.test(jobId)) {
    throw new ApiError(404, "EXPORT_NOT_FOUND", "Export job not found.");
  }

  const limit = rateLimit(`exports-download:${ctx.userId}:${getClientIp(req)}`, 30, 60 * 60_000);
  if (!limit.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many downloads. Please wait a moment.");
  }

  return downloadExport(ctx, jobId, { requestId: req.headers.get("x-request-id") ?? "" });
});
