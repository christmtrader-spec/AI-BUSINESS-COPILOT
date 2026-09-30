import "server-only";

/**
 * Export service — Prompt 31 §3/§4/§12-§38/§301-§320.
 *
 * LAWS:
 *  - AUTHORITY: createBusinessExport receives a server-resolved AuthContext;
 *    the browser NEVER chooses the businessId (§3/§7/§10).
 *  - PERMISSION: OWNER/ADMIN only (§4) — enforced here AND in the route.
 *  - BOUNDS: datasets allowlist (§5), EXPORT_MAX_DATASETS, per-fetch
 *    EXPORT_MAX_RECORDS headroom and EXPORT_MAX_BYTES file cap (§24);
 *    exceeding limits FAILS the job with EXPORT_LIMIT_EXCEEDED — never a
 *    partial file labeled complete (§26/§320).
 *  - STATE MACHINE (§165): QUEUED → PROCESSING → COMPLETED | FAILED |
 *    CANCELED; EXPIRED only from COMPLETED (by TTL/cleanup). Invalid
 *    transitions are rejected (atomic conditional updates, §316).
 *  - INTEGRITY (§22): before COMPLETED — file written + readable, record
 *    counts collected, manifest valid, whole-file SHA-256 recorded.
 *  - AUDIT (§33/§34): safe metadata only (jobId, datasets, format, counts,
 *    requestId). No file contents, no customer rows (§35).
 *  - EXPIRY (§16): operational TTL only — never a legal retention claim.
 *  - CRASH SAFETY (§317-§320): processing is synchronous within the
 *    request; a crashed process leaves a stale QUEUED/PROCESSING row that
 *    the stale-detector converts to FAILED (export generation is safe to
 *    retry — it is read-only and files are rewritten atomically).
 */

import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { zipSync, type Zippable } from "fflate";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api-helpers";
import type { AuthContext } from "@/lib/tenant";
import { toCsv } from "@/lib/csv";
import {
  EXPORT_CATALOG,
  DATASET_CSV_COLUMNS,
  DATASET_FETCHERS,
  DATASET_IMPLICATIONS,
  type ExportDatasetKey,
} from "./export-catalog";
import { buildManifest, sha256Hex, EXPORT_SCHEMA_VERSION } from "./manifest";
import { buildStorageKey, writeArtifact, verifyArtifact, artifactWebStream, deleteArtifact } from "./storage";
import {
  exportFileTtlHours,
  exportMaxBytes,
  exportMaxDatasets,
  exportMaxRecords,
  maxActiveExportsPerBusiness,
  staleJobThresholdMinutes,
} from "./config";

export type ExportFormat = "JSON" | "CSV";

const ACTIVE_STATUSES = ["QUEUED", "PROCESSING"] as const;

/* ----------------------------- authorization ------------------------------- */

export function assertExportRole(ctx: AuthContext): void {
  if (ctx.role !== "OWNER" && ctx.role !== "ADMIN") {
    throw new ApiError(403, "EXPORT_UNAUTHORIZED", "Only owners and admins can export business data.");
  }
}

/* ------------------------------- job reads --------------------------------- */

export type ExportJobDTO = {
  id: string;
  status: string;
  format: ExportFormat;
  datasets: ExportDatasetKey[];
  schemaVersion: number;
  recordCount: number | null;
  fileSize: number | null;
  checksum: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
  failureCode: string | null;
  failureMessageSafe: string | null;
  downloadAvailable: boolean;
};

function jobToDTO(job: {
  id: string;
  status: string;
  format: string;
  requestedDatasets: string;
  schemaVersion: number;
  recordCount: number | null;
  fileSize: number | null;
  checksum: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  expiresAt: Date | null;
  failureCode: string | null;
  failureMessageSafe: string | null;
}): ExportJobDTO {
  let datasets: ExportDatasetKey[] = [];
  try {
    const parsed: unknown = JSON.parse(job.requestedDatasets);
    if (Array.isArray(parsed)) {
      datasets = parsed.filter(
        (k): k is ExportDatasetKey => typeof k === "string" && k in EXPORT_CATALOG,
      );
    }
  } catch {
    /* defensive: malformed catalog never blocks status reporting */
  }
  const expired = job.expiresAt !== null && job.expiresAt.getTime() <= Date.now();
  return {
    id: job.id,
    status: expired && job.status === "COMPLETED" ? "EXPIRED" : job.status,
    format: job.format === "CSV" ? "CSV" : "JSON",
    datasets,
    schemaVersion: job.schemaVersion,
    recordCount: job.recordCount,
    fileSize: job.fileSize,
    checksum: job.checksum,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    expiresAt: job.expiresAt?.toISOString() ?? null,
    failureCode: job.failureCode,
    failureMessageSafe: job.failureMessageSafe,
    downloadAvailable: job.status === "COMPLETED" && !expired,
  };
}

/** Tenant-scoped, paginated job list (§27/§323 — recent jobs only). */
export async function listExportJobs(
  businessId: string,
  opts: { page: number; pageSize: number },
): Promise<{ items: ExportJobDTO[]; total: number }> {
  await reapStaleExportJobs(businessId);
  const [rows, total] = await Promise.all([
    db.dataExportJob.findMany({
      where: { businessId },
      orderBy: { createdAt: "desc" },
      skip: (opts.page - 1) * opts.pageSize,
      take: opts.pageSize,
    }),
    db.dataExportJob.count({ where: { businessId } }),
  ]);
  return { items: rows.map(jobToDTO), total };
}

export async function getExportJob(businessId: string, jobId: string): Promise<ExportJobDTO> {
  const job = await db.dataExportJob.findFirst({ where: { id: jobId, businessId } });
  if (!job) throw new ApiError(404, "EXPORT_NOT_FOUND", "Export job not found.");
  await expireIfDue(businessId, job.id);
  const fresh = await db.dataExportJob.findFirst({ where: { id: jobId, businessId } });
  return jobToDTO(fresh ?? job);
}

/* --------------------------- expiry + stale jobs --------------------------- */

async function expireIfDue(businessId: string, jobId: string): Promise<void> {
  await db.dataExportJob.updateMany({
    where: {
      id: jobId,
      businessId,
      status: "COMPLETED",
      expiresAt: { not: null, lte: new Date() },
    },
    data: { status: "EXPIRED" },
  });
}

/**
 * Stale-job detector (§317/§318): jobs stuck QUEUED/PROCESSING beyond the
 * threshold are crash leftovers → FAILED (safe to retry; read-only work).
 */
async function reapStaleExportJobs(businessId: string): Promise<void> {
  const cutoff = new Date(Date.now() - staleJobThresholdMinutes() * 60_000);
  await db.dataExportJob.updateMany({
    where: {
      businessId,
      status: { in: [...ACTIVE_STATUSES] },
      createdAt: { lt: cutoff },
    },
    data: {
      status: "FAILED",
      failureCode: "EXPORT_GENERATION_FAILED",
      failureMessageSafe: "Export processing did not complete. You can retry the export.",
    },
  });
}

/* ------------------------------- job create -------------------------------- */

export type CreateExportInput = {
  datasets: ExportDatasetKey[];
  format: ExportFormat;
  idempotencyKey?: string | null;
};

export async function createBusinessExport(
  ctx: AuthContext,
  input: CreateExportInput,
  meta: { requestId: string },
): Promise<ExportJobDTO> {
  assertExportRole(ctx);

  // Idempotency (§38): a retried request with the SAME bounded key returns
  // the existing job instead of spawning a duplicate.
  if (input.idempotencyKey) {
    const existing = await db.dataExportJob.findUnique({
      where: { businessId_idempotencyKey: { businessId: ctx.businessId, idempotencyKey: input.idempotencyKey } },
    });
    if (existing) {
      const dto = jobToDTO(existing);
      if (dto.status === "EXPIRED") return dto; // read-only paths below re-expire
      return dto;
    }
  }

  // Concurrency cap (§37): one business cannot spawn unbounded exports.
  const activeCount = await db.dataExportJob.count({
    where: {
      businessId: ctx.businessId,
      status: { in: [...ACTIVE_STATUSES] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
  if (activeCount >= maxActiveExportsPerBusiness()) {
    throw new ApiError(429, "EXPORT_CONCURRENCY_LIMIT", "Too many active export jobs. Wait for one to finish.");
  }

  // Dataset allowlist + implications (§5) + cap (§24).
  const resolved = new Set<ExportDatasetKey>();
  for (const key of input.datasets) {
    resolved.add(key);
    for (const implied of DATASET_IMPLICATIONS[key] ?? []) resolved.add(implied);
  }
  const datasetKeys = [...resolved].sort();
  if (datasetKeys.length > exportMaxDatasets()) {
    throw new ApiError(422, "EXPORT_LIMIT_EXCEEDED", "Too many datasets requested.");
  }

  const job = await db.dataExportJob.create({
    data: {
      businessId: ctx.businessId,
      requestedByUserId: ctx.userId,
      status: "QUEUED",
      format: input.format,
      schemaVersion: EXPORT_SCHEMA_VERSION,
      requestedDatasets: JSON.stringify(datasetKeys),
      idempotencyKey: input.idempotencyKey ?? null,
    },
  });

  await audit({
    businessId: ctx.businessId,
    actorId: ctx.userId,
    action: "data_export.requested",
    entityType: "DataExportJob",
    entityId: job.id,
    after: { datasets: datasetKeys, format: input.format, requestId: meta.requestId },
    ip: null,
    userAgent: null,
  });

  // Single-node, bounded generation runs synchronously (no queue — §36);
  // EXPORT_MAX_RECORDS/EXPORT_MAX_BYTES keep the work bounded (§24).
  return processExportJob(job.id, meta.requestId);
}

/* ------------------------------ generation --------------------------------- */

export async function processExportJob(jobId: string, requestId: string): Promise<ExportJobDTO> {
  // Atomic claim (§316): only one claimant flips QUEUED → PROCESSING.
  const claimed = await db.dataExportJob.updateMany({
    where: { id: jobId, status: "QUEUED" },
    data: { status: "PROCESSING", startedAt: new Date() },
  });
  if (claimed.count === 0) {
    const existing = await db.dataExportJob.findUnique({ where: { id: jobId } });
    if (!existing) throw new ApiError(404, "EXPORT_NOT_FOUND", "Export job not found.");
    return jobToDTO(existing);
  }

  try {
    const job = await db.dataExportJob.findUniqueOrThrow({ where: { id: jobId } });
    const business = await db.business.findUniqueOrThrow({
      where: { id: job.businessId },
      select: { id: true, name: true, slug: true, currencyCode: true, decimalPrecision: true, timezone: true },
    });
    const datasetKeys = (JSON.parse(job.requestedDatasets) as ExportDatasetKey[]).filter(
      (k) => k in EXPORT_CATALOG,
    );

    const totalCap = exportMaxRecords();
    const perDatasetCap = Math.max(1, totalCap);
    const datasetCounts: Array<{ key: ExportDatasetKey; recordCount: number }> = [];
    const jsonDatasets: Record<string, unknown> = {};
    const csvTables = new Map<ExportDatasetKey, Uint8Array>();
    let totalRecords = 0;

    for (const key of datasetKeys) {
      const result = await DATASET_FETCHERS[key]({
        businessId: business.id,
        decimalPrecision: business.decimalPrecision,
        maxRecords: perDatasetCap,
      });
      if (result.truncated) {
        throw new ApiError(422, "EXPORT_LIMIT_EXCEEDED", "The dataset exceeds the configured export record limit.");
      }
      totalRecords += result.rows.length;
      if (totalRecords > totalCap) {
        throw new ApiError(422, "EXPORT_LIMIT_EXCEEDED", "The export exceeds the configured record limit.");
      }
      datasetCounts.push({ key, recordCount: result.rows.length });
      if (job.format === "JSON") {
        jsonDatasets[key] = result.rows.map((r) => r.json);
      } else {
        const csvText = toCsv(DATASET_CSV_COLUMNS[key], result.rows.map((r) => r.csv));
        csvTables.set(key, new TextEncoder().encode(csvText));
      }
    }

    let artifact: Uint8Array;
    let storageKey: string;

    if (job.format === "JSON") {
      // Payload checksum is computed over the EXACT datasets fragment bytes
      // that land in the file (documented verification recipe, §312).
      const datasetsJson = JSON.stringify(jsonDatasets);
      const payloadChecksum = sha256Hex(datasetsJson);
      const manifest = buildManifest({
        business: {
          id: business.id,
          name: business.name,
          timezone: business.timezone,
          currency: business.currencyCode,
          decimalPrecision: business.decimalPrecision,
        },
        format: "JSON",
        datasetCounts,
        payloadChecksum,
      });
      const file = `{"manifest":${JSON.stringify(manifest)},"datasets":${datasetsJson}}`;
      artifact = new TextEncoder().encode(file);
      storageKey = buildStorageKey("exports", job.id, "json");
    } else {
      // CSV → ZIP package (§149): manifest.json + one CSV per dataset.
      // Bounded inputs (dataset count + EXPORT_MAX_BYTES) — no archive-bomb
      // risk on CREATE; we never extract untrusted archives (§148/§150).
      const keys = [...csvTables.keys()].sort();
      const payloadChecksum = sha256Hex(
        keys.reduce<Uint8Array>((acc, k) => {
          const bytes = csvTables.get(k)!;
          const merged = new Uint8Array(acc.length + bytes.length);
          merged.set(acc, 0);
          merged.set(bytes, acc.length);
          return merged;
        }, new Uint8Array()),
      );
      const manifest = buildManifest({
        business: {
          id: business.id,
          name: business.name,
          timezone: business.timezone,
          currency: business.currencyCode,
          decimalPrecision: business.decimalPrecision,
        },
        format: "CSV",
        datasetCounts,
        payloadChecksum,
      });
      const zip: Zippable = {
        "manifest.json": new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
      };
      for (const key of keys) {
        zip[EXPORT_CATALOG[key].csvFile] = csvTables.get(key)!;
      }
      artifact = zipSync(zip);
      storageKey = buildStorageKey("exports", job.id, "zip");
    }

    if (artifact.byteLength > exportMaxBytes()) {
      throw new ApiError(422, "EXPORT_LIMIT_EXCEEDED", "The export exceeds the configured file size limit.");
    }

    const storage = await writeArtifact("exports", storageKey, artifact);
    // Post-write verification BEFORE completing (§22): readable + counts +
    // checksum + manifest presence.
    await verifyArtifact("exports", storageKey, storage.checksum);

    const expiresAt = new Date(Date.now() + exportFileTtlHours() * 3_600_000);
    const recordTotal = datasetCounts.reduce((sum, d) => sum + d.recordCount, 0);

    const completed = await db.dataExportJob.updateMany({
      where: { id: job.id, status: "PROCESSING" },
      data: {
        status: "COMPLETED",
        recordCount: recordTotal,
        fileSize: storage.size,
        checksum: storage.checksum,
        storageKey,
        completedAt: new Date(),
        expiresAt,
        failureCode: null,
        failureMessageSafe: null,
      },
    });
    if (completed.count === 0) {
      // Canceled mid-generation — clean the orphan artifact (§178/§315).
      deleteArtifact("exports", storageKey);
      const canceled = await db.dataExportJob.findUniqueOrThrow({ where: { id: job.id } });
      return jobToDTO(canceled);
    }

    await audit({
      businessId: business.id,
      actorId: job.requestedByUserId,
      action: "data_export.completed",
      entityType: "DataExportJob",
      entityId: job.id,
      after: { datasets: datasetKeys, format: job.format, recordCount: recordTotal, requestId },
    });

    // Prompt 32 §100/§328 — export-ready notification AFTER the file passed
    // checksum + count verification (§331: never before the commit).
    const { notifyExportCompleted } = await import("@/lib/notifications");
    notifyExportCompleted({
      userId: job.requestedByUserId,
      businessId: business.id,
      jobId: job.id,
      datasets: datasetKeys,
      recordCount: recordTotal,
      expiresAt,
    });

    const fresh = await db.dataExportJob.findUniqueOrThrow({ where: { id: job.id } });
    return jobToDTO(fresh);
  } catch (error) {
    const safeCode =
      error instanceof ApiError && error.code === "EXPORT_LIMIT_EXCEEDED"
        ? "EXPORT_LIMIT_EXCEEDED"
        : "EXPORT_GENERATION_FAILED";
    const failedJob = await db.dataExportJob.findUnique({
      where: { id: jobId },
      select: { businessId: true, requestedByUserId: true },
    });
    await db.dataExportJob.updateMany({
      where: { id: jobId, status: "PROCESSING" },
      data: {
        status: "FAILED",
        failureCode: safeCode,
        failureMessageSafe:
          safeCode === "EXPORT_LIMIT_EXCEEDED"
            ? "The export exceeds the configured limits. Narrow the selected datasets."
            : "Export generation failed. You can retry.",
      },
    });
    await audit({
      businessId: failedJob?.businessId ?? null,
      actorId: null,
      action: "data_export.failed",
      entityType: "DataExportJob",
      entityId: jobId,
      after: { failureCode: safeCode, requestId },
    });
    // Prompt 32 §101 — export-failed notification (safe summary only).
    if (failedJob) {
      const { notifyExportFailed } = await import("@/lib/notifications");
      notifyExportFailed({
        userId: failedJob.requestedByUserId,
        businessId: failedJob.businessId,
        jobId,
        reasonCode: safeCode,
      });
    }
    if (error instanceof ApiError && error.code === "EXPORT_LIMIT_EXCEEDED") {
      const failed = await db.dataExportJob.findUniqueOrThrow({ where: { id: jobId } });
      return jobToDTO(failed);
    }
    throw error instanceof ApiError ? error : new ApiError(500, "EXPORT_GENERATION_FAILED", "Export generation failed.");
  }
}

/* ------------------------------ cancel/download ---------------------------- */

export async function cancelExportJob(
  ctx: AuthContext,
  jobId: string,
  meta: { requestId: string },
): Promise<ExportJobDTO> {
  assertExportRole(ctx);
  // Cancellation is only meaningful while queued; a completed file is NOT
  // revoked by cancel (§29) — it simply expires on schedule.
  const updated = await db.dataExportJob.updateMany({
    where: { id: jobId, businessId: ctx.businessId, status: "QUEUED" },
    data: { status: "CANCELED", completedAt: new Date() },
  });
  if (updated.count === 0) {
    const job = await db.dataExportJob.findFirst({ where: { id: jobId, businessId: ctx.businessId } });
    if (!job) throw new ApiError(404, "EXPORT_NOT_FOUND", "Export job not found.");
    throw new ApiError(409, "EXPORT_NOT_CANCEABLE", "This export can no longer be canceled.");
  }
  await audit({
    businessId: ctx.businessId,
    actorId: ctx.userId,
    action: "data_export.canceled",
    entityType: "DataExportJob",
    entityId: jobId,
    after: { requestId: meta.requestId },
  });
  const job = await db.dataExportJob.findUniqueOrThrow({ where: { id: jobId } });
  return jobToDTO(job);
}

const EXPORT_CONTENT_TYPES: Record<string, string> = {
  json: "application/json",
  zip: "application/zip",
};

/** Safe download filename (§262/§263): slug + scope + date, sanitized ASCII. */
export function exportFileName(businessSlug: string, datasetKeys: ExportDatasetKey[], format: ExportFormat): string {
  const slug = businessSlug.replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "business";
  const scope = datasetKeys.length === 1 ? datasetKeys[0] : "datasets";
  const stamp = new Date().toISOString().slice(0, 10);
  const ext = format === "CSV" ? "zip" : "json";
  return `${slug}-${scope.replace(/[^a-z0-9_-]/gi, "")}-${stamp}.${ext}`.slice(0, 120);
}

/**
 * Download (§30/§31/§276): re-checks membership+role (fresh from the route's
 * AuthContext), job status, expiry, file existence and whole-file checksum;
 * then streams with attachment + private, no-store + nosniff headers (§31/
 * §168/§206). The URL never grants access by itself (§15).
 */
export async function downloadExport(
  ctx: AuthContext,
  jobId: string,
  meta: { requestId: string },
): Promise<NextResponse> {
  assertExportRole(ctx);
  const job = await db.dataExportJob.findFirst({ where: { id: jobId, businessId: ctx.businessId } });
  if (!job) throw new ApiError(404, "EXPORT_NOT_FOUND", "Export job not found.");
  if (job.status === "EXPIRED" || (job.expiresAt !== null && job.expiresAt.getTime() <= Date.now())) {
    throw new ApiError(410, "EXPORT_EXPIRED", "This export has expired. Create a new one.");
  }
  if (job.status !== "COMPLETED" || !job.storageKey || !job.checksum) {
    throw new ApiError(409, "EXPORT_NOT_READY", "This export is not ready for download.");
  }

  let artifact;
  try {
    artifact = await verifyArtifact("exports", job.storageKey, job.checksum);
  } catch {
    throw new ApiError(410, "EXPORT_EXPIRED", "This export file is no longer available.");
  }

  await audit({
    businessId: ctx.businessId,
    actorId: ctx.userId,
    action: "data_export.downloaded",
    entityType: "DataExportJob",
    entityId: job.id,
    after: { fileSize: artifact.size, requestId: meta.requestId },
  });

  const datasetKeys = (JSON.parse(job.requestedDatasets) as ExportDatasetKey[]).filter(
    (k) => k in EXPORT_CATALOG,
  );
  const ext = job.storageKey.split(".").pop() ?? "bin";
  const body = artifactWebStream(artifact.absolutePath);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "content-type": EXPORT_CONTENT_TYPES[ext] ?? "application/octet-stream",
      "content-length": String(artifact.size),
      "content-disposition": `attachment; filename="${exportFileName(ctx.business.slug, datasetKeys, job.format === "CSV" ? "CSV" : "JSON")}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

/** Cryptographically strong correlation token for ops logs (not a credential). */
export function newExportRunToken(): string {
  return randomBytes(12).toString("hex");
}
