/**
 * scripts/prompt31-unit.ts — Prompt 31 data-portability UNIT harness.
 *
 * Deterministic, no server required (bun --preload scripts/p29-preload.ts):
 *   §234  CSV serialization: formula injection, quotes, commas, BOM
 *   §157/§227  money: minor ↔ decimal-string exact round trip, rejects
 *   §231  date: ISO-8601 normalization
 *   §154/§266  UTF-8 / Persian / emoji / JSON special chars round trip
 *   §264  CSV formula injection on customer names
 *   §267  CSV quoted field parse ("Smith, John" stays one field)
 *   §268  empty-field policy
 *   §68/§238  header normalization + mapping validation (no __proto__/raw SQL)
 *   §69-§71/§347  import field allowlist invariants
 *   §269  duplicate normalization determinism
 *   §262/§263  filename sanitization
 *   §182  config integer parsing (negative/zero/NaN/Infinity → defaults)
 *   §9    manifest builder shape (no secrets, integrity present)
 *   §237  storage key safety (path traversal rejected)
 *
 * Run:  bun --preload scripts/p29-preload.ts scripts/prompt31-unit.ts
 */
import { formatMinorToDecimal, parseDecimalToMinor, MoneyParseError } from "../src/lib/data-portability/money-csv";
import { toCsv, csvCell } from "../src/lib/csv";
import { parseImportFile, sniffFormat } from "../src/lib/data-portability/import-parse";
import { validateMapping, validateRows } from "../src/lib/data-portability/validators";
import {
  IMPORT_FIELDS,
} from "../src/lib/data-portability/import-fields";
import {
  normalizeHeader,
  normalizeForMatch,
  suggestMapping,
  templateHeaders,
  templateExampleRow,
} from "../src/lib/data-portability/import-catalog";
import { validateStorageRoot, exportMaxRecords, importMaxErrors, probeStorageHealth } from "../src/lib/data-portability/config";
import { buildManifest } from "../src/lib/data-portability/manifest";
import { buildStorageKey, isSafeArtifactKey } from "../src/lib/data-portability/storage";
import { EXPORT_DATASET_KEYS, DATASET_CSV_COLUMNS, DATASET_IMPLICATIONS } from "../src/lib/data-portability/export-catalog";
import { createHash } from "node:crypto";
import { join } from "node:path";

const results: { name: string; ok: boolean; info?: string }[] = [];
function check(name: string, cond: boolean, info = "") {
  results.push({ name, ok: cond, info });
  console.log(`${cond ? "✓" : "✗"} ${name}${info ? ` — ${info}` : ""}`);
}

/* ------------------------------ §234 CSV writer ----------------------------- */
{
  const csv = toCsv(["name", "note"], [["Smith, John", 'He said "hi"']]);
  const lines = csv.replace(/^\uFEFF/, "").split("\r\n");
  check("CSV: quoted comma stays one field (§267)", lines[1] === '"Smith, John","He said ""hi"""', lines[1]);
  check("CSV: BOM present (§67/§154)", csv.charCodeAt(0) === 0xfeff);
  const formula1 = csvCell("=CMD(...)");
  const formula2 = csvCell("+SUM(A1)");
  const formula3 = csvCell("@cmd");
  const negNumber = csvCell("-12.5");
  check("CSV: = formula neutralized (§264)", formula1 === "'=CMD(...)" && formula1.startsWith("'"), formula1);
  check("CSV: + formula neutralized (§264)", formula2 === "'+SUM(A1)" && formula2.startsWith("'"), formula2);
  check("CSV: @ neutralized", formula3 === "'@cmd" && formula3.startsWith("'"), formula3);
  check("CSV: negative NUMBER stays numeric", negNumber === "-12.5", negNumber);
  check("CSV: newline inside cell quoted", toCsv(["a"], [["x\ny"]]).includes('"x\ny"'));
}

/* ----------------------------- §157 money round trip ------------------------ */
{
  const cases: Array<[number, number]> = [
    [0, 2], [1, 2], [1250, 2], [-1250, 2], [999999999, 0], [7, 4], [100, 2],
  ];
  let allOk = true;
  for (const [minor, precision] of cases) {
    const s = formatMinorToDecimal(minor, precision);
    const back = parseDecimalToMinor(s, precision);
    if (back !== minor) { allOk = false; console.log(`  mismatch ${minor}@${precision} → ${s} → ${back}`); }
  }
  check("MONEY: minor → decimal → minor exact for valid cases (§157)", allOk);
  check("MONEY: IRR-style 0-decimals", formatMinorToDecimal(150000, 0) === "150000");
  check("MONEY: trailing zeros preserved", formatMinorToDecimal(1050, 2) === "10.50");
  check("MONEY: rejects thousands separators", throws(() => parseDecimalToMinor("1,250", 2)));
  check("MONEY: rejects exponent", throws(() => parseDecimalToMinor("1e5", 2)));
  check("MONEY: rejects excess precision", throws(() => parseDecimalToMinor("12.505", 2)));
  check("MONEY: rejects empty (§228 → required path)", throws(() => parseDecimalToMinor("", 2)));
  check("MONEY: rejects currency symbols TEST", throws(() => parseDecimalToMinor("$12.50", 2)));
  check("MONEY: accepts +12.5 → 1250", parseDecimalToMinor("+12.5", 2) === 1250);
  check("MONEY: .5 → 50", parseDecimalToMinor(".5", 2) === 50);
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof MoneyParseError;
  }
}

/* --------------------------- §154/§266 UTF-8 round trip --------------------- */
{
  const rows = [
    ["علی رضایی", "یادداشت: خرید ۱۲ عدد"],
    ["Emoji 🚀 + quote \"", "back\\slash"],
    ["Mixed ۱۲۳ and 123", "line\nbreak"],
  ];
  const csv = toCsv(["name", "note"], rows);
  check("CSV: Persian round trip byte-exact (§155/§365)", csv.includes("علی رضایی") && csv.includes("خرید ۱۲ عدد"));
  const json = JSON.stringify({ datasets: rows });
  const reparsed = JSON.parse(json) as { datasets: string[][] };
  check("JSON: quotes/backslashes/newlines/Persian/emoji survive (§266)", JSON.stringify(reparsed.datasets) === JSON.stringify(rows));
}

/* ------------------------- §65/§66/§67 import parsing ----------------------- */
{
  const bomCsv = Buffer.from("\uFEFFname,phone\nعلی,+98 912 000 0000\n", "utf8");
  const parsed = parseImportFile(bomCsv, "customers", "csv", 1000);
  check("PARSE: BOM stripped from headers (§67)", parsed.headers[0] === "name", JSON.stringify(parsed.headers));
  check("PARSE: Persian value preserved", parsed.rows[0][0] === "علی");
  check("PARSE: quoted comma", (() => {
    const p = parseImportFile(Buffer.from('name,note\n"Smith, John","x"\n', "utf8"), "customers", "csv", 1000);
    return p.rows[0][0] === "Smith, John";
  })());
  check("SNIFF: NUL byte → rejected (§65)", (() => {
    try {
      parseImportFile(Buffer.from("n\0ame\nx", "utf8"), "customers", "csv", 100);
      return false;
    } catch {
      return true;
    }
  })());
  check("SNIFF: .json content mismatch → rejected (§65)", (() => {
    try {
      parseImportFile(Buffer.from("name\nx\n", "utf8"), "customers", "json", 100);
      return false;
    } catch {
      return true;
    }
  })());
  // JSON portability export file extract
  const exportJson = JSON.stringify({
    manifest: { kind: "ai-business-copilot/data-export", exportSchemaVersion: 1 },
    datasets: { customers: [{ name: "A", phone: "1" }, { name: "B" }] },
  });
  const jp = parseImportFile(Buffer.from(exportJson, "utf8"), "customers", "json", 1000);
  check("PARSE: JSON export file extracts dataset", jp.rows.length === 2 && jp.headers.includes("name"));
  // Bare array
  const bare = parseImportFile(Buffer.from('[{"name":"X"}]', "utf8"), "customers", "json", 1000);
  check("PARSE: bare JSON array accepted (§58)", bare.rows.length === 1);
  // businessId column present but never importable (§73)
  const sneaky = parseImportFile(Buffer.from('name,businessId\nX,other-business\n', "utf8"), "customers", "csv", 1000);
  const mappingTest = validateMapping({ name: "name", businessId: "businessId" }, "customers", sneaky.headers);
  check("CROSS-TENANT: businessId target rejected (§73/§105)", !mappingTest.ok);
}

/* ----------------------------- §70/§88 mapping ------------------------------ */
{
  const headers = ["name", "phone", "email", "address", "note"];
  const ok = validateMapping({ name: "name", phone: "phone" }, "customers", headers);
  check("MAPPING: valid partial mapping accepted", ok.ok);
  const unknownColumn = validateMapping({ name: "nope" }, "customers", headers);
  check("MAPPING: unknown source column rejected", !ok.ok === false && !unknownColumn.ok);
  const proto = validateMapping({ "__proto__": "name" }, "customers", headers);
  check("MAPPING: __proto__ target rejected (§238)", !proto.ok);
  const sql = validateMapping({ "OR 1=1": "name" }, "customers", headers);
  check("MAPPING: SQL-ish column rejected (unknown column)", !sql.ok);
  const missingRequired = validateMapping({ phone: "phone" }, "customers", headers);
  check("MAPPING: required field unmapped rejected", !missingRequired.ok);
  const twice = validateMapping({ name: "name", note: "name" }, "customers", headers);
  check("MAPPING: field mapped twice rejected", !twice.ok);
}

/* ------------------------------ §74 row validation -------------------------- */
{
  const headers = ["name", "phone", "email", "address", "note"];
  const mapping = { name: "name", phone: "phone", email: "email", address: "address", note: "note" };
  const result = validateRows("customers", headers, [
    ["Ali", "+989120000000", "ali@example.com", "", ""],
    ["", "", "not-an-email", "", ""],
    ["Sara", "+989121111111", "sara@example.com", "", "Note"],
  ], mapping, 2);
  check("VALIDATE: valid rows count", result.validRows.length === 2 && result.errors.length === 1, JSON.stringify(result.errors));
  check("VALIDATE: empty required → ROW_REQUIRED_FIELD_MISSING (§75/§228)", result.errors.some((e) => e.code === "ROW_REQUIRED_FIELD_MISSING"));
  const emailResult = validateRows("customers", headers, [
    ["Ali", "", "not-an-email", "", ""],
  ], mapping, 2);
  check("VALIDATE: bad email → ROW_INVALID_EMAIL (§76)", emailResult.errors.some((e) => e.code === "ROW_INVALID_EMAIL" && e.field === "email"), JSON.stringify(emailResult.errors));
  check("VALIDATE: error rows carry NO raw values (§321)", !JSON.stringify(emailResult.errors).includes("not-an-email"));

  // product money
  const pHeaders = ["name", "sku", "unit", "sale_price", "cost_price", "stock_qty", "low_stock_at", "is_active"];
  const pMapping = Object.fromEntries(pHeaders.map((h) => [h, h]));
  const pResult = validateRows("products", pHeaders, [
    ["Widget", "W-1", "piece", "12.50", "6", "10", "5", "true"],
    ["Bad", "", "", "1.234", "", "", "", ""],
    ["BadBool", "", "", "", "", "", "", "yes"],
  ], pMapping, 2);
  check("VALIDATE: product money minor conversion exact (§77)", pResult.validRows[0]?.values.sale_price === 1250);
  check("VALIDATE: money over-precision → ROW_INVALID_AMOUNT", pResult.errors.some((e) => e.code === "ROW_INVALID_AMOUNT"));
  check("VALIDATE: boolean 'yes' → ROW_INVALID_BOOLEAN (§229)", pResult.errors.some((e) => e.code === "ROW_INVALID_BOOLEAN"));
}

/* ------------------------------ §68/§269 normalization ---------------------- */
{
  check("NORMALIZE: header BOM/case/underscores (§68)", normalizeHeader("\uFEFF Sale_Price ") === "sale price");
  check("NORMALIZE: email match key", normalizeForMatch("  Ali@Example.COM ", "email") === "ali@example.com");
  check("NORMALIZE: phone match key", normalizeForMatch("+98 912-000-0000", "phone") === "+989120000000");
  check("NORMALIZE: text match key", normalizeForMatch("  Ali   Rezaei ", "text") === "ali rezaei");
  const suggestion = suggestMapping(["Party Name", "E Mail"], "customers");
  check("AUTO-MAP: aliases hit (customers)", suggestion["Party Name"] === "name" && suggestion["E Mail"] === "email", JSON.stringify(suggestion));
  const skuSuggestion = suggestMapping(["SKU Code"], "products");
  check("AUTO-MAP: sku aliases hit (products)", skuSuggestion["SKU Code"] === "sku", JSON.stringify(skuSuggestion));
}

/* ---------------------------- §70/§347 catalog laws ------------------------- */
{
  const forbidden = ["businessId", "userId", "password", "passwordHash", "role", "platformRole", "subscription", "paymentStatus", "mfa", "session", "token", "secret"];
  let clean = true;
  for (const dataset of Object.keys(IMPORT_FIELDS) as Array<keyof typeof IMPORT_FIELDS>) {
    for (const field of IMPORT_FIELDS[dataset]) {
      if (forbidden.includes(field.name)) clean = false;
      if (["id", "createdAt", "updatedAt", "deletedAt"].includes(field.name)) clean = false;
    }
  }
  check("CATALOG: no forbidden/system fields importable (§71/§291-§296)", clean);
  check("CATALOG: template headers == field names (§119/§213)", templateHeaders("customers").join(",") === IMPORT_FIELDS.customers.map((f) => f.name).join(","));
  check("CATALOG: template example is synthetic (§212)", templateExampleRow("customers")[0] === "Example Customer");
}

/* ------------------------------ §262/§263 filenames ------------------------- */
{
  check("STORAGE KEY: server-generated shape", /^[a-z0-9]{20,40}\.json$/i.test(buildStorageKey("exports", "ckabcdefghijklmnopqrstuvwxyz", "json")));
  check("STORAGE KEY: traversal never survives", !buildStorageKey("exports", "../../evil", "json").includes("/"));
  check("SAFE KEY: rejects traversal/absolute/dotfiles (§237)", !isSafeArtifactKey("../../secret.db") && !isSafeArtifactKey("/abs/path.db") && !isSafeArtifactKey(".hidden") && isSafeArtifactKey("abc123.json"));
}

/* ------------------------------ §182 config parsing ------------------------- */
{
  const original = process.env.EXPORT_MAX_RECORDS;
  for (const [value, expectDefault] of [["-5", true], ["0", true], ["abc", true], ["Infinity", true], ["1.5", true], ["999999", false]] as Array<[string, boolean]>) {
    process.env.EXPORT_MAX_RECORDS = value;
    const n = exportMaxRecords();
    const ok = expectDefault ? n === 100_000 : n === 999999;
    check(`CONFIG[EXPORT_MAX_RECORDS=${value}] → ${expectDefault ? "default" : "accepted"}`, ok, String(n));
  }
  process.env.EXPORT_MAX_RECORDS = original;
  const originalErrors = process.env.IMPORT_MAX_ERRORS;
  process.env.IMPORT_MAX_ERRORS = "0";
  check("CONFIG[IMPORT_MAX_ERRORS=0] → default (invalid zero)", importMaxErrors() === 500, String(importMaxErrors()));
  process.env.IMPORT_MAX_ERRORS = originalErrors;
  check("CONFIG: storage root rejects public/ (§304)", validateStorageRoot(join(process.cwd(), "public", "exports")) === "WEB_SERVED");
  check("CONFIG: storage root rejects .next/", validateStorageRoot(join(process.cwd(), ".next", "cache")) === "WEB_SERVED");
  check("CONFIG: default root valid", validateStorageRoot("/app/var/data-portability") === null);
  check("CONFIG: probe storage health returns safe status (§305)", ["READY", "NOT_WRITABLE", "INVALID", "NOT_CONFIGURED"].includes(probeStorageHealth().status));
}

/* ------------------------------- §9 manifest -------------------------------- */
{
  const datasetsJson = JSON.stringify({ customers: [{ id: "a" }] });
  const payloadChecksum = createHash("sha256").update(datasetsJson).digest("hex");
  const manifest = buildManifest({
    business: { id: "b1", name: "Biz", timezone: "UTC", currency: "USD", decimalPrecision: 2 },
    format: "JSON",
    datasetCounts: [{ key: "customers", recordCount: 1 }],
    payloadChecksum,
  });
  check("MANIFEST: schema version explicit (§8)", manifest.exportSchemaVersion === 1);
  check("MANIFEST: required fields (§9)", !!manifest.createdAt && manifest.format === "JSON" && manifest.business.name === "Biz" && manifest.generationStatus === "COMPLETED");
  check("MANIFEST: integrity scope documented (§312)", manifest.integrity.scope === "datasets" && manifest.integrity.value === payloadChecksum);
  check("MANIFEST: no secrets in shape", !JSON.stringify(manifest).includes("password"));
  const reparsed = JSON.parse(datasetsJson);
  check("MANIFEST: payload checksum verifiable from file (§312)", createHash("sha256").update(JSON.stringify(reparsed)).digest("hex") === payloadChecksum);
}

/* ------------------------------- §5 export catalog --------------------------- */
{
  check("EXPORT CATALOG: sale_items implied by sales (§46)", (DATASET_IMPLICATIONS.sales ?? []).includes("sale_items"));
  check("EXPORT CATALOG: CSV columns defined for every dataset", EXPORT_DATASET_KEYS.every((k) => DATASET_CSV_COLUMNS[k].length > 0));
  check("EXPORT CATALOG: no AI/audit/platform datasets (§9/§51-§53)", !EXPORT_DATASET_KEYS.includes("audit" as never) && !EXPORT_DATASET_KEYS.includes("chat" as never));
}

/* --------------------------------- summary ---------------------------------- */
const failed = results.filter((r) => !r.ok);
console.log(`\nprompt31-unit: ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  FAIL: ${f.name} ${f.info ?? ""}`);
  process.exit(1);
}
process.exit(0);
