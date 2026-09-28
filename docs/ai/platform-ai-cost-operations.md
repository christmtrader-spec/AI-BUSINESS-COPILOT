# Platform AI Cost Operations — Prompt 28

Status: IMPLEMENTED (internal area `#/platform/ai-cost`, APIs under
`/api/v1/platform/ai-cost/*`). This area is INTERNAL ONLY — every route is
platform-gated (`platform:ai-cost:read/manage/reconcile`) and tenants
receive 403. All numbers come from the Prompt-26 services
(`src/lib/ai/cost/*`); nothing is recalculated in React or in routes.

## 1. Sections (§38)

Overview · Rates · Ledger · Reconciliation · Economics · Anomalies.

## 2. Overview (§39)

- `getAiCostHealth(window)`: per-currency KNOWN totals (string nano-minor,
  never mixed), known/unknown record counts, cost coverage (known /
  attributable records), token coverage (complete-token usage events / AI
  usage events), verified/unverified rate counts, open anomalies, guard
  configuration state (ENABLED/DISABLED).
- `getAiCostBreakdown(window)`: aggregates by provider / model / plan /
  business.
- `getUnknownCostGroups(window)`: grouped UNKNOWN reasons.

## 3. Rate management (§40-§44)

- Listing: paginated, filters (provider/environment/activeOnly).
- Creation (`POST /api/v1/platform/ai-cost/rates`): requires
  `platform:ai-cost:manage`, reason, reauthentication, rate limiting.
  - TEST rates: `environment: "TEST"` with clearly synthetic values.
  - PRODUCTION rates require ALL of: provider, model, ISO-4217 rate
    currency, version, input/output nano-minor rates, effective window,
    `sourceReference` and `verifiedBy`. `verifiedAt` is SERVER-generated
    (the client can never supply it). Missing evidence is rejected with
    `PLATFORM_AI_RATE_INVALID`.
  - The provider pricing currency is an ISO-4217 code in its own right —
    it is never assumed to be a business/settlement currency (Prompt 26
    §24), so the settlement-currency allowlist does NOT apply here.
  - NO production rate currently exists in the repository. None was
    invented. No fake "z-ai" price exists.
- Resolution reuses `resolveAiCostRate` (exact provider/model/currency/
  environment/window/verified-status matching — no fuzzy matching).
- Deactivation (`POST .../rates/[id]/deactivate`): a USED RATE IS NEVER
  DELETED — it is deactivated; historical AiCostRecord snapshots remain
  intact (§44). Deletion of used rates is impossible through any API.

## 4. Reconciliation (§45/§46/§93)

Workflow (the UI enforces the sequence; the API enforces the authorization):

1. DRY RUN (`mode: "dry-run"`) — no mutation. Report: candidates, eligible,
   rateFound, rateMissing, tokenComplete/Incomplete, currencyMismatch,
   conflicts, wouldUpdateCount, bounded window.
2. APPLY (`mode: "apply"`) requires `platform:ai-cost:reconcile`, a typed
   confirmation (`RECONCILE`), reauthentication (current password), a
   reason, and rate limiting.
3. Apply re-validates EVERY record itself — it never trusts stale dry-run
   data — and uses compare-and-update semantics (idempotent; a repeated
   apply updates nothing). KNOWN records are never rewritten. Tokens are
   never invented (incomplete-token records stay UNKNOWN).
4. Apply is audited (`ai_cost.reconciliation_applied` in platform audit;
   the service writes its own tenant audit row).

## 5. UNKNOWN semantics (§47)

UNKNOWN cost = NULL cost + status UNKNOWN + a stable unknownReason.
UNKNOWN is NEVER zero and never estimated. The UI displays UNKNOWN as
UNKNOWN everywhere (ledger + overview), with the honest note that it waits
for a verified rate.

## 6. Economics (§48/§49)

`getPlanAiEconomics(planCode, billingPeriod)` — status-gated:
COMPARABLE · NOT_COMPARABLE_CURRENCY · COST_UNKNOWN · PRICE_UNKNOWN ·
INSUFFICIENT_SAMPLE. Displayed as "AI CONTRIBUTION" (price − known AI cost)
— NEVER "net profit". Currencies are never mixed, summed or converted
(no FX; NOT_COMPARABLE_CURRENCY is preserved). Misleading numerics are
null when the status says so.

## 7. Anomalies (§50/§53)

Existing detection types are displayed (usage/token/cost spike,
unknown-cost ratio, missing rate, business concentration). Operators may
ACKNOWLEDGE an OPEN anomaly (audited `ai_cost.anomaly_acknowledged`).
Nothing is automatically suspended and the acknowledgment changes no
billing behavior.

## 8. Guard (§51)

The current guard configuration state (ENABLED/DISABLED) is DISPLAYED only.
The guard is DISABLED by default and remains so while no verified
commercial rates exist — the UI does not enable it.

## 9. Customer isolation (§52)

Tenant OWNER/ADMIN/STAFF receive 403 for every AI-cost surface (rates,
records, economics, anomalies, reconciliation). No customer API returns
any of: PlatformOperator, PlatformAuditLog, AiCostRate, AiCostRecord,
AiCostAnomaly (Prompt 27 + Prompt 28 scanners both enforce this).

## 10. Audit (§53)

Audited actions: rate created, rate verified, rate deactivated,
reconciliation applied, anomaly acknowledged. NEVER logged: prompts,
responses, secrets.
