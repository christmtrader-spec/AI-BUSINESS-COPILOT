import "server-only";

/**
 * Import service — Prompt 31 §55/§56/§60/§61/§86/§91-§107/§144/§162/§163/
 * §167/§172/§277/§302/§308-§311/§319/§373/§374.
 *
 * LAWS:
 *  - PERMISSION: OWNER/ADMIN only (§56) — enforced here AND at the route;
 *    the route re-checks role at commit time (§277).
 *  - STATE MACHINE (§103): UPLOADED → PARSING → MAPPING_REQUIRED →
 *    VALIDATING → READY → COMMITTING → COMPLETED; FAILED/EXPIRED/CANCELED
 *    are explicit terminal transitions. The client can NEVER assign a
 *    status (§104) — statuses change only through atomic conditional
 *    updates in this service; businessId/userId always come from the
 *    AuthContext, never the request (§105/§106).
 *  - NO MUTATION before commit (§60): upload/parse/map/validate/dry-run
 *    never touch business rows (§86/§285 — a dry run changes nothing).
 *  - ALL-OR-NOTHING commit (§95): validation + duplicate detection run
 *    FRESH inside the commit transaction (§309 stale-validation law);
 *    any invalid row aborts the whole import. One SQLite transaction
 *    makes the commit atomic — a crash rolls back everything (§319:
 *    no partial import is ever written).
 *  - IDEMPOTENCY (§102/§163/§374): the READY→COMMITTING transition (plus
 *    an optional client commit key) marks the commit exactly once; a
 *    replayed request returns the completed result instead of importing
 *    again.
 *  - ISOLATION (§73/§107-§110): inserts are bound to the AuthContext
 *    businessId; NO code path touches billing, subscription, usage,
 *    platform, audit or identity tables.
 *  - FILE (§62/§311): the staged upload lives outside web-served dirs;
 *    its SHA-256 is re-verified at commit — a changed file refuses to
 *    commit (IMPORT_FILE_CHANGED).
 */

import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/api-helpers";
import type { AuthContext } from "@/lib/tenant";
import type { Prisma } from "@prisma/client";
import { toCsv } from "@/lib/csv";
import {
  IMPORT_CATALOG,
  DUPLICATE_MODES,
  suggestMapping,
  type DuplicateMode,
  type ImportDatasetKey,
} from "./import-catalog";
import { parseImportFile, type ParsedImportFile } from "./import-parse";
import { validateMapping, validateRows, type RowError, type ValidatedRow } from "./validators";
import { buildStorageKey, readStagedUpload, writeArtifact, deleteArtifact, PortabilityStorageError } from "./storage";
import {
  importFileTtlHours,
  importMaxBytes,
  importMaxErrors,
  importCommitBatchSize,
  maxActiveImportsPerBusiness,
  staleJobThresholdMinutes,
} from "./config";

const ACTIVE_IMPORT_STATUSES = ["UPLOADED", "PARSING", "MAPPING_REQUIRED", "VALIDATING", "READY"] as const;

export class ImportCommitBlocked extends ApiError {
  constructor(code: string, message: string) {
    super(409, code, message);
  }
}

export type ImportJobDTO = {
  id: string;
  datasetType: ImportDatasetKey;
  status: string;
  fileName: string;
  fileSize: number;
  schemaVersion: number;
  duplicateMode: DuplicateMode;
  mapping: Record<string, string> | null;
  rowCount: number | null;
  validRows: number | null;
  invalidRows: number | null;
  duplicateRows: number | null;
  wouldCreate: number | null;
  wouldSkip: number | null;
  createdCount: number | null;
  skippedCount: number | null;
  failedCount: number | null;
  errorsTruncated: boolean;
  topErrors: Array<{ rowNumber: number; field: string | null; code: string }>;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  failureCode: string | null;
  failureMessageSafe: string | null;
};

/* ------------------------------- DTO mapping ------------------------------- */

type ImportJobRow = {
  id: string;
  datasetType: string;
  status: string;
  fileName: string;
  fileSize: number;
  schemaVersion: number;
  mappingJson: string | null;
  duplicateMode: string;
  rowCount: number | null;
  validRows: number | null;
  invalidRows: number | null;
  duplicateRows: number | null;
  wouldCreate: number | null;
  wouldSkip: number | null;
  createdCount: number | null;
  skippedCount: number | null;
  failedCount: number | null;
  errorReport: string | null;
  createdAt: Date;
  completedAt: Date | null;
  expiresAt: Date | null;
  failureCode: string | null;
  failureMessageSafe: string | null;
};

function jobToDTO(job: ImportJobRow): ImportJobDTO {
  let mapping: Record<string, string> | null = null;
  if (job.mappingJson) {
    try {
      const parsed: unknown = JSON.parse(job.mappingJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        mapping = parsed as Record<string, string>;
      }
    } catch {
      /* defensive: mapping JSON is server-written */
    }
  }
  let errors: RowError[] = [];
  let errorsTruncated = false;
  if (job.errorReport) {
    try {
      const parsed = JSON.parse(job.errorReport) as { errors?: RowError[]; truncated?: boolean };
      errors = Array.isArray(parsed.errors) ? parsed.errors : [];
      errorsTruncated = parsed.truncated === true;
    } catch {
      /* defensive */
    }
  }
  return {
    id: job.id,
    datasetType: (job.datasetType in IMPORT_CATALOG ? job.datasetType : "customers") as ImportDatasetKey,
    status: expiredStatus(job),
    fileName: job.fileName,
    fileSize: job.fileSize,
    schemaVersion: job.schemaVersion,
    duplicateMode: (DUPLICATE_MODES as readonly string[]).includes(job.duplicateMode)
      ? (job.duplicateMode as DuplicateMode)
      : "SKIP",
    mapping,
    rowCount: job.rowCount,
    validRows: job.validRows,
    invalidRows: job.invalidRows,
    duplicateRows: job.duplicateRows,
    wouldCreate: job.wouldCreate,
    wouldSkip: job.wouldSkip,
    createdCount: job.createdCount,
    skippedCount: job.skippedCount,
    failedCount: job.failedCount,
    errorsTruncated,
    topErrors: errors.slice(0, 10).map((e) => ({ rowNumber: e.rowNumber, field: e.field, code: e.code })),
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
    expiresAt: job.expiresAt?.toISOString() ?? null,
    failureCode: job.failureCode,
    failureMessageSafe: job.failureMessageSafe,
  };
}

function expiredStatus(job: ImportJobRow): string {
  if (job.status === "COMPLETED" && job.expiresAt !== null && job.expiresAt.getTime() <= Date.now()) {
    return "EXPIRED";
  }
  return job.status;
}

/* ------------------------------ reads + list ------------------------------- */

export async function listImportJobs(
  businessId: string,
  opts: { page: number; pageSize: number },
): Promise<{ items: ImportJobDTO[]; total: number }> {
  await reapStaleImportJobs(businessId);
  const [rows, total] = await Promise.all([
    db.dataImportJob.findMany({
      where: { businessId },
      orderBy: { createdAt: "desc" },
      skip: (opts.page - 1) * opts.pageSize,
      take: opts.pageSize,
    }),
    db.dataImportJob.count({ where: { businessId } }),
  ]);
  return { items: rows.map(jobToDTO), total };
}

export async function getImportJob(businessId: string, jobId: string): Promise<ImportJobDTO> {
  const job = await db.dataImportJob.findFirst({ where: { id: jobId, businessId } });
  if (!job) throw new ApiError(404, "IMPORT_NOT_FOUND", "Import job not found.");
  return jobToDTO(job);
}

/** Role gate shared by every import mutation (§56/§144). */
export function assertImportRole(ctx: AuthContext): void {
  if (ctx.role !== "OWNER" && ctx.role !== "ADMIN") {
    throw new ApiError(403, "IMPORT_UNAUTHORIZED", "Only owners and admins can import business data.");
  }
}

async function loadJob(businessId: string, jobId: string) {
  const job = await db.dataImportJob.findFirst({ where: { id: jobId, businessId } });
  if (!job) throw new ApiError(404, "IMPORT_NOT_FOUND", "Import job not found.");
  return job;
}

/* --------------------------- stale + expiry reaper -------------------------- */

async function reapStaleImportJobs(businessId: string): Promise<void> {
  const cutoff = new Date(Date.now() - staleJobThresholdMinutes() * 60_000);
  // §318: a COMMITTING job stuck past the threshold means the process died
  // mid-commit. SQLite rolled the transaction back — mark it for review;
  // NEVER auto-retry database mutations.
  await db.dataImportJob.updateMany({
    where: {
      businessId,
      status: { in: ["COMMITTING", "PARSING", "VALIDATING"] },
      createdAt: { lt: cutoff },
    },
    data: {
      status: "FAILED",
      failureCode: "IMPORT_COMMIT_FAILED",
      failureMessageSafe: "Import processing did not complete. No partial data was written — upload the file again to retry.",
    },
  });
}

/** Terminal states that allow staged-file deletion on cancel (§62 hygiene). */
export async function cancelImportJob(
  ctx: AuthContext,
  jobId: string,
  meta: { requestId: string },
): Promise<ImportJobDTO> {
  assertImportRole(ctx);
  const job = await loadJob(ctx.businessId, jobId);
  const cancellable = ["UPLOADED", "PARSING", "MAPPING_REQUIRED", "VALIDATING", "READY"].includes(job.status);
  if (!cancellable) {
    throw new ApiError(409, "IMPORT_NOT_CANCEABLE", "This import can no longer be canceled.");
  }
  const updated = await db.dataImportJob.updateMany({
    where: { id: job.id, businessId: ctx.businessId, status: job.status },
    data: { status: "CANCELED", completedAt: new Date() },
  });
  if (updated.count === 0) {
    throw new ApiError(409, "IMPORT_NOT_CANCEABLE", "This import can no longer be canceled.");
  }
  deleteArtifact("imports", job.storageKey);
  await audit({
    businessId: ctx.businessId,
    actorId: ctx.userId,
    action: "data_import.canceled",
    entityType: "DataImportJob",
    entityId: job.id,
    after: { dataset: job.datasetType, requestId: meta.requestId },
  });
  return jobToDTO(await loadJob(ctx.businessId, jobId));
}

/* --------------------------------- upload ---------------------------------- */

export type UploadImportInput = {
  dataset: ImportDatasetKey;
  fileName: string;
  contentType: string | null;
  buffer: Buffer;
};

export type UploadImportResult = {
  job: ImportJobDTO;
  detectedColumns: string[];
  suggestedMapping: Record<string, string>;
};

const ALLOWED_EXTENSIONS = ["csv", "json"];
const ALLOWED_MIME = new Set([
  "text/csv",
  "application/csv",
  "text/plain",
  "application/vnd.ms-excel",
  "application/json",
  "text/json",
  "application/octet-stream", // browsers mislabel; content signature decides (§65)
]);

/** Sanitized DISPLAY name (§147) — never used as a filesystem path. */
function sanitizeDisplayName(rawName: string): string {
  const base = rawName.split(/[/\\]/).pop() ?? "upload";
  const cleaned = base.replace(/[\x00-\x1f\x7f]/g, "").replace(/[^A-Za-z0-9._ \u0600-\u06FF-]/g, "_");
  return cleaned.slice(0, 120) || "upload";
}

export async function createImportJob(
  ctx: AuthContext,
  input: UploadImportInput,
  meta: { requestId: string },
): Promise<UploadImportResult> {
  assertImportRole(ctx);

  // Concurrency cap (§101/§244) — jobs already past their expiry do not
  // count toward the active limit (they can never commit).
  const activeCount = await db.dataImportJob.count({
    where: {
      businessId: ctx.businessId,
      status: { in: [...ACTIVE_IMPORT_STATUSES] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
  if (activeCount >= maxActiveImportsPerBusiness()) {
    throw new ApiError(429, "IMPORT_CONCURRENCY_LIMIT", "Too many active import jobs. Finish or cancel one first.");
  }

  // Size (§57) + extension + MIME (§65) — content signature decides later.
  if (input.buffer.byteLength === 0) {
    throw new ApiError(422, "IMPORT_INVALID_FILE", "The uploaded file is empty.");
  }
  if (input.buffer.byteLength > importMaxBytes()) {
    throw new ApiError(413, "IMPORT_TOO_LARGE", "The uploaded file exceeds the size limit.");
  }
  const extension = (input.fileName.split(".").pop() ?? "").toLowerCase();
  if (extension && !ALLOWED_EXTENSIONS.includes(extension)) {
    throw new ApiError(422, "IMPORT_INVALID_FILE", "Only CSV and JSON files are accepted.");
  }
  if (input.contentType && !ALLOWED_MIME.has(input.contentType.split(";")[0].trim().toLowerCase())) {
    throw new ApiError(422, "IMPORT_INVALID_FILE", "This file type is not accepted.");
  }

  // Row cap derives deterministically from the byte cap (documented).
  const maxRows = Math.max(1000, Math.min(200_000, Math.floor(importMaxBytes() / 64)));

  const job = await db.dataImportJob.create({
    data: {
      businessId: ctx.businessId,
      requestedByUserId: ctx.userId,
      datasetType: input.dataset,
      status: "PARSING",
      fileName: sanitizeDisplayName(input.fileName),
      fileSize: input.buffer.byteLength,
      fileChecksum: null, // stored below together with the storage key
      schemaVersion: 1,
      expiresAt: new Date(Date.now() + importFileTtlHours() * 3_600_000),
    },
  });

  await audit({
    businessId: ctx.businessId,
    actorId: ctx.userId,
    action: "data_import.created",
    entityType: "DataImportJob",
    entityId: job.id,
    after: { dataset: input.dataset, fileSize: input.buffer.byteLength, requestId: meta.requestId },
  });

  // Stage the file OUTSIDE web-served directories (§62) — server-generated key.
  const storageKey = buildStorageKey("imports", job.id, "upload");
  try {
    const stored = await writeArtifact("imports", storageKey, new Uint8Array(input.buffer));
    await db.dataImportJob.update({
      where: { id: job.id },
      data: { storageKey, fileChecksum: stored.checksum },
    });
  } catch {
    await db.dataImportJob.updateMany({
      where: { id: job.id, status: "PARSING" },
      data: { status: "FAILED", failureCode: "IMPORT_COMMIT_FAILED", failureMessageSafe: "The import file could not be stored." },
    });
    throw new ApiError(500, "IMPORT_COMMIT_FAILED", "The import file could not be stored.");
  }

  try {
    const parsed = parseImportFile(input.buffer, input.dataset, extension || null, maxRows);
    if (parsed.rows.length === 0) {
      throw new ApiError(422, "IMPORT_INVALID_FILE", "The file has no data rows.");
    }
    const suggestedMapping = suggestMapping(parsed.headers, input.dataset);
    await db.dataImportJob.updateMany({
      where: { id: job.id, status: "PARSING" },
      data: {
        status: "MAPPING_REQUIRED",
        rowCount: parsed.rows.length,
        mappingJson: JSON.stringify(suggestedMapping),
      },
    });
    return {
      job: jobToDTO(await loadJob(ctx.businessId, job.id)),
      detectedColumns: parsed.headers,
      suggestedMapping,
    };
  } catch (error) {
    deleteArtifact("imports", storageKey);
    const isApi = error instanceof ApiError;
    const code = isApi && error.code === "IMPORT_TOO_LARGE" ? "IMPORT_TOO_LARGE" : "IMPORT_INVALID_FILE";
    await db.dataImportJob.updateMany({
      where: { id: job.id, status: "PARSING" },
      data: {
        status: "FAILED",
        failureCode: code,
        failureMessageSafe: isApi ? error.message : "The file could not be parsed.",
      },
    });
    if (isApi) throw error;
    throw new ApiError(422, "IMPORT_INVALID_FILE", "The file could not be parsed.");
  }
}

/* --------------------------- shared parse + validate ------------------------ */

function readAndParse(job: {
  id: string;
  storageKey: string | null;
  fileChecksum: string | null;
  datasetType: string;
  fileName: string;
}): ParsedImportFile {
  if (!job.storageKey) {
    throw new ApiError(409, "IMPORT_NOT_READY", "The import file is not available.");
  }
  const staged = readStagedUpload(job.storageKey, job.fileChecksum); // §311
  const extension = (job.fileName.split(".").pop() ?? "").toLowerCase();
  const maxRows = Math.max(1000, Math.min(200_000, Math.floor(importMaxBytes() / 64)));
  return parseImportFile(staged.buffer, job.datasetType, extension || null, maxRows);
}

type Analysis = {
  parsed: ParsedImportFile;
  validRows: ValidatedRow[];
  errors: RowError[];
  errorsTruncated: boolean;
};

/** Pure parse+validate against the STORED mapping (no DB, no mutation). */
function analyzeWithStoredMapping(job: {
  datasetType: string;
  mappingJson: string | null;
  business: { decimalPrecision: number };
}, parsed: ParsedImportFile): Analysis {
  const dataset = job.datasetType as ImportDatasetKey;
  if (!(dataset in IMPORT_CATALOG)) {
    throw new ApiError(409, "IMPORT_NOT_READY", "Unknown import dataset.");
  }
  let mapping: Record<string, string> | null = null;
  try {
    mapping = job.mappingJson ? (JSON.parse(job.mappingJson) as Record<string, string>) : null;
  } catch {
    mapping = null;
  }
  if (!mapping) {
    throw new ImportCommitBlocked("IMPORT_MAPPING_INVALID", "Confirm the field mapping first.");
  }
  const mappingCheck = validateMapping(mapping, dataset, parsed.headers);
  if (!mappingCheck.ok) {
    throw new ImportCommitBlocked("IMPORT_MAPPING_INVALID", "The stored mapping no longer matches the file.");
  }
  const result = validateRows(dataset, parsed.headers, parsed.rows, mapping, job.business.decimalPrecision);
  const cap = importMaxErrors();
  return {
    parsed,
    validRows: result.validRows,
    errors: result.errors.slice(0, cap),
    errorsTruncated: result.errors.length > cap,
  };
}

/* --------------------------------- mapping --------------------------------- */

export async function setImportMapping(
  ctx: AuthContext,
  jobId: string,
  input: { mapping: unknown; duplicateMode: DuplicateMode },
  meta: { requestId: string },
): Promise<ImportJobDTO> {
  assertImportRole(ctx);
  const job = await loadJob(ctx.businessId, jobId);
  if (job.status !== "MAPPING_REQUIRED" && job.status !== "READY" && job.status !== "VALIDATING") {
    throw new ApiError(409, "IMPORT_NOT_READY", "This import cannot be remapped right now.");
  }
  const parsed = readAndParse(job);
  const dataset = job.datasetType as ImportDatasetKey;
  const mappingCheck = validateMapping(input.mapping, dataset, parsed.headers);
  if (!mappingCheck.ok) {
    throw new ApiError(422, "IMPORT_MAPPING_INVALID", "The submitted mapping is not valid for this dataset.");
  }
  await db.dataImportJob.updateMany({
    where: { id: job.id, businessId: ctx.businessId, status: job.status },
    data: {
      mappingJson: JSON.stringify(mappingCheck.mapping),
      duplicateMode: input.duplicateMode,
      status: "VALIDATING",
      // A new mapping invalidates the previous validation (§309).
      validRows: null,
      invalidRows: null,
      duplicateRows: null,
      wouldCreate: null,
      wouldSkip: null,
      errorReport: null,
    },
  });
  return jobToDTO(await loadJob(ctx.businessId, jobId));
}

/* -------------------------------- validation -------------------------------- */

export type ValidationSummary = {
  job: ImportJobDTO;
  wouldCreate: number | null;
  wouldSkip: number | null;
  duplicateRows: number | null;
};

/**
 * POST validate (§89): schema validation + counts. NO DB mutation of
 * business data (§60) — only the job's own row counters advance.
 */
export async function validateImportJob(
  ctx: AuthContext,
  jobId: string,
  meta: { requestId: string },
): Promise<ValidationSummary> {
  assertImportRole(ctx);
  const job = await loadJob(ctx.businessId, jobId);
  if (job.status !== "VALIDATING" && job.status !== "READY") {
    throw new ApiError(409, "IMPORT_NOT_READY", "Confirm the mapping before validation.");
  }
  const business = await db.business.findUniqueOrThrow({
    where: { id: ctx.businessId },
    select: { decimalPrecision: true },
  });
  const parsed = readAndParse(job);
  const analysis = analyzeWithStoredMapping(
    { datasetType: job.datasetType, mappingJson: job.mappingJson, business },
    parsed,
  );

  // Duplicate detection needs DB state — informational counts here; the
  // authoritative pass runs at dry-run and commit (§309).
  const duplicates = await scanDuplicates(db, ctx.businessId, job.datasetType as ImportDatasetKey, analysis.validRows);
  const rejectMode = job.duplicateMode === "REJECT";
  // REJECT mode (§82): duplicates become ROW_DUPLICATE errors (bounded).
  const rejectErrors: RowError[] = rejectMode
    ? duplicates.duplicateRowNumbers.slice(0, importMaxErrors()).map((rowNumber) => ({
        rowNumber,
        field: null,
        code: "ROW_DUPLICATE" as const,
      }))
    : [];
  const totalErrors = analysis.errors.length + rejectErrors.length;
  const allInvalid = analysis.validRows.length === 0 && parsed.rows.length > 0;
  await db.dataImportJob.updateMany({
    where: { id: job.id, businessId: ctx.businessId, status: { in: ["VALIDATING", "READY"] } },
    data: {
      status: allInvalid ? "FAILED" : "READY",
      rowCount: parsed.rows.length,
      validRows: analysis.validRows.length,
      invalidRows: totalErrors,
      errorReport: JSON.stringify({ errors: [...analysis.errors, ...rejectErrors], truncated: analysis.errorsTruncated }),
      duplicateRows: duplicates.total,
      wouldCreate: allInvalid ? 0 : Math.max(0, analysis.validRows.length - duplicates.total),
      wouldSkip: allInvalid ? 0 : duplicates.total,
      failureCode: allInvalid ? "IMPORT_VALIDATION_FAILED" : null,
      failureMessageSafe: allInvalid ? "Every row has validation errors. Fix the file or the mapping and try again." : null,
    },
  });

  await audit({
    businessId: ctx.businessId,
    actorId: ctx.userId,
    action: "data_import.validated",
    entityType: "DataImportJob",
    entityId: job.id,
    after: {
      dataset: job.datasetType,
      rowCount: parsed.rows.length,
      validRows: analysis.validRows.length,
      invalidRows: totalErrors,
      requestId: meta.requestId,
    },
  });

  return {
    job: jobToDTO(await loadJob(ctx.businessId, jobId)),
    wouldCreate: allInvalid ? 0 : Math.max(0, analysis.validRows.length - duplicates.total),
    wouldSkip: allInvalid ? 0 : duplicates.total,
    duplicateRows: duplicates.total,
  };
}

/* --------------------------------- dry run ---------------------------------- */

/**
 * POST dry-run (§90): full would-create/would-skip/duplicate analysis
 * against CURRENT business data. ZERO database mutation (§86/§285).
 */
export async function dryRunImportJob(
  ctx: AuthContext,
  jobId: string,
  meta: { requestId: string },
): Promise<ValidationSummary> {
  assertImportRole(ctx);
  const job = await loadJob(ctx.businessId, jobId);
  if (job.status !== "READY") {
    throw new ApiError(409, "IMPORT_NOT_READY", "Validate the import before the dry run.");
  }
  const business = await db.business.findUniqueOrThrow({
    where: { id: ctx.businessId },
    select: { decimalPrecision: true },
  });
  const parsed = readAndParse(job);
  const analysis = analyzeWithStoredMapping(
    { datasetType: job.datasetType, mappingJson: job.mappingJson, business },
    parsed,
  );
  const duplicates = await scanDuplicates(db, ctx.businessId, job.datasetType as ImportDatasetKey, analysis.validRows);
  const rejectMode = job.duplicateMode === "REJECT";
  const rejectErrors: RowError[] = rejectMode
    ? duplicates.duplicateRowNumbers.slice(0, importMaxErrors()).map((rowNumber) => ({
        rowNumber,
        field: null,
        code: "ROW_DUPLICATE" as const,
      }))
    : [];
  const totalErrors = analysis.errors.length + rejectErrors.length;

  const wouldCreate = Math.max(0, analysis.validRows.length - duplicates.total);
  await db.dataImportJob.updateMany({
    where: { id: job.id, businessId: ctx.businessId, status: "READY" },
    data: {
      rowCount: parsed.rows.length,
      validRows: analysis.validRows.length,
      invalidRows: totalErrors,
      duplicateRows: duplicates.total,
      wouldCreate,
      wouldSkip: rejectMode ? 0 : duplicates.total,
      errorReport: JSON.stringify({ errors: [...analysis.errors, ...rejectErrors], truncated: analysis.errorsTruncated }),
    },
  });

  await audit({
    businessId: ctx.businessId,
    actorId: ctx.userId,
    action: "data_import.dry_run",
    entityType: "DataImportJob",
    entityId: job.id,
    after: {
      dataset: job.datasetType,
      wouldCreate,
      duplicates: duplicates.total,
      requestId: meta.requestId,
    },
  });

  return {
    job: jobToDTO(await loadJob(ctx.businessId, jobId)),
    wouldCreate,
    wouldSkip: rejectMode ? 0 : duplicates.total,
    duplicateRows: duplicates.total,
  };
}

/* ---------------------------- duplicate detection --------------------------- */

type DuplicateScan = {
  /** Data-row numbers treated as duplicates (file-internal + existing). */
  duplicateRowNumbers: number[];
  total: number;
};

type ClientWithParties = Pick<Prisma.TransactionClient, "customer" | "supplier" | "product">;

/** Load the normalized key sets of the CURRENT tenant's rows (§81). */
async function existingKeySetsFor(
  client: ClientWithParties,
  businessId: string,
  dataset: ImportDatasetKey,
): Promise<Map<string, Set<string>>> {
  const sets = new Map<string, Set<string>>();
  if (dataset === "products") {
    const rows = await client.product.findMany({
      where: { businessId },
      select: { sku: true, name: true },
    });
    sets.set("sku", new Set(rows.map((r) => r.sku?.trim().toLowerCase() ?? "")));
    sets.set("name", new Set(rows.map((r) => r.name.trim().toLowerCase().replace(/\s+/g, " "))));
  } else {
    const rows =
      dataset === "customers"
        ? await client.customer.findMany({
            where: { businessId },
            select: { email: true, phone: true, name: true },
          })
        : await client.supplier.findMany({
            where: { businessId },
            select: { email: true, phone: true, name: true },
          });
    sets.set("email", new Set(rows.map((r) => r.email?.trim().toLowerCase() ?? "")));
    sets.set("phone", new Set(rows.map((r) => r.phone?.replace(/[\s\-().]/g, "").toLowerCase() ?? "")));
    sets.set("name", new Set(rows.map((r) => r.name.trim().toLowerCase().replace(/\s+/g, " "))));
  }
  return sets;
}

/**
 * Deterministic duplicate detection (§81/§269) — ONE canonical single-pass
 * algorithm shared by dry-run and commit so their numbers always agree:
 *   a row is a duplicate iff an EARLIER row in the file had the same
 *   normalized match key (file-internal), OR a current tenant row has it.
 * Rows without any match-key value are never duplicates. No fuzzy/AI
 * matching (§270/§271).
 */
async function scanDuplicates(
  client: ClientWithParties,
  businessId: string,
  dataset: ImportDatasetKey,
  validRows: ValidatedRow[],
): Promise<DuplicateScan> {
  const existing = await existingKeySetsFor(client, businessId, dataset);
  const seen = new Set<string>();
  const duplicateRowNumbers: number[] = [];
  for (const row of validRows) {
    if (!row.matchKey) continue;
    const composite = `${row.matchKey.field}:${row.matchKey.normalized}`;
    if (seen.has(composite)) {
      duplicateRowNumbers.push(row.rowNumber);
      continue;
    }
    seen.add(composite);
    const values = existing.get(row.matchKey.field);
    if (values && values.has(row.matchKey.normalized)) {
      duplicateRowNumbers.push(row.rowNumber);
    }
  }
  return { duplicateRowNumbers, total: duplicateRowNumbers.length };
}

/* ---------------------------------- commit ---------------------------------- */

export type CommitInput = {
  confirmation: "IMPORT DATA";
};

export type CommitResult = {
  job: ImportJobDTO;
  created: number;
  skipped: number;
  failed: number;
  total: number;
};

/**
 * POST commit (§91): the ONE mutating step. Owner/admin + fresh role +
 * step-up are checked by the route BEFORE calling this; typed
 * confirmation "IMPORT DATA" is required (§92/§281).
 *
 * ALL-OR-NOTHING (§95): validation + duplicates are recomputed FRESH
 * inside the commit transaction (§309); any invalid row aborts with no
 * writes. A single SQLite transaction guarantees atomicity (§94/§319).
 */
export async function commitImportJob(
  ctx: AuthContext,
  jobId: string,
  input: CommitInput,
  meta: { requestId: string },
): Promise<CommitResult> {
  assertImportRole(ctx);
  if (input.confirmation !== "IMPORT DATA") {
    throw new ApiError(422, "IMPORT_CONFIRMATION_MISMATCH", 'Type "IMPORT DATA" to confirm the import.');
  }
  const job = await loadJob(ctx.businessId, jobId);

  // Expired imports cannot commit (§167).
  if (job.status === "COMPLETED" && job.commitToken) {
    // Idempotent replay (§374): return the recorded result — never re-import.
    return {
      job: jobToDTO(job),
      created: job.createdCount ?? 0,
      skipped: job.skippedCount ?? 0,
      failed: job.failedCount ?? 0,
      total: job.rowCount ?? 0,
    };
  }
  if (job.expiresAt !== null && job.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(410, "IMPORT_EXPIRED", "This import has expired. Upload the file again.");
  }
  if (job.status !== "READY") {
    throw new ApiError(409, "IMPORT_NOT_READY", "Validate the import and review the dry run before committing.");
  }

  // Atomic claim + idempotency marker (§163): exactly one claimant wins.
  const commitToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const claimed = await db.dataImportJob.updateMany({
    where: { id: job.id, businessId: ctx.businessId, status: "READY" },
    data: { status: "COMMITTING", commitToken },
  });
  if (claimed.count === 0) {
    const current = await loadJob(ctx.businessId, jobId);
    if (current.status === "COMPLETED") {
      return {
        job: jobToDTO(current),
        created: current.createdCount ?? 0,
        skipped: current.skippedCount ?? 0,
        failed: current.failedCount ?? 0,
        total: current.rowCount ?? 0,
      };
    }
    if (current.status === "COMMITTING") {
      throw new ImportCommitBlocked("IMPORT_COMMIT_IN_PROGRESS", "This import is already committing.");
    }
    throw new ApiError(409, "IMPORT_NOT_READY", "This import can no longer be committed.");
  }

  try {
    // Fresh file verification at commit time (§311) — a tampered/replaced
    // staged file refuses to commit.
    const fresh = await loadJob(ctx.businessId, jobId);
    let staged: { buffer: Buffer; size: number };
    try {
      staged = readStagedUpload(fresh.storageKey ?? "", fresh.fileChecksum);
    } catch (storageError) {
      if (storageError instanceof PortabilityStorageError && storageError.code === "FILE_CHECKSUM_MISMATCH") {
        throw new ApiError(409, "IMPORT_FILE_CHANGED", "The import file changed after validation. Upload it again.");
      }
      throw new ApiError(409, "IMPORT_COMMIT_FAILED", "The import file is no longer available.");
    }
    const extension = (fresh.fileName.split(".").pop() ?? "").toLowerCase();
    const maxRows = Math.max(1000, Math.min(200_000, Math.floor(importMaxBytes() / 64)));
    const parsed = parseImportFile(staged.buffer, fresh.datasetType, extension || null, maxRows);

    const business = await db.business.findUniqueOrThrow({
      where: { id: ctx.businessId },
      select: { decimalPrecision: true },
    });

    const dataset = fresh.datasetType as ImportDatasetKey;
    const result = await db.$transaction(
      async (tx) => {
        const analysis = analyzeWithStoredMapping(
          { datasetType: fresh.datasetType, mappingJson: fresh.mappingJson, business },
          parsed,
        );
        // ALL_OR_NOTHING (§95/§373): any invalid row aborts the import.
        if (analysis.errors.length > 0) {
          throw new ImportCommitBlocked("IMPORT_VALIDATION_FAILED", "The file still contains invalid rows. Fix them and validate again.");
        }

        // Fresh duplicate scan INSIDE the transaction (§309) — the SAME
        // single-pass algorithm dry-run uses, so the numbers agree (§269).
        const duplicates = await scanDuplicates(tx, ctx.businessId, dataset, analysis.validRows);
        const rejectMode = fresh.duplicateMode === "REJECT";
        if (rejectMode && duplicates.total > 0) {
          // REJECT mode: duplicates are errors → abort with no writes.
          throw new ImportCommitBlocked("IMPORT_VALIDATION_FAILED", "Duplicate rows are present and the import uses REJECT mode.");
        }
        const duplicateSet = new Set(duplicates.duplicateRowNumbers);
        const rowsToCreate = analysis.validRows.filter((row) => !duplicateSet.has(row.rowNumber));

        let created = 0;
        const batchSize = importCommitBatchSize(); // chunked INSERTs inside the ONE transaction
        for (let i = 0; i < rowsToCreate.length; i += batchSize) {
          for (const row of rowsToCreate.slice(i, i + batchSize)) {
            const data = row.values as Record<string, string | number | boolean | null>;
            // §71/§105 — server-owned identity + tenant binding. NO field
            // outside the catalog can enter here (validateRows guarantees it).
            if (dataset === "products") {
              await tx.product.create({
                data: {
                  businessId: ctx.businessId,
                  name: String(data.name ?? ""),
                  sku: (data.sku as string | null) ?? null,
                  unit: (data.unit as string | null) ?? null,
                  salePriceMinor: typeof data.sale_price === "number" ? data.sale_price : 0,
                  costPriceMinor: typeof data.cost_price === "number" ? data.cost_price : 0,
                  stockQty: typeof data.stock_qty === "number" ? data.stock_qty : 0,
                  lowStockAt: typeof data.low_stock_at === "number" ? data.low_stock_at : 5,
                  isActive: data.is_active === null ? true : Boolean(data.is_active),
                },
              });
            } else if (dataset === "customers") {
              await tx.customer.create({
                data: {
                  businessId: ctx.businessId,
                  name: String(data.name ?? ""),
                  phone: (data.phone as string | null) ?? null,
                  email: (data.email as string | null) ?? null,
                  address: (data.address as string | null) ?? null,
                  note: (data.note as string | null) ?? null,
                },
              });
            } else {
              await tx.supplier.create({
                data: {
                  businessId: ctx.businessId,
                  name: String(data.name ?? ""),
                  phone: (data.phone as string | null) ?? null,
                  email: (data.email as string | null) ?? null,
                  address: (data.address as string | null) ?? null,
                  note: (data.note as string | null) ?? null,
                },
              });
            }
            created += 1;
          }
        }
        const skipped = analysis.validRows.length - created;
        return { created, skipped, failed: analysis.errors.length + (rejectMode ? duplicates.total : 0), total: parsed.rows.length, analysis };
      },
      { isolationLevel: "Serializable" },
    );

    const completed = await db.dataImportJob.updateMany({
      where: { id: job.id, businessId: ctx.businessId, status: "COMMITTING" },
      data: {
        status: "COMPLETED",
        rowCount: result.total,
        validRows: result.analysis.validRows.length,
        invalidRows: result.failed,
        createdCount: result.created,
        skippedCount: result.skipped,
        failedCount: result.failed,
        completedAt: new Date(),
        expiresAt: new Date(Date.now() + importFileTtlHours() * 3_600_000),
      },
    });

    await audit({
      businessId: ctx.businessId,
      actorId: ctx.userId,
      action: "data_import.committed",
      entityType: "DataImportJob",
      entityId: job.id,
      after: {
        dataset: fresh.datasetType,
        created: result.created,
        skipped: result.skipped,
        failed: result.failed,
        requestId: meta.requestId,
      },
    });

    if (completed.count === 0) {
      // Lost a race with cancel/expiry between tx commit and status flip —
      // report honestly; the business rows are already durable.
      const current = await loadJob(ctx.businessId, jobId);
      return { job: jobToDTO(current), created: result.created, skipped: result.skipped, failed: result.failed, total: result.total };
    }
    return { job: jobToDTO(await loadJob(ctx.businessId, jobId)), created: result.created, skipped: result.skipped, failed: result.failed, total: result.total };
  } catch (error) {
    // The transaction rolled back — no partial data (§373). Mark FAILED.
    await db.dataImportJob.updateMany({
      where: { id: job.id, businessId: ctx.businessId, status: "COMMITTING" },
      data: {
        status: "FAILED",
        failureCode:
          error instanceof ImportCommitBlocked && error.code === "IMPORT_VALIDATION_FAILED"
            ? "IMPORT_VALIDATION_FAILED"
            : "IMPORT_COMMIT_FAILED",
        failureMessageSafe:
          error instanceof ImportCommitBlocked
            ? error.message
            : "The import could not be committed. No partial data was written — try again.",
      },
    });
    await audit({
      businessId: ctx.businessId,
      actorId: ctx.userId,
      action: "data_import.failed",
      entityType: "DataImportJob",
      entityId: job.id,
      after: {
        dataset: job.datasetType,
        failureCode: error instanceof ImportCommitBlocked ? error.code : "IMPORT_COMMIT_FAILED",
        requestId: meta.requestId,
      },
    });
    throw error instanceof ApiError ? error : new ApiError(500, "IMPORT_COMMIT_FAILED", "The import could not be committed.");
  }
}

/* ------------------------------- error report ------------------------------- */

/** Downloadable error report (§98/§173): bounded CSV, safe columns only. */
export async function buildErrorReportCsv(
  businessId: string,
  jobId: string,
  localize: (code: string, field: string | null) => string,
): Promise<{ csv: string; fileName: string } | null> {
  const job = await db.dataImportJob.findFirst({ where: { id: jobId, businessId } });
  if (!job || !job.errorReport) return null;
  let errors: RowError[] = [];
  try {
    const parsed = JSON.parse(job.errorReport) as { errors?: RowError[] };
    errors = Array.isArray(parsed.errors) ? parsed.errors : [];
  } catch {
    return null;
  }
  const rows = errors.map((e) => [e.rowNumber, e.field ?? "", e.code, localize(e.code, e.field)]);
  const csv = toCsv(["row_number", "field", "error_code", "message"], rows);
  return { csv, fileName: `import-errors-${job.datasetType}-${job.id.slice(-8)}.csv` };
}
