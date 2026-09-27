/**
 * Anonymous funnel identity — Prompt 25.
 *
 * A random, server-issued cookie UUID identifying an anonymous pricing
 * visitor across the conversion funnel. Deliberately NOT a browser
 * fingerprint: no canvas/UA entropy, no IP hashing — just an opaque random
 * key in a first-party cookie (180 days). When absent, the key is simply
 * null — "omitted beats invented".
 */

import type { NextRequest } from "next/server";

export const FUNNEL_COOKIE = "copilot_funnel";
const FUNNEL_MAX_AGE = 60 * 60 * 24 * 180; // 180 days

export function readFunnelKey(req: NextRequest): string | null {
  const raw = req.cookies.get(FUNNEL_COOKIE)?.value;
  if (!raw) return null;
  // Defensive: accept only well-formed UUIDs the server itself issued.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)
    ? raw.toLowerCase()
    : null;
}

/** (key, setCookieHeader|null) — issues a fresh key when absent/invalid. */
export function funnelIdentity(req: NextRequest): {
  key: string | null;
  setCookie: string | null;
} {
  const existing = readFunnelKey(req);
  if (existing) return { key: existing, setCookie: null };
  const key = crypto.randomUUID();
  const setCookie = `${FUNNEL_COOKIE}=${key}; Path=/; Max-Age=${FUNNEL_MAX_AGE}; SameSite=Lax`;
  return { key, setCookie };
}
