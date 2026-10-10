# AI Data Use — internal document record

**Document ID:** LEGAL-AIDATA-v1 · **Created:** 2026-09-25 (Prompt 27 §163)
**Status:** DRAFT — **LEGAL REVIEW REQUIRED** before public production launch.

Public document source: `src/content/legal/ai-data-use.ts` (en + fa),
rendered at `#/ai-data-use`.

## What the page says (and the code behind it)

| Statement | Code evidence |
|---|---|
| Copilot answers from recorded business data via a per-request snapshot | `src/lib/ai/snapshot.ts`, `copilot/route.ts` |
| Message + snapshot processed by "AI service providers configured by the platform" | `src/lib/ai/provider.ts` — provider abstraction; production provider identity depends on deployment; **model id UNKNOWN** when the integration does not expose it (§106) |
| NOT claimed "fully private" — sending requests to AI infrastructure is stated plainly (§94) | explicit paragraph added deliberately |
| Conversations stored per (business, user), deletable by the owner | `ChatSession` triple-scoped lookups; `DELETE /copilot/sessions/[id]` |
| Token-usage metadata recorded only when reported | `AiProviderUsage` null-safe; Prompt 21 semantics |
| Analytics never store raw prompts/responses | `src/lib/analytics.ts` allowlist |
| Business isolation for conversations/usage/history | server-side tenant pipeline; verified by regression harnesses |
| Usage limits enforced server-side | UsageService (Prompt 20/21) |
| Review responsibility (assistance, not decisions) | mirrors Terms AI sections (§41) |

## Hard boundaries enforced by this prompt

- The page NEVER names a provider/model that is not actually active (§25).
- The page NEVER contains AI cost rates, margins or platform cost data
  (§26/§107) — internal financial governance is not customer disclosure.
- No "100% private AI" claims (§94).

## Update trigger

When a production AI provider is activated, update
`src/content/legal/ai-data-use.ts` (and `service-providers.md`) to identify
the provider per the activation-gate checklist (§55), bump the document
version per the runbook.
