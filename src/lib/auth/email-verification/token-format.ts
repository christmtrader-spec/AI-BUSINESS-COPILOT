import "server-only";

/**
 * Constant-time-ish FORMAT gate for email-verification tokens (§130):
 * malformed tokens are rejected BEFORE any database work. The format is
 * identical to reset tokens (32 random bytes, base64url → 43 chars) —
 * that shared format does NOT mean shared purpose (§315).
 */
export function isPlausibleEmailVerificationToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}
