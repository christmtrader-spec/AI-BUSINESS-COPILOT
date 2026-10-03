# Inventory Low-Stock Alerts

**Prompt 38 · Status: IMPLEMENTED + FINALIZED (Prompt 38-F) · Operator-scheduled inventory notification processor.**

Prompt 38 completes the MVP notification scope (docs/ARCHITECTURE.md §5.1 "In-app alerts (overdue, low stock)"): P37 delivered the overdue half; this module delivers the **low-stock** half. It is NOT an inventory-automation feature — it is a **notification-only** pipeline that watches products and tells the business's OWNER/ADMIN members when stock reaches the configured alert threshold.

**Prompt 38-F hardening (final behavior):**

- **REAL bounded scanning (§7–§11):** the former inherited implementation loaded ALL active products with one unbounded `findMany` and then applied `slice(0, max)` — fake boundedness. The processor now reads Product rows in **cursor-paginated pages** with a hard `take: pageSize` on EVERY query (default 250 rows/page, clamped 50–500 via `INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE`), in the deterministic order `stockQty ASC → name ASC → id ASC` (worst shortages first; `id` is the unique tiebreaker that makes the server-derived cursor stable). Scanning continues across pages until rows are exhausted or the notification budget is hit — the first page is never assumed to contain all candidates.
- **Creation budget, not a scan cap (§12–§18):** `max` (default 100, hard 10–500) caps the **NEW notifications CREATED per run** — never the products scanned or candidates visited. **Duplicates never consume the budget** (no row was created), and neither do failures. With N recipients per product the run stops exactly when `created === max`; the result reports `truncated: true` and the remaining eligible (product, qty, recipient) combinations are reached on a LATER run — no logical starvation. `created` can never exceed `max`.
- **Truncated lookahead (§19):** `truncated` is computed by a pure helper (`hasRemainingLowStockWork`): true iff the cap was hit while unnotified recipients, later low-stock candidates on the current page, or further pages MAY remain; false when the run provably covered everything.
- **Systemic vs per-candidate failures (§49/§50):** one bad candidate increments `failed` and the run continues; a SYSTEMIC database failure (Prisma connection/pool/access class codes P1001/P1002/P1003/P1010/P1017/P2024) propagates to the CLI → exit 1, instead of hiding behind per-candidate failure counts. A vanished cursor row (P2025) ends the scan deterministically (documented termination, re-scanned next run).
- **CLI syntax repair:** the inherited entry script contained a Linux cron example with a literal `*/6` inside its block comment — the `*/` sequence terminated the comment and the script had NEVER been runnable. The schedule example now uses `0 0,6,12,18 * * *` with an explanatory note.

---

## 1. Low-stock definition (unchanged, §5/§6)

A product is low-stock **iff**:

```
deletedAt = null AND isActive = true AND stockQty <= lowStockAt
```

The comparison is **inclusive**: `stockQty = 5, lowStockAt = 5` IS low-stock. The predicate (`isLowStockNow`) is defensive against corrupt legacy rows: non-finite or negative values classify as NOT low — a malformed row never fabricates notification data and never aborts the run. `stockQty = 0` (true stock-out) is low-stock whenever `lowStockAt >= 0`; there is deliberately NO separate out-of-stock notification type.

Nothing about stock semantics changed: inventory adjustments, sale stock decrement, sale-reversal restock and the product form (`lowStockAt` 0–1,000,000) behave exactly as before; the processor is read-only over products.

## 2. Notification identity (idempotency)

`sourceEventId = inventory-low-stock:<productId>:<stockQty>:<recipientUserId>` — composed through the shared `lowStockSourceEventId` helper in BOTH the dry-run existence check and the APPLY path (no drift). No run timestamp.

- **Same (product, qty, recipient) → same identity.** Repeated runs dedupe via the Notification unique index `(userId, type, sourceEventId)`.
- **Different qty → different logical event.** 5 → notification; 4 → new notification; back to 5 → dedupes against the OLD 5 event (identity is never time-based).
- **Threshold changes do NOT mint identities.** Re-eligibility after a threshold change dedupes against the historical event for the same (product, qty, recipient). Example: stock 9/threshold 10 → alert; threshold 5 → no longer low; threshold 10 again → the existing 9-level event dedupes.

## 3. Recipients

Active `OWNER` + `ADMIN` members of the product's business, resolved server-side at run time (closed `LOW_STOCK_RECIPIENT_ROLES` vocabulary), ordered deterministically `userId ASC`, cached per business for the run, and **re-verified against the current membership rows immediately before each notify**. A membership revoked between scan and notify never receives that alert; the remaining recipients still do (no blanket suppression). STAFF never receives inventory alerts; a mid-run STAFF→ADMIN promotion becomes eligible on a later run (never fabricated mid-run). If a business has no OWNER/ADMIN, the candidate is skipped — a recipient is never fabricated. `businessId` always comes from the FRESH product state; the CLI's `--business-id` is operator scope only and never grants user access.

## 4. Fresh re-check before every notification (P37-F pattern)

Between the page scan and each notify, the processor re-reads the product's CURRENT minimal state (id, businessId, name, sku, unit, stockQty, lowStockAt, deletedAt, isActive). The scanned row is never authoritative: restocked, deleted or deactivated products between scan and notify are SKIPPED (counted in `skipped`), and the identity always embeds the **FRESH** qty.

## 5. Result DTO and counts

```json
{ "mode": "APPLY|DRY_RUN", "scanned": 0, "candidates": 0, "created": 0,
  "duplicates": 0, "skipped": 0, "failed": 0, "max": 0, "truncated": false }
```

| Field | Meaning (§166) |
| --- | --- |
| `scanned` | actual Product rows read (accumulated across pages) |
| `candidates` | low-stock products actually evaluated before the run stopped |
| `created` | NEW notifications created (in DRY RUN: wouldCreate, §168) |
| `duplicates` | existing logical identities hit (budget-free) |
| `skipped` | eligible rows skipped for state/recipient reasons |
| `failed` | notification processing failures (never counted as created) |
| `truncated` | cap reached while additional eligible work MAY remain |

In DRY RUN nothing is written — no Notification, Delivery, Product or Audit row (proven by full content snapshots in the E2E); `max` is honored as the would-create budget so dry-run numbers are representative of APPLY.

## 6. Scheduler (operator-managed, single-node)

The repository provides `scripts/process-inventory-low-stock.mjs`; the OS owns WHEN it runs. Recommended cadence: **every 6 hours** (`0 0,6,12,18 * * *`). Default is DRY RUN; `--apply` writes. This is a SINGLE-NODE scheduler architecture: idempotency (database uniqueness + deterministic identity) protects against overlapping or duplicate execution — it is NOT distributed scheduling. No in-process timers, no HTTP scheduler endpoint, no Redis/queue/worker.

```bash
bun scripts/process-inventory-low-stock.mjs              # dry run
bun scripts/process-inventory-low-stock.mjs --apply      # create notifications
bun scripts/process-inventory-low-stock.mjs --apply --business-id=<id> --max=100
```

CLI: reuse of the audited Prompt 37-F parser — `(no flags)` → DRY_RUN, `--apply --dry-run` → exit 1 (conflict), unknown flags → exit 1, `--max=` strict 10–500 (no silent clamping), `--business-id=` validated `^[a-zA-Z0-9_-]{6,64}$`, all validation BEFORE the processor import / any DB access. Duplicate value flags: last occurrence wins (documented, deterministic).

## 7. Environment variables

| Variable | Default | Bounds | Meaning |
| --- | --- | --- | --- |
| `INVENTORY_LOW_STOCK_MAX_PER_RUN` | 100 | 10–500 (clamped) | max NEW notifications created per run (duplicates/failed don't consume it) |
| `INVENTORY_LOW_STOCK_SCAN_PAGE_SIZE` | 250 | 50–500 (clamped) | Product rows per database query — never "unlimited" |
| `INVENTORY_LOW_STOCK_DEBUG` | unset | `1` enables | emits ONE aggregate JSON line with EXACTLY the §52 key vocabulary (`debug, phase, scanned, candidates, created, duplicates, skipped, failed, max, mode, truncated`) — never row-level data |

## 8. Notification surface (Prompt 32 platform)

Type `BUSINESS_INVENTORY_LOW_STOCK` (the ONLY inventory notification type — no OUT_OF_STOCK/RESTOCKED/CRITICAL noise), category BUSINESS, priority NORMAL, severity WARNING, `IN_APP = ALWAYS` (cannot be disabled), `EMAIL = IF_ENABLED` (preference-controlled; SKIPPED with `PREFERENCE_DISABLED` when opted out, honoring the global email-verification policy), CTA `products` → `#/products`, expiry 30 days. Data payload is a strict allowlist: `productId, productName (≤160), sku (≤64, nullable), unit (≤24, nullable), stockQty, lowStockAt` — never prices, business/customer data or audit fields. Product name/SKU/unit are user data rendered as plain text; the email template HTML-escapes; no `dangerouslySetInnerHTML` anywhere.

## 9. Known limitations (honest)

- Single-node scheduler; SQLite; page-scan snapshot consistency is per-page, not per-run (a product changing between pages is caught by the fresh re-check; the theoretical miss window is a cursor row deleted mid-run — deterministically re-scanned next run).
- Notifications are per (product, qty, recipient): a business with rapidly fluctuating stock receives one alert per distinct qty level — no rate limiting/digest (by design; the identity law IS the dedupe).
- No inventory automation: no purchase orders, no restock suggestions, no valuation impact — the processor never mutates financial or inventory data (proven by byte-identical product snapshots and financial-equality checks in the E2E).
- EMAIL delivery end-to-end depends on operator SMTP configuration; delivery-row semantics are verified locally only.
