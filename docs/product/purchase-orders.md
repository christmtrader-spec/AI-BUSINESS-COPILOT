# Purchase Orders — Procurement Commitment Documents

**Prompt 41 (finalized by 41-F)** · Status: implemented + hardened · Scope: `src/lib/purchase-orders/`, `/api/v1/purchase-orders/**`, `#/purchase-orders` views, `docs/adr/0041-purchase-orders.md`, `docs/security/purchase-orders-security.md`.

---

## 1. What a purchase order IS — and what it is NOT

A purchase order (PO) is a **procurement commitment document**: *"the business
intends to buy these products from this supplier under these commercial
terms."* It records intent — never money movement, never goods movement.

**It is NOT:**

- an **Expense** — no `Expense` row is ever created, updated or reversed;
- a **Payment** — no `Payment` row, no supplier balance change;
- an **inventory receipt** — no `InventoryAdjustment`, no `Product.stockQty`
  change, on ANY lifecycle transition (send/confirm/close/cancel included);
- a **payable** — supplier statements, payables aging and receivables never
  read or include purchase orders (`docs/audit/financial-semantics.md` §8);
- an **accounting entry** — no journal, no double entry, no ledger.

The UI states this explicitly on every document ("This document records
procurement intent only…"). The static scan
(`scripts/prompt41-purchase-order-static-scan.mjs` rules 32–40) forbids any
side-effect write in the P41 domain, and the E2E suite proves financial
non-mutation by snapshot comparison (`scripts/prompt41-purchase-order-check.mjs`
group 22).

## 2. Lifecycle

Five statuses, closed vocabulary: `DRAFT → SENT → CONFIRMED → CLOSED`, with
`CANCELLED` reachable from DRAFT/SENT/CONFIRMED. `CLOSED` and `CANCELLED` are
terminal. Transitions run through **dedicated endpoints only**
(`/send`, `/confirm`, `/close`, `/cancel`); there is deliberately no generic
status PATCH. The current status is re-checked **inside** the mutation
transaction, so concurrent transitions cannot double-apply — a 5-way parallel
`send` produces exactly one `200`, four stable `422`s, and exactly one audit
row.

"Mark as sent" is an internal status change. **No email, SMS, webhook or any
external delivery is performed or claimed** (§16).

## 3. Editing rules

- Lines may be added/edited/removed **only while DRAFT**.
- A line binds one product (at most once per order — DB-enforced by
  `@@unique([purchaseOrderId, productId])`), an integer quantity
  (1..1,000,000) and an integer unit price in minor units (0..1,000,000,000;
  zero is allowed for free/promotional items; negatives never).
- The line cap defaults to 200 (`PURCHASE_ORDER_MAX_LINES`, clamped 20..500).
  The write path counts inside the transaction, and re-counts after the
  insert — a concurrent race can never persist more than the cap.
- The document total is **server-derived with BigInt** and must stay a safe
  integer; an unsafe total is rejected with `422
  PURCHASE_ORDER_TOTAL_OVERFLOW` — never silently rounded.
- Client input never controls: businessId, status, supplier/product/currency
  snapshots, createdByUserId, or any total.

## 4. Historical snapshots (immutable history)

At write time the document freezes:

| Snapshot | Survives |
|---|---|
| `supplierNameAtOrder` | supplier rename, soft-delete |
| `productNameAtOrder`, `skuAtOrder`, `unitAtOrder` | product rename, SKU change, unit change, deactivation, soft-delete |
| `currencyCodeAtOrder`, `currencySymbolAtOrder`, `decimalPrecisionAtOrder` | business currency configuration change |

The live supplier name is shown only as navigation metadata (`supplier.name`,
`supplier.stillExists`); the display identity is always the snapshot. A
soft-deleted supplier blocks `DRAFT → SENT` (`422 INVALID_SUPPLIER`) but the
historical document stays fully readable. Deactivated products cannot be
ADDED to a draft, but editing an existing draft line remains allowed.

## 5. Corrupted persisted status — integrity policy

An unknown persisted `status` (corrupt data) is **never** silently treated as
`DRAFT` — a fake draft would expose edit/send behavior on an unknown state.
`parsePurchaseOrderStatus()` (pure, `types.ts`) throws the controlled
integrity error; the server maps it to `500
PURCHASE_ORDER_INVALID_PERSISTED_STATUS` with a fixed, value-free message.
The same policy covers detail, list, export, transitions, Supplier 360 and
product history. Global search omits the corrupted row's status token instead
of faking one.

## 6. API surface

| Method & path | Permission | Notes |
|---|---|---|
| `POST /api/v1/purchase-orders` | `data:write` | blank reference → server generates `PO-<YYYYMMDD>-<6>`; duplicate user-chosen reference → `409 DUPLICATE_PURCHASE_ORDER_REFERENCE` |
| `GET /api/v1/purchase-orders` | `data:read` | `q`, `status`, `from`/`to` (strict calendar dates, `from > to` → 422), `page`, `pageSize ≤ 100`; deterministic `orderedAt desc → createdAt desc → id desc` |
| `GET /api/v1/purchase-orders/[id]` | `data:read` | detail + ALL lines (cap-bounded) in one consistent transactional read |
| `PATCH /api/v1/purchase-orders/[id]` | `data:write` | DRAFT-only; reference/orderedAt/expectedDate/notes |
| `POST …/[id]/lines` | `data:write` | DRAFT-only; productId + orderedQty + unitPriceMinor; duplicate → 409 |
| `PATCH|DELETE …/[id]/lines/[lineId]` | `data:write` | DRAFT-only; qty/price only — product identity and snapshots are immutable |
| `POST …/[id]/send|confirm|close|cancel` | `data:write` | dedicated lifecycle endpoints |
| `GET …/[id]/export?locale=en|fa` | `data:read` + `CSV_EXPORT` | full-document CSV, rate limited 10/5min, `no-store`, attachment |

Foreign-tenant ids resolve to a safe `404` everywhere (no existence leak).

## 7. Integrations (all read-only, all bounded)

- **Global search**: finds POs by reference, supplier snapshot/current name,
  product snapshot names and SKUs. No monetary values in search results.
  Tenant-isolated (proven live).
- **Supplier 360**: ≤ 10 recent POs, line slices bounded by the line cap.
- **Product detail**: ≤ 10 recent procurement lines joined to their
  tenant-scoped order.
- **Data portability**: `purchase_orders` + `purchase_order_lines` datasets
  (CONFIDENTIAL, explicit columns, snapshots verbatim). **Import remains
  intentionally unsupported** for both datasets.
- **Notifications**: none. Purchase orders never create notification types.

## 8. CSV export (per order)

One row per line, order fields denormalized; **all** lines are exported
(cap+1 fetch proves completeness — never a page). Cells pass the shared OWASP
formula-injection guard (`csvCell`); BOM + CRLF; EN machine-form headers, FA
Persian headers; snapshot values only. Labels never say expense/payable/owed.

## 9. Testing & verification (P41-F)

- Pure unit suite: `bun --preload ./scripts/lib/register-server-only-shim.ts scripts/prompt41-unit.ts` — 233 assertions.
- Real E2E: `node scripts/prompt41-purchase-order-check.mjs` — 218 checks incl. concurrency storms, corruption probes, export gates and financial non-mutation; also gates `node --check` of the static scanner (§8 law) and runs the isolated cap process.
- Isolated cap/concurrency process: `PURCHASE_ORDER_MAX_LINES=20 bun --preload ./scripts/lib/register-server-only-shim.ts scripts/prompt41-purchase-order-cap-check.ts` — 20 checks.
- Static security scan: `node scripts/prompt41-purchase-order-static-scan.mjs` — 145 rules.
- Browser QA: 5 viewports × EN/FA × light/dark; screenshots `qa-p41-purchase-orders-*.png`; console clean; zero horizontal overflow.

## 10. i18n

Exact EN/FA key parity (`purchaseOrders` namespace + search group +
portability labels). Sidebar: "Purchase Orders" / "سفارش‌های خرید". CSV
headers are Persian in the FA export (no English fallback). Deep links:
`#/purchase-orders` and `#/purchase-orders/<id>` (malformed ids fall back to
the dashboard).
