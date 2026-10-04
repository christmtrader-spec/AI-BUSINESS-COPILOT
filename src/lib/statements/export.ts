/**
 * Prompt 39 — statement CSV export (§76–§83/§121/§132/§183–§185).
 *
 * LAWS:
 *   §132/§133 — the CSV is generated from the SAME buildStatement() engine
 *   as the API/UI (one source of calculation, never a second one). The
 *   export walks the whole range chunk-by-chunk through the engine cursor.
 *   §82 — bounded memory: events are fetched and mapped CHUNK-BY-CHUNK
 *   (STATEMENT_EXPORT_CHUNK rows per engine call); only the CSV lines
 *   accumulate (same in-memory-string convention as the existing report
 *   export). NO silent truncation — every event in the range is exported.
 *   §79/§80 — columns date/reference/description/increase/decrease/balance;
 *   money is an EXACT decimal string at the business precision (integer
 *   minor units underneath — never a currency symbol, never a float).
 *   §81 — UTF-8 with BOM so Persian text survives Excel opening.
 *   §121 — no internal database ids, no user/actor ids, no platform or
 *   security metadata — business-facing references only.
 *   §176 — cells pass through the shared csvCell() OWASP formula guard.
 *   §143 — filename is safe: "<type>-statement-<from>-<to>.csv" (never the
 *   party name).
 */
import { csvCell } from "@/lib/csv";
import { messagesFor } from "@/i18n/messages";
import { buildStatement, type StatementRequest } from "./engine";
import { statementCsvRowCells } from "./formatting";

export const STATEMENT_EXPORT_CHUNK = 500;

export type StatementCsvResult = {
  csv: string;
  filename: string;
  eventCount: number;
  closingBalanceMinor: number;
};

export async function buildStatementCsv(
  req: Omit<StatementRequest, "limit" | "cursor">,
  decimalPrecision: number,
): Promise<StatementCsvResult> {
  const messages = messagesFor(req.locale).statements;
  const headers = [
    messages.csvDate,
    messages.csvReference,
    messages.csvDescription,
    messages.csvIncrease,
    messages.csvDecrease,
    messages.csvBalance,
  ];

  const lines: string[] = [headers.map(csvCell).join(",")];

  let cursor: string | null = null;
  let eventCount = 0;
  let closingBalanceMinor = 0;
  let guardChunks = 0;

  // Walk the FULL range through the shared engine (§132/§184/§185) — the
  // chunk loop is bounded per iteration and terminates when the engine
  // returns nextCursor = null.
  for (;;) {
    guardChunks += 1;
    if (guardChunks > 100_000) {
      // Practically unreachable (100k × 500 = 50M events); a deterministic
      // stop instead of an infinite loop. NEVER silent: the throw surfaces.
      throw new Error("Statement export exceeded the chunk guard — refusing to loop forever.");
    }
    const page = await buildStatement({ ...req, limit: STATEMENT_EXPORT_CHUNK, cursor });
    for (const row of page.rows) {
      const cells = statementCsvRowCells(
        {
          ...row,
          occurredAt: new Date(row.occurredAt),
        },
        decimalPrecision,
        req.timeZone,
      );
      lines.push(
        [
          cells.date,
          cells.reference,
          cells.description,
          cells.increase,
          cells.decrease,
          cells.balance,
        ]
          .map(csvCell)
          .join(","),
      );
    }
    eventCount += page.rows.length;
    closingBalanceMinor = page.summary.closingBalanceMinor;
    cursor = page.nextCursor;
    if (!cursor) break;
  }

  // §81 — BOM + CRLF (same convention as the existing report export).
  const csv = `\uFEFF${lines.join("\r\n")}\r\n`;
  // §143 — safe filename: type + calendar range only (never the party name).
  const filename = `${req.kind === "CUSTOMER" ? "customer" : "supplier"}-statement-${req.from}_${req.to}.csv`;

  return { csv, filename, eventCount, closingBalanceMinor };
}
