/**
 * Prompt 55 (§X1) — the shared REAL Excel (.xlsx) export kit.
 *
 * Companion to src/lib/csv.ts: the CSV path remains the LOSSLESS archival
 * format (decimal strings via formatMinorToDecimal — never floats); the
 * XLSX path is the WORKING spreadsheet: typed NUMBER cells Excel can sum,
 * a styled frozen header row, auto-fitted column widths, and an RTL sheet
 * view for the Persian UI locale.
 *
 * LAWS:
 *  - exceljs is loaded LAZILY (dynamic import) so the ~1MB bundle never
 *    touches the initial page load — only actual Excel exports pay for it.
 *  - Numeric cells are IEEE-754 doubles (Excel-native). That is the
 *    industry-standard trade-off; values originate from integer minor
 *    units and are only divided for display, exactly like the on-screen
 *    formatters. Any figure that must survive bit-exact archival goes
 *    through the CSV export.
 *  - String cells are written as STRING-typed cells — Excel never
 *    reinterprets them as formulas on open (the CSV formula-injection
 *    guard exists because CSV cells are untyped; XLSX is typed by
 *    construction).
 *  - Sheet names are sanitized (Excel law: no [ ] / \\ ? * : and ≤ 31
 *    chars) — a long filename can never break the workbook.
 */

export type XlsxExportColumn<T> = {
  header: string;
  value: (row: T) => string | number | null | undefined;
};

const MAX_COL_WIDTH = 42;
const MIN_COL_WIDTH = 8;
const MAX_SHEET_NAME = 31;

/** Excel worksheet-name law: these characters are forbidden. */
function sanitizeSheetName(raw: string): string {
  const cleaned = raw.replace(/[[\]/\\?*:]/g, "-").trim();
  return (cleaned === "" ? "Export" : cleaned).slice(0, MAX_SHEET_NAME);
}

/** Number format: integers stay compact, decimals get 2 places. */
function numFmtFor(value: number): string {
  return Number.isInteger(value) ? "#,##0" : "#,##0.00";
}

export type XlsxSheetSpec<T> = {
  sheetName: string;
  columns: XlsxExportColumn<T>[];
  rows: T[];
  /** Mirror the Persian UI: sheet reads right-to-left. */
  rightToLeft?: boolean;
};

/** Build the .xlsx binary for the given sheets (lazy-loads exceljs). */
export async function buildXlsxBuffer<T>(
  sheetsOrSpec: XlsxSheetSpec<T> | Array<XlsxSheetSpec<T>>,
): Promise<ArrayBuffer> {
  const sheets = Array.isArray(sheetsOrSpec) ? sheetsOrSpec : [sheetsOrSpec];
  if (sheets.length === 0) throw new Error("buildXlsxBuffer requires at least one sheet");
  const mod = (await import("exceljs")) as unknown as {
    default?: { Workbook: new () => ExcelWorkbook };
    Workbook?: new () => ExcelWorkbook;
  };
  const WorkbookCtor = mod.default?.Workbook ?? mod.Workbook;
  if (!WorkbookCtor) throw new Error("exceljs failed to load");
  const wb = new WorkbookCtor();
  wb.creator = "AI Business Copilot";
  wb.created = new Date();

  for (const spec of sheets) {
    const ws = wb.addWorksheet(sanitizeSheetName(spec.sheetName), {
      views: [
        spec.rightToLeft
          ? { state: "frozen", ySplit: 1, rightToLeft: true }
          : { state: "frozen", ySplit: 1 },
      ],
    });

    const widths: number[] = spec.columns.map((c) => c.header.length);

    // Header row — bold on a neutral fill with a bottom rule; frozen above.
    const headerRow = ws.addRow(spec.columns.map((c) => c.header));
    headerRow.font = { bold: true };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F3F7" } };
    headerRow.border = { bottom: { style: "thin", color: { argb: "FFD4D8E0" } } };
    headerRow.alignment = { vertical: "middle" };

    for (const row of spec.rows) {
      // Plain values only in addRow — the {value,numFmt} object shape is
      // NOT a supported cell value; number formats are applied to the
      // placed cells right after the row lands.
      const cells: Array<string | number> = [];
      const numeric: Array<{ col: number; fmt: string } | null> = [];
      spec.columns.forEach((col, i) => {
        const v = col.value(row);
        if (typeof v === "number" && Number.isFinite(v)) {
          widths[i] = Math.max(widths[i], String(v).length);
          cells.push(v);
          numeric.push({ col: i + 1, fmt: numFmtFor(v) });
        } else {
          const s = v == null ? "" : String(v);
          widths[i] = Math.max(widths[i], s.length);
          cells.push(s);
          numeric.push(null);
        }
      });
      const placed = ws.addRow(cells);
      for (const n of numeric) {
        if (n) placed.getCell(n.col).numFmt = n.fmt;
      }
    }

    ws.columns.forEach((col, i) => {
      col.width = Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, (widths[i] ?? MIN_COL_WIDTH) + 2));
    });
  }

  const buffer = await wb.xlsx.writeBuffer();
  return buffer as ArrayBuffer;
}

/** Trigger a client-side download of a generated .xlsx workbook. */
export async function downloadXlsx<T>(opts: {
  /** Full filename WITHOUT extension — ".xlsx" is appended here. */
  filename: string;
  sheetName: string;
  columns: XlsxExportColumn<T>[];
  rows: T[];
  rightToLeft?: boolean;
}): Promise<void> {
  const buffer = await buildXlsxBuffer<T>({
    sheetName: opts.sheetName,
    columns: opts.columns,
    rows: opts.rows,
    rightToLeft: opts.rightToLeft,
  });
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${opts.filename}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* Minimal structural typing so the kit compiles without importing
   exceljs types into every consumer (keeps the lazy boundary clean). */
interface ExcelWorksheet {
  addRow: (
    values: Array<string | number | { value: number; numFmt: string }>,
  ) => ExcelRow;
  columns: Array<{ width?: number }>;
}
interface ExcelRow {
  font: object;
  fill: object;
  border: object;
  alignment: object;
  getCell: (col: number) => { numFmt?: string };
}
interface ExcelWorkbook {
  creator: string;
  created: Date;
  addWorksheet: (
    name: string,
    opts?: { views?: Array<{ state?: string; ySplit?: number; rightToLeft?: boolean }> },
  ) => ExcelWorksheet;
  xlsx: { writeBuffer: () => Promise<ArrayBuffer> };
}
