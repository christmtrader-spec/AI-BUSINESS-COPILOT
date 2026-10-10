# AI Cost Gap Handling — Prompt 26

> Status: IMPLEMENTED. This document is the single source of truth for what
> happens when cost data is missing, partial, or late — and how gaps are
> repaired (never silently).

## 1. Gap taxonomy (§65)

| Gap | Detected by | Ledger state |
| --- | --- | --- |
| AI request with NO token usage (provider reported nothing) | gap report (1) / `tokenStatus=NONE` | UNKNOWN record, reason `NO_TOKEN_USAGE` |
| Token usage with NO verified rate | gap report (2) | UNKNOWN record, reason `NO_VERIFIED_RATE` |
| Cost record with missing/broken usage anchor | gap report (3) / consistency audit | integrity anomaly — operator investigates |
| Record anchored to AI_REQUESTS while an AI_TOKENS event exists | gap report (3 detail) | linkage convention: tokens were recorded after attribution; reconcile can upgrade |
| Unknown model | gap report (4) | `model=UNKNOWN` (§94) — a rate may still resolve via the operator's DEFAULT alias |
| Unknown provider | gap report (5) | data bug — operator investigates |
| KNOWN record without currency | gap report (6) | must be 0; if not, stop and investigate |
| Committed request with NO cost record at all | gap report coverage / consistency audit | attribution PENDING (§68) — retriable |

## 2. Why UNKNOWN is never zero (§17/§18)

A missing rate, a missing token dimension, or a total-only split means the
money amount is NOT KNOWN. Interpreting that as 0 would fabricate margin,
fake coverage at 100%, and silently break the circuit breaker's
completeness rule (§48). Every UNKNOWN carries a structured
`unknownReason`; coverage math counts it against the denominator.

## 3. Attribution is best-effort, usage is forever (§67/§68)

If attribution fails after a successful AI response, the response stands,
usage stands, and the operation appears as `pendingAttribution`. The
reconciliation tool can complete it later from authoritative usage data —
nothing is lost, nothing is invented.

## 4. Reconciliation (§69/§70/§71/§133)

`scripts/ai-cost-reconcile.ts`:

1. **Dry run by default** (§71): lists upgradable records (UNKNOWN +
   COMPLETE tokens + a rate ACTIVE AT THE USAGE TIME) and the exact amounts
   that would be written.
2. **Explicit mutation**: `--apply --confirm RECONCILE` (typed confirmation).
3. Only UNKNOWN→KNOWN upgrades, guarded by `WHERE costStatus="UNKNOWN"` —
   KNOWN records are never touched (§62/§128).
4. Historical usage is never rewritten (§69); rate selection honors the
   anchor event's creation time, never today's price (§63/§70).
5. PARTIAL / TOTAL_ONLY token data is never upgraded (§22/§23).

## 5. Rate configuration later (§70/§122)

Configuring a verified rate TODAY does not retroactively price history.
Each historical UNKNOWN record becomes upgradable only through the explicit
dry-run/apply flow above, using the rate window that matches the usage
time. Periods before the rate's `effectiveFrom` stay UNKNOWN — honestly.

## 6. Operator loop

```
gap report → fix the cause (rate config / token plumbing / model id)
           → reconcile dry run → review → apply → consistency audit
```

The consistency audit must end `CONSISTENT` after any repair.
