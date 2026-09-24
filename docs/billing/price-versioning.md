# Price Versioning — Prompt 24 (§8/§9/§30-§36/§61/§81/§104)

## Versions are rows, not edits

A price change NEVER mutates an existing `PlanPrice.amountMinor` (§36). It
creates a **new PriceBook version row**:

```
EUR_STANDARD v1-2026-09   (active, effectiveFrom 2026-09-24)
EUR_STANDARD v2-2027-01   (staged: active=false OR future effectiveFrom)
```

Version identifiers are readable and unique per code (`v1-2026-09`, §69);
book codes are stable and never encode prices (`EUR_STANDARD`, `IRR_IRAN`,
§70). Regional books (`EU`, `GLOBAL`) can be added later without schema
changes (§71) — regional ROUTING is not implemented.

## Effective windows (§9/§33)

`effectiveFrom` / `effectiveTo` gate every resolution against the **server
clock** (never browser time):

- future `effectiveFrom` → not selectable yet (staged price);
- past `effectiveTo` → expired, not selectable;
- among currently-effective active books, the newest `effectiveFrom` wins
  (deterministic when an operator stages overlapping books).

Inactive books are simply invisible to resolution — but they remain in the
database as history.

## Checkout snapshots (§29-§31)

At session creation the PricingService's resolution is frozen onto the
CheckoutSession:

| Column | New sessions | Pre-Prompt-24 sessions |
|---|---|---|
| `amountMinor` / `currency` | resolved price | unchanged |
| `pricingVersion` | book version (`v1-2026-09`) | legacy value (`v1-2026-09-eur`) — never reinterpreted |
| `priceBookCode` | book code (`EUR_STANDARD`) | `NULL` |
| `priceBookId` | book id | `NULL` |

Later catalog changes can never re-price an open or completed session. A
session priced at EUR-v1 still charges 900 after v2 activates (verified by
the p24 harness, Q9).

## Historical immutability (§31/§36/§100/§101)

- Completed/failed PaymentTransactions and their sessions are immutable.
- Existing active subscriptions are NOT re-priced or cancelled when the
  catalog changes.
- A price version used by history is **retired, never deleted**
  (`active=false`); the `Restrict` FK additionally prevents deleting a book
  that sessions still reference.

## Concurrency (§34)

A checkout resolves the book and its price rows and snapshots them in one
session row; a version change that lands mid-checkout cannot mix rows — the
session references exactly ONE book. Payment initiation does not hold a
database transaction open while the provider is called.

## Audit (§35)

Price-affecting operator actions go through the seed/migration path and are
reviewable in VCS; the checkout path audits `billing.checkout_created` with
plan, period, amount, currency, provider, version and book code on every
intent. A future interactive price-admin tool must record
old/new/currency/plan/period/version/actor/time per §35.
