import "server-only";

/**
 * Data portability configuration — Prompt 31 §181-§183, §303-§304.
 *
 * LAWS:
 *  - Every limit is parsed as an INTEGER with hard validation (§182):
 *    negative / zero-where-invalid / NaN / Infinity / unsafe values fall
 *    back to the documented default. No unbounded default exists (§183).
 *  - The storage root (§303) resolves to an ABSOLUTE path OUTSIDE every
 *    web-served directory (public/, .next/, static/) — §304 rejects
 *    dangerous configurations instead of serving customer data.
 *  - The operational file TTL (§16/§63/§132/§133/§184) is NOT a legal
 *    retention policy — documentation must never claim otherwise.
 */

import { isAbsolute, join, resolve, sep } from "node:path";
import fs from "node:fs";

/* ------------------------------ integer parsing ---------------------------- */

function intFromEnv(
  name: string,
  fallback: number,
  opts: { min: number; max: number },
): number {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  if (n < opts.min || n > opts.max) return fallback;
  return n;
}

export function exportFileTtlHours(): number {
  return intFromEnv("EXPORT_FILE_TTL_HOURS", 72, { min: 1, max: 24 * 30 });
}

export function exportMaxRecords(): number {
  return intFromEnv("EXPORT_MAX_RECORDS", 100_000, { min: 100, max: 5_000_000 });
}

export function exportMaxBytes(): number {
  return intFromEnv("EXPORT_MAX_BYTES", 50 * 1024 * 1024, {
    min: 1024,
    max: 1024 * 1024 * 1024,
  });
}

export function exportMaxDatasets(): number {
  return intFromEnv("EXPORT_MAX_DATASETS", 12, { min: 1, max: 32 });
}

export function importFileTtlHours(): number {
  return intFromEnv("IMPORT_FILE_TTL_HOURS", 72, { min: 1, max: 24 * 30 });
}

export function importMaxBytes(): number {
  return intFromEnv("IMPORT_MAX_BYTES", 10 * 1024 * 1024, {
    min: 1024,
    max: 128 * 1024 * 1024,
  });
}

export function importMaxErrors(): number {
  return intFromEnv("IMPORT_MAX_ERRORS", 500, { min: 10, max: 50_000 });
}

export function maxActiveExportsPerBusiness(): number {
  return intFromEnv("MAX_ACTIVE_EXPORTS_PER_BUSINESS", 2, { min: 1, max: 10 });
}

export function maxActiveImportsPerBusiness(): number {
  return intFromEnv("MAX_ACTIVE_IMPORTS_PER_BUSINESS", 2, { min: 1, max: 10 });
}

/** Rows per commit batch — bounded SQLite transactions (§94/§175/§176). */
export function importCommitBatchSize(): number {
  return intFromEnv("IMPORT_COMMIT_BATCH_SIZE", 500, { min: 50, max: 5_000 });
}

/**
 * Jobs stuck in QUEUED/PROCESSING beyond this age are treated as stale
 * crash leftovers (§317/§318) and marked FAILED / FAILED_REQUIRES_REVIEW.
 */
export function staleJobThresholdMinutes(): number {
  return intFromEnv("PORTABILITY_STALE_JOB_MINUTES", 20, { min: 5, max: 720 });
}

/* ------------------------------ storage root ------------------------------- */

/** Directories that must NEVER contain customer export/import files (§304). */
const FORBIDDEN_ROOT_SEGMENTS = ["public", ".next", "static", "node_modules"];

export function dataPortabilityRoot(): string {
  const configured = (process.env.DATA_PORTABILITY_ROOT ?? "").trim();
  if (configured) {
    return isAbsolute(configured) ? configured : join(process.cwd(), configured);
  }
  // Project convention (documented in docs/security/data-portability.md):
  // var/data-portability — sibling of the db/ directory, never web-served.
  return join(process.cwd(), "var", "data-portability");
}

/** Validate a resolved storage root (§304). Returns an error code or null. */
export function validateStorageRoot(root: string): "INVALID_PATH" | "WEB_SERVED" | null {
  const resolved = resolve(root);
  if (!isAbsolute(resolved)) return "INVALID_PATH";
  const segments = resolved.split(sep).filter((s) => s.length > 0);
  for (const forbidden of FORBIDDEN_ROOT_SEGMENTS) {
    if (segments.includes(forbidden)) return "WEB_SERVED";
  }
  return null;
}

export type StorageHealth = "READY" | "NOT_CONFIGURED" | "NOT_WRITABLE" | "INVALID";

/**
 * PORTABILITY_STORAGE health (§305) — probed with a real write+delete of a
 * probe file. Returns the status code only; never paths or internals.
 */
export function probeStorageHealth(): { status: StorageHealth; code: string | null } {
  const root = dataPortabilityRoot();
  const invalid = validateStorageRoot(root);
  if (invalid === "WEB_SERVED") return { status: "INVALID", code: "PORTABILITY_STORAGE_WEB_SERVED" };
  if (invalid === "INVALID_PATH") return { status: "INVALID", code: "PORTABILITY_STORAGE_INVALID" };
  let probePath: string | null = null;
  try {
    fs.mkdirSync(root, { recursive: true });
    probePath = join(root, `.probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probePath, "probe", { encoding: "utf8" });
    fs.unlinkSync(probePath);
    return { status: "READY", code: null };
  } catch {
    return { status: "NOT_WRITABLE", code: "PORTABILITY_STORAGE_NOT_WRITABLE" };
  } finally {
    if (probePath) {
      try {
        fs.unlinkSync(probePath);
      } catch {
        /* probe already absent */
      }
    }
  }
}
