# Pricing FAQ (content source) — Prompt 25 §111-§115

The rendered FAQ lives in the i18n files
(`src/i18n/messages/{en,fa}.ts` → `pricing.faq.*`) and renders from the
public pricing payload. This document is the review-friendly source of the
answers and the rules they follow.

| # | Question | Answer policy |
| --- | --- | --- |
| 1 | What is AI Business Copilot? | Factual module list; AI answers "from your recorded business data" (accurate per architecture). |
| 2 | Who is it for? | Small/growing businesses; server-enforced roles. |
| 3 | What is included? | Exactly the implemented modules; no storage/tax promises. |
| 4 | How do plans differ? | Points to the comparison table (real entitlements). |
| 5 | How does AI usage work? | Metered per accepted question; answers computed from data; no invented numbers. |
| 6 | What happens when a limit is reached? | Creation refused with a clear message; records never deleted. |
| 7 | Is there a free plan? | Yes — "Free plan" wording, limits listed; no "free forever" claim (§71). |
| 8 | Is there a trial? | Rendered ONLY when `BILLING_TRIALS_ENABLED=1` (§114). |
| 9 | How does cancellation work? | Real behavior: data kept, paid period finishes; **no refunds promised** (§113). |
| 10 | Which currencies are supported? | The selector lists exactly the currencies with an active book; no FX ever. |
| 11 | How is payment handled? | Server-side checkout with a frozen price snapshot + server verification; availability depends on currency/provider (§112: no "pay securely now" while real payments are blocked). |

Rules: every answer must stay technically accurate; when a capability does
not exist the FAQ must not imply it. Persian copy is a full equivalent, not
a machine translation afterthought.
