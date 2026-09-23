# Data Inventory — Before Prompt 19 Baseline

Captured BEFORE any migration metadata was written to the live database.
Source: `scripts/db-inventory.mjs` (read-only probe; counts/structure only — no record contents).

- Captured at: 2026-09-23T05:20:35.240Z
- Source database: `db/custom.db` (483328 bytes)
- SQLite integrity: ok · quick_check: ok
- Foreign-key violations: 0
- Migration tables present: none (db-push era)

## Row counts (authoritative baseline — machine-readable)

| Model | Rows |
|---|---|
| `User` | 34 |
| `Business` | 13 |
| `BusinessMember` | 19 |
| `BusinessInvite` | 6 |
| `AuditLog` | 230 |
| `Customer` | 23 |
| `Supplier` | 0 |
| `Product` | 2 |
| `InventoryAdjustment` | 10 |
| `Sale` | 11 |
| `SaleItem` | 13 |
| `Expense` | 5 |
| `Payment` | 9 |
| `ChatSession` | 1 |
| `ChatMessage` | 2 |
| `PasswordResetToken` | 4 |

## Relationship sanity checks (orphan detection)

| Check | Violations |
|---|---|
| business_ownerId_dangling | 0 |
| member_businessId_dangling | 0 |
| member_userId_dangling | 0 |
| saleItem_saleId_dangling | 0 |
| payment_invalid_target | 0 |
| payment_businessId_mismatch | 0 |
| passwordResetToken_userId_dangling | 0 |

## Per-owner / per-business aggregates (§39 comparison set)

### Businesses per owner

| Owner (userId) | Businesses |
|---|---|
| cmu9lm60p0000lswdqulrn9aq | 2 |
| cmu9ptfsp0000lsfyk52e1gyu | 2 |
| cmuav9gsu003okgtw6r2o262m | 1 |
| cmubayosc0004kghs69yb9xot | 1 |
| cmubayp0t0005kghs9blnwv4w | 1 |
| cmubazpoj001ukghsts4wood9 | 1 |
| cmubazpx1001vkghsvoejuiyn | 2 |
| cmubfcz6t0000kg1vxyfltfdf | 1 |
| cmubfczjf0001kg1v7fnuyrpa | 2 |

### Per-business aggregates

| businessId | members | customers | products | sales | expenses | payments | chatSessions |
|---|---|---|---|---|---|---|---|
| cmu9lmbzx0002lswdrt8einli | 4 | 17 | 1 | 1 | 1 | 3 | 1 |
| cmu9qa0bd0006lsfycft4wu9f | 1 | 2 | 1 | 1 | 1 | 3 | 0 |
| cmu9qa6uz000clsfykkzrqpos | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| cmu9vkstc000flsv5c35qsigg | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| cmuavbpvf003qkgtw8206cwti | 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| cmubaypue0007kghsn4u4hwfz | 2 | 1 | 0 | 3 | 1 | 1 | 0 |
| cmubaypvc000dkghswdcdjlpu | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| cmubazqlc001xkghs243ugy2j | 2 | 1 | 0 | 3 | 1 | 1 | 0 |
| cmubazqlp0023kghs39zowra3 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| cmubazrgu002nkghszrp9u4fb | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| cmubfd0z20003kg1vrukc4pgs | 2 | 1 | 0 | 3 | 1 | 1 | 0 |
| cmubfd0zi0009kg1vdvmr80k6 | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| cmubfd49e000tkg1vs0a74h2b | 1 | 0 | 0 | 0 | 0 | 0 | 0 |

## Money totals (integer minor units — must never change)

| Aggregate | Value (minor) |
|---|---|
| saleTotalMinor | 300008500 |
| salePaidMinor | 7000 |
| expenseAmountMinor | 163702 |
| expensePaidMinor | 60000 |
| paymentInMinor | 7000 |
| paymentOutMinor | 60000 |

> Note: `PasswordResetToken` rows may legitimately decrease over time via documented expired-token cleanup (Prompt 18). All other counts must never decrease.
