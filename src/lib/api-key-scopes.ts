/**
 * Pure API-key scope + quota laws (NO server-only, NO db) — safe to import
 * from server routes AND pure unit scripts. The server wrapper
 * (src/lib/api-keys.ts) re-exports them for route use.
 *
 * R61-3 scope model v2:
 *  - "read"            → EVERY open-API resource (legacy full access)
 *  - "read:<resource>" → exactly that one resource (closed set below)
 * Scopes are stored COMMA-SEPARATED in the ApiKey.scopes column and are
 * always normalized (canonical order, deduped, no blanks) before storage.
 *
 * R61-3 quota model:
 *  - Per-key MONTHLY request quota (UTC month buckets), default 10,000,
 *    env-overridable via API_KEY_MONTHLY_QUOTA (min 1).
 *  - Metering is best-effort accounting, NOT a security boundary — the
 *    hard boundaries remain auth + scopes + per-minute rate limit.
 */

export const OPEN_API_RESOURCES = ["customers", "products", "sales"] as const;
export type OpenApiResource = (typeof OPEN_API_RESOURCES)[number];

export const API_KEY_FULL_SCOPE = "read" as const;
export const API_KEY_GRANULAR_SCOPES = ["read:customers", "read:products", "read:sales"] as const;

/** Closed scope set — canonical order: full scope first, then granular. */
export const API_KEY_SCOPES = [API_KEY_FULL_SCOPE, ...API_KEY_GRANULAR_SCOPES] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * Normalize a raw comma-separated scope string (DB form) or an array of
 * scope tokens (API form) into the canonical closed set. Unknown tokens
 * are DROPPED (fail-closed — a key with only unknown tokens has no
 * usable scope and must be rejected upstream). Deduped; canonical order.
 */
export function parseApiKeyScopes(raw: string | readonly string[]): ApiKeyScope[] {
  const tokens: string[] = typeof raw === "string" ? raw.split(",") : [...raw];
  const present = new Set(tokens.map((t) => t.trim()));
  return API_KEY_SCOPES.filter((s) => present.has(s));
}

/** Validate the API create form: every token must be a known scope. */
export function isValidApiKeyScopeList(tokens: readonly string[]): boolean {
  return tokens.length > 0 && tokens.every((t) => (API_KEY_SCOPES as readonly string[]).includes(t));
}

/** Does this scope set grant access to the given open-API resource? */
export function scopeCoversResource(scopes: readonly ApiKeyScope[], resource: OpenApiResource): boolean {
  return scopes.includes(API_KEY_FULL_SCOPE) || scopes.includes(`read:${resource}` as ApiKeyScope);
}

/** UTC month bucket key, e.g. "2026-10". */
export function monthlyPeriodKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Per-key monthly quota (env-overridable, min 1). */
export function apiKeyMonthlyQuota(env: string | undefined = process.env.API_KEY_MONTHLY_QUOTA): number {
  const parsed = Number(env);
  if (!Number.isFinite(parsed) || parsed < 1) return 10_000;
  return Math.min(Math.floor(parsed), 1_000_000);
}

/** Milliseconds until the current UTC month bucket rolls over. */
export function msUntilNextUtcMonth(now: Date = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - now.getTime();
}

/** Serialize already-validated scope tokens for the DB column (canonical order/dedupe; full scope collapses granulars). */
export function serializeApiKeyScopes(scopes: readonly string[]): string {
  const valid = parseApiKeyScopes(scopes);
  if (valid.length !== scopes.length) {
    // Caller must validate first — unknown tokens are never persisted.
    throw new Error("serializeApiKeyScopes: unknown scope token");
  }
  // "read" grants everything — granular tokens beside it are pure noise.
  if (valid.includes(API_KEY_FULL_SCOPE)) return API_KEY_FULL_SCOPE;
  return valid.join(",");
}
