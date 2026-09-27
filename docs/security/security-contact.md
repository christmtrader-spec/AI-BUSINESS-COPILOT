# Security Contact & Vulnerability Reporting

**Document ID:** SEC-CONTACT-v1
**Round:** r27-docs-c
**Spec refs:** Prompt-spec §52 (report mechanism), §71 (handling workflow), §200 (security contact)
**Basis:** `src/lib/legal/public-config.ts` (runtime `SECURITY_CONTACT_EMAIL` read), `.env` (verified current state), `docs/security/password-recovery.md`, `docs/security/authentication-current-state.md`.

> **INTERNAL DOCUMENT.** Never linked from public pages. The public legal pages
> (`/privacy`, `/terms`, `/ai-data-use`, `/cookies`) render the security
> contact **only when an operator has configured it** — and honestly show a
> "not configured" state otherwise. This document explains the mechanism and
> the workflow behind that configuration.

---

## 1. Report mechanism — current state: NOT_CONFIGURED

- The report intake is the environment variable **`SECURITY_CONTACT_EMAIL`**,
  read at runtime by `src/lib/legal/public-config.ts` (never baked into client
  code, never hard-coded). Valid value = RFC-shaped email; invalid = `INVALID`;
  missing = `NOT_CONFIGURED`.
- **Today it is NOT_CONFIGURED**: `.env` contains no `SECURITY_CONTACT_EMAIL`
  (verified r27-docs-c). Until an operator sets it:
  - no public page advertises a security contact,
  - there is **no monitored intake channel** — nothing is pretending otherwise.
- When configured, the value is surfaced on the public legal pages as the
  designated address for security reports. Configuration is a deliberate
  operator act: setting the variable **is** the commitment to read that inbox.

## 2. What a good report contains

Reporters are asked for the minimum needed to reproduce and assess:

1. **Affected surface** — route or page (e.g. `POST /api/v1/copilot`,
   `/api/v1/businesses/[id]/members`), locale/UI area if relevant.
2. **Reproduction** — exact steps, minimal request (method, path, payload
   shape), expected vs actual behavior.
3. **Impact assessment** — what data or capability is exposed, which
   tenancy/role boundary is crossed (cross-tenant read? privilege
   escalation? auth bypass?), whether it is persistable.
4. **Environment** — signed-out vs signed-in role (VIEWER/STAFF/…), browser
   or tooling used, timestamp + timezone.
5. **Optional** — short screen recording or trimmed request/response pairs.

**No exploit weaponization.** Do not develop, automate, or chain the issue
further than needed to demonstrate it; do not run scanners against
production; do not degrade service to prove impact.

## 3. What NOT to include

- **Secrets** — any credentials you discovered (`NEXTAUTH_SECRET`, provider
  API keys, payment merchant credentials, session JWTs). Report that a class
  of secret is exposed and where; never paste the value.
- **Other users' data** — records, PII, transcripts, or invoices belonging to
  tenants other than your own test tenant. If a boundary leak exposes another
  tenant, report the *mechanism* and redact sample data.
- **AI prompt dumps** — full copilot grounding snapshots, system-prompt
  extracts, or other users' conversation content. Quote only the minimal
  fragment needed to show the behavior.
- No bulk exfiltration: demonstrate access, do not harvest.

## 4. Handling workflow

| Step | What happens | Honest status |
|---|---|---|
| **Acknowledge** | Operator confirms receipt to the reporter | Manual; only possible when `SECURITY_CONTACT_EMAIL` is configured. No auto-responder exists. No promised acknowledgement window. |
| **Triage** | Classify against the severity ladder in `docs/security/incident-response.md` (S1 data exposure / S2 auth bypass / S3 availability / S4 cosmetic); reproduce internally | Manual |
| **Fix** | Patch through the normal round workflow (worklog entry, migration discipline if schema changes, harness regression) | Standard engineering process |
| **Disclosure** | Coordinated with the reporter: reporter is told the fix shipped; public mention happens only by mutual agreement, without exploit detail | No bounty, no CVE process, no fixed disclosure deadline |

Reports that disclose another tenant's data or weaponized exploits may pause
cooperation until scope is re-agreed. Abuse of the intake (spam, threats) is
handled as ordinary abuse.

## 5. Explicit non-promises

- **No bug bounty program exists.** There is no reward, real or implied, for
  reports. Do not state or imply otherwise anywhere public.
- **No SLA is promised** — not for acknowledgement, triage, fix, or
  disclosure. Any timeframe language on public pages is prohibited; internal
  docs use effort-based phases only.
- **No 24/7 monitoring.** Intake is reviewed by platform operators during
  normal working rounds; there is no on-call rotation.
- **No compliance certification** backs this process (no SOC 2, no pen-test
  attestations).

## 6. Internal escalation path

- Escalation is to the **platform operators** via the configured contacts
  (`SECURITY_CONTACT_EMAIL` when set; support/privacy/legal contacts from
  `public-config.ts` when configured).
- Note the deliberate distinction: the operator env `AI_COST_OPERATOR_TOKEN`
  gates internal AI-cost mutation endpoints — it is **not** a security
  escalation channel and must never be referenced in reporter-facing
  communication.
- Suspected active incidents (data exposure in progress) follow
  `docs/security/incident-response.md` — the runbook, not this document.

## Current state (honest)

- `SECURITY_CONTACT_EMAIL` **not configured** → there is no public security
  contact and no monitored intake today; the public pages show the honest
  "not configured" state.
- Handling workflow is a manual operator process; no ticketing system, no
  auto-acknowledgement, no bounty, no SLA.
- First operator action when going public-with-contacts: set
  `SECURITY_CONTACT_EMAIL` to a monitored mailbox, then verify the legal pages
  render the CONFIGURED state (`public-config.ts` status).
- This document describes process intent only where it does not contradict
  the "not configured" reality above; anything not yet real is labeled as
  such, never as a promise.
