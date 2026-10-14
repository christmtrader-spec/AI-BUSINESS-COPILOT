# Aging Details — Security Notes (Prompt 49)

Scope: `GET /api/v1/reports/aging/items`, `GET /api/v1/reports/aging/items/export`,
the `#/reports/aging-details` view, the AgingCard drill-down and the 360
aging panels. Classification: **CONFIDENTIAL financial data** (same tier as
statements and the aggregate aging).

## 1. Threat model additions

| Threat | Defense | Verified by |
| --- | --- | --- |
| Cross-tenant reads via partyId | partyId resolved INSIDE the server-derived tenant; foreign/deleted/unknown → 404 (no existence leak) | E2E K2/K3, unit J6 |
| Cross-tenant data via stolen cursor | cursor HMAC-bound to businessId + side + party + bucket + pastDue + version; mismatch → 422 | E2E K4/I7–I11, unit [2]/[3] |
| Cursor payload leaks business data | payload = opaque ids + ordering key only; no names/references/amounts/notes | static R4, unit 1d |
| Cursor forgery | HMAC-SHA256, constant-time compare, length bound, no unsigned JSON | static R3, unit [3] |
| Unauthenticated access | getAuthContext + data:read on both routes | E2E K6/K7 |
| Unauthorized export body leak | CSV_EXPORT gate + membership run BEFORE any row read; 403 carries no CSV body | E2E K8 |
| SQL/logic overreach | chunked keyset reads (take ≤ 400), per-request scan cap, explicit select projections — no `findMany()` without tenant filter | static R16, cap suite |
| Formula injection via party names | shared `csvCell()` OWASP guard ('-prefix for `=`/`+`/`@`/tab/CR; negative numbers untouched) | E2E X6 |
| Note / metadata leakage | `note`/`internalNotes` absent from every P49 select, DTO and CSV | static R11, E2E B8/X7 |
| Client authority over filters | side/bucket/pastDue closed vocabularies; limit clamped 10..100; party format-validated; businessId NEVER accepted from the client; timezone always the server-side business row | E2E J1–J5, static R6/R12 |
| History falsification | read-only derived view; no persistence, no as-of parameter | domain (no writes) |

## 2. Tenant isolation mechanics

- `getAuthContext()` (session + membership) yields `ctx.businessId`; every
  Prisma where-clause carries it (Sale/Expense/Customer/Supplier).
- The aging view parses `#/reports/aging-details?party=…` but the party is
  re-resolved server-side per request; a forged hash renders the honest
  not-found state — never another business's rows.
- Business B cannot use A's party ids, source ids, statement links, cursors
  or export path (E2E K1–K8 with two live isolated businesses).

## 3. Money & headers

- Integer minor units in every DTO field; the export serializes exact
  decimals once (`fromMinor(minor, precision).toFixed(precision)`); no
  floats, no currency symbols in machine columns.
- `Cache-Control: private, no-store` on the JSON; `no-store` + attachment
  Content-Disposition (ASCII filename, no PII) on the CSV.

## 4. Rate limits and audit

- items: 30/min/user+business (authenticated read tier).
- export: 10/5-min/user + the CSV_EXPORT billing entitlement.
- `data.export` audit rows carry side, scope flags and COUNTS only — no
  party names, no amounts beyond the aggregate counts, no notes.

## 5. UI-layer guarantees

- Statement row navigation resolves targets from server-provided
  `sourceType`+`sourceId` through the closed entity-route vocabulary —
  client text is never a route key; unsupported types stay read-only.
- Unassigned parties render "No party recorded" with NO destination —
  a fake party URL is unconstructible by design.
- Malformed deep links fall back safely (unknown side → receivables, unknown
  bucket/party dropped) — never a blank screen, never injected state.
