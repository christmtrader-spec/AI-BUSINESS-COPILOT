import "server-only";

/**
 * Prompt 53 §W — outbound webhooks for event-driven integrations.
 *
 * Security law (mirrors §F8):
 *  - The signing secret (`whsec_<40 hex>`) exists ONLY at creation time —
 *    shown EXACTLY ONCE; the DB stores an AES-256-GCM secret-box envelope
 *    (src/lib/security/secret-box.ts, the same at-rest base as MFA TOTP
 *    secrets §188-§197) plus a 12-char display prefix. The delivery path
 *    decrypts transiently per attempt; no module-level cache.
 *  - An endpoint belongs to exactly ONE business; dispatch queries filter
 *    by that businessId (A01/A02 — no cross-tenant delivery, ever).
 *  - Event names are a CLOSED set (WEBHOOK_EVENTS below).
 *  - URL guard: https required in production, dev allows http (so plain-
 *    HTTP harness receivers and public test URLs work) but NEVER private
 *    ranges — only loopback + public hosts pass in dev. Userinfo is
 *    rejected outright. Honest limitation (documented): this is a
 *    scheme/host allow-guard, NOT a full DNS-rebinding defense.
 *
 * Delivery law (money-path safety):
 *  - dispatchWebhooks() is strictly FIRE-AND-FORGET: callers invoke it
 *    AFTER the business transaction has committed, with `void`, and the
 *    function itself never throws. A webhook can NEVER break, delay, or
 *    roll back a sale, payment, or expense.
 *  - Each delivery: POST JSON, 5s timeout, headers
 *      content-type: application/json
 *      x-abc-event: <event>
 *      x-abc-delivery: <endpointId>-<unixSeconds>
 *      x-abc-signature: t=<unixSeconds>,v1=<hexHMAC(secret, `${t}.${body}`)>
 *    — the same t/v1 envelope the Stripe adapter verifies (§F6), so
 *    receivers can reuse one verification routine.
 *  - The ledger row (WebhookDelivery) stores the payload TRUNCATED to
 *    8 KiB — the full bytes are signed, so the ledger is diagnostic, not
 *    a replay queue (no offline retry queue in this release; honest).
 *  - Consecutive failures: failureCount++ per failure, reset on success;
 *    at >= WEBHOOK_AUTO_DISABLE_THRESHOLD (5) the endpoint auto-disables
 *    with an audit row (never silently).
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { encryptSecret, decryptSecret } from "@/lib/security/secret-box";

export const WEBHOOK_SECRET_PREFIX = "whsec";
const SECRET_RANDOM_BYTES = 20; // 40 hex chars

/** Closed event set (§W). Adding an event = code change, by design. */
export const WEBHOOK_EVENTS = [
  "sale.created",
  "payment.created",
  "expense.created",
  "customer.created",
  "product.created",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export function isWebhookEvent(value: string): value is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/** Max active endpoints per business — runaway endpoint farms are a hazard. */
export const WEBHOOK_MAX_ACTIVE = 5;
/** Payload bytes stored in the delivery ledger (full body still signed). */
export const WEBHOOK_PAYLOAD_LEDGER_BYTES = 8 * 1024;
/** Per-attempt HTTP timeout. */
export const WEBHOOK_TIMEOUT_MS = 5_000;
/** Consecutive failures before auto-disable. */
export const WEBHOOK_AUTO_DISABLE_THRESHOLD = 5;
/** Error text kept in the ledger. */
const ERROR_TEXT_MAX = 200;

export function generateWebhookSecret(): {
  plaintext: string;
  prefix: string;
  secretBox: string;
} {
  const random = randomBytes(SECRET_RANDOM_BYTES).toString("hex"); // 40 hex
  const plaintext = `${WEBHOOK_SECRET_PREFIX}_${random}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, 12),
    secretBox: encryptSecret(plaintext),
  };
}

/* ------------------------------- URL guard -------------------------------- */

const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/,
  /^127\./,
  /^10\./,
  /^0\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
  /^\[?fe80:/i,
  /^\[?fc00:/i,
  /^\[?fd[0-9a-f]{2}:/i,
  /\.local$/i,
  /\.internal$/i,
];

export type UrlGuardResult =
  | { ok: true; url: string }
  | { ok: false; reason: "INVALID_URL" | "INSECURE_SCHEME" | "PRIVATE_HOST" };

/**
 * Validate a webhook target URL.
 *  - production: https:// only; dev also allows http:// (harness receivers
 *    and public test URLs) — but private ranges stay blocked in dev too.
 *  - userinfo (user:pass@) is rejected outright.
 *  - `opts.isProd` exists ONLY for unit tests (default = NODE_ENV).
 */
export function guardWebhookUrl(raw: string, opts?: { isProd?: boolean }): UrlGuardResult {
  const isProd = opts?.isProd ?? process.env.NODE_ENV === "production";
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "INVALID_URL" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "INSECURE_SCHEME" };
  }
  if (isProd && parsed.protocol !== "https:") {
    return { ok: false, reason: "INSECURE_SCHEME" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "INVALID_URL" };
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (!isProd && isLoopback) {
    return { ok: true, url: parsed.toString() };
  }
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(host))) {
    return { ok: false, reason: "PRIVATE_HOST" };
  }
  return { ok: true, url: parsed.toString() };
}

/* ------------------------------- signing ---------------------------------- */

/**
 * Signature envelope — `t=<unixSeconds>,v1=<hex>`, HMAC-SHA256 over
 * `${t}.${body}`. Deliberately the SAME shape as the Stripe adapter's
 * verification (§F6) so receivers implement one routine for both.
 */
export function signPayload(secret: string, timestampSeconds: number, body: string): string {
  const mac = createHmac("sha256", secret)
    .update(`${timestampSeconds}.${body}`)
    .digest("hex");
  return `t=${timestampSeconds},v1=${mac}`;
}

export function verifySignature(
  secret: string,
  header: string,
  body: string,
  toleranceSeconds = 300,
): boolean {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header.trim());
  if (!match) return false;
  const t = Number(match[1]);
  if (!Number.isFinite(t)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(match[2], "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------------ dispatch ---------------------------------- */

type DeliveryResult = {
  status: number | null;
  ok: boolean;
  error: string | null;
  durationMs: number;
};

async function attemptDelivery(
  url: string,
  endpointId: string,
  secret: string | null,
  event: string,
  body: string,
): Promise<DeliveryResult> {
  const started = Date.now();
  if (!secret) {
    return {
      status: null,
      ok: false,
      error: "SECRET_DECRYPTION_FAILED",
      durationMs: 0,
    };
  }
  const timestamp = Math.floor(Date.now() / 1000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-abc-event": event,
        "x-abc-delivery": `${endpointId}-${timestamp}`,
        "x-abc-signature": signPayload(secret, timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      error: null,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    return {
      status: null,
      ok: false,
      error: text.slice(0, ERROR_TEXT_MAX),
      durationMs: Date.now() - started,
    };
  }
}

/** Truncate the ledger copy of the payload (full bytes still signed). */
function ledgerBody(body: string): string {
  return body.length > WEBHOOK_PAYLOAD_LEDGER_BYTES
    ? `${body.slice(0, WEBHOOK_PAYLOAD_LEDGER_BYTES)}…[truncated]`
    : body;
}

type EndpointRow = {
  id: string;
  url: string;
  secretBox: string;
  failureCount: number;
};

async function deliverAndRecord(
  endpoint: EndpointRow,
  businessId: string,
  event: string,
  body: string,
): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  const secret = decryptSecret(endpoint.secretBox);
  const result = await attemptDelivery(endpoint.url, endpoint.id, secret, event, body);
  try {
    await db.webhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        businessId,
        event,
        payload: ledgerBody(body),
        status: result.status,
        ok: result.ok,
        attempt: 1,
        error: result.error,
        durationMs: result.durationMs,
      },
    });
    const failureCount = result.ok ? 0 : endpoint.failureCount + 1;
    const disable = failureCount >= WEBHOOK_AUTO_DISABLE_THRESHOLD;
    await db.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: {
        failureCount,
        lastStatus: result.status,
        lastDeliveryAt: new Date(),
        ...(disable ? { active: false } : {}),
      },
    });
    if (disable) {
      const { audit } = await import("@/lib/audit");
      await audit({
        businessId,
        actorId: null,
        action: "webhook.auto_disable",
        entityType: "WebhookEndpoint",
        entityId: endpoint.id,
        after: { url: endpoint.url, failureCount },
      });
    }
  } catch {
    // Ledger/audit book failure must never propagate (best-effort book).
  }
  return { ok: result.ok, status: result.status, error: result.error };
}

export type DispatchOutcome = {
  endpointId: string;
  ok: boolean;
  status: number | null;
  error: string | null;
};

/**
 * Fire-and-forget dispatch of ONE event to every active subscribed
 * endpoint of the business. NEVER throws; callers use
 * `void dispatchWebhooks(...)` right AFTER the business tx commits.
 */
export function dispatchWebhooks(
  businessId: string,
  event: WebhookEvent,
  payload: Record<string, unknown>,
): void {
  void (async () => {
    try {
      const endpoints: EndpointRow[] = await db.webhookEndpoint.findMany({
        where: { businessId, active: true, events: { contains: event } },
        select: { id: true, url: true, secretBox: true, failureCount: true },
      });
      if (endpoints.length === 0) return;

      const body = JSON.stringify({
        event,
        createdAt: new Date().toISOString(),
        data: payload,
      });
      await Promise.allSettled(
        endpoints.map((endpoint) => deliverAndRecord(endpoint, businessId, event, body)),
      );
    } catch {
      // Dispatch is best-effort by contract — swallow everything.
    }
  })();
}

/**
 * Awaitable single delivery used by the "Send test" button — returns the
 * outcome so the UI can show an honest result. Also ledgered. Works for
 * active AND paused endpoints (a paused endpoint can be probed without
 * re-activating it; auto-disable counters still apply).
 */
export async function sendTestDelivery(
  endpointId: string,
  businessId: string,
): Promise<DispatchOutcome> {
  const endpoint = await db.webhookEndpoint.findFirst({
    where: { id: endpointId, businessId },
    select: { id: true, url: true, secretBox: true, failureCount: true },
  });
  if (!endpoint) {
    return { endpointId, ok: false, status: null, error: "ENDPOINT_NOT_FOUND" };
  }
  const body = JSON.stringify({
    event: "ping.test",
    createdAt: new Date().toISOString(),
    data: { message: "Test delivery from AI Business Copilot", endpointId },
  });
  const result = await deliverAndRecord(endpoint, businessId, "ping.test", body);
  return { endpointId, ...result };
}
