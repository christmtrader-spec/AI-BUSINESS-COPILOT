# Global Search (Prompt 33)

Status: IMPLEMENTED (deterministic structured search — see "Honest limitations").

## 1. Scope

Global search is a **read-only DISCOVERY layer** over the ACTIVE business. It
helps the user answer: *"What did I search for, what is it, and where can I
open it?"* It is never an authority layer: it never mutates data, never
bypasses RBAC or tenant isolation, and never exposes platform/security-secret/
AI-cost/payment-processor internals.

Entry points:

- **Header Search button** (existing) → opens the Command Palette.
- **⌘K / Ctrl+K** → Command Palette with inlined search results (§12).
- **Search Results Center** `#/search` and `#/search?q=<query>` (§13).

## 2. Supported entities and searchable fields

| Entity | Searchable fields | Title | Subtitle | Extra tokens |
| --- | --- | --- | --- | --- |
| CUSTOMER | name, phone, email | name | phone, else email | — |
| SUPPLIER | name, phone, email | name | phone, else email | — |
| PRODUCT | name, sku | name | sku | ACTIVE / INACTIVE |
| SALE | number (numeric + `INV-0001` display form), note, customer.name | formatted invoice number (`formatInvoiceNumber`, never duplicated) | customer name | UNPAID/PARTIAL/PAID, issue date |
| EXPENSE | category, note, supplier.name | category | supplier name | UNPAID/PARTIAL/PAID, spent date |
| PAYMENT | note, method, linked sale invoice number, sale.customer.name, expense.category, expense.supplier.name | localized "Payment"/"پرداخت" (server-side, user's persisted locale) | related invoice/category/name | IN/OUT, method, paid date |

Deliberately NOT searched (kept concise / private): customer/supplier address
and note (v1), product prices, all amounts, AI Copilot conversations
(`ChatSession`/`ChatMessage`), notifications, audit logs, export/import jobs,
users, sessions, platform tables, billing internals.

## 3. Ranking (deterministic, never random)

Priority (server-internal weights, never exposed to the client):

1. `EXACT = 1000` — full-field (title) equality with the query
2. `IDENTIFIER_EXACT = 950` — invoice number / SKU / numeric form equality
3. `PREFIX = 800` — title or identifier starts with the query
4. `TITLE_CONTAINS = 650` — title contains the query
5. `SECONDARY_CONTAINS = 450` — email/phone/note/customer/supplier contains

Tie-breakers: `createdAt` **descending**, then `id` **ascending** (documented
choice; stable and index-friendly). The same input always produces the same
order. Recency is never a score — only a tie-breaker.

## 4. Limits and bounds

| Bound | Value |
| --- | --- |
| `q` length | 2–64 Unicode characters (code points); <2 → `422 VALIDATION_ERROR`, >64 silently clamped |
| `types` | optional, comma-separated, **closed allowlist**, unknown values rejected, duplicates deduped |
| `limit` | default 20, clamped into [6, 30] (project clamp convention) |
| Per-entity candidate cap | 8 rows (`SEARCH_PER_ENTITY_TAKE`) |
| Maximum candidate pool | 6 × 8 = 48 rows |
| Maximum response | 30 results (`total` = returned items, `truncated` flag when the ranked pool exceeded the cap) |

No unbounded `findMany`, no `count()` per entity, no full-table scans, no raw
SQL. Every query uses an explicit `select`.

## 5. Normalization (§17)

`normalizeSearchText` (pure, idempotent): trim → collapse whitespace → NFKC →
strip zero-width noise + control chars → Arabic `ي/ى`→Persian `ی`, `ك`→`ک` →
tatweel removed → Latin lowercase → Persian/Arabic digits → Latin digits.

`getSearchVariants` returns at most TWO variants (canonical + Arabic
compatibility `ی→ي`, `ک→ك`) — no combinatorial explosion. Invoice lookups:
`INV-0001`/`inv-25`/`25`/`001`/Persian digits all resolve to the numeric
invoice number (≤ 9 digits, via the existing `finance.ts` formatter for
display).

## 6. UX

### Command Palette (⌘K / Ctrl+K)

- Query < 2 chars: the existing navigation/preferences/session palette only.
- Query ≥ 2 chars: debounced (250 ms) server search renders grouped results
  FIRST, then "View all search results" → `#/search?q=…`, then the existing
  navigation/preferences/session groups (still filtered client-side).
- Loading, no-results and error states are localized; keyboard: ↑ ↓ Enter
  Escape; Escape closes; clicking a result only NAVIGATES to the owning
  module — the palette never executes mutations.
- Stale-response protection: results are keyed by the exact query in TanStack
  Query, so an older response can never overwrite a newer query's results.

### Search Results Center (`#/search`)

- Large autofocused input; query persists in the URL hash (refresh + browser
  back/forward keep it; `encodeURIComponent` only).
- Filters: All / Customers / Suppliers / Products / Sales / Expenses /
  Payments (closed vocabulary).
- Grouped, scannable result rows (icon · title · subtitle · status/method
  badge · localized date); every row navigates to its module; **no mutation
  actions exist in Search Center**.
- States: too-short hint, empty, loading, rate-limited, generic retryable
  error — all localized, never raw errors.
- Mobile (390×844 / 412×915): no horizontal overflow, 44px touch targets,
  horizontally scrollable filter chips, `dir="auto"` for mixed content.

## 7. Business scoping (§18)

The active business is the ONLY search boundary. Every request goes through
`getAuthContext` (session → verified membership → `ctx.businessId`), so:

- Business A's search never returns business B's records (harness-proven).
- `?businessId=…` in the query string is ignored (never authority).
- TanStack Query keys include `businessId` + `query` + `types`; the business
  switcher invalidates all queries on switch. The server remains the real
  authority regardless of cache state.

## 8. Future options (NOT implemented — documented honestly)

- SQLite FTS5 / Postgres full-text search: **not implemented**. `contains`
  substring matching is fine at MVP dataset scale; an FTS migration would
  only be justified by a measured performance problem (no index pretends to
  solve `%substring%` today).
- Fuzzy/typo-tolerant matching, phonetic search, semantic/AI search: NOT
  implemented.
- Cross-business search, audit search, notification search, search history /
  saved searches: intentionally out of scope.

## 9. Current SQLite limitations

- `contains` uses `LIKE %q%`: case-insensitive for ASCII, case-sensitive
  elsewhere (Persian has no case — covered by the variant mechanism above).
- No relevance scores beyond the deterministic weighting; no phrase/boolean
  operators; the whole query is matched as one substring.

## 10. Files

- Server: `src/lib/search/{types,normalize,schema,rank,query,service,dto,group,index}.ts`,
  `src/app/api/v1/search/route.ts`
- Client: `src/modules/search/{search-api,search-icons,search-view}.tsx(ts)`,
  `src/modules/shell/command-palette.tsx`, `src/store/app-store.ts`
- Tests: `scripts/prompt33-unit.ts`, `scripts/prompt33-search-check.mjs`,
  `scripts/search-static-scan.mjs`
- Security: see `docs/security/global-search-security.md`

## Prompt 34 — Exact-entity navigation (update)

Since Prompt 34, selecting a search result navigates to the EXACT ENTITY
DETAIL, not the module list:

- `CUSTOMER` → `#/customers/<id>` · `SUPPLIER` → `#/suppliers/<id>` ·
  `PRODUCT` → `#/products/<id>` · `SALE` → `#/sales/<id>` ·
  `EXPENSE` → `#/expenses/<id>` · `PAYMENT` → `#/payments/<id>`.
- The server response is unchanged (closed type tokens + id only); the
  client resolves `type + id` through the closed `SEARCH_TYPE_TO_ENTITY`
  map (`src/lib/entity-routes.ts`) and the centralized hash encoder.
  No URL is ever taken from server data or user input.
- "View all search results" still opens `#/search?q=…`.

See `docs/product/entity-details.md` and
`docs/security/entity-detail-security.md`.


## Prompt 35 additions — CRM search

Search now spans **eight** entity types: the original six plus
**LEAD** and **OPPORTUNITY**.

- LEAD fields: name, companyName, phone, email, sourceDetail (notes are
  matched as secondary fields only, never shown as titles).
- OPPORTUNITY fields: title, description, customer.name, lead.name.
- Groups appear in the Search Center with localized labels (Leads / فرصت‌ها)
  and the filter chips include Leads and Opportunities.
- Results deep-link through the closed `SEARCH_TYPE_TO_ENTITY` map to
  `#/leads/<id>` / `#/opportunities/<id>`; the API `destination` string is
  never trusted for navigation (Prompt 34 law, unchanged).
- Same privacy rules: 2–64 char q, bounded candidate caps, no query logging,
  no search history.


## GOODS_RECEIPT (Prompt 42)

Goods receipts join universal search as a tenant-scoped, read-only discovery
surface. Searchable fields (§122): receipt `reference`, PO reference snapshot
(`purchaseOrderReferenceAtReceipt`), supplier snapshot
(`supplierNameAtReceipt`), and product snapshot names/SKUs from receipt lines.
NO money exists in this domain and NO stock quantities are carried in the
snippet payload. Tenant isolation is absolute (businessId in every WHERE;
verified in both directions); a corrupted persisted status never renders as
Draft — its status token is safely omitted (§124). Results deep-link to
`#/inventory/goods-receipts/<id>`; the candidate pool is bounded by the
per-entity search take and the receipt line cap.
