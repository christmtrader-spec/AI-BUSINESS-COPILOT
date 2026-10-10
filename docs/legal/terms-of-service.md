# Terms of Service — internal document record

**Document ID:** LEGAL-TERMS-v1 · **Created:** 2026-09-25 (Prompt 27 §163)
**Status:** DRAFT — **LEGAL REVIEW REQUIRED** before public production launch.

Public document source: `src/content/legal/terms.ts` (en + fa), rendered at
`#/terms`.

## Topic → implementation mapping (§39/§122)

| Terms topic | Actual behavior documented |
|---|---|
| Accounts & eligibility | Real name/email signup; password responsibility; user responsible for account activity |
| The service | Business workspace + reports + AI copilot grounded in recorded data |
| Plans / trial / payments | Free plan exists; paid plans shown before purchase from the DB price book (PricingService); trial "may be offered when enabled" — NO hard-coded promise (§44; `BILLING_TRIALS_ENABLED` currently DISABLED); payments: "terms presented before purchase" (§45 — no invented refund windows/chargebacks/auto-renewal) |
| Cancellation | `billing/cancel` exists; effect shown in product; no refund promise (§46) |
| AI features | Assistive only; may contain errors; not professional advice (§40/§42); usage metered server-side |
| Business data responsibility | User responsible for lawfully entering third-party data (§12/§96) |
| Acceptable use | Concrete technical restrictions: unauthorized access, malware, automated attacks, credential theft, payment fraud, scraping outside provided exports, AI abuse (§50/§51/§99) |
| Availability | "May be unavailable from time to time" — NO uptime percentage (§47) |
| Support | Contact channel; NO response-time promise (§48) |
| IP | Platform software vs user content, neutral; AI-output ownership explicitly deferred to legal review (§97/§98) |
| Termination & deletion | Account/business deletion described accurately; operator may restrict access for violations (minimal, factual) |
| Disclaimers | As-is; metrics from recorded data; no licensed accounting/tax/audit/legal/investment services (§42) |
| Changes | Version/date mechanism (§142) |

## Deliberately ABSENT from the public document

- **Governing law / jurisdiction** — nothing invented (§147). The internal
  placeholder is `[GOVERNING LAW — LEGAL REVIEW REQUIRED]` and lives only
  here, never on the public page.
- **Liability cap numbers** — the public text says liability is limited
  "to the extent permitted by applicable law" and points to legal review
  for the detailed clause.
- **Refund policy** — none exists; none promised (§45/§46).
- **Company legal identity block** — rendered only when
  `PUBLIC_COMPANY_LEGAL_NAME` / address are configured (§148/§150).

## Legal-review checklist for the reviewer

1. Confirm the neutral controller/processor wording is acceptable (§11).
2. Provide the governing-law clause and company identity block.
3. Decide whether explicit acceptance + `UserLegalAcceptance` recording is
   required (§70) — currently NOT implemented by design.
4. Review the Persian text for legal equivalence with English (§145/§146).
5. Confirm acceptable-use list scope with counsel (§50).
