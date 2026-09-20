/**
 * Minimal CSV export helpers (client-safe, server-safe). Values are escaped
 * per RFC 4180; a BOM is prepended so Excel renders Persian text correctly.
 */

/** Plain numeric cells (incl. negatives) are allowed through as-is. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * CSV formula-injection guard (OWASP): cells that spreadsheet apps execute
 * as formulas (=, +, @, tab, CR, and non-numeric "-" leads) get a leading
 * apostrophe so they render as text. Negative NUMBERS stay untouched so
 * accounting exports remain numeric.
 */
export function csvCell(value: string | number | null | undefined): string {
  const s = value == null ? "" : String(value);
  let guarded = s;
  if (s !== "") {
    const first = s[0];
    if (first === "=" || first === "+" || first === "@" || first === "\t" || first === "\r") {
      guarded = `'${s}`;
    } else if (first === "-" && !PLAIN_NUMBER.test(s)) {
      guarded = `'${s}`;
    }
  }
  if (/[",\n\r]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

function escapeCell(value: string | number | null | undefined): string {
  return csvCell(value);
}

export function toCsv(headers: string[], rows: Array<Array<string | number | null | undefined>>): string {
  const lines = [headers, ...rows].map((row) => row.map(escapeCell).join(","));
  return "\uFEFF" + lines.join("\r\n");
}

/** Trigger a client-side download of a CSV file. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** RFC 4180-ish timestamp for export filenames. */
export function exportStamp(): string {
  return new Date().toISOString().slice(0, 10);
}
