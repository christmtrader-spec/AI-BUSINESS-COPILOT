/**
 * Prompt 49 (§7.1) — opaque SIGNED aging-detail cursor.
 *
 * Mirrors the Prompt 39 statement cursor pattern (§36–§38/§130/§131) —
 * the established repository convention for stateless, tamper-evident
 * keyset pagination:
 *   - payload: base64url(JSON) — stable IDs and ordering metadata ONLY;
 *   - signature: HMAC-SHA256 over the payload (base64url), constant-time
 *     compared. NO JWT, NO unsigned JSON.
 *   - stateless: no cursor table, no expiry (same documented trade-off as
 *     the statement cursor — docs/security/party-statements-security.md).
 *
 * PAYMENT LAW: the payload NEVER contains party names, references, notes,
 * emails, amounts or any business data — only opaque IDs + the last scanned
 * ordering key. (businessId/partyId are opaque stable IDs required for
 * binding per §7.1 — never rendered anywhere.)
 *
 * TENANT + FILTER LAW (§7.1/§20): a cursor is bound to
 *   businessId + side + partyId + bucket + pastDue + cursor version.
 * A cursor minted for one side/party/bucket/tenant is REJECTED (422) for
 * any other combination — never a fallback page, never a data leak.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { AGING_BUCKET_KEYS, type AgingBucketKey } from "./aging";

const CURSOR_VERSION = "v1";
const CURSOR_MAX_LENGTH = 1024;

function cursorSecret(): string {
  // Dedicated env var wins; NextAuth's secret is the documented fallback so
  // single-node deployments need zero extra configuration (same convention
  // as the statement cursor). Constant dev fallback keeps tests deterministic.
  return (
    process.env.STATEMENT_CURSOR_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    "statement-cursor-local-dev-secret"
  );
}

/** Closed detail sides (§5) — mirrors the aggregate report's two sides. */
export const AGING_DETAIL_SIDES = ["receivables", "payables"] as const;
export type AgingDetailSide = (typeof AGING_DETAIL_SIDES)[number];

export function isAgingDetailSide(value: string): value is AgingDetailSide {
  return (AGING_DETAIL_SIDES as readonly string[]).includes(value);
}

export function isAgingBucketKey(value: string): value is AgingBucketKey {
  return (AGING_BUCKET_KEYS as readonly string[]).includes(value);
}

export type AgingDetailCursorPayload = {
  v: "v1";
  /** businessId binding (§7.1). */
  b: string;
  /** side binding: "receivables" | "payables". */
  s: AgingDetailSide;
  /** partyId binding; "*" = no party filter. */
  p: string;
  /** bucket binding: AgingBucketKey or "*" = unfiltered. */
  k: string;
  /** past-due binding: "1" = past-due-only scope, "*" = unfiltered. */
  d: string;
  /** last SCANNED ordering instant (ISO) — never merely the last displayed row (§7.2). */
  ts: string;
  /** last SCANNED source id. */
  id: string;
};

function b64urlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function b64urlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(payload: string): string {
  return createHmac("sha256", cursorSecret()).update(payload).digest("base64url");
}

/** Encode a cursor state into the opaque "<payload>.<signature>" token. */
export function encodeAgingDetailCursor(state: AgingDetailCursorPayload): string {
  const payload = b64urlEncode(JSON.stringify(state));
  return `${payload}.${signPayload(payload)}`;
}

export type AgingDetailCursorExpectation = {
  businessId: string;
  side: AgingDetailSide;
  /** null = no party filter (cursor must carry "*"). */
  partyId: string | null;
  /** null = no bucket filter. */
  bucket: AgingBucketKey | null;
  /** true = past-due-only scope (payables). */
  pastDue: boolean;
};

/** Controlled validation error → the API maps it to the canonical 422. */
export class AgingDetailValidationError extends Error {
  constructor(
    public field: string,
    message: string,
  ) {
    super(message);
    this.name = "AgingDetailValidationError";
  }
}

function invalidCursor(message: string): AgingDetailValidationError {
  return new AgingDetailValidationError("cursor", message);
}

function bindingOf(expectation: AgingDetailCursorExpectation) {
  return {
    p: expectation.partyId ?? "*",
    k: expectation.bucket ?? "*",
    d: expectation.pastDue ? "1" : "*",
  };
}

/**
 * Decode + authenticate + bind a cursor to the current request (§7.1/§20).
 * Any tampering, malformed payload, or filter/tenant mismatch →
 * AgingDetailValidationError (→ 422, never a fallback page).
 */
export function decodeAgingDetailCursor(
  raw: string,
  expected: AgingDetailCursorExpectation,
): AgingDetailCursorPayload {
  if (!raw || raw.length > CURSOR_MAX_LENGTH) throw invalidCursor("cursor is invalid.");
  const dot = raw.lastIndexOf(".");
  if (dot <= 0 || dot === raw.length - 1) throw invalidCursor("cursor is invalid.");
  const payload = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);

  const expectedSignature = signPayload(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSignature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw invalidCursor("cursor is invalid.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(b64urlDecode(payload));
  } catch {
    throw invalidCursor("cursor is invalid.");
  }
  if (typeof parsed !== "object" || parsed === null) throw invalidCursor("cursor is invalid.");
  const c = parsed as Record<string, unknown>;
  if (
    c.v !== CURSOR_VERSION ||
    typeof c.b !== "string" ||
    typeof c.s !== "string" ||
    typeof c.p !== "string" ||
    typeof c.k !== "string" ||
    typeof c.d !== "string" ||
    typeof c.ts !== "string" ||
    typeof c.id !== "string" ||
    c.b.length > 64 ||
    c.p.length > 64 ||
    c.id.length > 64 ||
    c.ts.length > 40
  ) {
    throw invalidCursor("cursor is invalid.");
  }
  if (!isAgingDetailSide(c.s)) throw invalidCursor("cursor is invalid.");
  if (!isAgingBucketKey(c.k) && c.k !== "*") throw invalidCursor("cursor is invalid.");
  if (c.d !== "*" && c.d !== "1") throw invalidCursor("cursor is invalid.");
  const ts = new Date(c.ts);
  if (Number.isNaN(ts.getTime())) throw invalidCursor("cursor is invalid.");

  // §7.1 — a cursor is only valid for the exact filtered query it was minted
  // for: side, party, bucket, past-due flag and tenant must all match.
  const want = bindingOf(expected);
  if (c.b !== expected.businessId || c.s !== expected.side || c.p !== want.p || c.k !== want.k || c.d !== want.d) {
    throw new AgingDetailValidationError("cursor", "cursor does not match this aging query.");
  }

  return {
    v: "v1",
    b: c.b,
    s: c.s,
    p: c.p,
    k: c.k,
    d: c.d,
    ts: c.ts,
    id: c.id,
  };
}
