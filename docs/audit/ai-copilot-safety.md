# AI Copilot Safety Audit — Grounding Pipeline, Guards & Findings

**Audit doc:** Prompt 17 (r18) · **Scope:** `/api/v1/copilot/*`, `src/lib/ai/*`, transcript persistence
**Verdict:** the copilot is a **read-only, snapshot-grounded narrator**. The LLM has no database access, no tool-calling, and no write path. One LOW finding on transcript self-append (accepted residual risk, §7).

---

## 1. Actual request flow (as implemented)

```text
User question
  → POST /api/v1/copilot | /api/v1/copilot/stream
  → getAuthContext: session → x-business-id header → membership lookup → role   (tenant.ts:38-77)
  → requirePermission(ctx, "copilot:use")                                       (copilot/route.ts:28, stream:32)
  → rateLimit(`copilot:${userId}:${businessId}`, 10, 60_000)                    (copilot/route.ts:30, stream:34)
  → zod parse: question ≤500 chars, history ≤8 msgs (content ≤2000), days 7|30|90 (schemas.ts:119-126)
  → server builds tenant-scoped snapshot (deterministic, pre-formatted money)   (ai/snapshot.ts:51-113)
  → system prompt + snapshot JSON + ≤6 history turns + question                 (copilot/route.ts:56-64)
  → LLM narrates ONLY over snapshot figures; returns text                       (ai/provider.ts:16-24, 67-106)
  → response { answer, meta }  |  SSE: meta → delta* → done/error               (copilot/route.ts:88, stream:78-149)
```

**Intent resolution happens inside the LLM turn** (the model reads the question against the snapshot) — there is no separate intent-classification call. Note a documentation drift: `docs/ARCHITECTURE.md:81-101` and Constitution A12/A13 (`PROJECT-CONSTITUTION.md:217-228`) describe a `lib/copilot/tools.ts` allow-list + `lib/copilot/metrics.ts`; those modules **do not exist**. The implemented grounding is stricter in effect (no tool layer at all) and lives in `src/lib/ai/snapshot.ts` + `src/lib/reports.ts`. Flagged for a doc ADR.

---

## 2. The grounding snapshot — exactly what the server computes

`buildCopilotGrounding` (`src/lib/ai/snapshot.ts:51-113`) runs one `Promise.all` of 4 direct queries, the first of which (`buildReportSummary`) fans out into 8 more. **Every query is `WHERE businessId = ctx.businessId`** (passed from the verified membership context, `copilot/route.ts:39-51`):

| # | Query (file:line) | Purpose | Inputs / validation | Tenant scope | Output into snapshot | Failure mode |
|---|---|---|---|---|---|---|
| Q1 | `db.business.findUnique` (reports.ts:35-38) | Timezone for day bucketing | `businessId` from ctx | `where: { id: businessId }` | `timezone` string | Falls back to `"UTC"` (reports.ts:39) |
| Q2 | `db.sale.findMany` (reports.ts:62-69) | Invoiced revenue + count in window | `days ∈ {7,30,90}` (schemas.ts:122-125; normalizeReportDays reports.ts:16-19); `deletedAt: null`, `issueDate ≥ fetchFrom` | `businessId` | `kpis.revenueIssued`, `salesCount`, daily `invoiced` | Empty → zeros; ratios become "not available (no revenue)" (snapshot.ts:150,152) |
| Q3 | `db.payment.findMany` (reports.ts:70-73) | Cash in / cash out | `paidAt ≥ fetchFrom` | `businessId` | `cashCollected`, `cashPaidOut`, `netCashFlow`, daily series | Empty → zeros |
| Q4 | `db.expense.findMany` (reports.ts:74-81) | Expenses in window | `spentAt ≥ fetchFrom`, `deletedAt: null` | `businessId` | `expensesRecorded`, `expensesByCategory`, daily `expenses` | Empty → zeros |
| Q5 | `db.saleItem.findMany` (reports.ts:82-91) | Top products by revenue | via `sale: { businessId, deletedAt: null }` relation filter | scoped through parent Sale | `topProducts` (top 5, reports.ts:173-176) | Empty → `[]` |
| Q6 | `db.product.findMany` (reports.ts:92-102) | Inventory value + low stock | `deletedAt: null` | `businessId` | `inventory.valueAtCost`, `lowStockItems` (≤6) | Empty → zero value |
| Q7 | `db.sale.aggregate` (reports.ts:103-107) | All-time receivables | `status: { not: "PAID" }`, `deletedAt: null` | `businessId` | `outstandingAllTime.customersOweYou`, `openInvoicesCount` | 0/0 when settled |
| Q8 | `db.expense.aggregate` (reports.ts:108-112) | All-time payables | `status: { not: "PAID" }`, `deletedAt: null` | `businessId` | `outstandingAllTime.youOweSuppliers`, `openBillsCount` | 0/0 when settled |
| Q9 | `db.sale.findMany take 8` (snapshot.ts:77-88) | Oldest open invoices ("who owes me") | `status: { not: "PAID" }`, orderBy `issueDate asc` | `businessId` | `oldestOpenInvoices[]` with `balanceDue` strings | `[]` when none |
| Q10 | `db.expense.findMany take 8` (snapshot.ts:89-100) | Oldest open bills | same pattern | `businessId` | `oldestOpenBills[]` | `[]` when none |
| Q11 | `db.payment.findMany take 8` (snapshot.ts:101-112) | Recent payments | orderBy `paidAt desc` | `businessId` | `recentPayments[]` ("money in"/"money out") | `[]` when none |

**Money never reaches the model as raw numbers.** Every monetary value is pre-computed server-side and pre-formatted with the business currency config via `formatMoney` (snapshot.ts:65-71, 128-206); the header comment states raw minor units are intentionally excluded so the model "never performs arithmetic" (snapshot.ts:4-13). Even ratios are pre-computed: collection rate and expense share are rounded server-side or replaced by `"not available (no revenue)"` (snapshot.ts:121-126, 150-152).

**Meta / citations.** Each response carries `CopilotSnapshotMeta` (`snapshot.ts:19-43, 208-235`): `days`, `generatedAt` (ISO timestamp), `timezone`, `rangeFrom`/`rangeTo`, `sections`, and server-computed record `counts` (sales, expenses, openInvoices, openBills, activeProducts, lowStock, topProducts, expenseCategories, timelineDays, recentPayments). The client renders these as citation chips — "Grounded in … N sales / 0 open invoices / Computed at {time}" (`en.ts:780-787`, fa `fa.ts:786, 790`). Counts are "computed server-side (deterministic), never model-derived" (snapshot.ts:26-31).

---

## 3. Hallucination controls

The system prompt is rebuilt **fresh on every ask** and injected as the first message (`copilot/route.ts:60-64`; "never trust an assistant turn to carry authoritative numbers", copilot/route.ts:53-55). Its binding rules (`snapshot.ts:237-254`):

1. "ONLY use figures that appear verbatim in the DATA SNAPSHOT … Never compute, convert, estimate, or invent any monetary figure" (line 243).
2. Out-of-snapshot asks must be refused honestly, offering the closest available figures (line 244).
3. "You are strictly READ-ONLY. You cannot create, change, or delete anything…" (line 245).
4. Amounts quoted exactly as formatted — no currency reformatting (line 246).
5. Language mirrors the user (Persian/English), concise output (line 247).
6. Interpretation allowed, but **any stated number must exist in the snapshot** (line 248).
7. Prompt-instruction secrecy; refers to "your records" (line 249).
8. Zero-activity honesty clause (line 250), quoted verbatim:

   > `"If the business appears to have no activity (all zeros), say so plainly and suggest recording a first sale or expense."`

   Supporting code: an empty period produces zeroed KPIs and `collectionRate = "not available (no revenue)"` (`snapshot.ts:150-152`), and the UI's empty state promises "always exact, never estimated" (`en.ts:653-654`).

**Provider-level controls** (`src/lib/ai/provider.ts`): the `AIProvider` interface exposes only `chat(messages)` and `chatStream(messages)` (lines 16-24) — **no tool/function definitions, no tool_choice, no JSON-mode schema anywhere in the codebase** (grep for `tools|tool_choice|functions|function_call` matches only an unrelated comment). Empty completions raise `AiUnavailableError` (26-31, 74, 95, 104); failures surface as a generic 503 `AI_UNAVAILABLE` (copilot/route.ts:69-75) or an SSE `error` event (stream/route.ts:97-104). Vendor SDK (`z-ai-web-dev-sdk`) is imported in this file only, `server-only` (provider.ts:1-12).

---

## 4. Authorization, rate limiting, transport

| Control | Value | Evidence |
|---|---|---|
| Permission | `copilot:use` required on ask, stream, and all session endpoints | copilot/route.ts:28, stream/route.ts:32, sessions/route.ts:59, sessions/[id]/route.ts:35, …/messages/route.ts:43; `VIEWER` role lacks `copilot:use` (rbac.ts:69) — UI copy: "Viewers cannot query business intelligence" (en.ts:794) |
| Rate limit | 10 questions / minute / (userId, businessId) — ask & stream share the same key | copilot/route.ts:30, stream/route.ts:34; 429 with `retryAfterMs` (copilot/route.ts:31-35) |
| Audit | `copilot.query` with question truncated to 200 chars, days window; stream adds transport/status/chars, written on stream close | copilot/route.ts:77-86; stream/route.ts:121-136 |
| Transport | SSE events: `{meta}` → `{delta}`* → `{done}` / `{error}`; all auth+grounding happens **before** the stream opens, so pre-stream failures are normal JSON envelopes | stream/route.ts:8-17, 78-93, 141-149; `maxDuration = 60` (copilot/route.ts:24, stream:28) |
| Input bounds | question ≤500 chars; history ≤8 messages × 2000 chars; `days` hard enum with `.catch(30)` | schemas.ts:114-126 |

---

## 5. Conversation persistence — scoped and capped

Server-side transcripts (Phase 07 cross-device sync) are stored in `ChatSession`/`ChatMessage` (`prisma/schema.prisma:321-358`).

- **Scope:** every read/write filters `(businessId, userId)` — `chatSession.findMany({ where: { businessId, userId } })` (sessions/route.ts:61-63), `deleteMany` same (90-92), `updateMany` triple-keyed (sessions/[id]/route.ts:39-47), append upsert "never matches another user's session even on id collision" (…/messages/route.ts:74-96). Schema `@@unique([businessId, userId, id])` as defense in depth (schema.prisma:336). A user's questions are private to them; other members cannot read them (sessions/route.ts:6-11; copilot-sync.ts:11-13).
- **Caps:** 20 sessions × 200 messages (sessions/route.ts:27-28; messages/route.ts:29-30), content ≤ 8000 chars (schemas.ts:143; schema comment schema.prisma:346), meta JSON ≤ 4000 chars (messages/route.ts:31, 57-65). Over-cap appends return `{ skipped: true }` with 200 — storage is best-effort UX (messages/route.ts:9-15, 111-113).
- **Client mirror:** localStorage per business (`copilot-sessions.ts:43-45, 47-49`), sanitized on load (77-106); sync is fire-and-forget and "NOT financial authority" (copilot-sync.ts:1-13).

---

## 6. Action safety — the copilot is READ-ONLY

Enumeration of every AI-reachable code path:

- **Ask/stream endpoints:** call `buildCopilotGrounding` (reads only) and `getAI().chat/chatStream` (text out). No Prisma write, no `audit()` of any mutation other than the `copilot.query` log itself, no side effects (copilot/route.ts:39-88; stream/route.ts:43-137).
- **Session endpoints:** only create/rename/pin/delete the user's **own transcript rows** — no business data touched (sessions/*, §5).
- **Provider:** text completion only; no tool-calling surface exists to invoke even if the model asked (provider.ts:16-24; §3).
- **System prompt:** forbids the model from claiming write ability and tells it to redirect users to the relevant module (snapshot.ts:245).

There is **no destructive operation in any AI path**: no delete endpoints are reachable from copilot code, no mutation helper is imported by `snapshot.ts`/`provider.ts`/copilot routes. High-impact actions remain behind human UI flows with RBAC (`finance:manage` for payments, etc. — rbac.ts:37-70), consistent with Constitution §10 ("The MVP Copilot is read-only by design", PROJECT-CONSTITUTION.md:398-406) and the UI badge "Read-only — cannot change records" (en.ts:729, fa.ts:732).

---

## 7. Findings

### Finding A (LOW, accepted residual risk): client can POST `role:"assistant"` messages to its OWN transcript

- **What:** `POST /api/v1/copilot/sessions/[id]/messages` accepts `role: z.enum(["user","assistant"])` from the client (schemas.ts:141-149, role at 142) and stores it verbatim in the caller's own transcript (messages/route.ts:98-107). The server cannot distinguish a genuine assistant answer from a client-fabricated one, because answers are streamed to the client first and mirrored back (copilot-sync.ts:70-98).
- **Impact:** a user can fabricate text inside **their own private transcript** (scoped to their `userId`, §5). It is not visible to other members, does not feed any authoritative computation, and cannot alter financial data.
- **Why it is contained (defense in depth):**
  1. Stored answers are explicitly non-authoritative — "answers are historical narration only; every figure … is recomputed by the server on each ask" (copilot-sessions.ts:5-9; sessions/route.ts:12-14; schema.prisma:313-318).
  2. On each new ask the system prompt is rebuilt fresh with fresh data and takes precedence (copilot/route.ts:53-64); only the last 6 history turns are replayed and the snapshot rules still bind any number (snapshot.ts:243, 248).
  3. History replay is bounded and content-capped (schemas.ts:114-126), and the replayed "assistant" text cannot grant tools or data access because no such channel exists (§3).
- **Residual risk:** a user can (a) show themselves a doctored transcript (self-deception only), and (b) attempt prompt injection via replayed turns — bounded to style/refusal manipulation, since fabricated figures still have no snapshot source to "quote" from.
- **Status:** risk accepted for MVP. Future tightening candidates: store assistant turns server-side at answer time keyed to the request (server-of-record transcripts), sign `metaJson` with the request id, or drop client-supplied roles and derive them from the answer stream.

### Finding B (INFO): architecture docs drift

`docs/ARCHITECTURE.md:81-101` and A12/A13 describe an intent→tools→metrics pipeline (`lib/copilot/tools.ts`, `lib/copilot/metrics.ts`) that was never built; the real grounding is the snapshot pipeline documented here. Safety posture is equivalent-or-stronger (no tool layer at all), but the docs should get an ADR to stop promising a tool allow-list that does not exist.

### Finding C (INFO): history replay is client-supplied

`input.history` (≤8 turns) is client-controlled text replayed into the model context (copilot/route.ts:56-64). Mitigated by the fresh system prompt, verbatim-figure rule, read-only provider, and content caps. Same future-tightening path as Finding A.
