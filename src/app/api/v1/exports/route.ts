/**
 * GET  /api/v1/exports — tenant-scoped export job list (Prompt 31 §27/§323).
 * POST /api/v1/exports — create an export job (§28/§36/§37/§38).
 *
 * SECURITY:
 *  - Tenant context is resolved SERVER-SIDE from the session + membership
 *    (getAuthContext) — the browser never chooses a businessId (§3/§7).
 *  - OWNER/ADMIN only (§4) — enforced in the service too (§276 re-checks).
 *  - Dedicated rate limit (§36) + concurrency cap (§37, in service).
 *  - Strict Zod allowlists: dataset keys (§39/§239), format, bounded
 *    idempotency key (§38).
 *  - Status responses NEVER contain file content (§27).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, getClientIp, ok, parseBody, route } from "@/lib/api-helpers";
import { getAuthContext } from "@/lib/tenant";
import { rateLimit } from "@/lib/rate-limit";
import { createBusinessExport, listExportJobs, assertExportRole, type ExportFormat } from "@/lib/data-portability/export-service";
import { EXPORT_DATASET_KEYS } from "@/lib/data-portability/export-catalog";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  datasets: z.array(z.enum(EXPORT_DATASET_KEYS)).min(1).max(32),
  format: z.enum(["JSON", "CSV"]),
  idempotencyKey: z
    .string()
    .trim()
    .min(8)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});

export const GET = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  assertExportRole(ctx);

  const url = new URL(req.url);
  const page = Math.max(1, Math.min(100, Number(url.searchParams.get("page") ?? "1") || 1));
  const pageSize = Math.max(1, Math.min(50, Number(url.searchParams.get("pageSize") ?? "20") || 20));

  const limit = rateLimit(`exports-list:${ctx.userId}:${getClientIp(req)}`, 60, 60_000);
  if (!limit.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many requests. Please slow down.");
  }

  const result = await listExportJobs(ctx.businessId, { page, pageSize });
  return ok(result);
});

export const POST = route(async (req: NextRequest) => {
  const ctx = await getAuthContext(req);
  assertExportRole(ctx);

  const limit = rateLimit(`exports-create:${ctx.businessId}:${ctx.userId}`, 5, 15 * 60_000);
  if (!limit.allowed) {
    throw new ApiError(429, "RATE_LIMITED", "Too many export requests. Please wait a few minutes.");
  }

  const input = await parseBody(req, createSchema);
  const job = await createBusinessExport(
    ctx,
    {
      datasets: input.datasets,
      format: input.format as ExportFormat,
      idempotencyKey: input.idempotencyKey ?? null,
    },
    { requestId: req.headers.get("x-request-id") ?? "" },
  );
  return ok(job, job.status === "COMPLETED" ? 201 : 202);
});
