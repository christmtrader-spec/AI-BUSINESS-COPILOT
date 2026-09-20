# Rate Limiting Audit — In-Memory Sliding Window

**Audit doc:** Prompt 17 (r18) · **Scope:** `src/lib/rate-limit.ts` and every call site
**Constitution basis:** A14 "rate limiting (AI + auth endpoints)" (`docs/PROJECT-CONSTITUTION.md:230-240`); limiter header comment declares "MVP scope: single process" (`rate-limit.ts:1-5`).

---

## 1. Mechanism

`rateLimit(key, limit, windowMs)` (`src/lib/rate-limit.ts:17-47`) is a **per-process, in-memory sliding-window** limiter:

- **Storage:** a module-level `Map<string, { hits: number[] }>` (lines 7-9) — timestamps of recent hits per key.
- **Sliding window:** on each check, hits older than `windowMs` are filtered out (`line 24`), then the request is allowed only if `hits.length < limit` (line 26).
- **Deny path:** returns `{ allowed: false, remaining: 0, retryAfterMs: windowMs − (now − oldest) }` (lines 26-30); callers map this to HTTP 429 via `rateLimitResponse`/`ApiError` (lines 49-54; e.g. copilot/route.ts:31-35).
- **Allow path:** appends `now` to the bucket (line 32).
- **Memory bound:** when the map exceeds **5000 buckets**, an opportunistic sweep deletes buckets whose hits have all expired (lines 35-40). Sweeps only run on the allow path and only past the threshold — bounded memory, not O(1).
- **Resets on restart:** the Map lives in the Node process; a dev reload or deploy wipes all buckets. There is no persistence, no TTL timer, and no cross-instance coordination.

**Consequence (stated plainly):** this limiter is **NOT distributed**. With N server instances, effective limits are N × the configured values, and a rolling deploy resets counters. The code comment anticipates this: "a distributed limiter would be introduced with an ADR if/when multi-instance deployment lands" (`rate-limit.ts:3-4`; RULE 03/07, `PROJECT-CONSTITUTION.md:275-297`).

---

## 2. All current limits

| # | Endpoint / action | Key | Limit | Window | Evidence |
|---|---|---|---|---|---|
| 1 | Login (NextAuth credentials `authorize`) | `login:${email}:${ip}` | 10 | 5 min | `src/lib/auth.ts:55` (IP from `x-forwarded-for`, auth.ts:51-54) |
| 2 | Register | `register:${getClientIp(req)}` | 10 | 15 min | `auth/register/route.ts:27` |
| 3 | Copilot ask **and** stream (shared key) | `copilot:${userId}:${businessId}` | 10 | 1 min | `copilot/route.ts:30`, `copilot/stream/route.ts:34` |
| 4 | Copilot transcript message append | `copilot-sync:${userId}:${businessId}` | 60 | 1 min | `copilot/sessions/[id]/messages/route.ts:47` ("2 per Q&A — the ask endpoint is the tighter gate", lines 45-46) |
| 5 | Payment create (**NEW, Phase 17 hardening**) | `payments:write:${userId}:${businessId}` | 60 | 1 min | `payments/route.ts:92` |
| 6 | Payment revert/delete (**NEW**) | `payments:revert:${userId}:${businessId}` | 30 | 1 min | `payments/[id]/route.ts:23` |
| 7 | Business create | `business:create:${userId}` | 5 | 60 min | `businesses/route.ts:79` |
| 8 | Invite mint | `invite:create:${userId}:${businessId}` | 30 | 60 min | `businesses/[id]/invites/route.ts:84` |
| 9 | Invite accept (token brute-force guard) | `invite-accept:${userId}` | 10 | 5 min | `invites/[token]/route.ts:81` |
| 10 | Business data export (backup JSON, `settings:manage`) | `export:${userId}` | 4 | 5 min | `businesses/[id]/export/route.ts:36` |
| 11 | Business import | `import:${userId}` | 4 | 5 min | `businesses/[id]/import/route.ts:72` |
| 12 | Report CSV export (summary + per-month, shared key) | `report-export:${userId}` | 10 | 5 min | `reports/export/route.ts:35`, `reports/monthly/[month]/export/route.ts:35` |

Notes:
- Keys 3-6, 8 are scoped per **user + business** (multi-membership users get separate budgets per business); keys 7, 9, 10, 11, 12 per **user**; keys 1-2 per **email/IP**.
- Money-mutation limits (#5, #6) were added as audit hardening so bulk paidMinor churn cannot be driven faster than the audit trail can be reviewed (`payments/route.ts:90-91` — "money mutations get a light per-user/business limit", explicitly referencing this doc).
- All deny responses use the standard envelope `429 RATE_LIMITED` with `retryAfterMs` in `error.details` (e.g. `payments/route.ts:93-97`), and the UI has copy for it (`en.ts:722` generic, `en.ts:791` copilot-specific, `en.ts:713` CSV).

---

## 3. Client IP trust — `getClientIp`

```ts
// src/lib/api-helpers.ts:77-81
export function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
```

- **Trusted path (current deployment):** Caddy sits in front and **overwrites** the forwarding headers with the real remote host — `header_up X-Forwarded-For {remote_host}` and `header_up X-Real-IP {remote_host}` (`Caddyfile:7-11` for transformed ports and `Caddyfile:15-21` for the default `localhost:3000` proxy). Because Caddy sets (rather than appends) `X-Forwarded-For`, a client-sent header cannot survive to the app; the first comma token is the true client IP. `127.0.0.1:81` is the only ingress (Caddyfile:1).
- **Spoofable if exposed directly:** if the Next.js server (port 3000) were reachable without Caddy, any caller could set `X-Forwarded-For: 1.2.3.4` and get a fresh rate-limit identity per request. This affects the register limiter (#2, `getClientIp`) and login (#1, which reads the header directly, auth.ts:51-54). Mitigation if ever needed: bind port 3000 to loopback only, or accept a configured trusted-proxy count.

---

## 4. Honest production limitations

| Limitation | Impact | Trigger to fix |
|---|---|---|
| Per-process only | N instances ⇒ N× limits; a burst can be spread across instances | First multi-instance deploy |
| Lost on restart/deploy | Attacker gets a clean budget at every deploy; in-flight retryAfterMs windows vanish | Same |
| Map growth | Bounded by the 5000-bucket sweep (rate-limit.ts:36-40), but a flood of unique keys (e.g. spoofed IPs when directly exposed) can momentarily hold 5000 buckets | Abuse of unauthenticated endpoints |
| No shared state | Compliance scenarios that require provable global throttling are out of scope | Enterprise/contractual requirements |
| No 429 headers | `retryAfterMs` is returned in the JSON body, not as `Retry-After` — fine for this SPA, nonstandard for third-party clients | Public API |

---

## 5. Future interface (sketch only — NOT implemented)

When multi-instance deployment lands, the call sites keep their shape and only the backend swaps. The limiter already returns exactly the three values call sites consume (`rate-limit.ts:11-15`), so the seam is clean:

```ts
// docs/audit/rate-limiting.md — design sketch, deliberately NOT in src/
interface RateLimiter {
  /** Consume one hit for key; resolve when the decision is made. */
  check(key: string, limit: number, windowMs: number): Promise<{
    allowed: boolean;
    remaining: number;
    retryAfterMs: number; // 0 when allowed
  }>;
}

// Redis-backed implementation sketch (atomic, no read-modify-write race):
// ZADD hits <now> <uuid>  →  ZREMRANGEBYSCORE hits -inf <now-window>
// → ZCARD hits            →  compare with limit, TTL EXPIRE windowMs
// Awaiting an ADR per Constitution RULE 03/07 before any implementation.
```

Migration plan then: implement `RedisRateLimiter` behind this interface, flip call sites via a factory, keep the in-memory limiter for tests/dev. Requires an ADR (what/why/alternatives/impact) before any code changes.
