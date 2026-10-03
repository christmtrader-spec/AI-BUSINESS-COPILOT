import "server-only";

/**
 * Prompt 38 — LOW-STOCK INVENTORY ALERTS — pure vocabulary + laws.
 *
 * The MVP notification scope (docs/ARCHITECTURE.md §5.1 "Notifications:
 * In-app alerts (overdue, low stock)") is completed by this module: P37
 * delivered the overdue half; THIS module delivers the low-stock half.
 *
 * LAWS (mirroring the Prompt 37 reminder processor, audited by 37-F):
 *  - DETERMINISTIC: a product is low-stock iff it is active, not deleted,
 *    and `stockQty <= lowStockAt`. No hysteresis, no clocks, no randomness.
 *  - IDEMPOTENT: notification identity is (userId, type, sourceEventId)
 *    with sourceEventId = inventory-low-stock:<productId>:<stockQty>:
 *    <recipientUserId> — NO run timestamp. Repeated processor runs at the
 *    same stock level dedupe via the Notification unique index; a change
 *    of stockQty (deeper shortage after a partial restock, or a fresh drop
 *    after restocking above the threshold) is a NEW logical event.
 *  - RECIPIENT LAW: the business's active OWNER and ADMIN members,
 *    resolved server-side at run time. Never the acting user (there is
 *    none — the processor is operator-scheduled), never a client-supplied
 *    recipient, never a soft-deleted or revoked membership.
 *  - NOTIFICATION-ONLY: product rows are NEVER mutated by this pipeline.
 *  - BOUNDED: max notifications per run (default 100, hard 10–500).
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
 * the alert). Active/deleted state is checked by the caller's query.
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
 * stockQty is a different logical event (§38-a identity law).
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

/* --------------------------------- bounds --------------------------------- */

export const INVENTORY_LOW_STOCK_MAX_PER_RUN_DEFAULT = 100;
export const INVENTORY_LOW_STOCK_MAX_PER_RUN_MIN = 10;
export const INVENTORY_LOW_STOCK_MAX_PER_RUN_MAX = 500;

/** Effective per-run cap: option wins, then env, then default — clamped. */
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
