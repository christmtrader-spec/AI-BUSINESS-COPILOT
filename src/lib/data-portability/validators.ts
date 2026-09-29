import "server-only";

/**
 * Import row validation — Prompt 31 §68-§80/§97/§228/§229/§230/§321/§322.
 *
 * LAWS:
 *  - Every row is validated SERVER-SIDE against the per-dataset field
 *    allowlist (§74); the browser can never inject a Prisma field name
 *    (§69) — only catalog fields below exist.
 *  - EMPTY FIELD POLICY (§228): an empty value means NULL for optional
 *    fields and ROW_REQUIRED_FIELD_MISSING for required ones. One uniform
 *    rule for every field — never guessed per field.
 *  - MONEY (§77/§225): parsed from an exact decimal string into integer
 *    minor units with the BUSINESS decimal precision — never a float; the
 *    client cannot change the currency (§286).
 *  - BOOLEANS (§229): true/false only. ENUM-ish values are validated
 *    against the field type, never against localized labels (§230).
 *  - Row errors carry rowNumber + field + STABLE CODE only — NO raw row
 *    values (§321/§322), bounded by IMPORT_MAX_ERRORS upstream (§172).
 */

import { MoneyParseError, parseDecimalToMinor } from "./money-csv";
import { IMPORT_CATALOG, normalizeForMatch, type ImportDatasetKey, type ImportField } from "./import-catalog";

export const ROW_ERROR_CODES = [
  "ROW_REQUIRED_FIELD_MISSING",
  "ROW_INVALID_EMAIL",
  "ROW_INVALID_PHONE",
  "ROW_INVALID_AMOUNT",
  "ROW_INVALID_NUMBER",
  "ROW_INVALID_BOOLEAN",
  "ROW_VALUE_TOO_LONG",
  "ROW_DUPLICATE",
  "ROW_FOREIGN_REFERENCE_NOT_FOUND",
  "ROW_UNSUPPORTED_FIELD",
  "ROW_INVALID_DATE",
] as const;
export type RowErrorCode = (typeof ROW_ERROR_CODES)[number];

export type RowError = {
  rowNumber: number; // 1-based data-row number (header excluded)
  field: string | null;
  code: RowErrorCode;
};

export type ValidatedRow = {
  rowNumber: number;
  /** Server-minor-unit values, keyed by machine field name. */
  values: Record<string, string | number | boolean | null>;
  /** Duplicate-match key (first matching matchKey field present). */
  matchKey: { field: string; normalized: string } | null;
};

export class RowValidationError extends Error {
  constructor(
    public error: RowError,
  ) {
    super(error.code);
  }
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,20}$/;
const PHONE_RE = /^\+?[\d\s().-]{3,40}$/;

function validateField(field: ImportField, rawValue: string, decimalPrecision: number): string | number | boolean | null {
  const value = rawValue.trim();
  if (value === "") {
    // §228 — empty = null (required-ness handled by the caller).
    return null;
  }
  switch (field.type) {
    case "string": {
      if (field.maxLength && value.length > field.maxLength) {
        throw new RowValidationError({ rowNumber: 0, field: field.name, code: "ROW_VALUE_TOO_LONG" });
      }
      return value;
    }
    case "email": {
      if (value.length > 200 || !EMAIL_RE.test(value)) {
        throw new RowValidationError({ rowNumber: 0, field: field.name, code: "ROW_INVALID_EMAIL" });
      }
      return value.toLowerCase();
    }
    case "phone": {
      if (!PHONE_RE.test(value)) {
        throw new RowValidationError({ rowNumber: 0, field: field.name, code: "ROW_INVALID_PHONE" });
      }
      return value;
    }
    case "money": {
      try {
        return parseDecimalToMinor(value, decimalPrecision);
      } catch (error) {
        if (error instanceof MoneyParseError) {
          throw new RowValidationError({ rowNumber: 0, field: field.name, code: "ROW_INVALID_AMOUNT" });
        }
        throw error;
      }
    }
    case "integer": {
      if (!/^\d{1,10}$/.test(value)) {
        throw new RowValidationError({ rowNumber: 0, field: field.name, code: "ROW_INVALID_NUMBER" });
      }
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n > 2_000_000_000) {
        throw new RowValidationError({ rowNumber: 0, field: field.name, code: "ROW_INVALID_NUMBER" });
      }
      return n;
    }
    case "boolean": {
      const lowered = value.toLowerCase();
      if (lowered === "true" || lowered === "false") return lowered === "true";
      throw new RowValidationError({ rowNumber: 0, field: field.name, code: "ROW_INVALID_BOOLEAN" });
    }
  }
}

export type MappingValidation =
  | { ok: true; mapping: Record<string, string> }
  | { ok: false; code: "IMPORT_MAPPING_INVALID"; problem: string };

/**
 * Validate a submitted mapping (§70/§88): every target field must be in
 * the catalog allowlist, every source column must exist in the file, one
 * source per target, required fields covered. Path-py names such as
 * `__proto__`/`constructor` can never become query fragments — the target
 * side is matched against the catalog by exact string equality (§238).
 */
export function validateMapping(
  input: unknown,
  dataset: ImportDatasetKey,
  fileHeaders: string[],
): MappingValidation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "IMPORT_MAPPING_INVALID", problem: "MAPPING_SHAPE" };
  }
  const meta = IMPORT_CATALOG[dataset];
  const entries = Object.entries(input as Record<string, unknown>);
  const fieldByName = new Map(meta.fields.map((f) => [f.name, f]));
  const headerSet = new Set(fileHeaders);
  const seenFields = new Set<string>();

  const mapping: Record<string, string> = {};
  for (const [sourceColumn, targetField] of entries) {
    if (typeof targetField !== "string") {
      return { ok: false, code: "IMPORT_MAPPING_INVALID", problem: "TARGET_TYPE" };
    }
    if (!headerSet.has(sourceColumn)) {
      return { ok: false, code: "IMPORT_MAPPING_INVALID", problem: "UNKNOWN_COLUMN" };
    }
    if (targetField === "") continue; // explicit "not mapped" is allowed
    if (!fieldByName.has(targetField)) {
      return { ok: false, code: "IMPORT_MAPPING_INVALID", problem: "FIELD_NOT_IMPORTABLE" };
    }
    if (seenFields.has(targetField)) {
      return { ok: false, code: "IMPORT_MAPPING_INVALID", problem: "FIELD_MAPPED_TWICE" };
    }
    seenFields.add(targetField);
    mapping[sourceColumn] = targetField;
  }

  for (const field of meta.fields) {
    if (field.required && !seenFields.has(field.name)) {
      return { ok: false, code: "IMPORT_MAPPING_INVALID", problem: "REQUIRED_FIELD_UNMAPPED" };
    }
  }
  return { ok: true, mapping };
}

export type ValidateRowsResult = {
  validRows: ValidatedRow[];
  errors: RowError[];
};

/**
 * Apply the mapping to raw parsed rows and validate every row (§74-§80).
 * Pure function — no DB access, no mutation (§60/§86).
 */
export function validateRows(
  dataset: ImportDatasetKey,
  headers: string[],
  rows: string[][],
  mapping: Record<string, string>,
  decimalPrecision: number,
): ValidateRowsResult {
  const meta = IMPORT_CATALOG[dataset];
  const sourceByField = new Map<string, number>();
  for (const [sourceColumn, targetField] of Object.entries(mapping)) {
    if (targetField) sourceByField.set(targetField, headers.indexOf(sourceColumn));
  }

  const validRows: ValidatedRow[] = [];
  const errors: RowError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 1;
    const values: Record<string, string | number | boolean | null> = {};
    let rowError: RowError | null = null;

    for (const field of meta.fields) {
      const colIndex = sourceByField.get(field.name);
      const raw = colIndex === undefined || colIndex < 0 ? "" : (rows[i][colIndex] ?? "");
      try {
        values[field.name] = validateField(field, raw, decimalPrecision);
      } catch (error) {
        if (error instanceof RowValidationError) {
          rowError = { ...error.error, rowNumber };
          break;
        }
        throw error;
      }
      if (values[field.name] === null && field.required) {
        rowError = { rowNumber, field: field.name, code: "ROW_REQUIRED_FIELD_MISSING" };
        break;
      }
    }

    if (rowError) {
      errors.push(rowError);
      continue;
    }

    // Deterministic duplicate-match key (§81): first matchKey field that
    // has a value wins. Rows with no key value are never duplicate candidates.
    let matchKey: ValidatedRow["matchKey"] = null;
    for (const mk of meta.matchKeys) {
      const value = values[mk.field];
      if (typeof value === "string" && value.trim() !== "") {
        matchKey = { field: mk.field, normalized: normalizeForMatch(value, mk.normalize) };
        break;
      }
    }
    validRows.push({ rowNumber, values, matchKey });
  }

  return { validRows, errors };
}
