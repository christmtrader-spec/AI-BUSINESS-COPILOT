/**
 * Platform audit — Prompt 28 (§9/§10/§53/§73/§135/§136).
 *
 * THE single sanctioned write path for PlatformAuditLog. Every sensitive
 * operator mutation funnels through here, ideally INSIDE the same
 * transaction as the domain mutation (§73 — the callers decide; helpers
 * accept a Prisma transaction client).
 *
 * Sanitization law (§10) — a payload is NEVER recorded as-is:
 *  - Forbidden keys (passwords, tokens, secrets, AI prompts/responses,
 *    payment credentials, connection strings) are stripped recursively.
 *  - Only scalar/string/number/boolean JSON survives; BigInts are stringified.
 *  - Each serialized payload is bounded (MAX_JSON_CHARS) — no unbounded walls.
 *
 * Failure policy (§135): platformAudit NEVER throws and NEVER breaks the
 * primary mutation — but for security-critical mutations the callers write
 * the audit INSIDE the domain transaction where the architecture allows it,
 * so an audit failure rolls the mutation back together (transactional
 * guarantee) or, when non-transactional (external provider calls in flight),
 * the failure is logged loudly server-side and surfaced in the operation's
 * structured result (documented in docs/security/platform-admin-security.md).
 */
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/** Longest serialized before/after payload written to the audit row. */
export const MAX_JSON_CHARS = 8_000;

const FORBIDDEN_KEY_PATTERN =
  /pass(word)?|pwd|secret|token|apikey|api_key|authorization|cookie|credential|prompt|response|signature|database_?url|merchant/i;

/** Keys that are ALWAYS allowed even when the pattern above would match. */
const ALLOWED_KEYS = new Set(["providerRef", "priceVersion"]);

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 4) return "[depth-limit]";
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}…[truncated]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.slice(0, 25).map((v) => sanitizeValue(v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (ALLOWED_KEYS.has(k) || !FORBIDDEN_KEY_PATTERN.test(k)) {
        out[k] = sanitizeValue(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

/** Sanitize + bound a payload into an audit-ready JSON string (or null). */
export function sanitizeAuditJson(payload: unknown): string | null {
  if (payload === undefined || payload === null) return null;
  const clean = sanitizeValue(payload, 0);
  const json = JSON.stringify(clean);
  if (json.length <= MAX_JSON_CHARS) return json;
  return JSON.stringify({ truncated: true, head: json.slice(0, MAX_JSON_CHARS - 40) });
}

export type PlatformAuditInput = {
  operatorId: string | null;
  operatorRole?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  targetUserId?: string | null;
  targetBusinessId?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

type AuditClient = Pick<Prisma.TransactionClient, "platformAuditLog">;

export async function platformAudit(input: PlatformAuditInput, tx?: AuditClient) {
  const client = tx ?? db;
  const data = {
    operatorId: input.operatorId,
    operatorRole: input.operatorRole ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    targetUserId: input.targetUserId ?? null,
    targetBusinessId: input.targetBusinessId ?? null,
    reason: input.reason ? input.reason.slice(0, 500) : null,
    beforeJson: sanitizeAuditJson(input.before),
    afterJson: sanitizeAuditJson(input.after),
    requestId: input.requestId ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ? input.userAgent.slice(0, 300) : null,
  };
  try {
    return await client.platformAuditLog.create({ data });
  } catch (error) {
    // Audit must never break the primary operation — but it must be LOUD.
    console.error("[platform-audit] failed to persist platform audit log:", {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
    }, error);
  }
}

/** Safe request id: honor an existing correlation header, else mint a UUID. */
export function requestIdOf(req: Request): string {
  const existing =
    req.headers.get("x-request-id") ??
    req.headers.get("x-correlation-id");
  if (existing && /^[A-Za-z0-9._-]{8,64}$/.test(existing)) return existing;
  return crypto.randomUUID();
}
