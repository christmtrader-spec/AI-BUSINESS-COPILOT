/**
 * Minimal CSV export helpers (client-side). Values are escaped per
 * RFC 4180; a BOM is prepended so Excel renders Persian text correctly.
 */

function escapeCell(value: string | number | null | undefined): string {
  const s = value == null ? "" : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
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
