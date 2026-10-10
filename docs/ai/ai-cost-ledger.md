# AI Cost Ledger — Prompt 26

> Status: IMPLEMENTED + TEST-VERIFIED (harness `scripts/prompt26-cost-check.ts`).

## 1. AiCostRecord (§15)

Immutable ledger row — one per logical AI operation.

| Field | Notes |
| --- | --- |
| `businessId` | tenant scope (§49) |
| `usageEventId` | UNIQUE anchor into UsageEvent: the AI_TOKENS event when the provider reported tokens, otherwise the AI_REQUESTS event (§19; usage stays the usage authority, §61) |
| `requestId` | logical operation id; UNIQUE together with businessId (§20/§117) |
| `usagePeriodId` | subscription usage period at usage time (§55) |
| `provider` / `model` | server-side attribution; model = UNKNOWN unless reliably known (§94) |
| `planCodeAtUsage` | plan at usage time — later upgrades never reclassify history (§53/§54) |
| `rateId` / `rateVersion` / `currency` | rate snapshot used; null ⇔ UNKNOWN (§12/§14) |
| `inputTokens` / `outputTokens` / `totalTokens` | authoritative counts actually used; unknown dimensions are 0 AND flagged in `tokenStatus` (never silently zero, §22/§23) |
| `tokenStatus` | COMPLETE \| PARTIAL \| TOTAL_ONLY \| NONE |
| `costNanoMinor` | BigInt exact cost; null ⇔ UNKNOWN (never zero-by-guess, §18) |
| `costStatus` | KNOWN \| UNKNOWN (§16). ESTIMATED deliberately not implemented. |
| `unknownReason` | NO_TOKEN_USAGE \| PARTIAL_TOKEN_DATA \| TOTAL_TOKEN_ONLY \| NO_VERIFIED_RATE \| MODEL_UNRESOLVED |

Immutability: KNOWN records are never recalculated when rates change
(§14/§62/§63/§128). Corrections happen only through the audited reconcile
tool, and only UNKNOWN→KNOWN (§69).

## 2. Attribution algorithm (§21–§23)

```
input  (ledger.ts attributeAiCost)
1  find the operation's UsageEvents (businessId + requestId)
2  AI_REQUESTS missing or RELEASED → SKIP (no cost for un-accepted usage)
3  existing AiCostRecord → return it (idempotent replay, §20)
4  token facts: from the AI_TOKENS event meta (authoritative copy)
   COMPLETE (in+out) | PARTIAL | TOTAL_ONLY | NONE
5  resolve rate AT the usage time (provider, model→DEFAULT fallback, env)
6  decide:
   NONE                    → UNKNOWN / NO_TOKEN_USAGE
   no rate                 → UNKNOWN / NO_VERIFIED_RATE
   PARTIAL                 → UNKNOWN / PARTIAL_TOKEN_DATA   (§22)
   TOTAL_ONLY              → UNKNOWN / TOTAL_TOKEN_ONLY     (§23)
   COMPLETE + rate         → cost = in×inRate + out×outRate (BigInt, exact)
7  create record (unique key guarantees at-most-once; races → P2002 replay)
```

Idempotency guarantees (§20/§114/§115/§117): repeated response handling,
duplicate stream usage callbacks, server retries, and stream completion +
token callback double-fires all collapse into ONE record via
`(businessId, requestId)` and the unique `usageEventId` anchor.

## 3. Failure semantics (§67/§68)

- Attribution runs AFTER the AI response is secured (routes use
  `attributeAiCostSafe`): a failure logs loudly and leaves the operation
  WITHOUT a record → reported as `pendingAttribution` (COST_ATTRIBUTION_
  PENDING state) and retriable by `scripts/ai-cost-reconcile.ts`.
- Attribution failure must not: break the response, double-charge usage, or
  fabricate a zero.

## 4. Zero vs UNKNOWN (§18)

`UNKNOWN ≠ 0`. A missing rate, missing tokens, a partial split, or an
unknown model all produce UNKNOWN with a structured reason — coverage math
and the guard treat UNKNOWN explicitly (never as zero).

## 5. Client tampering (§130/§147)

Clients can submit only a UUID `requestId` (validated) and the question.
Cost, provider, model, and tokens are server-derived exclusively; the ledger
re-sanitizes provider token values (negative/implausible → unknown, never
fabricated).
