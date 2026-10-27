"use client";

/**
 * R71 — global same-origin attestation for every client /api/ call.
 *
 * WHY: the sandbox preview gateway rewrites the Host header (and may drop
 * X-Forwarded-Host), so the server's origin gate cannot always verify the
 * app's own browser document by Host comparison alone (user-reported
 * 2026-10-23: every registration POST → 403 ORIGIN_REJECTED). The fix is a
 * client ATTESTATION header that a cross-site attacker CANNOT forge:
 *
 *  - HTML forms cannot set custom headers at all;
 *  - `no-cors` fetches are limited to CORS-safelisted headers;
 *  - any custom header forces a CORS preflight, and this app never emits
 *    Access-Control-Allow-* anywhere (verified repo-wide) — so the preflight
 *    fails and the attacker's request never fires.
 *
 * Therefore a request carrying `X-Requested-With: XMLHttpRequest` reaching
 * the server was necessarily issued by THIS app's own JavaScript (or a
 * non-browser client, which is outside the browser-CSRF threat model and
 * may omit Origin entirely anyway). The server's evaluateSameOrigin accepts
 * it as the last fallback, after the stronger Origin/Host checks.
 *
 * INSTALL: imported as a module side-effect by the root client component
 * (src/modules/shell/app-root.tsx) so it runs before any query or mutation
 * can fire. Idempotent (guarded), installs only in the browser, and only
 * touches RELATIVE /api/ requests — absolute URLs, static assets, and
 * non-/api paths pass through untouched. Existing headers are preserved
 * (never overwritten).
 */

const ATTESTATION_HEADER = "x-requested-with";
const ATTESTATION_VALUE = "XMLHttpRequest";

declare global {
  interface Window {
    __fetchAttestationInstalled?: boolean;
  }
}

export function installFetchAttestation(): void {
  if (typeof window === "undefined") return;
  if (window.__fetchAttestationInstalled) return;
  window.__fetchAttestationInstalled = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = function attestedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    try {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.pathname
            : input.url;
      if (path.startsWith("/api/")) {
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        if (!headers.has(ATTESTATION_HEADER)) {
          headers.set(ATTESTATION_HEADER, ATTESTATION_VALUE);
        }
        return originalFetch(input, { ...init, headers });
      }
    } catch {
      // Never break a request because of the interceptor — fall through.
    }
    return originalFetch(input, init);
  };
}

installFetchAttestation();
