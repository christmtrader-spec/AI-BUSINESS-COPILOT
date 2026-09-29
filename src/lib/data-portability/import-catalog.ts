import "server-only";

/**
 * Import catalog (SERVER) — Prompt 31 §55/§59/§81-§85/§112-§121/§336.
 *
 * The field allowlists live in the CLIENT-SAFE module
 * `import-fields.ts` (shared with the UI so both sides render/enforce the
 * SAME catalog). This server module adds:
 *  - the deterministic duplicate-match keys (§81/§84)
 *  - template definitions (§119-§121)
 *  - header normalization + auto-mapping (§68/§69)
 *
 * SECURITY INVARIANTS (restated): controlled scope — customers, suppliers,
 * products ONLY (§59); financial history is NOT importable (§116-§118/§221);
 * imports create NO users/members/credentials (§288-§290); duplicate
 * policy is deterministic, never fuzzy/AI (§81/§270/§271).
 */

import { IMPORT_FIELDS, IMPORT_DATASET_KEYS, type ImportDatasetKey, type ImportField } from "./import-fields";

export { IMPORT_DATASET_KEYS, DUPLICATE_MODES } from "./import-fields";
export type { ImportDatasetKey, DuplicateMode, ImportField, ImportFieldType } from "./import-fields";

export const IMPORT_SCHEMA_VERSION = 1;
/** Linked template version (§121) — bump together with the schema version. */
export const IMPORT_TEMPLATE_VERSION = 1;

export type ImportDatasetMeta = {
  key: ImportDatasetKey;
  labelKey: string;
  fields: ImportField[];
  /** Deterministic duplicate matching keys, in priority order (§81/§84). */
  matchKeys: Array<{ field: string; normalize: "email" | "phone" | "text" }>;
  templateFile: string;
};

export const IMPORT_CATALOG: Record<ImportDatasetKey, ImportDatasetMeta> = {
  customers: {
    key: "customers",
    labelKey: "customers",
    fields: IMPORT_FIELDS.customers,
    // Deterministic priority: email → phone → name (§81). A row without
    // ANY of these is never a duplicate candidate (documented policy).
    matchKeys: [
      { field: "email", normalize: "email" },
      { field: "phone", normalize: "phone" },
      { field: "name", normalize: "text" },
    ],
    templateFile: "Customer.csv",
  },
  suppliers: {
    key: "suppliers",
    labelKey: "suppliers",
    fields: IMPORT_FIELDS.suppliers,
    matchKeys: [
      { field: "email", normalize: "email" },
      { field: "phone", normalize: "phone" },
      { field: "name", normalize: "text" },
    ],
    templateFile: "Supplier.csv",
  },
  products: {
    key: "products",
    labelKey: "products",
    fields: IMPORT_FIELDS.products,
    // §81 — SKU/code matching; name fallback when no SKU.
    matchKeys: [
      { field: "sku", normalize: "text" },
      { field: "name", normalize: "text" },
    ],
    templateFile: "Product.csv",
  },
};

/** Fields whose values the import is allowed to write (CREATE mode). */
export function importableFields(dataset: ImportDatasetKey): ImportField[] {
  return IMPORT_CATALOG[dataset].fields;
}

/* ------------------------- normalization + matching ------------------------ */

/** Normalize a header ONLY for matching (§68) — actual values untouched. */
export function normalizeHeader(raw: string): string {
  return raw
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_\-]+/g, " ")
    .trim();
}

export function normalizeForMatch(value: string, mode: "email" | "phone" | "text"): string {
  const trimmed = value.trim();
  switch (mode) {
    case "email":
      return trimmed.toLowerCase();
    case "phone":
      return trimmed.replace(/[\s\-().]/g, "").toLowerCase();
    case "text":
      return trimmed.toLowerCase().replace(/\s+/g, " ");
  }
}

/** Build the auto-mapping suggestion (exact normalized header/alias hits). */
export function suggestMapping(headers: string[], dataset: ImportDatasetKey): Record<string, string> {
  const meta = IMPORT_CATALOG[dataset];
  const suggestion: Record<string, string> = {};
  const normalized = headers.map((h) => ({ raw: h, norm: normalizeHeader(h) }));
  for (const field of meta.fields) {
    const aliasSet = new Set([normalizeHeader(field.name), ...field.aliases.map(normalizeHeader)]);
    const hit = normalized.find((h) => aliasSet.has(h.norm));
    if (hit) suggestion[hit.raw] = field.name;
  }
  return suggestion;
}

/** Stable CSV headers for the downloadable templates (§119/§193/§211). */
export function templateHeaders(dataset: ImportDatasetKey): string[] {
  return IMPORT_CATALOG[dataset].fields.map((f) => f.name);
}

/**
 * One harmless, clearly synthetic example row (§212 — never real data).
 * Values exercise the documented formats (money uses the exact
 * decimal-string format, §227).
 */
export function templateExampleRow(dataset: ImportDatasetKey): string[] {
  switch (dataset) {
    case "customers":
      // Phone values deliberately do NOT start with "+": the CSV export
      // formula guard would apostrophe a leading "+" and the round-trip
      // example must validate cleanly (§213).
      return ["Example Customer", "1555010000", "example.customer@example.com", "Example Street 1", "Synthetic template example — replace with real data"];
    case "suppliers":
      return ["Example Supplier", "1555010001", "example.supplier@example.com", "Example Street 2", "Synthetic template example — replace with real data"];
    case "products":
      return ["Example Product", "SKU-EXAMPLE", "piece", "10.00", "6.00", "0", "5", "true"];
  }
}
