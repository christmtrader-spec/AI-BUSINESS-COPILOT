# Incident Response Runbook

**Document ID:** SEC-IR-v2
**Round:** r27-docs-c · Prompt 29 update (request correlation, structured events, backup/restore evidence)
**Spec refs:** Prompt-spec §70 (incident process), §201 (runbook); §147/§238/§240 (internal-only)
**Basis:** `src/lib/audit.ts` + `AuditLog`, `src/lib/rate-limit.ts`, `src/lib/observability/*` (Prompt 29), `dev.log` / `server.log`, `db/backups/` convention, `docs/database/migration-workflow.md`, `src/lib/auth.ts` (NEXTAUTH_SECRET), `src/lib/ai/cost/*`.

> **INTERNAL DOCUMENT — never linked from public pages.** This is the
> operator runbook for responding to security incidents. It contains no
> customer-facing language. Every timeframe-free commitment here is an
> internal placeholder; nothing in this file may be quoted publicly without
> legal review.

---

## 0. Ground rules

- **No guaranteed notification timeframes.** No section of this runbook
  promises regulators, tenants, or reporters a notification deadline. Any
  external commitment is **LEGAL REVIEW REQUIRED** and may only say that
  handling follows "applicable requirements and internal procedures" — and
  even that phrasing stays an internal runbook placeholder until reviewed.
- Single-node deployment (SQLite, one app process): the blast radius of most
  incidents is bounded by what one database and one process can reach.
- The runbook uses only tools that actually exist in this repo (§1). If an
  incident needs a tool we lack, that gap is recorded in the postmortem.

## 1. Tools that actually exist

| Tool | Location | Notes |
|---|---|---|
| Audit log | `AuditLog` table via `src/lib/audit.ts` | before/after JSON, IP, user-agent, actor; append-only; platform events have `businessId: null` |
| Rate-limit counters | `src/lib/rate-limit.ts` | in-memory, per-process — lost on restart; useful only while the process lives |
| Dev/runtime log | `server.log` (prod) / `dev.log` (dev) | **Prompt 29:** structured JSON lines — one object per line, `requestId` on every request-scoped record; grep-able, redacted (§5 below) |
| DB backups | `db/backups/` via `scripts/backup-db.mjs` + `scripts/verify-backup.mjs` | **Prompt 29 automation:** timestamped artifacts + SHA-256 sidecars; restore drill `scripts/restore-drill.mjs` records PASS/FAIL to `db/backups/last-restore-drill.json`. Scheduling is the operator's job (not auto-installed, §109) — existence of a backup for a given date is still never assumed |
| Readiness signal | `GET /api/ready` (Prompt 29) | public-safe component statuses (`blocked` = database/migrations/mandatory config; `backups`/`restoreDrill` staleness) — useful as an incident impact check, not a root-cause source |
| Migration discipline | `prisma/migrations/`, `docs/database/migration-workflow.md` | schema changes are forward-only migrations; recovery can rebuild schema, not necessarily data |
| AI usage/cost ledger | `UsageEvent`, `AiCostRecord`, `AiCostAnomaly` | per-request token/cost trail for anomaly review |
| Session invalidation | `User.sessionVersion` + `NEXTAUTH_SECRET` rotation | per-user bump or global JWT re-sign invalidation |

## 2. Severity ladder

| Level | Definition | Examples |
|---|---|---|
| **S1** | Data exposure / tenant breach — cross-tenant read or write, secret leak affecting tenant data, business deletion by unauthorized actor | Tenant isolation bug returns another business's invoices; DB file exposed |
| **S2** | Auth bypass / privilege escalation without tenant-data cross-over | Role check skipped on a route; sessionVersion not enforced; invite grants wrong role |
| **S3** | Availability / integrity loss without confidentiality impact | AI provider outage surface (honest errors), runaway cost from a leaked platform key, DB corruption |
| **S4** | Cosmetic / informational | Header hygiene, verbose error text, missing rate limit on a harmless read |

Default starting severity: the **higher** of what the evidence supports;
downgrade only with evidence, and record the reasoning in the postmortem.

## 3. Phases

### 3.1 Detection
Sources: audit-log review (`GET /api/v1/audit` for tenant-scoped, direct DB
query for platform-level rows), rate-limit counter patterns (burst on
`login:*`/`pwd-reset-*` keys), `dev.log` error spikes, AI cost anomalies
(`AiCostAnomaly`, UNKNOWN-ratio alerts), and external reports via the
security contact (`docs/security/security-contact.md`). Record detection
time, source, and initial observation verbatim — no interpretation yet.

### 3.2 Triage
Assign severity (§2), name an owner, open a worklog-adjacent incident note
(timestamps, actions, evidence paths). Decide within the phase — not on a
clock — whether this is an active intrusion (go to Containment) or a
vulnerability report (normal fix workflow + coordinated disclosure).

### 3.3 Containment
Options, in escalating order: disable the affected feature at its boundary
(e.g. flip the AI cost guard or take a route behind its fail-closed gate),
invalidate sessions for affected users (`sessionVersion` bump), block abusive
keys at the rate limiter while the process stays up, or stop the process
entirely. Preserve evidence **before** disruptive steps: copy `dev.log`,
export relevant `AuditLog`/`UsageEvent` rows, and snapshot the DB file to
`db/backups/` with a `pre-incident-<timestamp>` name.

### 3.4 Investigation
Reconstruct the timeline from `AuditLog` (actor, IP, user-agent, before/after
JSON), rate-limit patterns, and AI usage metadata (tokens per request, model
strings as reported). Scope: which businesses, which users, which time
window, what data classes (per `docs/security/data-classification.md`
tiers). Do not modify evidence rows; work on copies.

### 3.5 Credential Rotation
Rotate every credential plausibly in scope; rotation scope is fixed and
checklisted:

- **AI provider keys** (rotate in the provider console, then update env).
- **Payment provider keys** — when live (mock/sandbox today).
- **SMTP/email credentials** — when configured (not today).
- **`NEXTAUTH_SECRET`** — rotation re-signs JWTs and thereby invalidates all
  sessions platform-wide; expect a mass re-login and say so internally.
- **`DATABASE_URL`** — rotate DB credentials if the deployment exposes them.

Never rotate by editing history files only; remove secrets from env, then
verify the new values via the app's fail-fast checks.

### 3.6 Data Impact Assessment
Classify exposed data against the classification tiers; enumerate affected
tenants/users from evidence rows; distinguish "mechanism existed" from "data
was actually accessed" — we record only what evidence supports. Output: a
written impact statement (what, whose, when, certainty level) that feeds
Legal Review.

### 3.7 Legal Review
**LEGAL REVIEW REQUIRED for every external commitment.** Whether notification
is owed, to whom, in what language, and within what timeframe is a legal
determination under the deployment jurisdiction — this runbook deliberately
contains no timeframes and no regulator names. Legal review also approves the
final wording of any customer communication before §3.8 may use it.

### 3.8 Customer Communication
Only after Legal Review. Approved factual content: what happened, what data
classes were involved, what was done, what customers should do (e.g.
password reset guidance after credential-adjacent events). Prohibited: any
promised timeframe, any "you were never at risk" assurance not backed by the
impact statement, any blame-shifting language. Communication happens through
configured channels only (email when configured; in-product notice when
appropriate).

### 3.9 Recovery
Restore or repair through the normal engineering path: forward migrations,
harness regression suites (`scripts/prompt17…prompt26-*.mjs`), i18n audit,
lint/tsc, and — only if the platform allows a build window — `bun run build`.
Verify from live behavior, not assumptions: health endpoint, auth flow,
copilot smoke, audit writes.

### 3.10 Postmortem
Blameless, written, appended to the worklog per Constitution Rule 08:
timeline, root cause, evidence inventory, severity call, what the runbook
lacked, and concrete follow-ups (files, owners). Gaps become risks in
`docs/RISK-REGISTER.md`.

## 5. Request correlation & structured logging (Prompt 29 §24–§34, §80–§85)

### Correlating a request across proxy + app + logs

- **Every API response carries `X-Request-ID`** (route wrapper in
  `src/lib/api-helpers.ts`; `/api/health` and `/api/ready` echo it too).
  Ask the reporter for it, or read it from the browser network panel.
- A client-supplied ID is honored only if 8–64 chars of `[A-Za-z0-9._-]`;
  anything malformed is replaced by a server-generated UUID — an attacker
  cannot poison the correlation stream.
- **Search the logs by requestId** (all lines of a request carry the same
  value):

  ```bash
  grep -F '"requestId":"<ID>"' server.log
  ```

- Widen the window by `route` and `ts`; pair with durable `AuditLog` rows
  (actor/IP/before-after) for the same time frame.

### Structured events and error classes

- Fixed event vocabulary: `src/lib/observability/events.ts` — full catalog
  and emission status in `docs/security/observability-and-logging.md` §5
  (`api.request.failed`, `api.request.rate_limited`, `auth.password_reset.*`,
  `database.connection.failed`, …).
- Coarse error classes for triage: `validation`, `authentication`,
  `authorization`, `rate_limit`, `not_found`, `conflict`, `dependency`,
  `database`, `provider`, `timeout`, `internal` — mapped from HTTP status;
  no internal detail ever leaves the server in an event.
- Log-level discipline: expected 4xx are quiet (DEBUG; visible via domain
  audit); 5xx-mapped states WARN; unhandled 500 ERROR with bounded
  `errorName`/`errorMessage` — no bodies, no parameters.

### Redaction guarantees (what is safe to paste into tickets)

- Secret-shaped keys (`password`, `token`, `secret`, `authorization`,
  `cookie`, `database_url`, `nextauth_secret`, `email_server_password`,
  `merchant`, …) are `[REDACTED]` **recursively**, enforced in the logger
  itself (§33).
- Oversized string values are DROPPED to a length marker, never sliced — a
  sensitive suffix cannot survive truncation (§34). Metadata is bounded
  (8 KB / depth 4 / 20 array items / 40 object keys).
- Stack traces never appear in production logs unless
  `SECURE_SERVER_DIAGNOSTICS=true` was deliberately enabled (§28).

### Backup / restore drill as incident recovery evidence

- Before disruptive containment steps, snapshot the DB with
  `node scripts/backup-db.mjs` (transaction-consistent, checksummed) — this
  doubles as the forensic copy.
- The **verified backup** (sidecar `verified=true` after
  `scripts/verify-backup.mjs`) is the recovery anchor; the restore drill
  (`scripts/restore-drill.mjs`, isolated temp clone, checksum-first) proves
  restorability WITHOUT touching production and records PASS/FAIL in
  `db/backups/last-restore-drill.json`.
- Recovery procedures: `docs/deployment/production-operations.md` (runbook)
  and `docs/deployment/release-rollback.md` (§118/§119). The production DB
  is never overwritten automatically.

## 6. Example walkthrough — leaked AI provider key

Scenario: a `Z_AI_*` provider credential was committed to a public fork.

1. **Detection** — key spotted externally; AI usage/cost ledger reviewed for
   anomalous request volume or unknown-token spikes since exposure.
2. **Triage** — severity S3 (platform cost/abuse risk; no tenant data on the
   line unless the key also enables reading tenant content — re-assess if so).
3. **Containment** — evidence first (copy `dev.log`, snapshot DB); if abuse is
   visible, enable the AI cost guard (fail-closed) or disable the provider
   config so requests fail closed.
4. **Investigation** — correlate `UsageEvent`/`AiCostRecord` rows (requestId,
   timestamps, token counts, reported model) against expected traffic; note
   all rows that cannot be attributed to legitimate business usage.
5. **Credential Rotation** — rotate the key **in the provider console**
   (revocation is authoritative there, not in env files); update the env
   value; **remove the key from env history** (old shells, pasted logs,
   screenshots); verify the app still reaches the provider with the new key.
6. **Data Impact Assessment** — if the leaked key only permitted inference
   calls: impact is platform cost, not tenant data. If the key were bundled
   with tenant-scope access, re-grade as S1 and identify affected tenants.
7. **Legal Review** — required before any external statement; likely none
   owed if no tenant data involved (placeholder, not a promise).
8. **Customer Communication** — only if impact assessment shows user-impacting
   exposure (e.g. sessions implicated): force session invalidation via
   `NEXTAUTH_SECRET` rotation or targeted `sessionVersion` bumps, and notify
   with Legal-Review-approved wording.
9. **Recovery** — regression suites green; guard policy decision recorded
   (enabled with verified rates or left disabled with reason).
10. **Postmortem** — how the key leaked (env discipline? paste?), scan repo
    history for other secrets, add prevention follow-up (e.g. pre-commit
    secret scan).

## Current state (honest)

- The runbook is **procedural, not operational**: there is no on-call
  rotation, no paging, no ticketing system, no automated alerting. Detection
  depends on humans reading logs/ledgers or external reports. (Prompt 29
  improves the *material* — request IDs, structured redacted events,
  readiness statuses — but nothing pages anyone.)
- Backup automation SCRIPTS now exist (`scripts/backup-db.mjs` /
  `verify-backup.mjs` / `restore-drill.mjs` / `prune-backups.mjs`), but
  **scheduling is operator duty** (not auto-installed, §109) — recovery-point
  objectives still cannot be stated until the operator actually schedules
  them, and offsite + encryption remain manual (APPLICATION-LEVEL BACKUP
  ENCRYPTION NOT IMPLEMENTED, §59).
- Rate-limit counters and in-process state are lost on restart — post-incident
  analysis of abuse patterns may be impossible after containment restarts.
- No timeframe commitments anywhere; Legal Review owns all external
  communication decisions and has not yet reviewed this document.
- Structured logs are stdout-only with operator-managed retention/rotation —
  evidence older than the log retention is gone; durable facts live in the
  audit tables.
