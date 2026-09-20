/**
 * Client API wrapper — Constitution §7.
 * Adds the active business context header, unwraps the response
 * envelope and raises typed errors for UI handling.
 */
"use client";

export class ApiClientError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

export function setBusinessContextHeader(
  headers: Record<string, string>,
  businessId: string | null | undefined,
): Record<string, string> {
  if (businessId) headers["x-business-id"] = businessId;
  return headers;
}

/** Reads the active business id set by the app store (injected via init). */
let businessIdProvider: () => string | null | undefined = () => null;

export function registerBusinessIdProvider(fn: () => string | null | undefined) {
  businessIdProvider = fn;
}

export async function api<T>(
  path: string,
  init?: RequestInit & { businessId?: string | null },
): Promise<T> {
  const businessId = init?.businessId ?? businessIdProvider();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (businessId) headers["x-business-id"] = businessId;

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  } catch {
    throw new ApiClientError("NETWORK_ERROR", "Network error. Please check your connection and try again.", 0);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  const envelope = body as Envelope<T> | null;
  if (!res.ok || !envelope || envelope.ok === false) {
    const err = envelope && envelope.ok === false ? envelope.error : null;
    throw new ApiClientError(
      err?.code ?? "HTTP_ERROR",
      err?.message ?? "Unable to complete the request. Please try again.",
      res.status,
      err?.details,
    );
  }

  return envelope.data;
}
