# AI Cost Rates — Prompt 26

> Status: IMPLEMENTED (model + service + validation). **No real rate is
> configured.** The rate table is EMPTY by design until an operator verifies
> an actual commercial price (§2/§25/§89/§158). Tests may create synthetic
> rates in the TEST environment only (§90/§91/§92).

## 1. The AiCostRate model (§6)

| Field | Meaning |
| --- | --- |
| `provider` | Provider slug as recorded by the usage layer (e.g. `z-ai`) |
| `model` | Exact model id, or `DEFAULT` (see §3 below) |
| `currency` | Explicit provider-cost currency (§31) — may differ from revenue currency |
| `inputRateNanoMinorPerToken` | BigInt nano-minor per INPUT token (§9) |
| `outputRateNanoMinorPerToken` | BigInt nano-minor per OUTPUT token (§10) — never inferred from input |
| `version` | e.g. `ZAI-DEFAULT-v1` — a pricing change ADDS a version (§12) |
| `effectiveFrom` / `effectiveTo` | Usage-time window (§13); `[effectiveFrom, effectiveTo)` |
| `active` | Only active rates resolve (§28) |
| `environment` | `PRODUCTION` \| `TEST` (§92/§93) — test rates can never resolve in production attribution |
| `verifiedAt` / `verifiedBy` / `sourceReference` | Operator verification trail (§27/§88); sourceReference points at a pricing page/contract/billing agreement — never a secret |

Uniqueness: `(provider, model, currency, version, environment)`. A rate
referenced by cost records CANNOT be deleted (Restrict) — retire it with
`active=false` / `effectiveTo` (§12/§14).

## 2. Nano-minor units (§7)

```
1 minor unit = 1,000,000 nano-minor units
1 nano-minor = 1e-8 EUR  (exponent 2)   ·   1e-6 IRR (exponent 0)
```

Example: a provider price of USD 0.15 per 1M input tokens = `1500` nano-cent
per token (0.15 USD = 15000 minor cent; 15000/1M = 0.015 minor? — no:
0.15 USD/1e6 tokens = 1.5e-7 USD/token = 1.5e-5 cent = **15 nano-cent**).
Operators enter rates as decimal **minor-unit strings** via
`parseMinorStringToNanoMinor` (exact string math, no float) or as exact
nano-minor integers.

## 3. Model identity (§11/§94)

- The Z-AI integration does not expose a reliable model id → cost records
  store `model = UNKNOWN`.
- A rate row may target `DEFAULT`: an **explicit operator assertion** that
  the price applies to whatever model the provider actually serves for this
  integration. It is never inferred by the application.
- Resolution order at time `t`: exact model → `DEFAULT` → none (UNKNOWN).

## 4. Activation & conflict rules

- Usable ⇔ `active = true ∧ effectiveFrom ≤ t < effectiveTo` (§28).
- Two simultaneously ACTIVE overlapping rates for the same
  provider+model+currency+environment are REJECTED at creation (§29) and
  re-checked by `scripts/ai-cost-consistency.ts`.
- Historical attribution resolves the rate that was active WHEN THE USAGE
  OCCURRED — never today's price (§13/§63/§120).

## 5. Operator workflow (§88/§89/§90)

1. Obtain the verified commercial price (provider pricing page, contract, or
   deployment billing agreement).
2. Record it via the rate service (createAiCostRate) with: provider, model,
   currency, exact input/output nano-minor rates, version, effectiveFrom,
   verifiedAt/verifiedBy, sourceReference.
3. No production seeding of synthetic/test rates — ever (§90/§92).

## 6. Administration surface (§30)

No public API. No admin panel (no admin architecture exists, §75). Rates are
managed through trusted operator scripts/seeds using
`src/lib/ai/cost/rates.ts`. Customers can never read or write rates
(§129/§130).
