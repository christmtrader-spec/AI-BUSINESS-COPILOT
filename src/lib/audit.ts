/**
 * Audit helper — Constitution A09.
 * Single sanctioned path for audit records. Critical mutations call
 * `audit()` inside the same transaction as the mutation when possible.
 */
import { db } from "@/lib/db";

export type AuditInput = {
  /** Null for account-level security events (auth.*, account deletion). */
  businessId: string | null;
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
};

export async function audit(input: AuditInput, tx?: Pick<typeof db, "auditLog">) {
  const client = tx ?? db;
  const data = {
    businessId: input.businessId,
    actorId: input.actorId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    beforeJson: input.before === undefined ? null : JSON.stringify(input.before),
    afterJson: input.after === undefined ? null : JSON.stringify(input.after),
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  };
  try {
    return await client.auditLog.create({ data });
  } catch (error) {
    // Auditing must never break the primary operation, but must be loud in logs.
    console.error("[audit] failed to write audit log:", error);
  }
}

/**
 * Prompt 48 (§14-F) — STRICT audit variant for the supplier-bill POSTING
 * transaction: an audit failure there MUST roll back the entire posting
 * (bill status + the newly created payable Expense) so the system can never
 * commit an un-audited payable-creating transition. Same AuditInput shape
 * and the same privacy law (no notes, no bodies) — the ONLY difference is
 * that failures propagate instead of being swallowed. Used exclusively
 * inside the atomic bill-posting transaction; every other mutation keeps
 * the standard swallowing audit() (existing convention).
 */
export async function auditStrict(input: AuditInput, tx: Pick<typeof db, "auditLog">) {
  const data = {
    businessId: input.businessId,
    actorId: input.actorId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    beforeJson: input.before === undefined ? null : JSON.stringify(input.before),
    afterJson: input.after === undefined ? null : JSON.stringify(input.after),
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  };
  return tx.auditLog.create({ data });
}
