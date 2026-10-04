# Party Statements — Security Notes

**Prompt 39** · Scope: `/api/v1/{customers,suppliers}/[id]/statement(+/export)`, `src/lib/statements/`, `#/statements`.

---

## 1. Tenant isolation

- The business scope ALWAYS comes from `getAuthContext()` (session →
  membership → server-resolved `businessId`). No route, query or cursor ever
  accepts a business scope from the client (`x-business-id` is the client
  convenience header for the server to RE-VERIFY — never an authority).
- Party authorization: a statement request loads the party with
  `{ id, businessId, deletedAt: null }` — a customer/supplier from another
  business or a soft-deleted one returns **404** (identical to an unknown id:
  no existence leak), never 403.
- Every statement query (aggregates, counts, page windows) repeats the
  `businessId` + party + `deletedAt: null` predicates — there is no code path
  that aggregates a party's transactions without the tenant scope.
- Cursor tenant safety: the signed cursor payload binds `businessId`; a cursor
  minted in Business A is rejected for Business B (422), even for the same
  party id string.

## 2. Party authorization & RBAC

- Permission: `data:read` only (all roles ≥ VIEWER already hold it). No new
  permission; statements are read-only — no POST/PATCH/DELETE handlers exist
  for statement routes.
- The detail-page "Statement" CTA deliberately renders for every role (it
  requires no `data:write`).

## 3. Payment target authority

- Statement payments resolve their party exclusively through the target
  transaction (`Payment.sale.customerId` / `Payment.expense.supplierId`) with
  the target's `deletedAt: null` enforced in the same query. `Payment.actorId`
  (the user who recorded the payment) is never treated as party identity.
- Orphan/mismatch defense: a payment can only enter a statement when target
  transaction + target party + business all match — there is no path where a
  payment contributes a movement through a display name, an actor id, or a
  client-declared direction.

## 4. Soft delete semantics

- Deleted Sales/Expenses are excluded (`deletedAt: null` in every query); a
  payment whose target is deleted is excluded with it. Deleted payment rows no
  longer exist, so reversal is exclusion by absence. The statement is always
  recomputed from remaining rows — no cached "historical payment event"
  survives a reversal.

## 5. Cache isolation

- Response headers: `Cache-Control: private, no-store` on statement responses;
  `no-store` on CSV exports. No shared/public cache anywhere.
- TanStack Query keys carry `["statements", <type>, <businessId>, <partyId>,
  <from>, <to>, <cursor>]` — a Customer A statement can never be served for
  Supplier B (type is in the key) or across businesses (businessId is in the
  key). A business switch invalidates the query cache; a statement whose party
  does not exist in the new business renders the not-found state.
- Transaction mutations (sale/payment/expense create/delete) invalidate the
  `["statements"]` family through the shared `useInvalidateFinance()` helper —
  targeted invalidation, never the whole query client.

## 6. Cursor security

- The cursor is `base64url(JSON payload) + "." + base64url(HMAC-SHA256)`
  signed with `STATEMENT_CURSOR_SECRET` (fallback: `NEXTAUTH_SECRET`; constant
  dev fallback for single-node test runs — set a dedicated secret in
  production). Signature verified with `timingSafeEqual`; NO JWT.
- Payload contains ONLY stable IDs + ordering metadata (`v, k, b, p, f, t, ts,
  id, st`) — never names, emails, phones, notes, or business secrets.
- The cursor is bound to kind + business + party + from + to: any parameter
  mismatch or one-character tampering → 422 `VALIDATION_ERROR` (field
  `cursor`), never a degraded query. Cursors are stateless (no cursor table)
  and do not expire (no project expiry convention to reuse — documented in the
  ADR).
- The client never constructs a cursor object; it can only echo the opaque
  token back.

## 7. Export security

- Identical authentication/membership/`data:read`/tenant scope as the
  statement endpoint, plus the established CSV export conventions:
  `CSV_EXPORT` entitlement gate (server-side, fresh read) and 10 exports /
  5 min / user rate limit (shared limiter, no second limiter).
- Export endpoints are GET-only; no arbitrary file paths; the filename is
  `<type>-statement-<from>_<to>.csv` — the party name never enters the
  filename.
- The export walks the same engine with the same tenant predicates — it cannot
  export beyond the caller's business.

## 8. CSV safety

- UTF-8 with BOM (Persian-safe Excel opening), CRLF rows, RFC 4180 quoting.
- Formula-injection guard (shared `csvCell`): cells beginning with `=`, `+`,
  `@`, tab or CR get a leading apostrophe; non-numeric leading `-` guarded
  while negative numbers stay numeric for accounting use.
- Stored data is never altered — only the export representation is escaped.

## 9. Sensitive-data exclusion

The statement DTO and CSV contain ONLY: event id (source-type-prefixed),
event type, instant, business-facing reference, localized description,
integer amounts. They never contain:

- private notes (`Sale/Expense/Payment.note`);
- internal audit payloads (`AuditLog.beforeJson/afterJson`);
- actor IPs, user agents, session data;
- platform data (Subscription, CheckoutSession, PaymentTransaction,
  PlatformAuditLog);
- AI cost data (AiCostRate/Record/Anomaly) or Copilot transcripts;
- Notification rows or delivery metadata;
- internal database ids beyond the event id required by the API contract (and
  never in the CSV).

CSV rows carry business-facing references only (invoice numbers, stated bill
references/categories). Party identity never enters the audit record of an
export (`data.export` stores statement type + calendar range only).

## 10. Safe logging

- No `console.*` logging in the statement domain; unhandled errors surface
  through the central route wrapper (structured, bodyless in production).
- Safe fields if diagnostics are ever added: operation, statementType,
  duration, eventCount, status, requestId — never customerId/supplierId,
  party names, invoice references, payment details, or party-identifying
  date ranges.

## 11. Rate limiting & abuse

- Statement reads: 30 / min / user+business on the shared limiter (normal
  authenticated read limits — no second limiter).
- Exports: 10 / 5 min / user (mirrors report exports).
- Both fail with 429 + `retryAfterMs`; the limiter fails open by design
  (documented product-wide behavior, single-node deployment).
