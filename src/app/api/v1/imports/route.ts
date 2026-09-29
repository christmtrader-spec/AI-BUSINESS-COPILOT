/**
 * GET  /api/v1/imports — tenant-scoped import job list (Prompt 31 §324).
 * POST /api/v1/imports — multipart upload that creates a staged import job
 * (§57/§60/§62/§65/§100/§101). NO database mutation happens on upload —
 * the file is parsed and columns detected; the caller then confirms the
 * mapping (§60 flow).
 *
 * SECURITY:
 *  - Tenant context from the session (getAuthContext) — never the browser.
 *  - OWNER/ADMIN only (§56); dedicated rate limit (§100).
 *  - Upload size enforced via content-length + stream cap (§57); content
 *    signature decides the format (§65); arbitrary SQL/SQLite/HTML/XML are
 *    rejected by signature (§140/§208/§209).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, getClientIp, ok, route } from "@/lib/api-helpers";
import { getAuthContext } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { createImportJob, listImportJobs, assertImportRole } from "@/lib/data-portability/import-service";
import { importMaxBytes } from "@/lib/data-portability/config";
import { IMPORT_DATASET_KEYS } from "@/lib/data-portability/import-catalog";

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  assertImportRole(ctx);

  const url = new URL(req.url);
  const page = Math.max(1, Math.min(100, Number(url.searchParams.get("page") ?? "1") || 1));
  const pageSize = Math.max(1, Math.min(50, Number(url.searchParams.get("pageSize") ?? "20") || 20));

  const result = await listImportJobs(ctx.businessId, { page, pageSize });
  return ok(result);
});

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  assertImportRole(ctx);

  const limit = rateLimit(`imports-create:${ctx.businessId}:${ctx.userId}:${getClientIp(req)}`, 5, 15 * 60_000);
  if (!limit.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many import uploads. Please wait a few minutes.");
  }

  // Reject oversized uploads BEFORE buffering the body (§57).
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > importMaxBytes() + 64 * 1024) {
    throw new ApiError(413, "IMPORT_TOO_LARGE", "The uploaded file exceeds the size limit.");
  }

  const form = await req.formData().catch(() => null);
  if (!form) {
    throw new ApiError(400, "BAD_REQUEST", "A multipart form with a file is required.");
  }
  const datasetRaw = form.get("dataset");
  const datasetCheck = z.enum(IMPORT_DATASET_KEYS).safeParse(datasetRaw);
  if (!datasetCheck.success) {
    throw new ApiError(422, "IMPORT_INVALID_FILE", "Unknown import dataset.");
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new ApiError(422, "IMPORT_INVALID_FILE", "A file upload is required.");
  }
  if (file.size > importMaxBytes()) {
    throw new ApiError(413, "IMPORT_TOO_LARGE", "The uploaded file exceeds the size limit.");
  }
  const buffer = Buffer.from(await file.arrayBuffer());

  const result = await createImportJob(
    ctx,
    {
      dataset: datasetCheck.data,
      fileName: file.name || "upload.csv",
      contentType: file.type || null,
      buffer,
    },
    { requestId: req.headers.get("x-request-id") ?? "" },
  );
  return ok(result, 201);
});
