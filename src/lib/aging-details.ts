/**
 * Prompt 49 (§5–§9/§12/§14/§19) — DETAILED AGING domain: the open source
 * documents behind the aggregate receivables/payables aging.
 *
 * ONE CALCULATION AUTHORITY (§3.2): bucket assignment, age math, the
 * past-due law and the open-item guard are REUSED from src/lib/aging.ts
 * (localDayIndex / agingBucketForAge) — there is no second bucket
 * algorithm here, in any React component or CSV route.
 *
 * SOURCES (§2/§8):
 *   receivables = OPEN Sale invoices of the tenant   (never SalesOrders,
 *                 never SalesQuotations — separate tables, never counted)
 *   payables    = OPEN Expense payables of the tenant (SupplierBill is NOT
 *                 a second item; a posted bill's linked Expense is counted
 *                 exactly once — the bill reference may appear only as
 *                 supplemental document metadata, never as a balance)
 *
 * MONEY (§3.1): integer minor units everywhere — outstandingMinor is the
 * exact integer difference totalMinor − paidMinor validated for sanity;
 * no float, no rounding, no clamping.
 *
 * HONESTY (§3.4/§9):
 *   - receivables carry NO due date and are NEVER labelled overdue — the
 *     age is "invoice age", a distribution measure only;
 *   - payables past-due = stated dueDate AND today's business-local day
 *     strictly AFTER the due day AND positive balance (due today is not
 *     overdue; no dueDate is never overdue);
 *   - every scan is bounded; truncation is an explicit flag, never silent.
 *
 * NO HISTORICAL AS-OF (§15): this report is a snapshot of CURRENT open
 * source items as of the server-derived business-local date. There is no
 * client-supplied asOf and no invented point-in-time reconstruction.
 */
import { ApiError } from "@/lib/api-helpers";
import { db } from "@/lib/db";
import { formatInvoiceNumber } from "@/lib/finance";
import { isValidEntityId } from "@/lib/entity-routes";
import {
  AGING_BUCKET_KEYS,
  agingBucketForAge,
  localDayIndex,
  localDayKey,
  type AgingBucketKey,
} from "./aging";
import {
  decodeAgingDetailCursor,
  encodeAgingDetailCursor,
  AgingDetailValidationError,
  isAgingBucketKey,
  isAgingDetailSide,
  type AgingDetailSide,
} from "./aging-details-cursor";

// ---------------------------------------------------------------------------
// Bounds (§7/§19) — explicit, documented, never silently weakened.
// ---------------------------------------------------------------------------

/** Page size default / clamp bounds (statement-§35 convention). */
export const AGING_DETAIL_DEFAULT_LIMIT = 25;
export const AGING_DETAIL_MIN_LIMIT = 10;
export const AGING_DETAIL_MAX_LIMIT = 100;

/**
 * Env-tunable bound (the established cap-suite convention — P42/P47/P48:
 * each cap suite runs its own process with ITS OWN env var; production
 * defaults stay at the documented values). Clamped to a sane range so a
 * bogus env value can neither disable the bound nor throttle it to death.
 */
function envCap(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw || !/^\d+$/.test(raw.trim())) return fallback;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** Per-request bounded-read cap (§19): the maximum number of source rows one
 * API request may walk (page scan AND summary scan each). The aggregate
 * report's AGING_SCAN_CAP (1000/side) is untouched — this cap governs only
 * the detail endpoints and never weakens the aggregate `truncated` signal. */
export const AGING_DETAIL_SCAN_CAP = envCap("AGING_DETAIL_SCAN_CAP", 5000, 20, 200_000);

/** Chunk size of one keyset read — keeps memory O(chunk) not O(scope) (§19). */
export const AGING_DETAIL_CHUNK = 400;

/** Detailed-CSV completeness bound (§14): exports beyond this REJECT with a
 * stable controlled error — never a silently truncated file. */
export const AGING_DETAIL_EXPORT_MAX_ROWS = envCap("AGING_DETAIL_EXPORT_MAX_ROWS", 5000, 20, 200_000);

/**
 * §14 — the EXPORT scan budget. Bucket/past-due filtering skips non-matching
 * rows inside the keyset walk, so an export may need to scan MORE source rows
 * than it returns. The budget is deliberately larger than the page-scan cap
 * (≥ 4× the matching-row cap) yet still bounded; when it exhausts before the
 * scope is proven complete the export REJECTS — never a partial file.
 */
export const AGING_DETAIL_EXPORT_SCAN_CAP = Math.max(AGING_DETAIL_SCAN_CAP, AGING_DETAIL_EXPORT_MAX_ROWS * 4);

// ---------------------------------------------------------------------------
// Pure item contract (§5) — explicit DTO, never a raw Prisma row (§3.2/§32).
// ---------------------------------------------------------------------------

export type AgingDetailSourceType = "SALE" | "EXPENSE";

/** One open source document (customer invoice / supplier expense payable). */
export type AgingDetailItem = {
  sourceType: AgingDetailSourceType;
  sourceId: string;
  /** Invoice number (INV-0007) or expense reference ?? category fallback. */
  reference: string;
  partyId: string | null;
  partyName: string | null;
  /** Originating document day instant (issueDate | spentAt), ISO. */
  documentDate: string;
  /** Effective aging anchor instant (issueDate | dueDate ?? spentAt), ISO. */
  anchorDate: string;
  /** Stated due date (payables) — null for receivables (no invented terms). */
  dueDate: string | null;
  totalMinor: number;
  paidMinor: number;
  /** Exact integer totalMinor − paidMinor (> 0 by the open guard). */
  outstandingMinor: number;
  /** Whole business-local calendar days between anchor day and asOf day. */
  ageDays: number;
  bucket: AgingBucketKey;
  /** Payables only law (§9); always false for receivables. */
  pastDue: boolean;
  /** Supplemental posted-bill document reference (payables) — NEVER a balance. */
  supplierBillReference: string | null;
};

/** Four-bucket distribution of a scope (always exactly 4, engine order). */
export type AgingDetailBucketTotal = { key: AgingBucketKey; minor: number; count: number };

export type AgingDetailSummary = {
  asOf: string;
  timezone: string;
  /** Full scope (side + party + pastDue filter; bucket NOT applied) — the
   * reconcilable number (§12). */
  totalOutstandingMinor: number;
  openItemCount: number;
  /** Full-scope four-bucket distribution. */
  buckets: AgingDetailBucketTotal[];
  /** Payables only — stated-due-date strictly-past slice of the full scope. */
  pastDueMinor: number | null;
  pastDueCount: number | null;
  /** Totals WITH the bucket filter applied (== full totals when unfiltered). */
  filteredTotalOutstandingMinor: number;
  filteredOpenItemCount: number;
  /** Summary scan hit its bounded cap → totals cover the scanned subset. */
  truncated: boolean;
};

export type AgingDetailPage = {
  party: { id: string; name: string } | null;
  summary: AgingDetailSummary;
  items: AgingDetailItem[];
  nextCursor: string | null;
  /** Page scan hit its bounded cap mid-scope (§7.2) — page may be partial. */
  pageTruncated: boolean;
};

export type AgingDetailRequest = {
  side: AgingDetailSide;
  /** Server-derived tenant scope — never client-supplied (§7). */
  businessId: string;
  /** Tenant-validated party id or null (all parties). */
  partyId: string | null;
  bucket: AgingBucketKey | null;
  /** Payables-only past-due slice. */
  pastDue: boolean;
  timeZone: string;
  now: Date;
  limit: number;
  cursor: string | null;
};

// ---------------------------------------------------------------------------
// Query parsing (§7) — nothing else is accepted; errors are controlled 422s.
// ---------------------------------------------------------------------------

export function parseAgingDetailQuery(params: URLSearchParams): {
  side: AgingDetailSide;
  partyId: string | null;
  bucket: AgingBucketKey | null;
  pastDue: boolean;
  limit: number;
  cursor: string | null;
} {
  const rawSide = (params.get("side") ?? "").trim().toLowerCase();
  if (!isAgingDetailSide(rawSide)) {
    throw new AgingDetailValidationError("side", "'side' must be 'receivables' or 'payables'.");
  }

  const rawParty = (params.get("partyId") ?? "").trim();
  if (rawParty && !isValidEntityId(rawParty)) {
    throw new AgingDetailValidationError("partyId", "partyId is invalid.");
  }

  const rawBucket = (params.get("bucket") ?? "").trim();
  if (rawBucket && !isAgingBucketKey(rawBucket)) {
    throw new AgingDetailValidationError(
      "bucket",
      `'bucket' must be one of ${AGING_BUCKET_KEYS.join(", ")}.`,
    );
  }
  const bucket: AgingBucketKey | null = isAgingBucketKey(rawBucket) ? rawBucket : null;

  const rawPastDue = (params.get("pastDue") ?? "").trim();
  if (rawPastDue && rawPastDue !== "true" && rawPastDue !== "1") {
    throw new AgingDetailValidationError("pastDue", "pastDue must be 'true' or omitted.");
  }
  const pastDue = rawPastDue === "true" || rawPastDue === "1";
  // §9 — receivables have NO authoritative due date: a past-due filter is
  // meaningless there and is rejected instead of silently ignored.
  if (pastDue && rawSide === "receivables") {
    throw new AgingDetailValidationError(
      "pastDue",
      "pastDue filtering applies to payables only.",
    );
  }

  let limit = AGING_DETAIL_DEFAULT_LIMIT;
  const rawLimit = params.get("limit");
  if (rawLimit !== null && rawLimit !== "") {
    if (!/^\d+$/.test(rawLimit.trim())) {
      throw new AgingDetailValidationError("limit", "limit must be a positive integer.");
    }
    limit = Number(rawLimit.trim());
    if (limit < AGING_DETAIL_MIN_LIMIT || limit > AGING_DETAIL_MAX_LIMIT) {
      throw new AgingDetailValidationError(
        "limit",
        `limit must be between ${AGING_DETAIL_MIN_LIMIT} and ${AGING_DETAIL_MAX_LIMIT}.`,
      );
    }
  }

  const rawCursor = params.get("cursor");
  const cursor = rawCursor && rawCursor.trim() !== "" ? rawCursor.trim() : null;
  if (cursor && cursor.length > 1024) {
    throw new AgingDetailValidationError("cursor", "cursor is invalid.");
  }

  return { side: rawSide, partyId: rawParty || null, bucket, pastDue, limit, cursor };
}

// ---------------------------------------------------------------------------
// Pure per-row mapping (canonical engine reuse — the ONE bucket/past-due law).
// ---------------------------------------------------------------------------

/** Exact integer outstanding with the domain integrity guard (§8). */
export function outstandingOf(totalMinor: number, paidMinor: number): number {
  if (!Number.isInteger(totalMinor) || !Number.isInteger(paidMinor)) {
    throw new Error("Aging detail money invariant violated: non-integer minor units");
  }
  return totalMinor - paidMinor;
}

export type SaleSourceRow = {
  id: string;
  number: number;
  issueDate: Date;
  totalMinor: number;
  paidMinor: number;
  customer: { id: string; name: string } | null;
};

export type ExpenseSourceRow = {
  id: string;
  reference: string | null;
  category: string;
  spentAt: Date;
  dueDate: Date | null;
  amountMinor: number;
  paidMinor: number;
  supplier: { id: string; name: string } | null;
  supplierBill: { reference: string; status: string } | null;
};

/** Receivables item — anchor = Sale.issueDate; NEVER a due date (§9). */
export function saleDetailItem(row: SaleSourceRow, timeZone: string, now: Date): AgingDetailItem {
  const outstanding = outstandingOf(row.totalMinor, row.paidMinor);
  const ageDays = localDayIndex(now, timeZone) - localDayIndex(row.issueDate, timeZone);
  return {
    sourceType: "SALE",
    sourceId: row.id,
    // §8 — the CURRENT canonical invoice-number formatter (never an id, never
    // a re-implemented padding rule).
    reference: formatInvoiceNumber(row.number),
    partyId: row.customer?.id ?? null,
    partyName: row.customer?.name ?? null,
    documentDate: row.issueDate.toISOString(),
    anchorDate: row.issueDate.toISOString(),
    dueDate: null,
    totalMinor: row.totalMinor,
    paidMinor: row.paidMinor,
    outstandingMinor: outstanding,
    ageDays: Math.max(0, ageDays),
    bucket: agingBucketForAge(ageDays),
    pastDue: false,
    supplierBillReference: null,
  };
}

/** Payables item — anchor = dueDate ?? spentAt; past-due per the §9 law. */
export function expenseDetailItem(row: ExpenseSourceRow, timeZone: string, now: Date): AgingDetailItem {
  const outstanding = outstandingOf(row.amountMinor, row.paidMinor);
  const anchor = row.dueDate ?? row.spentAt;
  const ageDays = localDayIndex(now, timeZone) - localDayIndex(anchor, timeZone);
  let pastDue = false;
  if (row.dueDate) {
    pastDue = localDayIndex(now, timeZone) > localDayIndex(row.dueDate, timeZone);
  }
  return {
    sourceType: "EXPENSE",
    sourceId: row.id,
    // §12 of the statement engine — reference ?? category fallback, never an id.
    reference: row.reference ?? row.category,
    partyId: row.supplier?.id ?? null,
    partyName: row.supplier?.name ?? null,
    documentDate: row.spentAt.toISOString(),
    anchorDate: anchor.toISOString(),
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    totalMinor: row.amountMinor,
    paidMinor: row.paidMinor,
    outstandingMinor: outstanding,
    ageDays: Math.max(0, ageDays),
    bucket: agingBucketForAge(ageDays),
    pastDue,
    // Supplemental metadata only — a posted bill is the DOCUMENT behind the
    // Expense; it adds NO balance and NO movement anywhere (§8).
    supplierBillReference:
      row.supplierBill && row.supplierBill.status === "POSTED" ? row.supplierBill.reference : null,
  };
}

/** The open-item guard shared by every scan (closed/broken balances skip). */
function isOpen(item: AgingDetailItem): boolean {
  return item.outstandingMinor > 0;
}

// ---------------------------------------------------------------------------
// Scope SQL (tenant-scoped + soft-delete aware + party/bounded, §7/§20).
// ---------------------------------------------------------------------------

const SALE_SELECT = {
  id: true,
  number: true,
  issueDate: true,
  totalMinor: true,
  paidMinor: true,
  customer: { select: { id: true, name: true } },
} as const;

const EXPENSE_SELECT = {
  id: true,
  reference: true,
  category: true,
  spentAt: true,
  dueDate: true,
  amountMinor: true,
  paidMinor: true,
  supplier: { select: { id: true, name: true } },
  supplierBill: { select: { reference: true, status: true } },
} as const;

function saleScope(businessId: string, partyId: string | null) {
  return {
    businessId,
    deletedAt: null,
    status: { not: "PAID" },
    ...(partyId ? { customerId: partyId } : {}),
  };
}

function expenseScope(businessId: string, partyId: string | null) {
  return {
    businessId,
    deletedAt: null,
    status: { not: "PAID" },
    ...(partyId ? { supplierId: partyId } : {}),
  };
}

/** Keyset boundary: strictly after (date, id) — no skipped, no repeated rows. */
function afterClause(dateField: "issueDate" | "spentAt", after: { ts: Date; id: string } | null) {
  if (!after) return {};
  return {
    OR: [{ [dateField]: { gt: after.ts } }, { [dateField]: after.ts, id: { gt: after.id } }],
  };
}

async function readSaleChunk(
  businessId: string,
  partyId: string | null,
  after: { ts: Date; id: string } | null,
  take: number,
) {
  return db.sale.findMany({
    where: { ...saleScope(businessId, partyId), ...afterClause("issueDate", after) },
    orderBy: [{ issueDate: "asc" }, { id: "asc" }],
    take,
    select: SALE_SELECT,
  });
}

async function readExpenseChunk(
  businessId: string,
  partyId: string | null,
  after: { ts: Date; id: string } | null,
  take: number,
) {
  return db.expense.findMany({
    where: { ...expenseScope(businessId, partyId), ...afterClause("spentAt", after) },
    orderBy: [{ spentAt: "asc" }, { id: "asc" }],
    take,
    select: EXPENSE_SELECT,
  });
}

type ScanRow = { key: { ts: Date; id: string }; item: AgingDetailItem };

function mapSaleRows(rows: Awaited<ReturnType<typeof readSaleChunk>>, tz: string, now: Date): ScanRow[] {
  return rows.map((row) => ({
    key: { ts: row.issueDate, id: row.id },
    item: saleDetailItem(row, tz, now),
  }));
}

function mapExpenseRows(
  rows: Awaited<ReturnType<typeof readExpenseChunk>>,
  tz: string,
  now: Date,
): ScanRow[] {
  return rows.map((row) => ({
    key: { ts: row.spentAt, id: row.id },
    item: expenseDetailItem(row, tz, now),
  }));
}

// ---------------------------------------------------------------------------
// Party resolution (§7/§20) — 404 for foreign/deleted/unknown, never a leak.
// ---------------------------------------------------------------------------

export async function loadAgingParty(side: AgingDetailSide, businessId: string, partyId: string) {
  if (!isValidEntityId(partyId)) {
    throw new ApiError(404, "NOT_FOUND", side === "receivables" ? "Customer not found." : "Supplier not found.");
  }
  if (side === "receivables") {
    const customer = await db.customer.findFirst({
      where: { id: partyId, businessId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!customer) throw new ApiError(404, "NOT_FOUND", "Customer not found.");
    return customer;
  }
  const supplier = await db.supplier.findFirst({
    where: { id: partyId, businessId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!supplier) throw new ApiError(404, "NOT_FOUND", "Supplier not found.");
  return supplier;
}

// ---------------------------------------------------------------------------
// Summary scan (§7.3) — full filtered-scope aggregates from ONE bounded walk.
// ---------------------------------------------------------------------------

/** §7.3 — full filtered-scope summary from ONE bounded walk (also the CSV
 * audit-trail source; the JSON page builds it internally per request). */
export async function buildAgingDetailSummary(req: AgingDetailRequest): Promise<AgingDetailSummary> {
  const buckets = new Map<AgingBucketKey, { minor: number; count: number }>(
    AGING_BUCKET_KEYS.map((k) => [k, { minor: 0, count: 0 }]),
  );
  let totalMinor = 0;
  let openCount = 0;
  let filteredMinor = 0;
  let filteredCount = 0;
  let pastDueMinor = 0;
  let pastDueCount = 0;
  let scanned = 0;
  let truncated = false;

  let after: { ts: Date; id: string } | null = null;
  while (scanned < AGING_DETAIL_SCAN_CAP) {
    const take = Math.min(AGING_DETAIL_CHUNK, AGING_DETAIL_SCAN_CAP - scanned);
    const rows =
      req.side === "receivables"
        ? mapSaleRows(await readSaleChunk(req.businessId, req.partyId, after, take), req.timeZone, req.now)
        : mapExpenseRows(await readExpenseChunk(req.businessId, req.partyId, after, take), req.timeZone, req.now);
    if (rows.length === 0) break;
    for (const { key, item } of rows) {
      after = key;
      scanned += 1;
      if (!isOpen(item)) continue;
      const b = buckets.get(item.bucket)!;
      b.minor += item.outstandingMinor;
      b.count += 1;
      totalMinor += item.outstandingMinor;
      openCount += 1;
      if (item.pastDue) {
        pastDueMinor += item.outstandingMinor;
        pastDueCount += 1;
      }
      if (req.bucket === null || item.bucket === req.bucket) {
        filteredMinor += item.outstandingMinor;
        filteredCount += 1;
      }
    }
    if (rows.length < take) break;
  }
  if (scanned >= AGING_DETAIL_SCAN_CAP) truncated = true;

  const summary: AgingDetailSummary = {
    asOf: localDayKey(req.now, req.timeZone),
    timezone: req.timeZone,
    totalOutstandingMinor: totalMinor,
    openItemCount: openCount,
    buckets: AGING_BUCKET_KEYS.map((key) => ({ key, ...buckets.get(key)! })),
    pastDueMinor: req.side === "payables" ? pastDueMinor : null,
    pastDueCount: req.side === "payables" ? pastDueCount : null,
    filteredTotalOutstandingMinor: filteredMinor,
    filteredOpenItemCount: filteredCount,
    truncated,
  };
  return summary;
}

// ---------------------------------------------------------------------------
// Page scan (§7.1/§7.2) — deterministic keyset pagination with honest bounds.
// ---------------------------------------------------------------------------

export async function buildAgingDetailPage(req: AgingDetailRequest): Promise<AgingDetailPage> {
  // Cursor first (§7.1): authenticate + bind before ANY page query runs.
  const decoded = req.cursor
    ? decodeAgingDetailCursor(req.cursor, {
        businessId: req.businessId,
        side: req.side,
        partyId: req.partyId,
        bucket: req.bucket,
        pastDue: req.pastDue,
      })
    : null;
  const after: { ts: Date; id: string } | null = decoded ? { ts: new Date(decoded.ts), id: decoded.id } : null;

  const party = req.partyId ? await loadAgingParty(req.side, req.businessId, req.partyId) : null;

  const [summary] = await Promise.all([buildAgingDetailSummary(req)]);

  const items: AgingDetailItem[] = [];
  // §7.2 — the keyset walk advances a MUTABLE scan boundary seeded from the
  // (immutable) decoded cursor; it always tracks the last SCANNED row.
  let scanAfter: { ts: Date; id: string } | null = after;
  let scanned = 0;
  let pageTruncated = false;

  while (scanned < AGING_DETAIL_SCAN_CAP && items.length < req.limit) {
    const take = Math.min(AGING_DETAIL_CHUNK, AGING_DETAIL_SCAN_CAP - scanned);
    const rows =
      req.side === "receivables"
        ? mapSaleRows(await readSaleChunk(req.businessId, req.partyId, scanAfter, take), req.timeZone, req.now)
        : mapExpenseRows(await readExpenseChunk(req.businessId, req.partyId, scanAfter, take), req.timeZone, req.now);
    if (rows.length === 0) break;
    for (const { key, item } of rows) {
      // §7.2 — the cursor tracks the last SCANNED row, not the last displayed
      // one, so post-query filtering can never lose or repeat a row.
      scanAfter = key;
      scanned += 1;
      if (!isOpen(item)) continue;
      if (req.bucket !== null && item.bucket !== req.bucket) continue;
      if (req.pastDue && !item.pastDue) continue;
      items.push(item);
      if (items.length >= req.limit) break;
    }
    if (rows.length < take) break; // scope exhausted
  }
  const lastScanned = scanAfter;

  // §7.2 — scan cap reached mid-scope: an explicit partial-page indicator,
  // never a silent "complete" page.
  if (scanned >= AGING_DETAIL_SCAN_CAP && items.length < req.limit) {
    pageTruncated = true;
  }

  // hasNext probe: one bounded read past the last scanned row decides
  // whether a next cursor is warranted (no phantom "Next" on the last page).
  let hasNext = false;
  if (lastScanned && !pageTruncated) {
    const probe =
      req.side === "receivables"
        ? await readSaleChunk(req.businessId, req.partyId, lastScanned, 1)
        : await readExpenseChunk(req.businessId, req.partyId, lastScanned, 1);
    hasNext = probe.length > 0;
  }

  const nextCursor =
    lastScanned && (pageTruncated || hasNext)
      ? encodeAgingDetailCursor({
          v: "v1",
          b: req.businessId,
          s: req.side,
          p: req.partyId ?? "*",
          k: req.bucket ?? "*",
          d: req.pastDue ? "1" : "*",
          ts: lastScanned.ts.toISOString(),
          id: lastScanned.id,
        })
      : null;

  return { party, summary, items, nextCursor, pageTruncated };
}

// ---------------------------------------------------------------------------
// Complete export scan (§14) — full scope or a controlled rejection; NEVER a
// silently truncated CSV.
// ---------------------------------------------------------------------------

export class AgingExportTooLargeError extends Error {
  constructor(public cap: number) {
    super(`The detailed aging export exceeds the ${cap}-row safety cap.`);
    this.name = "AgingExportTooLargeError";
  }
}

export async function collectAgingDetailRows(req: AgingDetailRequest): Promise<AgingDetailItem[]> {
  const rows: AgingDetailItem[] = [];
  let after: { ts: Date; id: string } | null = null;
  let scanned = 0;

  while (scanned < AGING_DETAIL_EXPORT_SCAN_CAP) {
    const take = Math.min(AGING_DETAIL_CHUNK, AGING_DETAIL_EXPORT_SCAN_CAP - scanned);
    const chunk =
      req.side === "receivables"
        ? mapSaleRows(await readSaleChunk(req.businessId, req.partyId, after, take), req.timeZone, req.now)
        : mapExpenseRows(await readExpenseChunk(req.businessId, req.partyId, after, take), req.timeZone, req.now);
    if (chunk.length === 0) break;
    for (const { key, item } of chunk) {
      after = key;
      scanned += 1;
      if (!isOpen(item)) continue;
      if (req.bucket !== null && item.bucket !== req.bucket) continue;
      if (req.pastDue && !item.pastDue) continue;
      rows.push(item);
      // §14 — completeness bound checked on MATCHING rows (the declared scope).
      if (rows.length > AGING_DETAIL_EXPORT_MAX_ROWS) {
        throw new AgingExportTooLargeError(AGING_DETAIL_EXPORT_MAX_ROWS);
      }
    }
    if (chunk.length < take) break; // scope exhausted
  }

  // §14 — the export scan budget stopped the walk BEFORE the scope was
  // proven exhausted: completeness cannot be certified, so the export
  // REJECTS instead of returning a plausible-looking partial file. A one-row
  // probe past the last scanned key disambiguates "exactly at the budget"
  // (complete) from "more rows exist" (incomplete → reject).
  if (scanned >= AGING_DETAIL_EXPORT_SCAN_CAP) {
    const probe =
      req.side === "receivables"
        ? await readSaleChunk(req.businessId, req.partyId, after, 1)
        : await readExpenseChunk(req.businessId, req.partyId, after, 1);
    if (probe.length > 0) {
      throw new AgingExportTooLargeError(AGING_DETAIL_EXPORT_MAX_ROWS);
    }
  }

  return rows;
}

export { AgingDetailValidationError };

// ---------------------------------------------------------------------------
// R89/R93/R94/R95 — the PARTY ROLLUP (the board behind the detail rows).
//
// A streaming fold over the SAME filtered detail rows the list shows: the
// board ≡ rows reconciliation law (§ the folded sum equals the filtered
// total for an untruncated board). Pure functions, no day math — the rows
// arrive with their ageDays already computed by the shared aging engine.
// ---------------------------------------------------------------------------

/** Production default for the party board cap (the envCap convention). */
export const AGING_DETAIL_ROLLUP_MAX_GROUPS = 12;

/** One folded party group — the accumulator value shape. */
export type AgingRollupGroup = {
  partyId: string | null;
  partyName: string | null;
  count: number;
  outstandingMinor: number;
  /** MAX age across the party's folded rows (the "oldest item" honesty). */
  oldestDays: number;
};

/** Streaming accumulator: partyId-keyed ("" = the honest unassigned group). */
export type AgingRollupAccumulator = Map<string, AgingRollupGroup>;

/** The row shape the fold consumes (subset of the detail item). */
export type AgingRollupFoldItem = {
  partyId: string | null;
  partyName: string | null;
  outstandingMinor: number;
  ageDays: number;
};

/**
 * Fold ONE row into the accumulator — ONLY when the caller's filter matched
 * it (a filtered-out row never enters the board, test 1a). Unassigned
 * parties (null id) are their OWN honest group keyed "" — never merged
 * into a fabricated party (test 1c). Mutates the SAME map (streaming fold).
 */
export function rollupAccumulate(
  acc: AgingRollupAccumulator,
  item: AgingRollupFoldItem,
  matched: boolean,
): void {
  if (!matched) return;
  const key = item.partyId ?? "";
  const existing = acc.get(key);
  if (!existing) {
    acc.set(key, {
      partyId: item.partyId,
      partyName: item.partyName,
      count: 1,
      outstandingMinor: item.outstandingMinor,
      oldestDays: item.ageDays,
    });
    return;
  }
  existing.count += 1;
  existing.outstandingMinor += item.outstandingMinor;
  existing.oldestDays = Math.max(existing.oldestDays, item.ageDays);
}

/** The ranked board: groups + untrimmed count + honest truncation flag. */
export type AgingRollup = {
  groups: AgingRollupGroup[];
  /** EVERY distinct party in scope — the untrimmed count (test 2b/2f). */
  groupCount: number;
  groupsTruncated: boolean;
};

/**
 * Rank the folded board: outstanding DESC; ties break name-then-id
 * (deterministic across pages/refreshes, test 2d); the unassigned group
 * ranks by its own outstanding like any other (it lands last only when it
 * IS the smallest — honesty, not a special case). The cap keeps the TOP of
 * the ranking; groupCount stays untrimmed; the flag is honest (2e-2h).
 */
export function rollupRank(
  acc: AgingRollupAccumulator,
  maxGroups: number = AGING_DETAIL_ROLLUP_MAX_GROUPS,
): AgingRollup {
  const all = Array.from(acc.values());
  if (all.length === 0) {
    return { groups: [], groupCount: 0, groupsTruncated: false };
  }
  const ranked = all.sort((a, b) => {
    if (b.outstandingMinor !== a.outstandingMinor) {
      return b.outstandingMinor - a.outstandingMinor;
    }
    const an = a.partyName ?? "";
    const bn = b.partyName ?? "";
    if (an !== bn) return an < bn ? -1 : 1;
    const aid = a.partyId ?? "";
    const bid = b.partyId ?? "";
    if (aid !== bid) return aid < bid ? -1 : 1;
    return 0;
  });
  const cap = Math.max(1, Math.floor(maxGroups));
  return {
    groups: ranked.slice(0, cap),
    groupCount: all.length,
    groupsTruncated: all.length > cap,
  };
}
