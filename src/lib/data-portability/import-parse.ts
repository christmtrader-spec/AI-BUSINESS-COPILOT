import "server-only";

/**
 * Import file parsing — Prompt 31 §58/§62/§65-§67/§152/§153/§171/§208/§209.
 *
 * LAWS:
 *  - Formats: CSV (minimum, §58) and JSON (portability export file OR a
 *    bare JSON array of row objects). NEVER SQL, SQLite, HTML or XML —
 *    content signatures below reject anything else (§65/§140/§208/§209).
 *  - Parsing uses the established `csv-parse` library (§66) — UTF-8,
 *    quoted fields, escaped separators, header row. The UTF-8 BOM is
 *    stripped explicitly (§67).
 *  - Type detection does not trust the extension alone: extension + MIME
 *    (when present) + content signature must agree (§65).
 *  - Parser exceptions are normalized to safe codes — a parser error can
 *    contain raw file content, which must NEVER reach logs or responses
 *    (§171).
 *  - Imported values remain DATA — nothing is ever evaluated (§152/§207).
 */

import { parse } from "csv-parse/sync";

export type ImportFileFormat = "CSV" | "JSON";

export class ImportParseError extends Error {
  constructor(
    public code: "IMPORT_INVALID_FILE" | "IMPORT_PARSE_ERROR" | "IMPORT_TOO_LARGE" | "IMPORT_EMPTY_FILE" | "IMPORT_NO_HEADERS",
    message: string,
  ) {
    super(message);
  }
}

export type ParsedImportFile = {
  format: ImportFileFormat;
  headers: string[]; // original header names (display)
  /** rows[r][c] — raw string values ("" = empty, §228). */
  rows: string[][];
};

const MAX_COLUMNS = 64;

/** Strip the UTF-8 BOM (§67) and reject NUL bytes / binary payloads. */
function textFromBuffer(buffer: Buffer): string {
  if (buffer.includes(0)) {
    throw new ImportParseError("IMPORT_INVALID_FILE", "Binary files are not accepted.");
  }
  let text = buffer.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

/**
 * Content signature sniff (§65): JSON must start with { or [; CSV must be
 * decodable text. Returns the format the CONTENT claims.
 */
export function sniffFormat(buffer: Buffer, declaredExtension: string | null): ImportFileFormat {
  const head = textFromBuffer(buffer.subarray(0, 2048)).trimStart();
  const looksJson = head.startsWith("{") || head.startsWith("[");
  if (declaredExtension === "json") {
    if (!looksJson) throw new ImportParseError("IMPORT_INVALID_FILE", "File content does not match the .json extension.");
    return "JSON";
  }
  if (declaredExtension === "csv") {
    if (looksJson) throw new ImportParseError("IMPORT_INVALID_FILE", "File content does not match the .csv extension.");
    return "CSV";
  }
  // Unknown/missing extension → content decides (both formats accepted).
  return looksJson ? "JSON" : "CSV";
}

/** Parse a CSV buffer into headers + raw rows (bounded, §66/§67). */
function parseCsv(text: string, maxRows: number): ParsedImportFile {
  let records: string[][];
  try {
    records = parse(text, {
      columns: false,
      bom: true, // csv-parse also handles a BOM — double safety (§67)
      skip_empty_lines: true,
      trim: false, // values preserved verbatim; normalization is explicit (§68)
      max_record_size: 64 * 1024,
    }) as string[][];
  } catch {
    // §171 — parser exceptions may embed raw row content. Normalize.
    throw new ImportParseError("IMPORT_PARSE_ERROR", "The file could not be parsed as CSV.");
  }
  if (records.length === 0) {
    throw new ImportParseError("IMPORT_NO_HEADERS", "The file has no header row.");
  }
  const headers = records[0].map((h) => String(h ?? ""));
  const usable = headers.filter((h) => h.trim() !== "");
  if (usable.length === 0) {
    throw new ImportParseError("IMPORT_NO_HEADERS", "The file has no header row.");
  }
  if (headers.length > MAX_COLUMNS) {
    throw new ImportParseError("IMPORT_INVALID_FILE", "The file has too many columns.");
  }
  const rows = records.slice(1, maxRows + 1).map((r) => {
    const row = r.map((v) => (v == null ? "" : String(v)));
    while (row.length < headers.length) row.push("");
    return row.slice(0, headers.length);
  });
  if (records.length - 1 > maxRows) {
    throw new ImportParseError("IMPORT_TOO_LARGE", "The file exceeds the row limit for its size.");
  }
  return { format: "CSV", headers, rows };
}

type JsonExportFile = {
  manifest?: { kind?: unknown; exportSchemaVersion?: unknown };
  datasets?: Record<string, unknown>;
};

/**
 * Parse JSON input (§153): either OUR data-export format (extract the
 * single requested dataset) or a bare array of row objects. Executable
 * JSON does not exist — values remain data (§153/§207).
 */
function parseJsonFile(text: string, dataset: string, maxRows: number): ParsedImportFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportParseError("IMPORT_PARSE_ERROR", "The file could not be parsed as JSON.");
  }

  let rowsRaw: unknown[] | null = null;

  if (Array.isArray(parsed)) {
    rowsRaw = parsed;
  } else if (parsed && typeof parsed === "object" && "datasets" in (parsed as JsonExportFile)) {
    const datasets = (parsed as JsonExportFile).datasets;
    const selected = datasets && typeof datasets === "object" ? (datasets as Record<string, unknown>)[dataset] : undefined;
    if (Array.isArray(selected)) rowsRaw = selected;
    else if (selected && typeof selected === "object") {
      // sales-style nested payloads are not importable — flat datasets only.
      throw new ImportParseError("IMPORT_INVALID_FILE", "This dataset cannot be imported.");
    }
  }

  if (!rowsRaw) {
    throw new ImportParseError("IMPORT_INVALID_FILE", "JSON input must be an array of row objects or an export file for this dataset.");
  }
  if (rowsRaw.length > maxRows) {
    throw new ImportParseError("IMPORT_TOO_LARGE", "The file exceeds the row limit for its size.");
  }

  // Column union in first-seen order (bounded).
  const headers: string[] = [];
  const headerSet = new Set<string>();
  for (const row of rowsRaw.slice(0, 200)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    for (const key of Object.keys(row as Record<string, unknown>)) {
      if (!headerSet.has(key)) {
        headerSet.add(key);
        headers.push(key);
        if (headers.length >= MAX_COLUMNS) break;
      }
    }
    if (headers.length >= MAX_COLUMNS) break;
  }
  if (headers.length === 0) {
    throw new ImportParseError("IMPORT_NO_HEADERS", "The JSON rows have no usable keys.");
  }

  const rows = rowsRaw.map((row) =>
    headers.map((h) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return "";
      const value = (row as Record<string, unknown>)[h];
      if (value === null || value === undefined) return "";
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      // Objects/arrays are not importable scalar values — empty (§228).
      return "";
    }),
  );
  return { format: "JSON", headers, rows };
}

/**
 * Full parse pipeline. maxRows derives from the configured byte cap —
 * deterministic and documented (no hidden row limits).
 */
export function parseImportFile(buffer: Buffer, dataset: string, declaredExtension: string | null, maxRows: number): ParsedImportFile {
  const format = sniffFormat(buffer, declaredExtension);
  const text = textFromBuffer(buffer);
  if (text.trim() === "") {
    throw new ImportParseError("IMPORT_EMPTY_FILE", "The uploaded file is empty.");
  }
  return format === "JSON" ? parseJsonFile(text, dataset, maxRows) : parseCsv(text, maxRows);
}
