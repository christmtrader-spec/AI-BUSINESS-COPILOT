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

export type PagedPayload<T> = { items: T[]; total: number };

/**
 * Walk a paginated list endpoint end-to-end for exports. The server caps
 * pageSize at 100 (listParams), so a single oversized page request silently
 * truncates — exports MUST page through instead. Stops at maxRows (sane
 * client-side bound) and reports honestly whether the result is truncated.
 */
export async function fetchAllPages<T>(
  fetchPage: (page: number, pageSize: number) => Promise<PagedPayload<T>>,
  maxRows = 1000,
): Promise<{ rows: T[]; total: number; truncated: boolean }> {
  const pageSize = 100; // mirrors the server's listParams pageSize cap
  const first = await fetchPage(1, pageSize);
  const total = first.total;
  const rows: T[] = [...first.items];
  if (rows.length > 0 && rows.length < total) {
    const maxPages = Math.ceil(maxRows / pageSize);
    const wantedPages = Math.ceil(total / pageSize);
    for (let p = 2; p <= Math.min(wantedPages, maxPages); p++) {
      const res = await fetchPage(p, pageSize);
      rows.push(...res.items);
      if (res.items.length < pageSize) break;
    }
  }
  const truncated = rows.length < total;
  return { rows: rows.slice(0, maxRows), total, truncated };
}
