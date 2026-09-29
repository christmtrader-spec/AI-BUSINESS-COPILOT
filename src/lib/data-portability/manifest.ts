import "server-only";

/**
 * Export manifest — Prompt 31 §9/§10/§40/§312.
 *
 * The manifest travels INSIDE every export artifact:
 *  - JSON format: single file `{ manifest, datasets }`.
 *  - CSV format: ZIP package with manifest.json + one CSV per dataset.
 *
 * Integrity model (two clearly separated checksums):
 *  - manifest.integrity: SHA-256 over the DATASET PAYLOAD bytes
 *    (JSON: the exact serialized `datasets` fragment; CSV: the exact CSV
 *    file bytes concatenated in dataset-key order). Documented recipe —
 *    a recipient can recompute it without knowing our internals.
 *  - DataExportJob.checksum: SHA-256 over the ENTIRE artifact file,
 *    verified on every download (§30/§312/§372).
 *
 * The manifest never contains secrets, session data or platform metadata
 * (§9/§10/§40).
 */

import { createHash } from "node:crypto";
import { EXPORT_CATALOG, type ExportDatasetKey, type ExportSensitivity } from "./export-catalog";
import { APP_VERSION } from "@/lib/app-version";

export const EXPORT_SCHEMA_VERSION = 1;

export type ExportManifest = {
  kind: "ai-business-copilot/data-export";
  exportSchemaVersion: number;
  appVersion: string;
  createdAt: string;
  business: {
    id: string;
    name: string;
    timezone: string;
    currency: string;
    decimalPrecision: number;
  };
  format: "JSON" | "CSV";
  datasets: Array<{
    key: ExportDatasetKey;
    sensitivity: ExportSensitivity;
    file: string | null; // CSV file name; null for the JSON single-file format
    recordCount: number;
  }>;
  recordCounts: Record<string, number>;
  integrity: {
    algorithm: "sha256";
    /** What the value covers — documented + verifiable. */
    scope: "datasets";
    value: string;
  };
  generationStatus: "COMPLETED";
};

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function buildManifest(input: {
  business: { id: string; name: string; timezone: string; currency: string; decimalPrecision: number };
  format: "JSON" | "CSV";
  datasetCounts: Array<{ key: ExportDatasetKey; recordCount: number }>;
  /** SHA-256 over the dataset payload (see module doc). */
  payloadChecksum: string;
}): ExportManifest {
  const datasets = input.datasetCounts.map(({ key, recordCount }) => ({
    key,
    sensitivity: EXPORT_CATALOG[key].sensitivity,
    file: input.format === "CSV" ? EXPORT_CATALOG[key].csvFile : null,
    recordCount,
  }));
  const recordCounts: Record<string, number> = {};
  for (const { key, recordCount } of input.datasetCounts) {
    recordCounts[key] = recordCount;
  }
  return {
    kind: "ai-business-copilot/data-export",
    exportSchemaVersion: EXPORT_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    createdAt: new Date().toISOString(),
    business: input.business,
    format: input.format,
    datasets,
    recordCounts,
    integrity: {
      algorithm: "sha256",
      scope: "datasets",
      value: input.payloadChecksum,
    },
    generationStatus: "COMPLETED",
  };
}
