# Inventory Low-Stock Alerts — Security Documentation

**Prompt 38-F · covers `src/lib/inventory/*`, `scripts/process-inventory-low-stock.mjs`, the `BUSINESS_INVENTORY_LOW_STOCK` notification surface.**

## Threat model summary

The low-stock processor is a batch pipeline that turns business inventory state into notifications. Its risks: tenant leakage (alerts crossing businesses), stale-recipient delivery, data over-collection in payloads/logs, product-data mutation, unbounded work (memory/DB), and injection through user-controlled product fields. Each is addressed below and enforced by static scans + unit + E2E tests.

## 1. Tenant isolation

- The processor runs OUTSIDE the request lifecycle (operator CLI). There is no HTTP surface and no `NextRequest` anywhere in the inventory module (static scan rules 5/18).
- Recipients are resolved ONLY from `BusinessMember` rows of the product's OWN business (`businessId` taken from the FRESH product state, §28) — a non-member can never be addressed. E2E A11b proves an ADMIN of a DIFFERENT business receives nothing.
- `--business-id` is operator scope for scanning, validated `^[a-zA-Z0-9_-]{6,64}$`; it never grants user access and never overrides the per-notification business derivation (§165). E2E X1–X3 prove zero cross-business leakage.

## 2. Active/deleted filtering

The scan query filters `deletedAt = null AND isActive = true`; the notify path RE-READS the product fresh with the same filters plus the inclusive threshold predicate. Soft-deleted, deactivated and restocked products between scan and notify are skipped (E2E L1/L2, RC4–RC6 mid-run races). `isLowStockNow` is defensive: non-finite/negative values never classify as low (§159/§160 — one malformed legacy row cannot fabricate data or abort the run).

## 3. Recipient authority

- Recipients = current `BusinessMember.userId` with role in the closed `["OWNER", "ADMIN"]` vocabulary — never a product owner field, HTTP user, CLI user, browser user or email field (§29).
- Deterministic `userId ASC` ordering (§17); membership re-verified per notify against CURRENT rows (§26/§27) — revocation between scan and notify prevents delivery (E2E RC7/RC8 proves re-check is live, not blanket).
- No OWNER/ADMIN ⇒ skip; a recipient is never fabricated (§42; E2E NR1–NR4).

## 4. Notification data minimization (§33/§34)

Payload allowlist is exactly `{ productId, productName≤160, sku≤64|null, unit≤24|null, stockQty, lowStockAt }`, enforced by the catalog's strict zod schema (unknown keys stripped, oversized rejected). No businessId, userId, email, phone, address, cost/sale prices, supplier, customer, description, audit, security, AI-cost or billing fields. Product name/SKU/unit are user-controlled: stored as bounded plain-text data, rendered as plain text in-app, HTML-escaped in email; no `dangerouslySetInnerHTML`; `sourceEventId` composes from ids + truncated qty ONLY (E2E Y1–Y5 with HTML-hostile `<test>&"'>` / `<b>SKU&</b>` fixtures).

## 5. Safe logging (§51/§52)

- Structured logs carry ONLY: job, mode, runId, timestamps, aggregate counts, error categories — never productId, businessId, product name, SKU, stockQty, recipient userId, email or notification body (enforced by static scan rules 8–12).
- `INVENTORY_LOW_STOCK_DEBUG=1` emits ONE JSON line whose key set is the exported closed constant `INVENTORY_LOW_STOCK_DEBUG_KEYS` (exactly 11 aggregate keys) — no row-level data path exists in debug mode (static scan verifies the shape AND the absence of row-level identifiers in the debug block).
- The CLI's only outputs are the safe usage-error JSON and the aggregate result JSON.

## 6. No product mutation (§22/§23)

The processor never calls product.create/update/updateMany/delete/deleteMany/upsert (static scan rule 13). Proven dynamically: E2E M1 snapshots a full Product row before/after an APPLY run — byte-identical. Financial non-interference: the pipeline touches only Notification/Delivery writes through the Prompt 32 service.

## 7. Concurrency & idempotency (§44–§47)

- Identity `(userId, type, sourceEventId)` with `inventory-low-stock:<productId>:<qty>:<recipientUserId>` (no run timestamp) + the existing database UNIQUE index remain the sole, authoritative dedupe boundary — no dedupe table, no weakening (§47).
- Two concurrent APPLY processors converge on exactly ONE row per identity: the service's P2002 handler re-reads and returns `duplicate` (E2E N1–N6 with REAL concurrent processes: 12/12 unique identities, zero duplicates).
- Honest wording: duplicate-SAFE through database uniqueness + deterministic identity — NOT "zero duplicate risk" and NOT distributed coordination (single-node scheduler, §65).

## 8. Bounded work & memory (§7–§11, §161–§164)

Every product query carries `take: pageSize` (50–500, default 250); cursor pagination with a server-derived cursor (the CLI cannot supply one, §163); deterministic total order `stockQty ASC, name ASC, id ASC`; termination on page exhaustion, budget exhaustion, or cursor-row removal (P2025) — no unbounded query, no infinite loop, no whole-table materialization (only the current page + counts + a small per-business recipient cache).

## 9. No scheduler attack surface (§62–§65)

No `setInterval`/`setTimeout` in runtime code, no HTTP run endpoint (nothing to authenticate or DDoS), no Redis/queue/worker, no fake distributed locks. The CLI validates ALL flags (conflicts, unknowns, ranges, IDs) BEFORE importing the processor — invalid usage performs zero database access (E2E C1–C7 full-snapshot proof).

## 10. Failure semantics (§49/§50)

Per-candidate exceptions increment `failed` and the run continues (isolation); systemic Prisma connection/pool/access failures (P1001/P1002/P1003/P1010/P1017/P2024) PROPAGATE → CLI exit 1 (never misreported as a successful run with inflated failure counts).
