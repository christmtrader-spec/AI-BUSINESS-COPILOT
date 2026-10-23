/**
 * API pipeline helpers — Constitution §7 (API principles).
 * Every route returns a predictable envelope:
 *   { ok: true, data } | { ok: false, error: { code, message } }
 * Internal details (stack traces, DB errors) are never leaked.
 *
 * Prompt 29 observability contract (§25/§26/§27/§28/§84/§85):
 *  - Every response produced through the central wrapper carries a canonical
 *    `X-Request-ID` (client-supplied only when bounded and safe).
 *  - Unhandled errors emit a STRUCTURED safe event (api.request.failed) with
 *    requestId/route/method/status/error class/duration — never a body, never
 *    a stack trace in production (stacks only with explicit diagnostics flag).
 *  - Expected 4xx responses are NOT logged at ERROR: 401/403/404 stay quiet
 *    (authentication/authorization failures are visible via domain audit and
 *    aggregate counters elsewhere); 4xx validation problems log at DEBUG.
 */
import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { getOrCreateRequestId, requestIdHeaderName } from "@/lib/observability/request-id";
import { logDebug, logError, logWarn } from "@/lib/observability/logger";
import { OPERATIONAL_EVENTS, classifyStatus } from "@/lib/observability/events";
import { MfaServiceError } from "@/lib/auth/mfa/service";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export type ApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ ok: true, data } satisfies ApiEnvelope<T>, { status });
}

export function fail(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): NextResponse {
  return NextResponse.json(
    { ok: false, error: { code, message, details } } satisfies ApiEnvelope<never>,
    { status },
  );
}

/** Attach the canonical request id to any outgoing API response. */
function withRequestId(response: NextResponse, requestId: string): NextResponse {
  response.headers.set(requestIdHeaderName(), requestId);
  return response;
}

/** Route/request context carried through the wrapper (§27). */
export type RouteContext = {
  requestId: string;
  route: string;
  method: string;
  startedAt: number;
};

function describeRoute(args: unknown[]): string {
  // Best-effort stable route label from the request argument (NextRequest or
  // Request). Never includes query strings or user data.
  const first = args[0] as { url?: string } | undefined;
  if (first && typeof first.url === "string") {
    try {
      const u = new URL(first.url);
      return u.pathname;
    } catch {
      return "unknown";
    }
  }
  return "unknown";
}

/**
 * Map any thrown error to a safe response (existing behavior preserved) and
 * emit the §26/§28 structured correlation event for unhandled (5xx) errors.
 */
export function toErrorResponse(error: unknown, ctx?: RouteContext): NextResponse {
  const requestId = ctx?.requestId ?? "unattributed";
  const route = ctx?.route ?? "unknown";
  const method = ctx?.method ?? "unknown";
  const durationMs = ctx ? Date.now() - ctx.startedAt : 0;

  if (error instanceof ApiError) {
    // Expected operational 4xx — DEBUG level only (§85). 5xx-mapped ApiErrors
    // (e.g. 503 dependency states) are WARN.
    const cls = classifyStatus(error.status);
    if (error.status >= 500) {
      logWarn(OPERATIONAL_EVENTS.apiRequestFailed, {
        requestId,
        route,
        method,
        status: error.status,
        code: error.code,
        errorClass: cls,
        durationMs,
      });
    } else {
      logDebug(OPERATIONAL_EVENTS.apiRequestFailed, {
        requestId,
        route,
        method,
        status: error.status,
        code: error.code,
        errorClass: cls,
        durationMs,
      });
    }
    return fail(error.status, error.code, error.message, error.details);
  }
  if (error instanceof ZodError) {
    logDebug(OPERATIONAL_EVENTS.apiRequestFailed, {
      requestId,
      route,
      method,
      status: 422,
      code: "VALIDATION_ERROR",
      errorClass: "validation",
      durationMs,
      issueCount: error.issues.length,
    });
    return fail(422, "VALIDATION_ERROR", "The submitted data is invalid.", error.issues);
  }
  if (error instanceof MfaServiceError) {
    // Prompt 30-F — MFA capability failures are EXPECTED operational
    // outcomes, never 500s: not-configured → 503 (honest capability state,
    // §184), already-enabled → 409, not-enabled → 400, decryption → 503
    // fail-closed (§36). Messages are fixed, value-free service strings.
    const status =
      error.code === "MFA_ALREADY_ENABLED"
        ? 409
        : error.code === "MFA_NOT_ENABLED"
          ? 400
          : 503;
    const cls = classifyStatus(status);
    logDebug(OPERATIONAL_EVENTS.apiRequestFailed, {
      requestId,
      route,
      method,
      status,
      code: error.code,
      errorClass: cls,
      durationMs,
    });
    return fail(status, error.code, error.message);
  }
  // Unhandled → 500. Structured, bodyless, stackless-in-production (§26/§28).
  logError(OPERATIONAL_EVENTS.apiRequestFailed, {
    requestId,
    route,
    method,
    status: 500,
    code: "INTERNAL_ERROR",
    errorClass: "internal",
    durationMs,
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage:
      error instanceof Error
        ? // Error MESSAGE is allowed (class-level diagnostics); body/params never are.
          error.message.slice(0, 300)
        : String(typeof error),
  });
  return fail(500, "INTERNAL_ERROR", "Something went wrong. Please try again.");
}

/**
 * R69 (Prompt 69 §4/§2.3 F2) — same-origin enforcement for unsafe methods.
 *
 * WHY: the deployment's session cookies are SameSite=None+Secure (required
 * for the embedded third-party preview iframe — see src/lib/auth.ts). A
 * SameSite=None cookie is attached to EVERY cross-site request, so any
 * state-changing endpoint that does not verify the Origin can be driven by
 * an attacker page via a simple cross-site POST (form or no-cors fetch).
 * JSON-body routes are de-facto protected (a cross-site form cannot set
 * application/json and a JSON content-type fetch triggers a CORS preflight
 * that fails — no CORS headers are ever emitted), but BODY-LESS mutations
 * (cancel/post/finalize/revoke style endpoints) had no such protection.
 *
 * LAW (§81 — one choke point): every route wrapped in `route()` now runs
 * this check BEFORE the handler for POST/PUT/PATCH/DELETE. The 17 legacy
 * routes that do not use the wrapper call it explicitly (search
 * "assertSameOrigin" outside this file).
 *
 * Policy (browser-CSRF threat model only — non-browser clients are not the
 * threat and may omit Origin):
 *   GET/HEAD/OPTIONS            → never checked (safe methods).
 *   no Origin header            → ALLOW (curl, tests, server-to-server).
 *   Origin: null                → DENY (sandboxed-iframe/data-URI POSTs).
 *   Origin host === request host → ALLOW (same-origin browser request).
 *   otherwise                   → DENY 403 with a value-free error.
 *   /api/auth/*                 → EXEMPT (NextAuth enforces its own CSRF token).
 *   /api/webhooks/*             → EXEMPT (authenticated by provider signature,
 *                                 never by cookies).
 *
 * Host comparison uses the Host header (Caddy forwards it verbatim), NOT
 * the scheme — TLS terminates at the edge and internal URLs are http.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ORIGIN_EXEMPT_PREFIXES = ["/api/auth/", "/api/v1/webhooks/"];

export function assertSameOrigin(req: Request): void {
  const method = req.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return;

  let pathname = "";
  try {
    pathname = new URL(req.url).pathname;
  } catch {
    pathname = "";
  }
  if (ORIGIN_EXEMPT_PREFIXES.some((p) => pathname.startsWith(p))) return;

  const origin = req.headers.get("origin");
  if (origin === null) return; // non-browser client — not the CSRF threat
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ApiError(403, "ORIGIN_REJECTED", "Cross-site request rejected.");
  }
  // Origin "null" parses to host "null" — a legitimate Host can never be
  // the literal string "null", so the comparison below denies it.
  const requestHost = req.headers.get("host");
  if (!requestHost || originHost !== requestHost) {
    throw new ApiError(403, "ORIGIN_REJECTED", "Cross-site request rejected.");
  }
}

/** Wrap a route handler with consistent error mapping + request correlation. */
export function route<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args) => {
    const ctx: RouteContext = {
      requestId: getOrCreateRequestId(args[0] as Request),
      route: describeRoute(args),
      method: (args[0] as { method?: string } | undefined)?.method ?? "GET",
      startedAt: Date.now(),
    };
    try {
      assertSameOrigin(args[0] as Request);
      const response = await handler(...args);
      return withRequestId(response, ctx.requestId);
    } catch (error) {
      const response = toErrorResponse(error, ctx);
      return withRequestId(response, ctx.requestId);
    }
  };
}

/**
 * Prompt 29 §78 — bounded JSON body parsing.
 *
 * Default cap: 1 MB — every JSON API in this product (auth, contact, legal,
 * platform, AI chat messages, pricing) is far below it. The backup import
 * route deliberately does NOT use parseBody for its 25 MB payload (it has
 * its own explicit, documented cap — §79 preserved).
 *
 * Enforcement is real, not header-trust: the request stream is read with a
 * hard byte cap, so a lying/absent content-length cannot smuggle an
 * oversized body into memory.
 */
export const DEFAULT_BODY_LIMIT_BYTES = 1 * 1024 * 1024;

async function readBodyBounded(req: Request, maxBytes: number): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
  }
  if (!req.body) {
    // Body already consumed or absent — fall back to req.json() semantics.
    return await req.text();
  }
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

/** Parse + validate a JSON body with zod, under a hard size cap (§78). */
export async function parseBody<T>(
  req: Request,
  schema: ZodType<T>,
  opts: { maxBytes?: number } = {},
): Promise<T> {
  let raw: unknown;
  try {
    const text = await readBodyBounded(req, opts.maxBytes ?? DEFAULT_BODY_LIMIT_BYTES);
    raw = JSON.parse(text);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "BAD_JSON", "Request body must be valid JSON.");
  }
  return schema.parse(raw);
}

/**
 * Client IP for rate-limit keys and audit metadata.
 *
 * R69 (Prompt 69 §4.3) — explicit trusted-proxy policy: this deployment is
 * single-node behind ONE trusted edge proxy (Caddy, see Caddyfile) whose
 * `header_up X-Forwarded-For {remote_host}` REPLACES any client-supplied
 * XFF with the real peer address. The LAST element is therefore the only
 * value this app may trust (with a longer proxy chain, each trusted hop
 * appends to the right — the last element is always the most recently
 * appended trusted observation, while the first remains attacker-writable).
 * Direct connections to the Node port are localhost-only (single exposed
 * port), so they cannot smuggle an XFF from outside the host.
 *
 * Guarantee: per-IP rate limits (login, invite redemption, setup, exports)
 * cannot be bypassed by rotating a client-supplied X-Forwarded-For through
 * the gateway; audit ipHash metadata cannot be poisoned by header injection.
 */
export function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : "unknown";
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}
