# ADR 0038 — Inventory Low-Stock Alerts

**Status:** Accepted (Prompt 38, implemented by a prior interrupted round) · Finalized (Prompt 38-F)
**Date:** 2026-10-03
**Complements:** ADR 0037 (CRM task reminders and the operator-managed external scheduler) — this ADR applies the same scheduling doctrine to the inventory surface and documents the 38-F bounded-scan + creation-budget additions.

## Context

The MVP notification scope (docs/ARCHITECTURE.md §5.1 "In-app alerts (overdue, low stock)") needed its inventory half: when a product's stock reaches its configured threshold, the business's OWNER/ADMIN members should be alerted in-app (email optional). The deployment reality is unchanged from ADR 0037: SQLite, single node, no Redis, no broker, no in-process worker — the OS owns timing, the application owns logic.

A prior cron round implemented the first version of the pipeline (processor, CLI, catalog entry) but was interrupted before finalization. 38-F inherited it and found it functionally unbounded in two ways: one unbounded `findMany` with post-hoc `slice()` (fake pagination), and a `max` that capped CANDIDATE PRODUCTS rather than CREATED notifications (so multi-recipient businesses could exceed the intended budget, while duplicates wasted it).

## Decision

1. **Operator scheduler (as ADR 0037):** `scripts/process-inventory-low-stock.mjs`, default DRY RUN, `--apply` to write; recommended 6-hour cadence; no HTTP scheduler endpoint, no in-process timers, no Redis/queue/worker. Single-node by design — idempotency protects duplicate execution; this is NOT distributed scheduling.
2. **Bounded pagination (38-F):** every product query carries a hard `take: INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE` (default 250, clamped 50–500). Cursor pagination on the deterministic total order `stockQty ASC → name ASC → id ASC` (id is the unique tiebreaker; the cursor is server-derived and cannot be client-supplied). Scanning is EXHAUSTIVE across pages, terminated only by row exhaustion or budget exhaustion (a vanished cursor row ends the scan deterministically and is re-scanned next run).
3. **Creation budget (38-F):** `max` (default 100, hard 10–500, strict at the CLI) caps NEW notifications CREATED per run. Duplicates and failures never consume the budget; `created ≤ max` always; on truncation the result reports `truncated: true` and remaining (product, qty, recipient) combinations stay eligible for the next run — no starvation (proven with a 120-combination E2E: run 1 creates exactly 100, run 2 creates the remaining 20 against 100 dedupes).
4. **Notification uniqueness:** the existing `Notification (userId, type, sourceEventId)` unique index remains the ONLY dedupe mechanism — `inventory-low-stock:<productId>:<stockQty>:<recipientUserId>`, no run timestamp, shared helper for both dry-run and apply paths. No reminder/low-stock history table, no new dedupe infrastructure, no queue.
5. **Notification-only:** product rows are never mutated; the processor re-checks fresh product state and current membership before every notify (P37-F defensive pattern).

## Consequences

**Positive**

- Memory and DB work are bounded per page regardless of catalog size; scanning cost is O(products/pagesize) queries with a deterministic cap on writes.
- The budget semantics make multi-recipient runs predictable and fair: later recipients/products are reached on subsequent runs instead of being starved by early duplicates.
- The runtime remains a plain request/response app; the only new operational dependency is the operator's cron entry.

**Negative / limitations (honest)**

- Single-node: overlapping execution is duplicate-safe, not coordinated; there is no cross-host lease.
- Per-page snapshot consistency: a product changing between pages is handled by the fresh re-check, but a cursor row deleted mid-run deterministically ends that run's scan early (self-healing next run).
- One alert per (product, qty, recipient): rapidly fluctuating stock produces multiple events by design — no rate limiting or digest.
- EMAIL end-to-end depends on operator SMTP configuration; the platform records delivery-row semantics either way.
