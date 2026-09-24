/**
 * Provider HTTP client — Prompt 23 §65-§67, §102.
 *
 * Every outbound provider call goes through here:
 * - hard TIMEOUT (AbortSignal.timeout) — a provider can never hang our
 *   request handlers (§66); documented default: 15s (Zarinpal guidance for
 *   request/verify round-trips on mobile networks).
 * - NO blind retries (§67) — payment creation is not idempotent at the
 *   provider, so a caller that truly needs a retry re-enters through the
 *   service (which re-verifies state first). Verification callers may retry
 *   deliberately through the user-driven verify endpoint (rate limited).
 * - errors normalized to typed outcomes: a TIMEOUT is NOT a payment
 *   failure (§36) — the adapter maps it to UNKNOWN, never FAILED.
 * - response size bounded + JSON parse guarded (§102 parsing safety).
 */

export const PROVIDER_HTTP_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

export type ProviderHttpResult =
  | { ok: true; status: number; body: string }
  | { ok: false; kind: "TIMEOUT" | "NETWORK" | "TOO_LARGE" | "HTTP_STATUS"; status?: number; body?: string };

export async function postJson(
  url: string,
  payload: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<ProviderHttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? PROVIDER_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "user-agent": "ai-business-copilot/1.0 (+payments)",
      },
      body: JSON.stringify(payload),
      redirect: "error", // §102 — never follow provider redirects blindly
      signal: controller.signal,
    });
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > MAX_RESPONSE_BYTES) {
      return { ok: false, kind: "TOO_LARGE", status: res.status };
    }
    const body = await res.text();
    if (body.length > MAX_RESPONSE_BYTES) {
      return { ok: false, kind: "TOO_LARGE", status: res.status };
    }
    return { ok: true, status: res.status, body };
  } catch (error) {
    const isTimeout =
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError");
    return isTimeout
      ? { ok: false, kind: "TIMEOUT" }
      : { ok: false, kind: "NETWORK" };
  } finally {
    clearTimeout(timer);
  }
}

/** Guarded JSON parse — malformed bodies become UNKNOWN, never crashes (§35). */
export function tryParseJson(body: string): unknown | null {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
