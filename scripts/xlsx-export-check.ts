/**
 * Prompt 55 §X1 — unit checks for the shared Excel (.xlsx) export kit
 * (src/lib/xlsx-export.ts). Builds REAL workbooks with exceljs and reads
 * them BACK with exceljs to assert the actual file structure:
 *   - sheet-name sanitization (forbidden chars, 31-char cap)
 *   - header row + frozen top row
 *   - numeric cells typed as numbers with #,##0[.00] formats
 *   - string cells stay STRING-typed (a "=cmd()" value is never a formula)
 *   - RTL sheet view for fa, LTR default for en
 *   - null → empty string; long text → bounded column widths
 *   - multiple sheets in one workbook
 *   - money display round-trip: integer minors divided for display keep
 *     2-decimal format (the CSV path remains the lossless archival export)
 *
 * Run: bun scripts/xlsx-export-check.ts
 * Exit: 0 = all green, 1 = at least one failure.
 */
import { buildXlsxBuffer } from "../src/lib/xlsx-export";

type Check = { name: string; ok: boolean; info?: string };
const results: Check[] = [];
function record(name: string, ok: boolean, info?: string) {
  results.push({ name, ok, info });
  console.log(`${ok ? "✓" : "✗"} ${name}${info ? ` — ${info}` : ""}`);
}

const ExcelJS = (await import("exceljs")).default ?? (await import("exceljs"));
const WorkbookCtor = (ExcelJS as any).Workbook;

async function load(buffer: ArrayBuffer) {
  const wb = new WorkbookCtor();
  await wb.xlsx.load(Buffer.from(buffer));
  return wb as any;
}

type Row = { name: string; qty: number; price: number; note: string | null };

const ROWS: Row[] = [
  { name: "Coffee beans", qty: 12, price: 17100 / 100, note: "=cmd()|/etc/passwd" },
  { name: "قند و شکر", qty: 5, price: 17100 / 2 / 100, note: null },
  { name: "Tea", qty: 0, price: 0.5, note: "Lead text -not-a-number" },
];

const COLUMNS = [
  { header: "Product", value: (r: Row) => r.name },
  { header: "Qty", value: (r: Row) => r.qty },
  { header: "Price", value: (r: Row) => r.price },
  { header: "Note", value: (r: Row) => r.note },
];

// 1-4: en workbook — structure + cell typing
{
  const buf = await buildXlsxBuffer<Row>({ sheetName: "Sales List", columns: COLUMNS, rows: ROWS });
  const wb = await load(buf);
  const ws = wb.getWorksheet("Sales List");
  record("en: sheet created with clean name", Boolean(ws));
  record(
    "en: header row matches columns",
    JSON.stringify(ws.getRow(1).values.slice(1)) === JSON.stringify(COLUMNS.map((c) => c.header)),
    JSON.stringify(ws.getRow(1).values.slice(1)),
  );
  const priceCell = ws.getCell("C2");
  record(
    "en: number cell typed numeric with #,##0 (171)",
    priceCell.type === 2 && priceCell.value === 171 && priceCell.numFmt === "#,##0",
    `type=${priceCell.type} value=${priceCell.value} numFmt=${priceCell.numFmt}`,
  );
  const decCell = ws.getCell("C3");
  record(
    "en: decimal money cell numFmt #,##0.00 (85.50)",
    decCell.value === 85.5 && decCell.numFmt === "#,##0.00",
    `value=${decCell.value} numFmt=${decCell.numFmt}`,
  );
  const formulaCell = ws.getCell("D2");
  record(
    "en: '=cmd()' stays a STRING cell — never a formula",
    formulaCell.value === "=cmd()|/etc/passwd" && !formulaCell.formula,
    `value=${formulaCell.value} formula=${String(formulaCell.formula)}`,
  );
  const nullCell = ws.getCell("D3");
  record("en: null → empty string cell", nullCell.value === "" || nullCell.value == null, `value=${JSON.stringify(nullCell.value)}`);
  record(
    "en: frozen header pane ySplit=1",
    ws.views?.[0]?.state === "frozen" && ws.views?.[0]?.ySplit === 1,
    JSON.stringify(ws.views?.[0]),
  );
  record(
    "en: LTR by default (no rightToLeft)",
    ws.views?.[0]?.rightToLeft !== true,
    String(ws.views?.[0]?.rightToLeft),
  );
  const widths = ws.columns.map((c: any) => c.width ?? 0);
  record(
    "en: column widths bounded [8,42]",
    widths.length === 4 && widths.every((w: number) => w >= 8 && w <= 42),
    JSON.stringify(widths),
  );
}

// 5-6: fa workbook — RTL view + Persian text round-trip
{
  const buf = await buildXlsxBuffer<Row>({
    sheetName: "فروش",
    columns: COLUMNS,
    rows: ROWS,
    rightToLeft: true,
  });
  const wb = await load(buf);
  const ws = wb.getWorksheet("فروش");
  record(
    "fa: RTL sheet view enabled",
    ws.views?.[0]?.rightToLeft === true,
    JSON.stringify(ws.views?.[0]),
  );
  record("fa: Persian text round-trips", ws.getCell("A3").value === "قند و شکر", String(ws.getCell("A3").value));
}

// 7: sheet-name sanitization law
{
  const buf = await buildXlsxBuffer<Row>({
    sheetName: "Report: Q1/2026? [final*]",
    columns: COLUMNS,
    rows: ROWS,
  });
  const wb = await load(buf);
  const names = wb.worksheets.map((w: any) => w.name);
  const name = names[0] ?? "";
  const forbidden = /[[\]/\\?*:]/.test(name);
  record(
    "sheet name: forbidden chars replaced, ≤31 chars",
    !forbidden && name.length <= 31 && !names.includes("Sheet1"),
    JSON.stringify(names),
  );
}

// 8: multiple sheets
{
  const buf = await buildXlsxBuffer<Row>([
    { sheetName: "Sales", columns: COLUMNS, rows: ROWS },
    { sheetName: "Empty", columns: COLUMNS, rows: [] },
  ]);
  const wb = await load(buf);
  const ws2 = wb.getWorksheet("Empty");
  record(
    "multi-sheet: second sheet exists with headers only",
    Boolean(ws2) && ws2.rowCount === 1,
    `rowCount=${ws2?.rowCount}`,
  );
}

// 9: empty rows still produce a styled header workbook
{
  const buf = await buildXlsxBuffer<Row>({ sheetName: "Sales", columns: COLUMNS, rows: [] });
  const wb = await load(buf);
  const ws = wb.getWorksheet("Sales");
  record("empty rows: header row present", ws.getRow(1).cellCount === 4, `cells=${ws.getRow(1).cellCount}`);
}

// 10: guard — zero sheets rejected
{
  try {
    await buildXlsxBuffer<Row>([]);
    record("zero sheets rejected", false, "no throw");
  } catch {
    record("zero sheets rejected", true);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.error("FAILED:", failed.map((f) => f.name).join(", "));
  process.exit(1);
}
