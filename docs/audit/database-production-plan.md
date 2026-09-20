# Database Production Plan — SQLite Today, PostgreSQL Later

**Audit doc:** Prompt 17 (r18) · **Scope:** persistence layer, migration safety, production readiness
**Headline:** SQLite is the right MVP engine, but the project currently uses `prisma db push --accept-data-loss` (`package.json:10`), which is **NOT migration-safe**. A baseline migration is REQUIRED before any production cutover.

---

## 1. Why SQLite works today

| Property | Evidence |
|---|---|
| Provider is `sqlite`, file `db/custom.db` | `prisma/schema.prisma:9-12`; `docs/ARCHITECTURE.md:52-57` |
| Single Next.js process, single node | standalone server via `bun .next/standalone/server.js` (`package.json:8`); architecture is a modular monolith (`ARCHITECTURE.md:30-49`) |
| Low write concurrency | writes are short transactional UI actions (invoice/payment CRUD); the only bulk path is import, itself rate-limited to 4/5min (`businesses/[id]/import/route.ts:72`) |
| Embedded = zero-ops | no DB server, no credentials to rotate; whole-DB backup is a single file copy |
| Client is a plain `PrismaClient` | `src/lib/db.ts:1-13` — **no `PRAGMA` / WAL configuration anywhere in code** (verified: no `pragma`, `journal_mode`, or `busy_timeout` is set). SQLite therefore runs with its default rollback journal; durability/locking characteristics are SQLite defaults, not tuned. The `log: ['query']` option (db.ts:10) is dev-oriented verbosity that should be dropped in production. |

Constitution framing matches this: simplest architecture that evolves safely (RULE 06, `docs/PROJECT-CONSTITUTION.md:289-293`).

---

## 2. Production limitations of SQLite (honest list)

| Limitation | Concrete consequence for this app |
|---|---|
| **Single writer at a time** (file-level write lock) | Two concurrent payment POSTs, or a report running amid writes, contend on one lock; under load users see latency or `SQLITE_BUSY`-style failures. The single-writer payments pipeline (`payments/route.ts:101-184`) is safe-but-serialized |
| **No network access** | The DB is a local file — the app cannot scale horizontally or split API/DB; a second instance would need a shared volume (worse: locking over network FS is unsafe) |
| **No connection pooling** | `PrismaClient` opens the file directly; there is no pooler tier, so connection count = process count and heavy parallelism queues on the file lock |
| **Single-file backup only** | Backup = copy `db/custom.db`; consistent hot backups require care (VACUUM INTO / filesystem snapshot), and there is no PITR |
| **No server-side enforcement depth** | No stored procedures/constraints beyond what Prisma emits; all invariants live in app code (§3 of financial-semantics audit) |

---

## 3. What changes for PostgreSQL

### 3.1 Provider & driver
- `datasource db { provider = "sqlite" }` → `"postgresql"` + `DATABASE_URL` (`prisma/schema.prisma:9-12`). Code impact is small: all data access is Prisma-idiomatic (no raw SQL found in `src/lib`), and `db.ts` needs only env-driven log levels.

### 3.2 Enum migration from string columns
SQLite lacks Prisma enums, so role/status columns are strings validated in app code (`prisma/schema.prisma:14-16`; `rbac.ts:7-9`). For Postgres, decide per column:
- **Promote to `enum`:** `BusinessMember.role` (schema:78), `Sale.status`/`Expense.status` (schema:234, 274), `Payment.direction` (schema:297), `Payment.method` (schema:299), `ChatMessage.role` (schema:345). Keep the authoritative sets in `rbac.ts` / `money.ts:106` / `schemas.ts:66` mirrored — or generate the enums FROM those constants to avoid dual sources.
- **Keep as `String`:** free-text-ish values (`Payment.note`, categories, locales, timezones) — unchanged.
- Data migration must backfill-verify: every `role` ∈ ROLES (`rbac.ts:11-18`), every `status` ∈ {UNPAID, PARTIAL, PAID} (`money.ts:106-115`), `direction` ∈ {IN, OUT}, `method` ∈ `PAYMENT_METHODS` (`schemas.ts:66`).

### 3.3 DateTime precision
SQLite stores Prisma `DateTime` as ISO-8601 text; PostgreSQL uses `timestamp(3)`. No application change (Prisma normalizes), but note: (a) range predicates (`issueDate ≥ …`, `paidAt ≥ …` — reports.ts:62-73) become index-friendly native temporal comparisons; (b) any historically hand-edited rows with sub-millisecond strings would need normalization; (c) all timestamps remain UTC per A07 (`schema.prisma:2-3`).

### 3.4 Constraints preserved 1:1
All `@@unique`/`@unique` survive the swap and MUST be verified in the first migration diff: `User.email` (schema:20), `Business.slug` (41), `@@unique([businessId, userId])` membership (81), `BusinessInvite.token` (93), `@@unique([businessId, number])` invoice numbering (244), `@@unique([businessId, userId, id])` chat sessions (336). The invoice-number uniqueness is load-bearing for I10 of the financial-semantics audit (`sales/route.ts:163-170`).

### 3.5 Transaction isolation — the one real code risk
- Today: SQLite effectively **serializes all writes**; the check-then-act overpayment guard (`payments/route.ts:116-122, 139-145`) cannot race because the write lock is held across the transaction.
- PostgreSQL: default isolation is **READ COMMITTED**; two concurrent payment POSTs against the same invoice can both read the same `paidMinor` and both pass the guard (lost update / overpayment window).
- **Required hardening at cutover (choose one, document in ADR):** `SELECT … FOR UPDATE` on the Sale/Expense row inside the tx; or make the update conditional (`UPDATE sale SET paidMinor = paidMinor + x WHERE id = ? AND paidMinor + x <= totalMinor` and check affected rows); or run the payments transaction `SERIALIZABLE`. The same analysis applies to invoice numbering (`sales/route.ts:164-170` max+1 under `@@unique` — retry on conflict) and chat-session upsert caps (`…/messages/route.ts:69-109`).

### 3.6 `prisma db push` is NOT migration-safe — flag
- Current workflow: `"db:push": "prisma db push --accept-data-loss"` (`package.json:10`) — it diffs the schema straight into the DB and **will drop/recreate columns/data** to match. There is **no `prisma/migrations/` history** to audit what changed or to reproduce a schema from scratch.
- **Requirement before production:** stop using `db:push` against shared/prod data; run a **baseline migration** (`prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma` → init migration), then move all envs to `migrate deploy`. The `db:migrate` / `db:reset` scripts already exist (`package.json:12-13`) but are not the operating procedure today.

### 3.7 Data types preserved
- Money stays `Int`/`INTEGER` minor units in Postgres (`schema.prisma:179-180, 229-234, 260, 272-274, 298`) — A08 law unchanged; do **not** "upgrade" to NUMERIC/Decimal (would violate the integer-arithmetic invariants, `money.ts:62-74`).
- IDs stay `String` cuid (`schema.prisma:19, 39, …`) → `TEXT` in Postgres. `ChatSession.id` remains client-generated with format validation (`schemas.ts:136-139`; messages route:37-40) — the triple unique (§3.4) keeps that safe.
- JSON-ish columns (`beforeJson`, `afterJson`, `metaJson` — schema:117-118, 350) may become `JsonB` later; as `String` they work unchanged.

---

## 4. Migration strategy (when Postgres is approved)

```text
1. BASELINE    freeze schema → create prisma/migrations/0001_baseline from the
               current datamodel (§3.6) → `migrate deploy` sanity-run on a copy
               of db/custom.db imported via a one-off ETL script
               (SQLite → SQL insert order: Business → members → master data →
               Sale/SaleItem → Expense → Payment → InventoryAdjustment →
               AuditLog → ChatSession/ChatMessage; respect FK direction)
2. SHADOW DB   let `prisma migrate dev` use its shadow database to prove every
               subsequent migration applies cleanly from empty
3. DUAL-RUN    deploy N+1 with Postgres behind a feature flag; run read-only
               parity jobs: buildReportSummary outputs byte-identical per
               business/day (reports.ts:212-241) on both engines; verify
               statusOf invariants (money.ts:106-115) over the full dataset
4. CUTOVER     write-freeze window → final SQLite export → import → flag flip
               → keep SQLite file for N weeks as cold backup; then hardening
               from §3.5 (row locks / conditional updates) lands WITH or
               BEFORE cutover, not after
```

Rollback plan: the SQLite file is never deleted at step 4; flip the flag back.

---

## 5. Query-performance watchlist

### 5.1 Indexes already present (from `prisma/schema.prisma`)

| Model | Indexes |
|---|---|
| Business | `ownerId` (68) |
| BusinessMember | `@@unique([businessId, userId])` (81); `userId` (82) |
| BusinessInvite | `[businessId, createdAt]` (105); `token` unique (93) |
| AuditLog | `[businessId, createdAt]` (124); `[entityType, entityId]` (125) |
| Customer / Supplier | `[businessId, deletedAt]`, `[businessId, name]` (148-149 / 166-168) |
| Product | `[businessId, deletedAt]`, `[businessId, name]` (192-193) |
| InventoryAdjustment | `[businessId, createdAt]`, `[productId, createdAt]` (208-209) |
| Sale | `@@unique([businessId, number])` (244); `[businessId, deletedAt, createdAt]` (245); `[businessId, status]` (246); `customerId` (247) |
| SaleItem | `saleId` (262) |
| Expense | `[businessId, deletedAt, createdAt]` (283); `[businessId, status]` (284); `supplierId` (285) |
| Payment | `[businessId, paidAt]` (306); `saleId` (307); `expenseId` (308) |
| ChatSession | `@@unique([businessId, userId, id])` (336); `[businessId, userId, updatedAt]` (337) |
| ChatMessage | `[sessionId, createdAt]` (356); `userId` (357) |

### 5.2 Hotspots to watch (honest list)

| Hotspot | Why | Evidence |
|---|---|---|
| **Reports aggregate over whole tables** | `buildReportSummary` / `buildMonthlyBreakdown` / `buildMonthDetail` fetch every matching row and bucket **in JS** (not SQL GROUP BY); row count grows with business age × activity | `reports.ts:60-113, 303-316, 431-468`; bucketing loops `115-136, 326-352, 470-487` |
| **Date filters vs index shape** | Report windows filter on `issueDate`/`spentAt`/`paidAt`, but the composite indexes lead with `deletedAt`/`createdAt` (`schema.prisma:245, 283`); SQLite+small data is fine, Postgres planner will still scan ranges — add `(businessId, issueDate)` / `(businessId, paidAt)` if reports slow down | filters `reports.ts:66-72, 305-310, 436, 465`; indexes above |
| **`SaleItem` via relation** | Top-products query filters items through the parent Sale relation (`reports.ts:82-91`); fine now, becomes a join to watch at scale on Postgres | — |
| **Receivables/payables `take: 200`** | List endpoints cap rows (correct totals come from `reports.ts:103-112` aggregates); >200 open documents = UI truncation, not data loss | `receivables/route.ts:19`, `payables/route.ts:19` |
| **AuditLog unbounded growth** | Every mutation appends (audit.ts callers across routes, e.g. `payments/route.ts:169-181`); no retention/pruning job exists. Index `[businessId, createdAt]` (schema:124) keeps listing sane, but plan partitioning/archival | `audit/route.ts` viewer; schema:108-126 |
| **ChatMessage growth** | Capped per session (200) and sessions per user (20, best-effort) but unbounded across users/time; `metaJson` ≤ 4000 chars each (messages route:31). Watch table size; deleteMany on clear already exists | `copilot/sessions/[id]/messages/route.ts:29-31, 83-96`; sessions/route.ts:90-92 |
| **`log: ['query']` in production** | Full query logging on every request (db.ts:10) — noise + latency; gate by env before prod | db.ts:7-11 |

---

## 6. Decision summary

1. SQLite + current single-node deploy is **correct for the MVP**; no premature Postgres (RULE 06).
2. The **urgent** item is not the engine — it is replacing `db push --accept-data-loss` with a baselined migration history (§3.6) so *any* future change (even staying on SQLite) is reproducible.
3. Postgres cutover is a contained change (§3) with exactly one deep code concern: **transaction isolation for the payments pipeline and invoice numbering** (§3.5), which must ship with the cutover ADR.
4. Performance work should be data-driven: the watchlist (§5.2) names the only places where growth can hurt; nothing requires speculative optimization today.
