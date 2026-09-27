# AI Provider Cost Rates — Prompt 26

> Status: **IMPLEMENTED**. Source of truth:
> `src/lib/ai/cost/rates.ts` (creation, verification, resolution),
> `src/lib/ai/cost/ledger.ts` (`reconcileAiCosts`), model `AiCostRate` in
> `prisma/schema.prisma`.

## The rate model

`AiCostRate` is the ONLY source of provider-cost truth.

| Field | Type | Meaning |
|---|---|---|
| `provider` | String ≤64 | provider abstraction slug (e.g. `z-ai`) |
| `model` | String ≤128 | EXACT model identifier as reported by the provider, or the reserved explicit mapping `DEFAULT` |
| `currency` | String | ISO 4217 (validated `^[A-Z]{3}$`) — the **provider's pricing currency**, never assumed equal to business or settlement currency (§24) |
| `version` | String ≤64 | immutable human version id (e.g. `2026-09-v1`) |
| `inputRateNanoMinorPer1K` / `outputRateNanoMinorPer1K` | BigInt | nano-minor per 1K tokens (1 minor = 1,000,000 nano-minor); ≤ 1e18 (= 1e12 minor units) |
| `effectiveFrom` / `effectiveTo` | DateTime / DateTime? | UTC effective window, `effectiveTo` strictly after `effectiveFrom`, open-ended when null |
| `active` | Boolean | deactivation only — used rates are never deleted (§12) |
| `environment` | String | `TEST` \| `PRODUCTION` — completely separate domains (§6) |
| `verifiedAt` / `verifiedBy` / `sourceReference` | nullable evidence triple | production verification evidence (§8) |

Creation is exhaustively validated server-side with structured rejections
(`AiCostRateError`): `INVALID_PROVIDER`, `INVALID_MODEL`,
`INVALID_CURRENCY`, `INVALID_ENVIRONMENT`, `INVALID_VERSION`,
`INVALID_RATE` (negative/NaN/Infinity/overflow rejected), 
`INVALID_EFFECTIVE_WINDOW`, `MISSING_SOURCE_REFERENCE`,
`DUPLICATE_VERSION`, `OVERLAPPING_ACTIVE_RATE`.

## Versioning semantics

- Versions are **immutable, human-readable ids** (`2026-09-v1` style). A
  price change means a **new version** — corrections are never edits of an
  existing version. Repricing history stays reconstructable via the rate
  snapshot on every cost record.
- **Uniqueness:** `@@unique([provider, model, currency, version,
  environment])`. The constraint decides duplicates under concurrency
  (§188) — a raced duplicate creation surfaces as `DUPLICATE_VERSION`,
  never as two rows.
- **No overlapping active windows** for the same
  `(provider, model, currency, environment)`: creation rejects overlaps
  (`OVERLAPPING_ACTIVE_RATE`, §11/§105) so resolution ambiguity is made
  impossible at write time; if data drift ever produces multiple
  candidates anyway, resolution fails as `AMBIGUOUS_RATE` rather than
  picking arbitrarily.

## TEST vs PRODUCTION separation (§6)

Rate domains are completely separate. The attribution environment comes
from `AI_COST_ENVIRONMENT` when set, else `PRODUCTION` in
production-like runtimes, `TEST` in development
(`attributionEnvironment()` in `ledger.ts`). A TEST rate can never price
PRODUCTION usage and vice versa.

## Production verification (§8/§34/§99)

A PRODUCTION rate is unusable for attribution unless **ALL THREE**
evidence fields are present together: `verifiedAt`, `verifiedBy`,
`sourceReference`. Otherwise resolution returns `RATE_NOT_VERIFIED`.

- `verifyAiCostRate(rateId, { verifiedBy, sourceReference })` records the
  evidence (verifiedBy ≤128 chars; sourceReference ≤512 chars) and writes
  an `ai_cost.rate_verified` audit entry. Re-verification is idempotent
  and updates the evidence (who/when/source may legitimately change).
- A PRODUCTION rate must already carry a non-empty `sourceReference` at
  creation time (`MISSING_SOURCE_REFERENCE` otherwise) — evidence is
  expected before the row even exists; the triple is completed at
  verification.
- TEST rates do not require verification (sandbox pricing is allowed to
  be approximate); the `ACTIVE` vs verified distinction only exists in
  the PRODUCTION domain.

## Effective windows and resolution (§32/§104)

`resolveAiCostRate({ provider, model, currency?, environment,
usageTimestamp, requireVerified? })` — deterministic order:

1. exact `provider`; 2. exact `model` (or the explicit `DEFAULT` mapping
where legitimate — see below); 3. exact `currency` when pinned; without a
pin, at most **one** distinct pricing currency may be resolvable, else
`AMBIGUOUS_RATE` (currencies are never mixed implicitly, §62); 4. exact
`environment`; 5. `active = true`; 6. `usageTimestamp` inside
`[effectiveFrom, effectiveTo)`; 7. verified, when PRODUCTION.

**The usage TIMESTAMP decides the version.** Later rates never apply
retroactively (§104): a record created before a rate was configured keeps
its `UNKNOWN` until reconciliation matches it by its own usage time
(the record's `createdAt` is the documented usage-time proxy). The
candidate scan is bounded (`take: 8`) purely to detect ambiguity.

### The explicit DEFAULT model mapping (§10/§33/§106)

`model = "DEFAULT"` is a **reserved, explicit** mapping. When the provider
reported no model (`model = "UNKNOWN"` on the record), resolution tries
the exact model first and only then the `DEFAULT` mapping — and only if
the operator deliberately configured such a row where provider semantics
make it legitimate. There is **no fuzzy matching, no prefix/pattern
matching, no best-guess**: an `UNKNOWN` model with no `DEFAULT` policy
stays honestly unpriced (`MODEL_UNKNOWN`).

## Lifecycle: deactivation, never deletion (§12)

`deactivateAiCostRate` flips `active = false` (`ai_cost.rate_deactivated`
audit). Used rates remain resolvable for history — the `rateId` index and
the per-record snapshot keep old cost rows explainable. Deletion is not
offered.

## Rate state machine (§83)

| State | Meaning |
|---|---|
| `NOT_CONFIGURED` | no row exists for the scope |
| `UNVERIFIED` | active PRODUCTION row missing any of the three evidence fields |
| `VERIFIED` | active PRODUCTION row with all three evidence fields |
| `ACTIVE` | active TEST row (verification not required) |
| `INACTIVE` | deactivated row (kept for history) |

`rateStateOf()` never collapses these states — "UNVERIFIED" must remain
visibly different from "NOT CONFIGURED" (§126).

## Reconciliation workflow (§41–§43/§103)

`reconcileAiCosts({ dryRun, environment?, windowDays?, limit? })`
re-evaluates `UNKNOWN` records against possibly newly configured/verified
rates. The workflow is always: **operator verifies the rate → insert →
dry-run → review report → apply → coverage rises**.

- Candidates: `costStatus = "UNKNOWN"` within a bounded window (default
  `AI_COST_ANOMALY_WINDOW_DAYS`, i.e. 7 days; limit default 200, max 1000).
- Eligibility: only `tokenStatus = COMPLETE` (tokens are never invented,
  §43), provider known, a resolvable rate for the record's own
  environment and usage-time proxy, snapshot currency agreeing with the
  rate currency (`currencyMismatch` otherwise), and PRODUCTION evidence
  complete.
- **Dry-run mutates nothing** (§42) and reports counts
  (`rateFound`/`rateMissing`/`tokenComplete`/`tokenIncomplete`/
  `currencyMismatch`/`conflicts`/`alreadyKnown`/`wouldUpdateCount`).
- **Apply re-validates every record itself** — it never trusts stale
  dry-run data (§186) — and writes with compare-and-update semantics
  (`updateMany where costStatus = "UNKNOWN"`) so concurrent applies cannot
  double-attribute (§187). `KNOWN` records are never rewritten (§44).
  Applied runs write a single `ai_cost.reconciled` audit entry.

## NO FAKE RATES (§9/§126)

No provider pricing is invented, scraped, estimated or seeded. No Z-AI
commercial pricing may be inserted without **operator-verified evidence**
(a real published price + `sourceReference` the operator has actually
checked). Configuration status reporting (`NOT_CONFIGURED`, `UNVERIFIED`)
is always preferred over a plausible-looking fabricated number.

### Current honest state

- The Z-AI adapter exists and reports `model` when the provider includes
  it in responses; token usage is recorded when genuinely exposed.
- **Production commercial rate: NOT CONFIGURED.** Zero `AiCostRate` rows
  exist as of Prompt 26 — none may be inserted without verification.
- Historical cost: **UNKNOWN** with a stable `unknownReason`
  (`RATE_NOT_FOUND` / `MODEL_UNKNOWN` / `TOKENS_MISSING`), honestly
  preserved until a verified rate exists for the exact usage timestamp.

All rate mutations are audited with bounded, secret-free payloads
(`ai_cost.rate_created`, `ai_cost.rate_verified`,
`ai_cost.rate_deactivated`, `ai_cost.reconciled`) under the internal
authorization boundary (`ai-cost-governance.md`).
