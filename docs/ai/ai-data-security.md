# AI Data Security — Context Isolation & Secret Boundaries

**Document ID:** AI-DATASEC-v1
**Round:** r27-docs-c
**Spec refs:** Prompt-spec §241 (AI data security); §81 (model honesty)
**Basis:** `src/lib/ai/snapshot.ts`, `src/lib/ai/provider.ts`, `src/app/api/v1/copilot/*`, `prisma/schema.prisma`, `scripts/prompt26-ai-cost-check.mjs`, `.env` (verified).
**Companion docs:** `ai-data-use.md` (inventory & flow), `ai-cost-architecture.md` (cost separation), `docs/security/trust-model.md` §5, `docs/security/data-classification.md` (tiers).

> **INTERNAL DOCUMENT.** Never linked from public pages. Describes the
> isolation mechanics that keep secrets and platform data out of AI context;
> the public-facing summary lives on `/ai-data-use` and `/privacy`.

---

## 1. Secret isolation — what can never enter AI context

Verified exclusion list. None of the following appears in the system prompt,
snapshot, request payload, or any copilot route response:

| Secret / restricted data | Where it actually lives | Why it cannot reach the seam |
|---|---|---|
| `NEXTAUTH_SECRET` | `.env`, consumed by NextAuth only | Never selected, never serialized |
| `DATABASE_URL` | `.env` | Connection config, not app data |
| AI provider API keys / SDK credentials | Environment; SDK reads them server-side inside `provider.ts` | Credentials configure the client; they are not message content |
| Payment merchant credentials & webhook secrets | Environment (`src/lib/payments/*`) | Server-only; no AI route touches payments config |
| Password hashes (`User.passwordHash`) | DB, read only inside `authorize()`/verify flows | Never in any `select` list |
| Password-reset tokens (only SHA-256 hashes stored) | `PasswordResetToken` | Single-use, hashed, separate table; not copilot-reachable |
| Session tokens / JWTs | httpOnly cookie | Not part of any snapshot payload |
| AI cost rates & cost records (`AiCostRate`, `AiCostRecord`, anomalies) | Platform-internal tables | Internal commercial data — no route that builds AI context selects them |
| Platform audit metadata (`AuditLog` incl. IPs/UAs) | `AuditLog` | Not selected by copilot code paths |
| Operator notes / governance internals (`AiCostAnomaly`, internal.ts marker) | Internal tables/env | No tenant-facing or AI-facing surface exists |

## 2. Context filtering mechanism — structural, not string-based

The guarantee is **architectural**: `buildCopilotGrounding()` in
`src/lib/ai/snapshot.ts` assembles the snapshot from an explicit DTO with
explicit Prisma `select` lists (e.g. open sales select only `number`,
`issueDate`, `totalMinor`, `paidMinor`, `customer.name`).

- There is **no pass-through of whole DB objects** — a query like
  `db.sale.findMany({ where: { businessId } })` without `select` cannot exist
  in this path, so a new sensitive column cannot silently enter context.
- There is **no string-filtering or regex redaction** to maintain — nothing
  needs to be stripped because nothing unlisted is ever fetched.
- Money figures are converted to pre-formatted display strings server-side
  (`formatMoney`); raw minor units are deliberately excluded from the DTO.
- The system prompt is a fixed template plus business name/currency/timezone;
  no runtime-injected configuration text joins it.

## 3. Provider boundary

- `src/lib/ai/provider.ts` is the **only** file importing the provider SDK,
  guarded by `import "server-only"` — a client component importing it fails
  the build rather than leaking a key into a bundle.
- Routes call `getAI().chat/chatStream` only; they cannot see or alter
  transport configuration. Swapping providers never widens the seam.
- Model honesty: the model identifier is surfaced **only** when the provider
  genuinely reports one (`extractModel` — non-empty string ≤128 chars), else
  `null` → recorded as `UNKNOWN`. Model names are never invented or defaulted.

## 4. Data minimization

- **Windowed, pre-computed figures:** KPIs, timeline, and category totals
  cover the requested report window; only outstanding balances are all-time.
  Counts behind each section are surfaced as citation chips.
- **No raw DB objects** cross the seam (§2) — and no cross-tenant data can:
  every query in the grounding path filters by the verified `businessId`
  from the auth context. The snapshot cannot contain another tenant's rows
  without a deliberate code change in `snapshot.ts` itself.
- **Conversation scope:** only the current session's turns are sent; a user's
  other sessions are not assembled into context.

## 5. Output handling

- Successful outputs are stored as `ChatMessage` rows scoped to **both**
  `businessId` and `userId`; citation metadata is server-computed, so
  restored answers still show where each number came from.
- **Failed requests are never persisted** to chat history — they stay
  client-local (`ChatMessage.failed` semantics) plus server-side logs.
- **No cross-tenant learning:** outputs are not used as future model input
  beyond the owning conversation; no fine-tuning, no shared memory, no
  output aggregation across businesses exists in code.
- Outputs cannot mutate anything: the copilot is read-only by system-prompt
  rule and by absence of any write tool.

## 6. Verification — what exists and what is still missing

| Check | Mechanism | Status |
|---|---|---|
| Snapshot DTO review | Code review against the explicit `select` lists in `snapshot.ts` | Enforced by review; structure makes accidents unlikely |
| "No prompt content in cost ledger" | `scripts/prompt26-ai-cost-check.mjs` L6: serialized cost record must not contain prompt fragments | **Present, passing** (Prompt 26 harness) |
| Cost-record shape (plan snapshot, statuses) | Same harness, L7 + ledger matrix | **Present, passing** |
| Rate-literal leak prevention in AI-cost paths | `scripts/prompt26-rate-literal-scan.mjs` | **Present, passing** |
| Static secret-scan of AI context assembly | `scripts/ai-context-secret-scan.mjs` — scans `src/lib/ai/**` for secret-bearing fields (`passwordHash`, `resetToken`, `sessionToken`, `providerKey`, cost fields, audit metadata) entering any snapshot/query | **SPECIFIED, NOT YET IMPLEMENTED** — the script does not exist in the repo as of r27-docs-c; treat it as a required follow-up before public launch |

The missing scan is a documented gap, not a hidden one: until it lands,
verification of §1 relies on the structural DTO argument (§2) plus the
passing Prompt 26 harness checks above.

## 7. Cost-data separation recap

Full treatment: `docs/ai/ai-cost-architecture.md` (cardinal separation),
`ai-cost-governance.md` (guard semantics), `ai-provider-cost-rates.md`
(rate truth), `ai-unit-economics.md` (contribution analysis). Summary for
AI data security:

- Customer price and provider cost are never derived from each other; both
  are invisible to tenants.
- `attributeAiCost` anchors on committed `AI_REQUESTS` usage events and
  stores either an exact cost or a reasoned **UNKNOWN = NULL + status +
  stable unknownReason** — never a guessed 0.
- `AiCostRecord`/`AiCostRate`/`AiCostAnomaly` never enter copilot context,
  tenant APIs, or tenant exports; the cost guard (`assertAiCostGuard`, at
  the AI boundary in both copilot routes) is default-DISABLED, fail-open,
  and UNKNOWN never blocks. `AI_COST_OPERATOR_TOKEN` is unset → no HTTP
  cost-mutation endpoint exists today.
- `AiCostRecord` is not FK-bound to `Business`: it is retained after
  business deletion by design — platform memory, not tenant data.

## Current state (honest)

- Enforced structurally today: single server-only seam, explicit-DTO
  snapshot with select lists, businessId-filtered grounding queries, no
  secrets in any AI path, honest UNKNOWN usage/model states.
- Verified by tests: Prompt 26 harness (104/104 ×2 runs per worklog r26)
  including the no-prompt-in-ledger check; rate-literal scan clean.
- **Open gap:** `scripts/ai-context-secret-scan.mjs` specified but not yet
  written; also no runtime regression that asserts a full serialized copilot
  payload against the §1 exclusion list (candidate follow-up alongside the
  scan script).
- Provider-side handling of transmitted data remains outside this repo's
  control (see `ai-data-use.md` §4); no provider contractual review exists.
