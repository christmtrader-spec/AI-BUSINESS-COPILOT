# Business Reports — Security Dossier (Prompt 50)

**Scope:** every `/api/v1/reports/*` route (summary, export, monthly,
monthly/[month], monthly/[month]/export, aging, aging/export,
aging/items, aging/items/export, performance, performance/export) and the
report engines they call.

## 1. Threat surface and controls

| Control | Implementation | Verified by |
|---|---|---|
| Authentication | `getAuthContext(req)` on every route — no session, no data (401 envelope). | P50 E2E G1 |
| Tenant isolation | `ctx.businessId` is SERVER-derived from session+membership; no route accepts a client businessId. Every engine query filters by it. | P50 E2E G11/G12 |
| Permission | `requirePermission(ctx, "data:read")` everywhere. | P50 E2E G1 |
| Entitlements | `ADVANCED_REPORTS` gates the advanced summary block + performance APIs (server-side omission / 403). `CSV_EXPORT` gates EVERY CSV route (main, monthly, aging, performance). | P50 E2E D1–D13 |
| Input validation | Closed enums for kind/groupBy/direction; strict `YYYY-MM-DD`/`YYYY-MM` keys; real-calendar-date parsing; ≤366-day custom ranges; limit clamps; cursor length ≤1024. | P50 E2E G2–G10 |
| No client timezone | Timezone is the business's persisted setting; the browser value is never read. | unit [3]/[4] |
| Sort/group-field injection | Grouping dimensions are closed enums — no client-selected DB fields. | P50 E2E G3 |
| Cursor tampering | HMAC-SHA256 signed, constant-time compared, bound to tenant+kind+range+direction+version. | unit [13], E2E F24/F25 |
| Bounded queries | Scan caps + group caps + keyset pagination + keyset-chunked exports; `truncated`/`groupTruncated`/`hasMore` markers; complete-or-reject exports. | P50 cap-check |
| Safe money | Integer minor units only; `safeAdd/safeMul` guards; BigInt allocation; controlled integrity errors. | unit [9]/[10]/[11] |
| Response hygiene | `Cache-Control: no-store` on report JSON/CSV; standard error envelope; no Prisma exceptions leak. | static scan [10] |
| Export hygiene | Formula-injection-escaped cells, BOM+CRLF, stable headers, safe filenames, rate limit 10/5min/user, `data.export` audit. | E2E E7/E8; static [4f/4g] |
| Rate limiting | Performance reads 30/min/user; ALL CSV exports 10/5min/user (429 with retryAfterMs). | P50 E2E (429 shape) |
| Audit | `data.export` on every CSV (ReportCSV / ReportMonthCSV / ReportPerformanceCSV) with IP+UA. | static [4g] |

## 2. Information model — what exports may contain

- Product/customer/supplier display names, category labels, calendar keys,
  amounts, statuses, invoice numbers, sale/expense stable ids (safe source
  navigation references).
- NEVER: internal notes, user identity data, authentication metadata,
  session ids, AI prompts, supplier invoice references beyond the approved
  reference fields, cross-tenant rows of any kind.

## 3. Cross-tenant guarantees

- The performance cursor is bound to the tenant (`b` field) AND the filter
  binding (`k` field) — a cursor minted in one tenant is invalid in
  another (422), and decoding verifies businessId equality.
- Tenant-scoped relation lookups: customer/product name resolution always
  includes `businessId` (ids alone never prove ownership — D50-C fix).
- Isolation is live-tested: a second business's 999,000-minor sale never
  appears in the first business's reports (E2E G11/G12).

## 4. Entitlement matrix (current billing contract, unchanged)

| Plan | Basic reports | ADVANCED_REPORTS | CSV_EXPORT |
|---|---|---|---|
| FREE | yes | no (block omitted; performance 403) | yes |
| STARTER and above | yes | yes | yes |

UI hiding is never the enforcement; every gate re-reads the subscription
server-side per request (`§111` fresh-read law).

## 5. Residual risks (honest)

- Signed cursors are stateless (no expiry) — the documented P39/P49
  trade-off; rotation of `STATEMENT_CURSOR_SECRET` invalidates all.
- SQLite local deployment: the report engines are read-heavy but bounded;
  no unbounded `findMany` remains in the report paths (static scan [1]).
- The 366-day custom cap applies to NEW advanced endpoints; legacy
  endpoints keep their documented parameters (backward compatibility).

## 6. Inventory valuation report (Prompt 51 — security contract)

- **Tenant isolation:** the product scan is `businessId`-scoped on every
  chunk (keyset `id >` cursor); `businessId` is never a query parameter —
  the scope comes from `getAuthContext()` membership resolution. Live
  tests: business B's catalog never appears in A's report; A's search for
  B's unique product name returns zero rows in both full and partial-name
  probes; B's CSV contains exactly B's rows.
- **Input validation:** closed enums for `costState/stockState/activity/
  sort` (422 `VALIDATION_ERROR`), `q` bounded at 80 chars (422 beyond),
  strict integer `page ≥ 1` and `pageSize ∈ [1,100]` (422 on malformed or
  out-of-range — never silently clamped).
- **Authorization:** JSON report = `data:read` (a drill-down of the basic
  summary KPI; deliberately NO `ADVANCED_REPORTS` gate — the gate protects
  the ADVANCED block, not basic detail). Export = `data:read` + the
  existing `CSV_EXPORT` entitlement enforced server-side (fresh read).
  Verified live: `CSV_EXPORT=false` plan → 403 on the export while the
  JSON stays 200.
- **Bounded reads:** chunked keyset scan (≤500/chunk) capped at
  `INVENTORY_SCAN_CAP` (50,000, env-clamped) — over-cap is a controlled
  413 `REPORT_TOO_LARGE`; exports cap at `INVENTORY_EXPORT_MAX_ROWS`
  (10,000) → 413 `EXPORT_TOO_LARGE`. A partial total or a partial file is
  never served as complete.
- **Rate limits:** JSON 60/min per user+business; export 10/5min per user
  (the shared `report-export:` limiter). Both responses `private,
  no-store`.
- **Read-only:** the service and both routes contain no mutation calls
  (static scan §6); live before/after snapshots show product rows
  byte-identical (including `updatedAt`) and zero new
  Sale/Expense/Payment/SupplierBill/InventoryAdjustment rows.
- **CSV safety:** shared `csvCell` formula-injection guard (verified with
  a product literally named `=SOMEFORMULA()` — downloaded as
  `'=SOMEFORMULA()`), UTF-8 BOM, CRLF, safe attachment filename, meta
  block stating the basis and limitation, no debug output.
- **Response hygiene:** the select projection carries exactly the eight
  safe product fields (no notes, no supplier relations, no audit
  payloads).
