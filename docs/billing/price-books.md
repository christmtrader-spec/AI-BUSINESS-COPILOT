# Price Books — Prompt 24

## Model

```
PriceBook                     PlanPrice
─────────────────────────     ─────────────────────────────────────
id (deterministic for seeds)  id
code    EUR_STANDARD          priceBookId  → PriceBook (cascade)
version v1-2026-09            planCode     STARTER|BUSINESS|PRO
currency EUR                  billingPeriod MONTHLY|YEARLY
active  Boolean               amountMinor  Int (minor units)
effectiveFrom DateTime        active Boolean
effectiveTo   DateTime?       @@unique([priceBookId, planCode, billingPeriod])
description String
@@unique([code, version])
@@index([currency, active])
```

- `@@unique([code, version])` — one row per commercial version (§64).
- `@@unique([priceBookId, planCode, billingPeriod])` — one price per
  plan+period inside a book (§64).
- `CheckoutSession.priceBookId → PriceBook` is **onDelete: Restrict** — a
  book referenced by any payment history can never be deleted (§31/§104).
- `PlanPrice` deletion cascades from its book, but the policy is:
  **books are deactivated, never deleted** once used.

## The baseline: EUR-v1 (§20/§37)

Migration `20260924113235_prompt24_price_books` seeds (idempotent,
deterministic ids, `INSERT OR IGNORE`):

| Plan | MONTHLY | YEARLY (explicit rows) |
|---|---|---|
| STARTER | 900 | 9000 |
| BUSINESS | 1900 | 19000 |
| PRO | 4900 | 49000 |

These are the Prompt 22 amounts **verbatim** — the migration does not change
any price. `FREE` and `ENTERPRISE` have **no rows** (§38/§39). The yearly
"2 months free" policy is now DATA, not runtime arithmetic (§61).

> Infrastructure note: Prisma's SQLite adapter stores `DateTime` as INTEGER
> epoch millis. The seed's date literals are normalized to that storage by
> migration `20260924114500_prompt24_seed_datetime_normalize` (idempotent,
> correct on fresh replays).

## IRR — prepared, not priced (§19 option B)

The schema, service and allowlist support IRR (Zarinpal's settlement
currency). **No IRR book exists** and none is invented: activating IRR
requires an operator to configure real amounts explicitly. Production
payment stays blocked until then (see `zarinpal-pricing-readiness.md`).

## Seed tooling (§27/§102)

```bash
bun scripts/seed-pricing.ts            # ensure/verify the EUR-v1 baseline
bun scripts/seed-pricing.ts --list     # print the catalog
# future IRR activation (explicit amounts only — never placeholders):
bun scripts/seed-pricing.ts --currency IRR \
  --monthly STARTER=9900000,BUSINESS=19900000,PRO=49900000 \
  --yearly  STARTER=99000000,BUSINESS=199000000,PRO=499000000 \
  [--activate]
```

Rules (§28/§103): create-missing only; re-runs are no-ops; a stored amount
that differs from the seed is **reported, never overwritten** (a change is a
new version); `--activate` is required to make an operator book live.
Amount validation: positive safe integers ≤ 10^12, no zero/negative/fractional
values for purchasable plans (§63).

## Activation policy (§51/§97)

Only operators (seed script / migration / future admin tool with strict
RBAC) may create or activate books. There is no public API that activates a
currency, and none is planned for the platform storefront.
