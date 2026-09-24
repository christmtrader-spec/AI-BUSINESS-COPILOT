# Payment Security Review — Prompt 23 (§102/§105/§58-§62)

## Threat model & controls

### Browser never decides money (§19/§20/§42/§119-§120)
- Success requires server-side verification or a signature-verified webhook. Query params (`status=OK`, `success=true`), screenshots, localStorage, user-supplied transaction ids are never evidence.
- The callback route uses provider params ONLY to locate the attempt; forging `Authority`/garbage yields the same uniform redirect (no probing oracle).
- The return page renders server state exclusively (`aria-live` announcements; §42 "only after server-side state confirms SUCCEEDED").

### Amount / currency / reference integrity (§12-§13/§21-§23)
- Clients send only `{ planCode, billingPeriod }`; zod strips everything else. Amount+currency come from the server catalog and are snapshotted (`pricingVersion`, §13).
- Fulfillment re-compares provider-claimed amount/currency against the snapshot; mismatch → RECONCILIATION_REQUIRED (never activation).
- Provider reference binding: the verify response must echo the exact authority of the attempt; cross-intent references are rejected.

### Tenant isolation & RBAC (§115/§63)
- Session reads/verifies are membership-scoped; a foreign business's session is indistinguishable from nonexistent (404).
- Initiation/verify require OWNER/ADMIN (`settings:manage`); history is business-scoped and paginated; the callback route is the only unauthenticated payment route and it cannot mutate state without provider verification.

### Provider adapter hardening (§65-§67/§102)
- Server-only HTTP client: 15s `AbortSignal.timeout`, bounded response size (512 KB), `redirect: "error"` (no unsafe redirects), guarded JSON parse (malformed → UNKNOWN, never crash/fake).
- No blind retries of non-idempotent creation; verification is user-bounded (10/min) — no uncontrolled browser-driven provider loops (§68).
- Endpoint URLs come ONLY from code+config per environment (sandbox/production separated); client input can never select or alter provider URLs (§64/§102). SSRF surface: none (no user-supplied URLs anywhere).
- Header injection: no user input flows into provider headers; payloads are JSON-serialized structs.

### Webhooks (§29-§32/§105/§121/§123)
- Per-provider signature verification over the RAW body (timing-safe HMAC + 5-min replay window) — unchanged from Prompt 22; failures → opaque 401 (gateways retry, probes learn nothing).
- Zarinpal has NO webhooks: the route rejects (401) and callback+verification is the documented authoritative mechanism (no invented signature formats, §31).
- Event-id ledger (`ProcessedWebhookEvent`, unique per provider+eventId) makes replays no-ops; out-of-order/stale events can never downgrade a confirmed payment (§75/§76).

### Secrets & logging (§10/§11/§56/§57)
- Credentials live only in server env (`ZARINPAL_MERCHANT_ID`); `.env.example` carries placeholders; blockers name VARIABLES, never values; nothing secret is returned by any API (`/api/v1/billing/providers` exposes slugs/mode/capabilities only).
- Logs/audits contain correlation ids, refs, normalized results — never raw payloads, headers, or credentials.

### Redirects & headers (§58/§103/§104)
- Checkout redirect URL comes only from the trusted provider contract (StartPay + stored authority); return URLs are built from `PAYMENT_BASE_URL` config, never Host headers or query params → no open-redirect surface.
- Webhook/callback endpoints keep the app's standard security middleware; the webhook route's "authentication" IS the provider signature (documented exception, §59).

### Rate limiting (§60)
- checkout 10/min/user · verify 10/min/user · callback 30/min/IP (generous for real flows) · webhook 120/min/IP (gateway retries never blocked).
