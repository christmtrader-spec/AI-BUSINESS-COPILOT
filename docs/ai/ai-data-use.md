# AI Data Use — Internal Reference

**Document ID:** AI-DATAUSE-v1
**Round:** r27-docs-c
**Spec refs:** Prompt-spec §7 (AI data inventory), §8 (provider data flow), §10 (purposes), §14 (usage honesty)
**Basis:** `src/lib/ai/snapshot.ts`, `src/lib/ai/provider.ts`, `src/app/api/v1/copilot/*`, `src/lib/billing/usage.ts`, `prisma/schema.prisma` (`ChatSession`/`ChatMessage`/`UsageEvent`), `src/content/legal/privacy.ts` & `terms.ts` (public wording).
**Companion docs:** `ai-cost-architecture.md`, `ai-cost-governance.md`, `ai-provider-cost-rates.md`, `ai-unit-economics.md` (Prompt 26 — cost data, not covered here), `docs/security/ai-data-security.md` (isolation mechanics), `docs/security/data-classification.md` (tiers).

> **INTERNAL DOCUMENT.** Never linked from public pages. The public
> counterpart is the `/ai-data-use` legal page (plus the AI sections of
> `/privacy` and `/terms`); this file is the engineering reference behind it
> and must never contradict it.

---

## 1. AI data inventory

| Data class | What it is | Where it lives | Notes |
|---|---|---|---|
| User prompts | Copilot questions and follow-up turns | Client-local until success; then `ChatMessage` (role `USER`) | Capped at 8000 chars server-side |
| Business-context snapshot | The grounding DTO: business name/currency/timezone, pre-computed KPI display strings, daily timeline, top products, expense categories, outstanding invoices/bills with counterparty names, low-stock items, recent payments with user notes | Built per ask in `snapshot.ts`; **not persisted as such** | Explicit `select` lists; windowed figures + all-time outstanding balances |
| AI outputs | Assistant answers (plus server-computed citation `metaJson`) | `ChatMessage` (role `ASSISTANT`) | Stored only on success; `meta` is counts/provenance chips, never model-derived |
| Usage metadata | Per-request token counts (input/output/total as reported) | `UsageEvent` (`AI_REQUESTS`, `AI_TOKENS`) | Sole quota authority (Prompt 21); no prompt content ever |
| Provider/model metadata | Provider id (configured adapter) and model identifier **only when the provider reports one** | `UsageEvent`; `AiCostRecord` (internal) | Missing report → `UNKNOWN` — never invented (`provider.ts` `extractModel`) |
| Error metadata | Failure events: unavailable provider, empty completion, guard blocks | Server logs (`dev.log`); counters only | **Failed requests are never persisted to chat history** (client-local only; `ChatMessage.failed` rows stay unsynced) |
| Cost records | Token/cost attribution with honest UNKNOWN states | `AiCostRecord` (platform-internal) | Covered by the Prompt 26 docs; never tenant-visible |

## 2. The actual provider data flow — and the warning

```
User (copilot UI)
  → App server  (auth + membership + copilot:use + rate limit + cost guard)
  → snapshot.ts (explicit business-context DTO, server-computed)
  → AI provider abstraction (src/lib/ai/provider.ts — the ONLY seam,
    server-only import of the provider SDK)
  → configured provider  (network call — data LEAVES the platform)
  → response (text + normalized usage; model if reported)
  → App server  (charge/metering, cost attribution, audit)
  → stored session (ChatSession/ChatMessage, business+user scoped)
```

> **Warning: AI data DOES leave the platform.** The prompt text, conversation
> context, and the business-context snapshot are transmitted to the
> configured third-party AI provider for processing. Once data crosses the
> seam, its handling is governed by that provider's terms and configuration
> — the app controls what is *sent*, not what the provider does with it.
> This is stated plainly on the public pages; no "data stays on your server"
> impression is given anywhere.

What is *sent* per request: system prompt (rules + business
name/currency/timezone), the user's question, prior conversation turns in the
session, and the snapshot DTO of §1. What is *never* sent: see
`docs/security/ai-data-security.md` §2 (structural exclusion list).

## 3. Purposes actually implemented

Only these purposes exist in code — nothing else may be claimed publicly:

1. **Response generation** — answering the user's business question from the
   snapshot.
2. **Business analysis** — explaining trends, outstanding balances, inventory
   and cash-flow figures the app pre-computed.
3. **Summarization** — condensing windowed records (timeline, top products,
   recent payments) into plain language.
4. **Assistant functionality** — conversation history, pinned/renamed
   sessions, citations of where numbers came from.
5. **Usage measurement** — token/request metering for quotas and honest cost
   attribution (Prompt 21/26).
6. **Service reliability** — availability errors surfaced honestly, rate
   limits, and the optional cost guard protecting the service.

No cross-tenant learning, no model fine-tuning, no advertising, no profiling
beyond the tenant's own data, no automated decisions about accounts.

## 4. Retention — current state

- **Conversations** (`ChatSession`/`ChatMessage`) are retained while both the
  business and the user exist. The owning user can delete any session
  (`DELETE /api/v1/copilot/sessions/[id]`, audited `copilot.session_delete`).
- **Cascades:** business deletion cascades all its sessions; account deletion
  cascades the user's memberships and transcripts (`onDelete: Cascade` on
  both relations).
- **Failed requests are never stored** — a failed AI call exists only in the
  user's local UI state and server logs, never as a chat row.
- **Usage metadata** (`UsageEvent`) persists as the billing/quota ledger;
  **cost records** (`AiCostRecord`) are platform-internal and survive business
  deletion by design (`ai-cost-architecture.md`).
- **Application-side AI retention configuration: none needed** beyond the
  cascade rules above; there is no independent "AI retention" job.
- **Provider-side retention: CURRENTLY NOT EXPLICITLY CONFIGURED.** The app
  sends no provider-side retention, logging, or training-opt-out parameters —
  whatever the provider does with inputs by default is not controlled from
  this codebase. Public language therefore stays neutral: "Provider retention
  and processing terms are governed by the applicable provider documentation
  and configuration."

## 5. Provider-agnostic disclosure rules

- **No model name publication.** We never advertise which model powers the
  copilot; the model identifier is recorded internally only when the provider
  reports it, and is `UNKNOWN` otherwise. Public pages say "third-party AI
  provider(s) configured by the platform" — never a vendor name.
- **"Third-party AI provider(s)" wording** is the mandated public phrasing
  (already used in `privacy.ts`/`terms.ts`); internal docs must match it
  when describing the flow.
- **Provider retention language is neutral** — no claims about provider
  logging, training use, or deletion on our behalf, in either direction.
- **Cost stays invisible.** Provider rates, cost records, margin analysis,
  and anomalies are internal commercial data (`ai-cost-architecture.md`
  cardinal separation) and never appear in tenant-facing data use language.

## Current state (honest)

- One provider adapter is configured (z-ai via the sanctioned seam); requests
  are non-streaming and streaming variants of the same flow.
- Snapshot contents are fully enumerated in §1; monetary figures arrive as
  pre-formatted display strings so no arithmetic happens at the provider.
- Retention today = conversation rows + usage/cost ledgers + server logs;
  deletions are user-initiated per session or cascade-driven; **no purge
  schedule exists** for chat data beyond explicit deletion/cascade.
- Provider-side data handling (retention, training use, logging) is **not
  configured and not contractually reviewed** from this repo — honest "not
  configured" status until an operator agreement says otherwise.
- No AI feature exists beyond the copilot routes; any future AI feature must
  extend this inventory and the public `/ai-data-use` page in the same round.
