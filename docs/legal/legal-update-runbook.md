# Legal Document Update Runbook

**Document ID:** LEGAL-RUNBOOK-v1 · **Created:** 2026-09-25 (Prompt 27 §85)
There is deliberately NO automation of legal approval. Every change to a
public legal document follows these steps, in order:

1. **Draft the change** — edit the structured content source:
   `src/content/legal/privacy.ts` / `terms.ts` / `ai-data-use.ts` /
   `trust.ts`. Both locale variants (`en`, `fa`) MUST change together;
   run `bun scripts/i18n-audit.ts` and the prompt-27 harness afterwards.
2. **Legal / operator review** — a qualified reviewer approves the wording.
   Machine translation alone is NOT approval (§146): the Persian and English
   drafts must BOTH be reviewed if they are meant to be equivalent
   (§145 — otherwise flag the mismatch internally).
3. **Version the document** — bump `version` in `src/config/legal.ts`
   (`LEGAL_DOCS[doc].version`, e.g. `1.0` → `1.1` for clarifications,
   `2.0` for material changes).
4. **Update effective date** — set `effectiveDate` to the date the new
   version becomes binding and `lastUpdated` to the edit date
   (both `YYYY-MM-DD`, same file).
5. **Deploy** — normal deployment process.
6. **Record the version** — append a row to the version log below and to
   `worklog.md`.
7. **Notify users where required** — the platform has NO notification
   engine; if a material change legally requires notice, the operator
   performs it through an agreed channel. This step is
   **LEGAL REVIEW REQUIRED** per jurisdiction.

## Re-acceptance (§72)

NO automatic re-acceptance mechanism exists. If product/legal policy later
requires explicit acceptance of new versions, implement the documented
`UserLegalAcceptance` design (documentType + documentVersion + userId +
acceptedAt + locale, server-side — never client-only storage) as a NEW
migration. Until then, the signup page provides document access BEFORE
signup completes and records nothing (§69/§70).

## Version log

| Document | Version | Effective | Last updated | Change | Reviewed by |
|---|---|---|---|---|---|
| Privacy Policy | 1.0 | 2026-09-25 | 2026-09-25 | First published draft | — (LEGAL REVIEW REQUIRED) |
| Terms of Service | 1.0 | 2026-09-25 | 2026-09-25 | First published draft | — (LEGAL REVIEW REQUIRED) |
| AI Data Use | 1.0 | 2026-09-25 | 2026-09-25 | First published draft | — (LEGAL REVIEW REQUIRED) |
| Trust | 1.0 | 2026-09-25 | 2026-09-25 | First published draft | — (LEGAL REVIEW REQUIRED) |

## Public-page marker rule (§164)

Internal documents may carry `LEGAL_REVIEW_REQUIRED` markers. Public pages
must never render raw internal markers — the content layer contains no such
strings, and `scripts/legal-public-readiness.mjs` enforces this.
