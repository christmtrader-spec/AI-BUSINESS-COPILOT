import "server-only";

/**
 * Prompt 38 — LOW-STOCK INVENTORY ALERTS — pure vocabulary + laws.
 * Prompt 38-F FINALIZED — bounded pagination + creation-budget semantics.
 *
 * The MVP notification scope (docs/ARCHITECTURE.md §5.1 "Notifications:
 * In-app alerts (overdue, low stock)") is completed by this module: P37
 * delivered the overdue half; THIS module delivers the low-stock half.
 *
 * LAWS (mirroring the Prompt 37 reminder processor, audited by 37-F):
 *  - DETERMINISTIC: a product is low-stock iff it is active, not deleted,
 *    and `stockQty <= lowStockAt` (INCLUSIVE — hitting the threshold IS the
 *    alert). No hysteresis, no clocks, no randomness.
 *  - IDEMPOTENT: notification identity is (userId, type, sourceEventId)
 *    with sourceEventId = inventory-low-stock:<productId>:<stockQty>:
 *    <recipientUserId> — NO run timestamp. Repeated processor runs at the
 *    same stock level dedupe via the Notification unique index; a change
 *    of stockQty is a NEW logical event; a return to a PREVIOUSLY SEEN qty
 *    dedupes against that older event (identity is (product, qty,
 *    recipient) — never time).
 *  - RECIPIENT LAW: the business's active OWNER and ADMIN members,
 *    resolved server-side at run time in DETERMINISTIC userId ASC order.
 *    Never the acting user (there is none — the processor is
 *    operator-scheduled), never a client-supplied recipient, never a
 *    soft-deleted or revoked membership.
 *  - NOTIFICATION-ONLY: product rows are NEVER mutated by this pipeline.
 *  - BOUNDED TWICE (38-F §7–§21):
 *      · SCAN pages: product rows are read in cursor-paginated pages of
 *        INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE (default 250, 50–500) — never
 *        one unbounded findMany.
 *      · NOTIFICATION BUDGET: max (default 100, 10–500) caps the NEW
 *        notifications CREATED per run — NOT the products scanned and NOT
 *        the candidates visited. Duplicates do NOT consume the budget (no
 *        row was created); when the budget is exhausted the run stops with
 *        truncated=true and remaining combinations stay eligible for the
 *        next run (no starvation).
 */

/* ------------------------------- thresholds ------------------------------- */

/**
 * Minimum sensible alert threshold. `lowStockAt` defaults to 5 in the
 * schema; the product form bounds it (0–1,000,000). A product with
 * `lowStockAt = 0` only alerts when stockQty reaches 0 (true stock-out).
 */
export const LOW_STOCK_THRESHOLD_MAX = 1_000_000;

/**
 * Pure predicate — the ONLY definition of "is this product low-stock right
 * now". `qty <= threshold` (inclusive by design: hitting the threshold IS
 * the alert). Defensive against corrupt legacy rows: non-finite or
 * negative values classify as NOT low — a malformed row never fabricates
 * notification data (38-F §159/§160).
 */
export function isLowStockNow(stockQty: number, lowStockAt: number): boolean {
  if (!Number.isFinite(stockQty) || !Number.isFinite(lowStockAt)) return false;
  if (stockQty < 0 || lowStockAt < 0) return false;
  return stockQty <= lowStockAt;
}

/* -------------------------------- identity -------------------------------- */

/**
 * Deterministic sourceEventId (Prompt 37 §25/§27 analog). No run timestamp:
 * repeated runs at the same stock level collapse onto the same identity and
 * dedupe via Notification (userId, type, sourceEventId) — while a different
 * stockQty is a different logical event (§38-a identity law). The threshold
 * is deliberately NOT part of the identity: changing lowStockAt never
 * fabricates a new event for an already-notified (product, qty, recipient)
 * triple; re-eligibility after a threshold change dedupes against the
 * historical event for the same qty (documented behavior, 38-F §39).
 */
export function lowStockSourceEventId(
  productId: string,
  stockQty: number,
  recipientUserId: string,
): string {
  return `inventory-low-stock:${productId}:${Math.trunc(stockQty)}:${recipientUserId}`;
}

/* ------------------------------- recipients ------------------------------- */

/**
 * Roles that receive business-level inventory alerts. Deliberately a CLOSED
 * vocabulary constant — never inferred from permissions at runtime, never
 * client-controlled.
 */
export const LOW_STOCK_RECIPIENT_ROLES = ["OWNER", "ADMIN"] as const;

export function isLowStockRecipientRole(role: string): boolean {
  return (LOW_STOCK_RECIPIENT_ROLES as readonly string[]).includes(role);
}

/* -------------------------- notification budget --------------------------- */

export const INVENTORY_LOW_STOCK_MAX_PER_RUN_DEFAULT = 100;
export const INVENTORY_LOW_STOCK_MAX_PER_RUN_MIN = 10;
export const INVENTORY_LOW_STOCK_MAX_PER_RUN_MAX = 500;

/**
 * Effective per-run NEW-NOTIFICATION cap: option wins, then env, then
 * default — clamped. This caps CREATED notifications (duplicates are free);
 * it is NOT a product-scan cap (38-F §12–§15).
 */
export function lowStockMaxPerRun(option?: number): number {
  const raw = (process.env.INVENTORY_LOW_STOCK_MAX_PER_RUN ?? "").trim();
  const envN = raw ? Number.parseInt(raw, 10) : NaN;
  const base = Number.isFinite(option)
    ? Math.trunc(option as number)
    : Number.isFinite(envN)
      ? envN
      : INVENTORY_LOW_STOCK_MAX_PER_RUN_DEFAULT;
  return Math.min(
    INVENTORY_LOW_STOCK_MAX_PER_RUN_MAX,
    Math.max(INVENTORY_LOW_STOCK_MAX_PER_RUN_MIN, base),
  );
}

/* ------------------------------ scan page size ---------------------------- */

export const INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE_DEFAULT = 250;
export const INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE_MIN = 50;
export const INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE_MAX = 500;

/**
 * Rows loaded PER DATABASE QUERY (38-F §8/§59) — NOT the notification cap.
 * Every product query carries a real `take:` bound (§7/§78); the env value
 * is validated project-consistently: invalid/NaN falls back to the default
 * and any out-of-bounds value clamps into [50, 500] — an invalid value can
 * NEVER become "unlimited" (§60).
 */
export function lowStockScanPageSize(option?: number): number {
  const raw = (process.env.INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE ?? "").trim();
  const envN = raw ? Number.parseInt(raw, 10) : NaN;
  const base = Number.isFinite(option)
    ? Math.trunc(option as number)
    : Number.isFinite(envN)
      ? envN
      : INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE_DEFAULT;
  return Math.min(
    INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE_MAX,
    Math.max(INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE_MIN, base),
  );
}

/* ------------------------- remaining-work lookahead ------------------------ */

/** Minimal shape the lookahead needs — no product data beyond the predicate inputs. */
export type LowStockScanRow = {
  stockQty: number;
  lowStockAt: number;
};

/**
 * Pure 38-F §19 truncated-lookahead: given the CURRENT page, the position
 * just abandoned, the abandoned candidate's recipient list position and
 * whether the scan knows more pages MAY follow, decide whether additional
 * eligible work may remain. Deterministic and side-effect free:
 *  - recipients not yet notified for the current candidate, OR
 *  - a later row on the CURRENT page that classifies as low-stock, OR
 *  - more pages may follow (hasMorePages — honest "may remain").
 */
export function hasRemainingLowStockWork(
  pageRows: readonly LowStockScanRow[],
  fromRowIdx: number,
  liveRecipientCount: number,
  nextRecipientIdx: number,
  hasMorePages: boolean,
): boolean {
  if (nextRecipientIdx < liveRecipientCount) return true;
  for (let j = fromRowIdx; j < pageRows.length; j++) {
    if (isLowStockNow(pageRows[j].stockQty, pageRows[j].lowStockAt)) return true;
  }
  return hasMorePages;
}

/* ------------------------------ debug vocabulary --------------------------- */

/**
 * The EXACT key set INVENTORY_LOW_STOCK_DEBUG=1 may emit (38-F §52). No
 * row-level data — aggregates and run configuration only. Exported so the
 * static scan (and tests) can pin the vocabulary instead of trusting prose.
 */
export const INVENTORY_LOW_STOCK_DEBUG_KEYS = [
  "debug",
  "phase",
  "scanned",
  "candidates",
  "created",
  "duplicates",
  "skipped",
  "failed",
  "max",
  "mode",
  "truncated",
] as const;
