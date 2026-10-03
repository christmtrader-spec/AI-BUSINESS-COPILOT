import "server-only";

/**
 * Prompt 38 — INVENTORY LOW-STOCK PROCESSOR (§38-a, FINALIZED by 38-F).
 *
 * The scheduled brain of low-stock in-app alerts, completing the MVP
 * notification scope (docs/ARCHITECTURE.md §5.1: "overdue, low stock" —
 * P37 delivered overdue; this delivers low stock). It is called by an
 * EXTERNAL, operator-managed scheduler (cron/systemd/Windows Task
 * Scheduler) through scripts/process-inventory-low-stock.mjs, or by tests
 * with an INJECTED clock. It is NEVER wired into the Next.js request
 * lifecycle — no in-process timers, no polling, no public HTTP endpoint.
 *
 * 38-F HARDENING LAWS:
 *  - REAL BOUNDED SCANNING (§7–§11, §161–§164): product rows are read in
 *    cursor-paginated pages of `lowStockScanPageSize()` (default 250,
 *    clamped 50–500). EVERY query carries a real `take:`; there is NO
 *    unbounded findMany and NO load-then-slice. Only the current page plus
 *    small derived state (counts + per-business recipient cache) is held in
 *    memory. The cursor is SERVER-DERIVED (the last row id of the previous
 *    page) — the CLI can never supply one (§163).
 *  - DETERMINISTIC ORDER (§10): stockQty ASC → name ASC → id ASC (worst
 *    shortages first; id is the unique tiebreaker that makes cursor
 *    pagination stable). Never random.
 *  - EXHAUSTIVE SCAN (§11): pages continue until rows run out OR the
 *    notification budget is exhausted — the first page is never assumed to
 *    be all candidates.
 *  - CREATION BUDGET, NOT A SCAN CAP (§12–§18): max caps NEW notifications
 *    CREATED per run (default 100, hard 10–500). Duplicates do NOT consume
 *    the budget (no row was created — §14); failed attempts do not consume
 *    it either. `created` can never exceed `max` (§167).
 *  - TRUNCATED SEMANTICS (§19): truncated=true iff the run stopped because
 *    the budget was hit while additional eligible work MAY remain (later
 *    recipients, later candidates on the page, or more pages). Pure
 *    lookahead helper: hasRemainingLowStockWork.
 *  - DRY-RUN (§20–§21, §168): NO writes of any kind (no Notification,
 *    Delivery, Product or Audit rows). It honors max as the would-create
 *    budget (duplicates don't consume it) so dry-run numbers are
 *    representative of APPLY. In DRY_RUN the reported `created` means
 *    wouldCreate (documented in the CLI output contract).
 *  - IDEMPOTENT: notification identity (userId, type, sourceEventId) with
 *    sourceEventId = inventory-low-stock:<productId>:<stockQty>:
 *    <recipientUserId> — NO run timestamp, composed through the SHARED
 *    lowStockSourceEventId helper in BOTH paths (no drift, §35/§36).
 *  - RECIPIENT LAW (§17, §26, §29): active OWNER + ADMIN members of the
 *    product's business, resolved server-side in deterministic userId ASC
 *    order, re-verified against the CURRENT membership rows immediately
 *    before each notify — a membership revoked between scan and notify
 *    never receives an alert, and a mid-run STAFF→ADMIN promotion becomes
 *    eligible on a LATER run (never fabricated mid-run).
 *  - DEFENSIVE FRESH RE-CHECK (§24/§25, P37-F analog): the product row is
 *    re-read FRESH immediately before notify (id + business + deletedAt +
 *    isActive + stockQty + lowStockAt + name + sku + unit). The scanned row
 *    alone is NOT trusted; the notification identity always embeds the
 *    FRESH qty. businessId always comes from the FRESH product state (§28).
 *  - NOTIFICATION-ONLY (§22/§23): product rows are never mutated. Proven
 *    dynamically by the E2E full-row before/after snapshot.
 *  - ISOLATED (§49) vs SYSTEMIC (§50): one bad candidate increments
 *    `failed` and the run continues; a systemic DB failure (connection /
 *    pool / access class Prisma codes) PROPAGATES to the caller (CLI exit
 *    1) instead of being misreported as per-candidate failures.
 *  - PRIVATE (§51/§52): no product names, SKUs, prices, quantities, emails
 *    or notification bodies ever enter the result, logs, or the debug
 *    channel — the debug key vocabulary is the exported
 *    INVENTORY_LOW_STOCK_DEBUG_KEYS constant.
 */

import { db } from "@/lib/db";
import { logInfo, logError } from "@/lib/observability/logger";
import { OPERATIONAL_EVENTS } from "@/lib/observability/events";
import {
  hasRemainingLowStockWork,
  INVENTORY_LOW_STOCK_DEBUG_KEYS,
  isLowStockNow,
  lowStockMaxPerRun,
  lowStockScanPageSize,
  lowStockSourceEventId,
  LOW_STOCK_RECIPIENT_ROLES,
} from "./low-stock-types";

/* --------------------------------- types ---------------------------------- */

export type LowStockProcessorOptions = {
  /** Injectable clock — tests inject; production defaults to now(). */
  now?: Date;
  /** Optional single-business scope (validated, exact, injection-safe). */
  businessId?: string;
  /** DRY_RUN (default) never writes; APPLY creates notifications. */
  dryRun?: boolean;
  /** Optional explicit NEW-NOTIFICATION cap override (bounded 10–500). */
  max?: number;
};

/** 38-F §19 result DTO — `created` is wouldCreate in DRY_RUN (§168). */
export type LowStockProcessorResult = {
  mode: "DRY_RUN" | "APPLY";
  scanned: number;
  candidates: number;
  created: number;
  duplicates: number;
  skipped: number;
  failed: number;
  max: number;
  truncated: boolean;
};

/** Minimal scanned row — only fields needed for classification. */
type ScannedRow = {
  id: string;
  businessId: string;
  stockQty: number;
  lowStockAt: number;
};

/** Fresh state re-read immediately before notify (§24). */
type FreshProductState = {
  id: string;
  businessId: string;
  name: string;
  sku: string | null;
  unit: string | null;
  stockQty: number;
  lowStockAt: number;
  deletedAt: Date | null;
  isActive: boolean;
};

/* --------------------------- systemic error class -------------------------- */

/**
 * Prisma request codes that mean the DATABASE ITSELF is unhealthy (§50).
 * These are never attributable to one bad candidate: they must propagate so
 * the operator's CLI exits 1 instead of reporting a "completed" run whose
 * failures were really an outage. Per-row data errors (P2xxx data/class
 * codes, e.g. a vanished cursor row) stay contained as failed/skip.
 */
const SYSTEMIC_PRISMA_CODES: ReadonlySet<string> = new Set([
  "P1001", // can't reach the database server
  "P1002", // database server timed out
  "P1003", // database file does not exist
  "P1010", // access denied
  "P1017", // server closed the connection
  "P2024", // connection pool timeout
]);

function isSystemicDbError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && SYSTEMIC_PRISMA_CODES.has(code);
}

/* ------------------------------- processor -------------------------------- */

export async function processInventoryLowStock(
  options: LowStockProcessorOptions = {},
): Promise<LowStockProcessorResult> {
  const mode: "DRY_RUN" | "APPLY" = options.dryRun === false ? "APPLY" : "DRY_RUN";
  const max = lowStockMaxPerRun(options.max);
  const pageSize = lowStockScanPageSize();

  const businessScope = options.businessId?.trim() || null;
  if (businessScope && !/^[a-zA-Z0-9_-]{6,64}$/.test(businessScope)) {
    throw new Error("inventory-low-stock: invalid businessId scope");
  }

  const result: LowStockProcessorResult = {
    mode,
    scanned: 0,
    candidates: 0,
    created: 0,
    duplicates: 0,
    skipped: 0,
    failed: 0,
    max,
    truncated: false,
  };

  // Recipients are resolved ONCE per distinct business (lazily, cached,
  // deterministic userId ASC), then re-verified per notify against the
  // CURRENT membership rows (§17/§26).
  const recipientsByBusiness = new Map<string, string[]>();

  const resolveRecipients = async (businessId: string): Promise<string[]> => {
    const cached = recipientsByBusiness.get(businessId);
    if (cached) return cached;
    const members = await db.businessMember.findMany({
      where: { businessId, role: { in: [...LOW_STOCK_RECIPIENT_ROLES] } },
      select: { userId: true },
      orderBy: { userId: "asc" },
    });
    const list = members.map((m) => m.userId).sort();
    recipientsByBusiness.set(businessId, list);
    return list;
  };

  // The dynamic import is cached after the first candidate; resolved once.
  let notifyInventoryLowStock:
    | ((input: {
        businessId: string;
        productId: string;
        recipientUserId: string;
        productName: string;
        sku: string | null;
        unit: string | null;
        stockQty: number;
        lowStockAt: number;
      }) => Promise<{ created: boolean; duplicate: boolean; notificationId: string | null } | null>)
    | null = null;

  /* --------------------------- bounded page scan --------------------------- */

  let hasMoreProducts = true;
  let cursor: string | null = null;

  scan: while (hasMoreProducts) {
    // REAL bounded page query (§7/§78): `take: pageSize` is the hard cap on
    // rows read PER QUERY. Cursor pagination on the deterministic total
    // order (stockQty, name, id) — id is unique, so the (server-derived)
    // cursor row fully identifies the scan position. skip:1 moves past the
    // cursor row itself. No unbounded findMany exists anywhere.
    let rows: ScannedRow[];
    try {
      rows = (await db.product.findMany({
        where: {
          ...(businessScope ? { businessId: businessScope } : {}),
          deletedAt: null,
          isActive: true,
        },
        orderBy: [{ stockQty: "asc" }, { name: "asc" }, { id: "asc" }],
        select: { id: true, businessId: true, stockQty: true, lowStockAt: true },
        take: pageSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })) as ScannedRow[];
    } catch (error) {
      // Cursor row deleted mid-run → the page position no longer resolves.
      // Deterministic termination (§162): stop scanning; the next run
      // re-scans idempotently. Any systemic failure propagates (§50).
      if (
        error instanceof Error &&
        (error as { code?: unknown }).code === "P2025"
      ) {
        break scan;
      }
      throw error;
    }

    if (rows.length === 0) break;
    result.scanned += rows.length;
    hasMoreProducts = rows.length === pageSize;
    cursor = rows[rows.length - 1].id;

    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      if (!isLowStockNow(row.stockQty, row.lowStockAt)) continue;
      result.candidates += 1;

      try {
        const recipients = await resolveRecipients(row.businessId);
        if (recipients.length === 0) {
          // No OWNER/ADMIN exists — never fabricate a recipient (§42).
          result.skipped += 1;
          continue;
        }

        // §24 — FRESH minimal product state, re-read NOW. The scanned row
        // is not trusted: stock/state may have changed since the page was
        // read (sale, adjustment, restock, delete, deactivate).
        const fresh = (await db.product.findFirst({
          where: { id: row.id, businessId: row.businessId, deletedAt: null },
          select: {
            id: true,
            businessId: true,
            name: true,
            sku: true,
            unit: true,
            stockQty: true,
            lowStockAt: true,
            deletedAt: true,
            isActive: true,
          },
        })) as FreshProductState | null;

        if (
          !fresh ||
          !fresh.isActive ||
          fresh.deletedAt !== null ||
          !isLowStockNow(fresh.stockQty, fresh.lowStockAt)
        ) {
          // Deleted / deactivated / restocked between scan and notify ⇒ skip.
          result.skipped += 1;
          continue;
        }

        // §26 — membership re-check (no stale recipients): only users whose
        // OWNER/ADMIN membership STILL exists get the alert. Deterministic
        // order preserved (recipients list is already userId ASC).
        const liveRecipients: string[] = [];
        for (const userId of recipients) {
          const membership = await db.businessMember.findFirst({
            where: {
              businessId: fresh.businessId,
              userId,
              role: { in: [...LOW_STOCK_RECIPIENT_ROLES] },
            },
            select: { id: true },
          });
          if (membership) liveRecipients.push(userId);
        }
        if (liveRecipients.length === 0) {
          result.skipped += 1;
          continue;
        }

        for (let rIdx = 0; rIdx < liveRecipients.length; rIdx++) {
          // CREATION BUDGET (§12–§15): stop when max NEW notifications have
          // been created this run. Duplicates and failures never reach here
          // as budget consumers — the check sits only on the created path.
          if (result.created >= max) {
            result.truncated = hasRemainingLowStockWork(
              rows,
              rowIdx,
              liveRecipients.length,
              rIdx,
              hasMoreProducts,
            );
            break scan;
          }

          const userId = liveRecipients[rIdx];
          const identity = lowStockSourceEventId(fresh.id, fresh.stockQty, userId);

          if (mode === "DRY_RUN") {
            // No notify calls at all — the would-create estimate comes from
            // a read-only existence check against the SAME deterministic
            // identity the APPLY path uses (shared helper — no drift).
            const existing = await db.notification.findFirst({
              where: {
                userId,
                type: "BUSINESS_INVENTORY_LOW_STOCK",
                sourceEventId: identity,
              },
              select: { id: true },
            });
            if (existing) result.duplicates += 1; // does NOT consume budget
            else result.created += 1; // wouldCreate — DOES consume budget
            continue;
          }

          // APPLY — notification writes only; product rows stay read-only
          // (§22/§23). businessId is the FRESH product's businessId (§28).
          if (notifyInventoryLowStock === null) {
            const mappers = await import("@/lib/notifications/event-mappers");
            notifyInventoryLowStock = mappers.notifyInventoryLowStock;
          }
          const outcome = await notifyInventoryLowStock({
            businessId: fresh.businessId,
            productId: fresh.id,
            recipientUserId: userId,
            productName: fresh.name,
            sku: fresh.sku,
            unit: fresh.unit,
            stockQty: fresh.stockQty,
            lowStockAt: fresh.lowStockAt,
          });
          if (outcome === null) result.failed += 1; // §48 — never "created"
          else if (outcome.duplicate) result.duplicates += 1; // budget-free (§14)
          else result.created += 1;
        }
      } catch (error) {
        // §49 vs §50: a single bad candidate never aborts the run — but a
        // SYSTEMIC database failure must propagate (CLI exit 1), not hide
        // behind per-candidate failure counts.
        if (isSystemicDbError(error)) throw error;
        result.failed += 1;
        logError(OPERATIONAL_EVENTS.inventoryLowStockProcessorFailed, { mode });
      }
    }
  }

  // Safe operational log: counts + mode only — no product names, SKUs,
  // quantities, prices or emails (P37 §69/§170 safe-log law).
  logInfo(OPERATIONAL_EVENTS.inventoryLowStockProcessorCompleted, {
    mode,
    scanned: result.scanned,
    candidates: result.candidates,
    created: result.created,
    duplicates: result.duplicates,
    skipped: result.skipped,
    failed: result.failed,
    max,
    truncated: result.truncated,
  });

  // §52 — the ONLY debug channel: exactly the exported key vocabulary,
  // aggregate values only, emitted once at completion. No row-level data.
  if (process.env.INVENTORY_LOW_STOCK_DEBUG === "1") {
    console.log(
      JSON.stringify({
        debug: "inventory-low-stock",
        phase: "complete",
        scanned: result.scanned,
        candidates: result.candidates,
        created: result.created,
        duplicates: result.duplicates,
        skipped: result.skipped,
        failed: result.failed,
        max,
        mode,
        truncated: result.truncated,
      } satisfies Record<(typeof INVENTORY_LOW_STOCK_DEBUG_KEYS)[number], unknown>),
    );
  }

  return result;
}
