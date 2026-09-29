/**
 * Import field metadata — CLIENT-SAFE (Prompt 31 §70/§232/§238).
 *
 * This module carries NO server-only imports so the UI can render the
 * exact same field catalog the server enforces. The server catalog
 * (import-catalog.ts, server-only) re-exports from here and ADDS the
 * duplicate-match keys + template definitions.
 *
 * SECURITY INVARIANT: only fields listed here can ever be mapped/inserted
 * (§70/§291-§296). No identity (id/businessId), no timestamps, no
 * password/mfa/session/token/secret, no role/platform/billing fields.
 */

export const IMPORT_DATASET_KEYS = ["customers", "suppliers", "products"] as const;
export type ImportDatasetKey = (typeof IMPORT_DATASET_KEYS)[number];

export const DUPLICATE_MODES = ["SKIP", "REJECT"] as const;
export type DuplicateMode = (typeof DUPLICATE_MODES)[number];

export type ImportFieldType =
  | "string"
  | "email"
  | "phone"
  | "money" // decimal string → integer minor units (business precision, §77)
  | "integer"
  | "boolean";

export type ImportField = {
  name: string; // stable machine field name (§120)
  type: ImportFieldType;
  required: boolean;
  maxLength?: number;
  /** CSV/JSON alias headers for auto-mapping (normalized match, §68). */
  aliases: string[];
  descriptionKey: string; // i18n key under portability.importFields
};

export const IMPORT_FIELDS: Record<ImportDatasetKey, ImportField[]> = {
  customers: [
    { name: "name", type: "string", required: true, maxLength: 200, aliases: ["name", "customer name", "full name", "party name"], descriptionKey: "name" },
    { name: "phone", type: "phone", required: false, maxLength: 40, aliases: ["phone", "phone number", "mobile", "tel", "telephone"], descriptionKey: "phone" },
    { name: "email", type: "email", required: false, maxLength: 200, aliases: ["email", "e mail", "mail", "email address"], descriptionKey: "email" },
    { name: "address", type: "string", required: false, maxLength: 500, aliases: ["address", "street", "location"], descriptionKey: "address" },
    { name: "note", type: "string", required: false, maxLength: 1000, aliases: ["note", "notes", "comment", "comments"], descriptionKey: "note" },
  ],
  suppliers: [
    { name: "name", type: "string", required: true, maxLength: 200, aliases: ["name", "supplier name", "vendor name", "party name"], descriptionKey: "name" },
    { name: "phone", type: "phone", required: false, maxLength: 40, aliases: ["phone", "phone number", "mobile", "tel", "telephone"], descriptionKey: "phone" },
    { name: "email", type: "email", required: false, maxLength: 200, aliases: ["email", "e mail", "mail", "email address"], descriptionKey: "email" },
    { name: "address", type: "string", required: false, maxLength: 500, aliases: ["address", "street", "location"], descriptionKey: "address" },
    { name: "note", type: "string", required: false, maxLength: 1000, aliases: ["note", "notes", "comment", "comments"], descriptionKey: "note" },
  ],
  products: [
    { name: "name", type: "string", required: true, maxLength: 200, aliases: ["name", "product name", "title"], descriptionKey: "name" },
    { name: "sku", type: "string", required: false, maxLength: 60, aliases: ["sku", "code", "sku code", "product code", "item code"], descriptionKey: "sku" },
    { name: "unit", type: "string", required: false, maxLength: 20, aliases: ["unit", "uom", "unit of measure"], descriptionKey: "unit" },
    { name: "sale_price", type: "money", required: false, aliases: ["sale price", "price", "saleprice", "selling price"], descriptionKey: "salePrice" },
    { name: "cost_price", type: "money", required: false, aliases: ["cost price", "cost", "costprice", "purchase price"], descriptionKey: "costPrice" },
    { name: "stock_qty", type: "integer", required: false, aliases: ["stock qty", "stock", "quantity", "qty", "stock quantity"], descriptionKey: "stockQty" },
    { name: "low_stock_at", type: "integer", required: false, aliases: ["low stock at", "low stock", "alert at", "low stock threshold"], descriptionKey: "lowStockAt" },
    { name: "is_active", type: "boolean", required: false, aliases: ["is active", "active", "enabled", "status"], descriptionKey: "isActive" },
  ],
};
