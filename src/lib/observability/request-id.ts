import "server-only";

/**
 * getOrCreateRequestId — Prompt 29 §24.
 *
 * Correlation contract:
 *  - A client-supplied `X-Request-ID` is honored ONLY if it is bounded and
 *    safe: 8..64 chars of [A-Za-z0-9._-] (no whitespace, no control chars,
 *    no path separators, no header-injection surface). Anything else is
 *    replaced by a server-generated UUID (§134 — malformed IDs never pass).
 *  - Missing header → UUID (crypto random).
 *  - The canonical ID is echoed on the response as `X-Request-ID` so clients
 *    and incident responders can correlate across proxy + app + logs.
 */

const REQUEST_ID_HEADER = "x-request-id";
const MIN_LEN = 8;
const MAX_LEN = 64;
/** Bounded safe alphabet — no control characters, no newline, no separators. */
const SAFE_RE = /^[A-Za-z0-9._-]+$/;

export function requestIdHeaderName(): string {
  return REQUEST_ID_HEADER;
}

export function isSafeRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= MIN_LEN &&
    value.length <= MAX_LEN &&
    SAFE_RE.test(value)
  );
}

/** Create a fresh canonical request id (UUID — no client influence). */
export function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Resolve the canonical request id for an incoming request.
 * Never throws; never trusts more than the bounded header contract.
 *
 * MEMOIZED per Request object (WeakMap) so the route wrapper and the handler
 * body observe the SAME id (§25): without memoization a handler calling this
 * again for a header-less request would mint a different UUID.
 */
const REQUEST_ID_STORE = new WeakMap<object, string>();

export function getOrCreateRequestId(req: Request): string {
  const existing = REQUEST_ID_STORE.get(req);
  if (existing) return existing;
  const raw = req.headers.get(REQUEST_ID_HEADER);
  let id: string;
  if (raw !== null) {
    // Trim surrounding whitespace, then validate strictly (not the other way
    // around): any surviving control character or unsafe char → replace.
    const trimmed = raw.trim();
    id = isSafeRequestId(trimmed) ? trimmed : newRequestId();
  } else {
    id = newRequestId();
  }
  try {
    REQUEST_ID_STORE.set(req, id);
  } catch {
    // WeakMap.set cannot realistically throw here; guard anyway.
  }
  return id;
}
