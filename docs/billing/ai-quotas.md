# AI Quotas — Prompt 21

> Status: **IMPLEMENTED** (hard limits, metered server-side). Token quotas:
> NOT IMPLEMENTED (tokens are recorded, never enforced — §14/§66).

## Where quota values live

ONE authoritative source: the entitlement catalog
(`src/lib/billing/catalog.ts`) seeded into
`Plan → PlanEntitlement → EntitlementDefinition` (see `plan-catalog.md`).
There is NO second quota table and NO hard-coded
`if (plan === "PRO") limit = …` in application code (§36/§106).

## Per-plan AI quotas (internal defaults, no prices §39)

| Plan | AI_COPILOT | AI_REQUESTS_MAX | AI_MESSAGES_MAX | AI_TOKENS |
|---|---|---|---|---|
| FREE | true | 25 | 25 | recorded only |
| STARTER | true | 150 | 150 | recorded only |
| BUSINESS | true | 500 | 500 | recorded only |
| PRO | true | 2000 | 2000 | recorded only |
| ENTERPRISE | true | null (unlimited) | null (unlimited) | recorded only |

- Changing a quota = seed-data change (upsert new rows; existing rows are
  never overwritten by the seed — deliberate catalog decisions stay).
- Unlimited is represented as `null` — NEVER a fake giant number (§64/§65).
- ENTERPRISE custom per-business overrides: NOT IMPLEMENTED (future
  extension; the resolution layer already treats `null` as unlimited, §107).

## What one unit means

One user Copilot question = **1 × AI_MESSAGES + 1 × AI_REQUESTS**, metered
atomically together under the same `requestId`. Internal tool/snapshot work,
stream chunks, history loads and rejected attempts never meter. Details:
`usage-metering.md`.

## Enforcement points

- `POST /api/v1/copilot` (chat transport)
- `POST /api/v1/copilot/stream` (SSE transport — gate parity was a Prompt 21
  bug fix; the endpoint previously skipped the `AI_COPILOT` boolean gate)

Pipeline order (§44): authenticate → membership → permission →
`AI_COPILOT` boolean gate (403) → rate limit (429) → validation →
**quota check + meter** (422 `USAGE_LIMIT_REACHED`) → provider call →
finalize/release. Rejections consume no usage.

## Failure semantics (§49)

| Event | Usage effect |
|---|---|
| Validation failure (e.g. malformed requestId) | none |
| Unauthorized / permission denied | none |
| Entitlement denied (`AI_COPILOT` false) | none |
| Quota exceeded | none (rejected pre-provider) |
| Provider unavailable / error before acceptance | metered then RELEASED |
| Stream aborted with no deltas | metered then RELEASED |
| Stream aborted after deltas | charge stands (provider accepted) |
| Successful completion | charge stands; tokens recorded when reported |
| Replay of a COMPLETED requestId | no additional charge |
| Replay of a RELEASED requestId | re-metered (replacement execution) |

## Copilot behavior at quota exhaustion (§54/§98/§114)

The API returns the structured 422 (see `usage-metering.md`); the Copilot UI
renders a localized, honest message with the limit and the renewal date
("You have used all {limit} AI requests included in your current plan…"),
pointing to Settings → Subscription. The LLM is never asked to generate the
quota message — it is a structured application error. `AI_USAGE_LIMIT_REACHED`
from the prompt maps to the existing envelope code `USAGE_LIMIT_REACHED`.

## Token recording policy (§14/§15/§62/§105)

- The provider abstraction (`src/lib/ai/provider.ts`) normalizes usage into
  `{ inputTokens?, outputTokens?, totalTokens? }` — provider-independent.
- Values are recorded ONLY when the provider genuinely reports them
  (verified live: the z-ai completion response carries a usage object; the
  integration records what it actually sent — no estimation, no fabrication).
- Non-integer / implausible values are sanitized (rounded, capped at 10M);
  nothing outside safe integer semantics is stored.
- Tokens are NOT priced and NOT quota-enforced in this phase; quantities are
  stored so a future billing layer can compute cost without altering the
  historical meaning of the data.
