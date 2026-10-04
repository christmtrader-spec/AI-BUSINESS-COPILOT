/**
 * Prompt 39 — opaque SIGNED statement cursor (§36/§37/§38/§130/§131).
 *
 * There was no pre-existing cursor utility in this repository, so this is
 * the small signed opaque cursor utility §130 prescribes:
 *   - payload: base64url(JSON) — stable IDs and ordering metadata ONLY;
 *   - signature: HMAC-SHA256 over the payload (base64url), constant-time
 *     compared. NO JWT, NO unsigned JSON (§130).
 *   - stateless: no cursor table, no expiry (the project has no signed-
 *     cursor expiry convention to reuse — §131 documented).
 *
 * PAYMENT LAW (§37): the payload NEVER contains business secrets, PII,
 * names, emails, phones or notes — only opaque IDs + ordering metadata.
 * (businessId/partyId are opaque stable IDs, required for tenant binding
 * per §38 — never rendered anywhere.)
 *
 * TENANT LAW (§38): a cursor minted for Business A is rejected for
 * Business B, and a cursor is bound to kind + party + from + to (§48):
 * any mismatch throws StatementValidationError → 422 (never a fallback
 * page, never a data leak).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { StatementValidationError } from "./schema";
import { isStatementKind, type StatementKind, type StatementSourceType } from "./types";

const CURSOR_VERSION = "v1";
const CURSOR_MAX_LENGTH = 1024;

function cursorSecret(): string {
  // Dedicated env var wins; NextAuth's secret is the documented fallback so
  // single-node deployments need zero extra configuration. A constant dev
  // fallback keeps local/test runs deterministic (single-node deployment —
  // see docs/security/party-statements-security.md).
  return (
    process.env.STATEMENT_CURSOR_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    "statement-cursor-local-dev-secret"
  );
}

export type StatementCursorPayload = {
  v: "v1";
  /** statement kind binding (§48). */
  k: StatementKind;
  /** businessId binding (§38). */
  b: string;
  /** partyId binding (§48). */
  p: string;
  /** from calendar date binding "YYYY-MM-DD" (§48). */
  f: string;
  /** to calendar date binding "YYYY-MM-DD" (§48). */
  t: string;
  /** last consumed event instant (ISO). */
  ts: string;
  /** last consumed event sourceId. */
  id: string;
  /** last consumed event sourceType. */
  st: StatementSourceType;
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
export function encodeStatementCursor(state: StatementCursorPayload): string {
  const payload = b64urlEncode(JSON.stringify(state));
  return `${payload}.${signPayload(payload)}`;
}

export type CursorExpectation = {
  kind: StatementKind;
  businessId: string;
  partyId: string;
  from: string;
  to: string;
};

function invalidCursor(message: string): StatementValidationError {
  return new StatementValidationError("cursor", message);
}

/**
 * Decode + authenticate + bind a cursor to the current request (§38/§48).
 * Any tampering, malformed payload, or query-parameter mismatch → 422.
 */
export function decodeStatementCursor(raw: string, expected: CursorExpectation): StatementCursorPayload {
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
    typeof c.k !== "string" ||
    typeof c.b !== "string" ||
    typeof c.p !== "string" ||
    typeof c.f !== "string" ||
    typeof c.t !== "string" ||
    typeof c.ts !== "string" ||
    typeof c.id !== "string" ||
    typeof c.st !== "string" ||
    c.b.length > 64 ||
    c.p.length > 64 ||
    c.f.length > 10 ||
    c.t.length > 10 ||
    c.id.length > 64 ||
    c.ts.length > 40
  ) {
    throw invalidCursor("cursor is invalid.");
  }
  if (!isStatementKind(c.k)) throw invalidCursor("cursor is invalid.");
  const ts = new Date(c.ts);
  if (Number.isNaN(ts.getTime())) throw invalidCursor("cursor is invalid.");

  // §48 — a cursor is only valid for the exact statement it was minted for.
  if (
    c.k !== expected.kind ||
    c.b !== expected.businessId ||
    c.p !== expected.partyId ||
    c.f !== expected.from ||
    c.t !== expected.to
  ) {
    throw new StatementValidationError("cursor", "cursor does not match this statement query.");
  }

  return {
    v: "v1",
    k: c.k,
    b: c.b,
    p: c.p,
    f: c.f,
    t: c.t,
    ts: c.ts,
    id: c.id,
    st: c.st as StatementSourceType,
  };
}
