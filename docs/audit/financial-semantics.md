# Financial Semantics — What the Numbers ACTUALLY Mean

**Audit doc:** Prompt 17 (r18) · **Scope:** every financial term used in the UI, API, reports and AI copilot
**Method:** every definition below is traced to the implementation. Code is authoritative; labels are checked against `src/i18n/messages/en.ts` / `fa.ts`.

---

## 0. The one-paragraph honest summary

AI Business Copilot implements **simplified cash-based tracking for small businesses**, not double-entry accounting. There is no chart of accounts, no journal, no ledger, no accruals, no tax engine, no refunds, and no multi-currency conversion. All money is stored as **integer minor units** (`Int`), all arithmetic is integer arithmetic, and every aggregate is recomputed server-side from recorded transactions (`src/lib/reports.ts:1-10`). It is honest arithmetic over honest records — it is **not** a P&L, a balance sheet, or an accounting system of record.

---

## 1. Storage foundation (applies to every term below)

| Rule | Implementation |
|---|---|
| Money is **integer minor units** (e.g. cents) in `Int` columns | `src/lib/money.ts:2-7` (header law); `prisma/schema.prisma:179-180, 229-234, 272-274, 298`; SQLite has no usable `Decimal` — A08, `docs/PROJECT-CONSTITUTION.md:184-191` |
| Floating-point forbidden for authoritative money | `src/lib/money.ts:2-7`; integer guards throw on non-integers (`money.ts:62-74`) |
| Decimal → minor conversion uses **string math via BigInt** | `toMinor`, `src/lib/money.ts:32-53` (BigInt products at 44-45) |
| Rounding: **half-up on the first discarded sub-minor digit** | `src/lib/money.ts:42-48` — `fracPart` keeps `digits + 1` chars (line 43); `firstDiscarded >= 5 → +1` (lines 47-48) |
| Conversion overflow impossible | `Number.isSafeInteger` guard, `src/lib/money.ts:50-51` |
| Input validation before any math | regex `^-?\d*(\.\d*)?$`, rejects empty/`-`/`.`, `src/lib/money.ts:35-38` |
| Precision is business config, clamped 0..4 | `src/lib/money.ts:16-20` (`clampPrecision`); `Business.decimalPrecision`, `prisma/schema.prisma:45` |
| Display formatting is presentation-only | `fromMinor` / `formatMoney`, `src/lib/money.ts:56-59, 80-95` |

**Rounding rule, stated exactly:** `toMinor("12.345", 2)` keeps `1234` minor units, then inspects the first discarded digit (`5`) and rounds half-up → `1235`. Half-up is applied **only at the minor-unit boundary during input conversion** (`money.ts:47-48`) and at one display ratio (`avgSaleMinor` uses `Math.round`, `reports.ts:217`). Stored totals are never re-rounded: they are sums of already-integer values.

---

## 2. Term definitions

### 2.1 Revenue = SUM of `Sale.totalMinor` issued in the period (invoiced revenue, regardless of collection)

- Computed: `revenueMinor += s.totalMinor` for every non-deleted sale whose `issueDate` falls in the window — `src/lib/reports.ts:141-148` (bucketing per day at `reports.ts:131`).
- Basis is `issueDate`, **not** payment date: `db.sale.findMany({ where: { …, issueDate: { gte } } })`, `reports.ts:62-69`.
- Month version: same semantics per `localMonthKey` bucket — `reports.ts:303-316, 342-343, 470-477`.
- UI label is explicit about the basis: **"Revenue (issued)"** (`en.ts:655`, fa: "درآمد (فاکتورشده)" `fa.ts:658`); copilot snapshot field `revenueIssued` (`src/lib/ai/snapshot.ts:141`).
- **This is invoiced revenue, not cash received.** Cash received is a separate figure ("Cash collected", §2.8).

### 2.2 Sales = the count of invoices issued in the period

- `salesCount` increments once per in-window sale — `src/lib/reports.ts:142-148`; per month `reports.ts:343`.
- A "Sale" record **is an invoice**: sequential per-business number rendered `INV-0001` (`src/lib/finance.ts:7-12`), UI section titled "Sales / Invoices for everything you sell" (`en.ts:444-446`). There is no separate quotation/order entity.

### 2.3 Expense = `Expense.amountMinor` recorded in the period

- `expensesMinor += e.amountMinor` for non-deleted expenses in window — `src/lib/reports.ts:149-156` (query basis `spentAt`, `reports.ts:74-81`).
- Created as `status: "UNPAID"` with `paidMinor` 0 (`expenses/route.ts:125-135`); schema `prisma/schema.prisma:265-286`.
- An expense is a **vendor-facing cost entry with its own payment schedule** (payable + payments), not a ledger debit.

### 2.4 Cost = `Product.costPriceMinor` — an inventory cost snapshot, NOT a COGS ledger

- `costPriceMinor` is a per-product field (`prisma/schema.prisma:180`, zod bounds `schemas.ts:28`).
- The only place it is aggregated is **inventory valuation at cost**: `inventoryValueMinor += p.stockQty * p.costPriceMinor` (`reports.ts:190-199`); label "Inventory value (cost)" (`en.ts:680`).
- **There is no COGS.** Selling a product decrements stock and records the line at sale price (`sales/route.ts:199-222`); the product's cost at sale time is **not** captured on the `SaleItem` (its money field is only `unitPriceMinor`/`lineTotalMinor`, `prisma/schema.prisma:250-263`). Cost changes are not history-tracked, so "profit (issued basis)" (§2.5) does **not** subtract cost of goods sold.

### 2.5 "Gross profit" / "Net profit" — what reports ACTUALLY show

The app computes **two clearly-labeled figures** (`reports.ts:222-223`):

| Field | Formula | Honest meaning |
|---|---|---|
| `netCashMinor` | `collectedMinor − paidOutMinor` (`reports.ts:222`) | **NET CASH FLOW**: actual money in (payments IN) minus actual money out (payments OUT) in the period. The primary honest number. Label: "Net cash flow" (`en.ts:661`, fa `fa.ts:664`). |
| `netAccrualMinor` | `revenueMinor − expensesMinor` (`reports.ts:223`) | **"Profit (issued basis)"** (`en.ts:662`, fa `fa.ts:665`): invoiced revenue minus *recorded expenses*. It is NOT a formal P&L: no COGS (§2.4), no depreciation, no accruals, no tax provision, no matching principle. |

**Plain statement:** the MVP shows **net cash flow** as the trustworthy bottom line. `netAccrualMinor` is a rough issued-basis indicator and must never be presented as accounting profit. There is **no formal gross profit anywhere** — no gross-margin figure is computed in `reports.ts` (nothing between revenue and expenses is netted; top products are ranked by revenue only, `reports.ts:166-176`).

### 2.6 Payment = one cash movement IN or OUT against exactly one Sale or one Expense

- Model: `direction` `"IN"` (customer pays us) | `"OUT"` (we pay supplier), `amountMinor`, `method`, one of `saleId`/`expenseId` (`prisma/schema.prisma:288-309`).
- Exactly-one-target is enforced: `.refine(v => Boolean(v.saleId) !== Boolean(v.expenseId))` (`src/lib/schemas.ts:103-106`).
- Direction is **derived server-side from the target** — `direction = "IN"` in the sale branch, `"OUT"` in the expense branch (`payments/route.ts:112, 135`); never client-supplied.
- **No refunds exist**: `amountMinor: z.number().int().min(1)` (`schemas.ts:98`) — a negative payment is unrepresentable. Correcting money = deleting the payment (reversal, §3).
- Methods are a closed enum `CASH | BANK_TRANSFER | CARD | OTHER` (`schemas.ts:66`).

### 2.7 Receivable / Payable = outstanding sums over non-deleted records with `status != "PAID"`

- Receivable: `SUM(totalMinor − paidMinor)` over `sale.findMany({ businessId, deletedAt: null, status: { not: "PAID" } })` — `src/app/api/v1/receivables/route.ts:16-26` (list capped `take: 200`, line 19).
- Payable: identical over expenses — `src/app/api/v1/payables/route.ts:16-26`.
- The same aggregates back the reports/copilot "outstanding" block: `sale.aggregate`/`expense.aggregate` with `status: { not: "PAID" }` (`reports.ts:103-112, 228-233`) — labeled all-time, outside the window (`snapshot.ts:138, 170-174`; `en.ts:684-685`).
- UI: "Total receivable" / "Total payable" (`en.ts:608, 627`; fa `fa.ts:689-690`).

### 2.8 Outstanding balance (per document) = `totalMinor − paidMinor`, floored at 0

- Per-invoice: `balanceMinor: s.totalMinor - s.paidMinor` (`sales/route.ts:115`; detail `sales/[id]/route.ts:47`; month drill-down `reports.ts:508, 517`).
- "Floored at 0" holds because `paidMinor ≤ totalMinor` is an enforced write invariant (§3, overpayment guard) — the subtraction can never go negative. The reversal path additionally clamps: `Math.max(sale.paidMinor - payment.amountMinor, 0)` (`payments/[id]/route.ts:39, 48`).
- UI: "Balance due" (`en.ts:506`); payment form enforces client-side too: "Payment cannot exceed the outstanding balance." (`en.ts:601`).

### 2.9 Cash flow = SUM(payments IN) − SUM(payments OUT) in the period

- `collectedMinor` / `paidOutMinor` accumulate by `p.direction` over the window (`reports.ts:157-163`; buckets `reports.ts:133-135`; monthly `reports.ts:346-352`).
- `netCashMinor = collectedMinor − paidOutMinor` (`reports.ts:222, 366, 499`).
- UI: "Cash in vs cash out — actual payments received and made — the cash view of the business." (`en.ts:669-670`).

### 2.10 Status (`UNPAID | PARTIAL | PAID`) — derived, never client input

- Single source of truth: `statusOf(totalMinor, paidMinor)` — `paid ≤ 0 → UNPAID`, `paid ≥ total → PAID`, else `PARTIAL` (`src/lib/money.ts:106-115`).
- Set only inside the payments pipeline (`payments/route.ts:123-129, 146-152`; reversal `payments/[id]/route.ts:39-43, 47-52`) or recomputed when an expense amount is edited (`expenses/[id]/route.ts:62-65`). Created as `UNPAID` (`sales/route.ts:180`, `expenses/route.ts:131`). Schema comment: "never client input" (`prisma/schema.prisma:214-218`).
- Labels EN/FA match the semantics: Unpaid/Partial/Paid (`en.ts:440-443`, `fa.ts:443-445`).

---

## 3. Invariants enforced in code

| # | Invariant | Where enforced |
|---|---|---|
| I1 | `totalMinor === subtotalMinor − discountMinor` | Server recompute at creation: `sales/route.ts:148-161` (client totals never read; discount may not exceed subtotal, `sales/route.ts:158-160`) |
| I2 | `lineTotalMinor === qty × unitPriceMinor` | `sales/route.ts:153` (integer multiply; zod `qty ≥ 1`, `unitPriceMinor ≥ 0`, `schemas.ts:72-73`); schema comment `prisma/schema.prisma:260` |
| I3 | `paidMinor ≤ totalMinor` (no overpayment) | Overpayment guard in the **single-writer** pipeline: `payments/route.ts:116-122` (sales) and `139-145` (expenses) — 422 `OVERPAYMENT` inside the transaction |
| I4 | `amountMinor ≥ 1` (no zero/negative payments ⇒ no refunds) | `schemas.ts:98`; expenses `amountMinor: min(1)` `schemas.ts:87` |
| I5 | `status === statusOf(totalMinor, paidMinor)` ∈ {UNPAID, PARTIAL, PAID} | `money.ts:106-115`; written only by payments pipeline / expense-update recompute (§2.10) |
| I6 | All money is `Int` minor units | Schema columns `Int` (`schema.prisma:229-234, 272-274, 298`); runtime integer guards `money.ts:62-74` |
| I7 | `paidMinor`/`status` have a **single writer**: the payments pipeline, one `$transaction` covering guard + increment + Payment row + audit | `payments/route.ts:2-8` (header law), `101-184`; reversal tx `payments/[id]/route.ts:35-75`; schema law `prisma/schema.prisma:212-218` |
| I8 | Every payment targets exactly one sale XOR one expense | `schemas.ts:103-106` |
| I9 | Money history stays honest on delete: a Sale/Expense with payments cannot be deleted | `sales/[id]/route.ts:81-88`; `expenses/[id]/route.ts:100-107` (422 `*_HAS_PAYMENTS`; soft delete via `deletedAt`, `schema.prisma:237, 277`) |
| I10 | Per-invoice sequential numbering `(businessId, number)` unique | `sales/route.ts:163-170`; `@@unique([businessId, number])` `schema.prisma:244` |
| I11 | Tenant scope on every financial query | All queries above filter `businessId: ctx.businessId`, resolved from verified membership (`src/lib/tenant.ts:38-77`) |

---

## 4. Explicit non-features (what this app is NOT)

| Non-feature | Evidence |
|---|---|
| **No double-entry accounting** — no ledger/journal/chart of accounts; balances are derived sums, not posted entries | Only `Sale/SaleItem/Expense/Payment` exist (`prisma/schema.prisma:220-309`); reports are recomputed aggregates (`reports.ts`) |
| **No accruals** — revenue on issue date, cash tracked separately; no deferrals/receivables aging schedule | `reports.ts:62-69` (issueDate basis) vs `70-73` (paidAt basis); MVP scope lists no aging (`docs/PROJECT-CONSTITUTION.md:98-115`) |
| **No taxes module** — no tax rates, no tax lines, no filings; a "tax label" is business settings copy only | No tax columns anywhere in `prisma/schema.prisma`; settings scope: "Currency, locale, timezone, tax label" (`docs/PROJECT-CONSTITUTION.md:103`) |
| **No refunds / credit notes** — payments are strictly positive; corrections happen by deleting a payment (audited reversal) | `schemas.ts:98` (`min(1)`); reversal restores balance and deletes the row (`payments/[id]/route.ts:35-75`); UI copy "Payment removed — balances restored" (`en.ts:567-569`) |
| **No multi-currency conversion** — one currency per business; no FX rates, no cross-currency totals | `Business.currencyCode/Symbol/decimalPrecision` (`schema.prisma:43-45`); A04 "MVP UX supports one primary currency per business" (`docs/PROJECT-CONSTITUTION.md:153-160`) |
| **Not an accounting system of record** — product claims are "AI-powered business management and financial insight", never "accounting software" | Vision wording `docs/PROJECT-CONSTITUTION.md:16-28`; positioning guardrail of this audit |

---

## 5. Consistency of the wording (i18n check)

Checked EN vs FA for the terms defined above; both dictionaries carry the honest semantics:

| Concept | EN (`en.ts`) | FA (`fa.ts`) | Verdict |
|---|---|---|---|
| Revenue (issued basis) | "Revenue (issued)" `en.ts:655` | "درآمد (فاکتورشده)" `fa.ts:658` | ✅ basis stated |
| Net cash flow | `en.ts:661` | "جریان نقدی خالص" `fa.ts:664` | ✅ |
| Issued-basis profit | "Profit (issued basis) {value}" `en.ts:662` | "سود (مبنای فاکتور)" `fa.ts:665` | ✅ labeled, not "net profit" |
| Outstanding balance | "Balance due" `en.ts:506`, "Outstanding" `en.ts:600` | "مانده" `fa.ts:603` | ✅ |
| Overpayment guard copy | "Payment cannot exceed the outstanding balance." `en.ts:601` | "پرداخت نمی‌تواند از مانده بیشتر باشد." `fa.ts:604` | ✅ |
| Copilot grounding note | "Every figure comes from your recorded transactions — never invented." `en.ts:789` | "همه اعداد از تراکنش‌های ثبت‌شدهٔ شما می‌آیند — بدون ساختگی." `fa.ts:782` | ✅ |
| Copilot read-only badge | "Read-only — cannot change records" `en.ts:729` | "فقط‌خواندنی — ثبت تغییر نمی‌کند" `fa.ts:732` | ✅ |

---

## 6. Auditor notes

1. `netAccrualMinor` is the only figure with upgrade risk: the name space ("profit") invites misreading as P&L net income even with the "(issued basis)" label. Any future marketing copy must keep the qualifier or drop the figure (see §2.5).
2. Inventory valuation (§2.4) uses **current** `costPriceMinor` × current stock; historic cost is not snapshotted, so the valuation moves when a product's cost is edited. Documented behavior, not a bug — but it must not be called "asset value".
3. `avgSaleMinor` is the only `Math.round` over a ratio (`reports.ts:217`); it can differ from any naive client-side recompute by ±0.5 minor units — the server value is authoritative.
4. Receivables/payables list endpoints cap at 200 rows (`receivables/route.ts:19`, `payables/route.ts:19`) while the aggregate in `reports.ts:103-112` is unbounded — totals stay correct beyond 200 open documents, only the itemized list truncates.
