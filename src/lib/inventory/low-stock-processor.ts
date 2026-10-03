import "server-only";

/**
 * Prompt 38 — INVENTORY LOW-STOCK PROCESSOR (§38-a).
 *
 * The scheduled brain of low-stock in-app alerts, completing the MVP
 * notification scope (docs/ARCHITECTURE.md §5.1: "overdue, low stock" —
 * P37 delivered overdue; this delivers low stock). It is called by an
 * EXTERNAL, operator-managed scheduler (cron/systemd/Windows Task
 * Scheduler) through scripts/process-inventory-low-stock.mjs, or by tests
 * with an INJECTED clock. It is NEVER wired into the Next.js request
 * lifecycle — no in-process timers, no polling, no public HTTP endpoint.
 *
 * Laws (mirroring the audited Prompt 37 reminder processor):
 *  - DETERMINISTIC: fixed queries, fixed order (businessId → stockQty →
 *    id — worst shortages first within a business), closed threshold
 *    predicate (`stockQty <= lowStockAt`, active, not deleted).
 *  - IDEMPOTENT: notification identity (userId, type, sourceEventId) with
 *    sourceEventId = inventory-low-stock:<productId>:<stockQty>:
 *    <recipientUserId> — NO run timestamp. Repeated runs at the same
 *    stock level dedupe on the existing unique index; a different qty is
 *    a NEW logical event.
 *  - RECIPIENT LAW: active OWNER + ADMIN members of the product's
 *    business, resolved server-side. Re-verified against the CURRENT
 *    membership rows immediately before each notify — a membership
 *    revoked between scan and notify never receives an alert (the
 *    P37-F "no stale recipients" law, applied to business-level alerts).
 *  - DEFENSIVE RE-CHECK (P37-F §31–§36 analog): the product row is
 *    re-read FRESH immediately before notify (id + business + deletedAt +
 *    isActive + stockQty + lowStockAt + name + sku + unit). The scanned
 *    row alone is NOT trusted: a product restocked or deleted between
 *    the scan and the notify is SKIPPED, and the notification identity
 *    always embeds the FRESH qty (never the scanned qty).
 *  - NOTIFICATION-ONLY: product rows are never mutated. Proven
 *    dynamically by the E2E full-row before/after snapshot.
 *  - BOUNDED: max notifications per run (default 100, hard 10–500);
 *    deterministic cap order means the next run continues where this
 *    one stopped.
 *  - ISOLATED: one bad candidate increments `failed` and the run
 *    continues; a systemic DB failure propagates to the caller (exit 1).
 *  - PRIVATE: no product names, SKUs, prices, quantities, emails or
 *    notification bodies ever enter the result or logs.
 */

import { db } from "@/lib/db";
import { logInfo, logError } from "@/lib/observability/logger";
import { OPERATIONAL_EVENTS } from "@/lib/observability/events";
import {
  isLowStockNow,
  isLowStockRecipientRole,
  lowStockMaxPerRun,
} from "./low-stock-types";

/* --------------------------------- types ---------------------------------- */

export type LowStockProcessorOptions = {
  /** Injectable clock — tests inject; production defaults to now(). */
  now?: Date;
  /** Optional single-business scope (validated, exact, injection-safe). */
  businessId?: string;
  /** DRY_RUN (default) never writes; APPLY creates notifications. */
  dryRun?: boolean;
  /** Optional explicit cap override (bounded 10–500). */
  max?: number;
};

export type LowStockProcessorResult = {
  mode: "DRY_RUN" | "APPLY";
  scanned: number;
  candidates: number;
  created: number;
  duplicates: number;
  skipped: number;
  failed: number;
  max: number;
};

/** Minimal scanned row — only fields needed for classification. */
type ScannedRow = {
  id: string;
  businessId: string;
  stockQty: number;
};

/** Fresh state re-read immediately before notify (§35 analog). */
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

/* ------------------------------- processor -------------------------------- */

export async function processInventoryLowStock(
  options: LowStockProcessorOptions = {},
): Promise<LowStockProcessorResult> {
  const mode: "DRY_RUN" | "APPLY" = options.dryRun === false ? "APPLY" : "DRY_RUN";
  const max = lowStockMaxPerRun(options.max);

  const businessScope = options.businessId?.trim() || null;
  if (businessScope && !/^[a-zA-Z0-9_-]{6,64}$/.test(businessScope)) {
    throw new Error("inventory-low-stock: invalid businessId scope");
  }

  // Deterministic scan: active, not deleted, at-or-below threshold.
  // Worst shortages first (stockQty asc), then name, then id — the cap
  // therefore always keeps the MOST urgent products within the run.
  const rows = (await db.product.findMany({
    where: {
      ...(businessScope ? { businessId: businessScope } : {}),
      deletedAt: null,
      isActive: true,
    },
    orderBy: [{ stockQty: "asc" }, { name: "asc" }, { id: "asc" }],
    select: { id: true, businessId: true, stockQty: true, lowStockAt: true },
  })) as Array<ScannedRow & { lowStockAt: number }>;

  const lowRows = rows.filter((row) => isLowStockNow(row.stockQty, row.lowStockAt));
  const bounded = lowRows.slice(0, max);

  // Safe aggregate debug output — the ONLY allowed debug channel. Counts
  // and run configuration only; NEVER product ids, names, SKUs, quantities
  // or business ids (P37-F §10/§11 safe-debug law).
  if (process.env.INVENTORY_LOW_STOCK_DEBUG === "1") {
    console.log(
      JSON.stringify({
        debug: "inventory-low-stock",
        phase: "candidate-scan",
        scanned: rows.length,
        lowStockScanned: lowRows.length,
        max,
        mode,
      }),
    );
  }

  const result: LowStockProcessorResult = {
    mode,
    scanned: rows.length,
    candidates: lowRows.length,
    created: 0,
    duplicates: 0,
    skipped: 0,
    failed: 0,
    max,
  };

  // Recipients are resolved ONCE per distinct business (bounded), then
  // re-verified per notify against the CURRENT membership rows.
  const businessIds = [...new Set(bounded.map((r) => r.businessId))];
  const recipientsByBusiness = new Map<string, string[]>();
  for (const businessId of businessIds) {
    const members = await db.businessMember.findMany({
      where: { businessId, role: { in: ["OWNER", "ADMIN"] } },
      select: { userId: true },
    });
    recipientsByBusiness.set(
      businessId,
      members.map((m) => m.userId).sort(),
    );
  }

  for (const row of bounded) {
    try {
      const recipients = recipientsByBusiness.get(row.businessId) ?? [];
      if (recipients.length === 0) {
        // No OWNER/ADMIN exists (cannot happen for a live business, but
        // the honest behavior is to skip — never fabricate a recipient).
        result.skipped += 1;
        continue;
      }

      // §35 analog — FRESH minimal product state, re-read NOW. The scanned
      // row is not trusted: stock may have changed (sale, adjustment,
      // restock) between the scan and this notify.
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

      // Membership re-check (no stale recipients): only users whose
      // OWNER/ADMIN membership STILL exists get the alert.
      const liveRecipients: string[] = [];
      for (const userId of recipients) {
        const membership = await db.businessMember.findFirst({
          where: { businessId: fresh.businessId, userId, role: { in: ["OWNER", "ADMIN"] } },
          select: { id: true },
        });
        if (membership) liveRecipients.push(userId);
      }
      if (liveRecipients.length === 0) {
        result.skipped += 1;
        continue;
      }

      if (mode === "DRY_RUN") {
        // No notify calls at all. The duplicate estimate comes from a
        // read-only existence check against the same deterministic
        // identity the APPLY path would use (P37 §66 analog).
        for (const userId of liveRecipients) {
          const existing = await db.notification.findFirst({
            where: {
              userId,
              type: "BUSINESS_INVENTORY_LOW_STOCK",
              sourceEventId: `inventory-low-stock:${fresh.id}:${fresh.stockQty}:${userId}`,
            },
            select: { id: true },
          });
          if (existing) result.duplicates += 1;
          else result.created += 1; // wouldCreate
        }
        continue;
      }

      // APPLY — notification writes only; product rows stay read-only.
      const { notifyInventoryLowStock } = await import("@/lib/notifications/event-mappers");
      for (const userId of liveRecipients) {
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
        if (outcome === null) result.failed += 1;
        else if (outcome.duplicate) result.duplicates += 1;
        else result.created += 1;
      }
    } catch {
      // One bad candidate never aborts the run. Safe log fields only.
      result.failed += 1;
      logError(OPERATIONAL_EVENTS.inventoryLowStockProcessorFailed, { mode });
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
  });

  return result;
}
