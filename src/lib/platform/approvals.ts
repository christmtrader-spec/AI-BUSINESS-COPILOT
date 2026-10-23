import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { platformError, type PlatformContext } from "./auth";
import { activatePriceBook } from "@/lib/payments/pricing-service";

/**
 * Two-person approval service — Prompt 65 (§10, §13, §14).
 *
 * THE single authoritative implementation of dual control for high-risk
 * platform mutations. A narrowly scoped registry of operations (APPROVAL_
 * OPERATIONS) defines every approvable kind; anything not registered can
 * never be requested (deny by default).
 *
 * Laws (§10.1):
 *  - The requested operation + parameters are stored STRUCTURED and
 *    VALIDATED per-kind at creation. The payload is IMMUTABLE — there is
 *    no edit API, so a material change can never inherit a prior approval.
 *  - payloadHash (SHA-256 of the canonical payload) is re-derived at
 *    execution; an approved request can only ever execute its exact
 *    stored payload.
 *  - The approver must hold platform:approvals:manage AND the operation's
 *    own permission, and must be a DIFFERENT OPERATOR ROW than the
 *    requester (server-side). Documented limitation: identity is resolved
 *    to the operator ROW — a second browser session of the same operator
 *    is still the same operator and cannot approve their own request.
 *  - Requests expire (APPROVAL_TTL_MS bounds BOTH approval and execution).
 *    Expiry is enforced lazily on every read/mutation (deterministic; no
 *    cron dependency) AND in the execution claim's WHERE clause.
 *  - Execution is claimed ATOMICALLY (status-conditional updateMany inside
 *    the execution flow): concurrent executions cannot double-run.
 *  - Status machine:
 *      PENDING → APPROVED | REJECTED | CANCELLED | EXPIRED (lazy)
 *      APPROVED | FAILED → EXECUTING (claim; expiry-guarded)
 *      EXECUTING → EXECUTED | FAILED (value-free error code only)
 *    "Executed exactly once" = EXECUTED is terminal; FAILED may be retried
 *    while unexpired (a FAILED run never produced the operation's effect —
 *    and the wired operation is itself idempotent, §74).
 *  - Every transition is audited via platformAudit (single write path §9).
 */

/** Requests expire after 24h — approval AND execution both bound. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export const APPROVAL_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
  "EXECUTING",
  "EXECUTED",
  "FAILED",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/* ------------------------- operation registry (§10) ------------------------ */

type ApprovalOperation<P = unknown> = {
  /** Permission required to REQUEST, APPROVE and EXECUTE (on top of
   * platform:approvals:manage). */
  permission: import("./rbac").PlatformPermission;
  payloadSchema: z.ZodType<P>;
  /** Safe, bounded UI description — never raw secrets. */
  describe: (payload: P) => string;
  execute: (payload: P, ctx: PlatformContext) => Promise<unknown>;
};

export const APPROVAL_OPERATIONS = {
  "pricing.activate": {
    permission: "platform:pricing:manage",
    payloadSchema: z.object({
      priceBookId: z.string().trim().min(1).max(64),
    }),
    describe: (p: { priceBookId: string }) => `Activate price book ${p.priceBookId}`,
    // The SAME authoritative service the direct route uses (§81 — one path;
    // PricingService remains the only activation authority, §13).
    execute: async (p: { priceBookId: string }, ctx: PlatformContext) =>
      activatePriceBook(p.priceBookId, { actorId: ctx.userId }),
  },
} as const satisfies Record<string, ApprovalOperation<never>> | Record<string, ApprovalOperation<any>>;

export type ApprovalKind = keyof typeof APPROVAL_OPERATIONS;

export const APPROVAL_KINDS = Object.keys(APPROVAL_OPERATIONS) as ApprovalKind[];

export function approvalOperationOf(kind: string): ApprovalOperation<any> | null {
  return Object.prototype.hasOwnProperty.call(APPROVAL_OPERATIONS, kind)
    ? (APPROVAL_OPERATIONS as Record<string, ApprovalOperation<any>>)[kind]
    : null;
}

/** Deterministic canonical JSON (sorted keys, recursive) → stable hash. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function payloadHashOf(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/* ------------------------------ expiry sweep ------------------------------- */

/** Lazy deterministic expiry (§10.1) — safe to call on every read/write. */
export async function sweepExpiredApprovals(): Promise<void> {
  await db.platformApprovalRequest.updateMany({
    where: { status: { in: ["PENDING", "APPROVED"] }, expiresAt: { lt: new Date() } },
    data: { status: "EXPIRED" },
  });
}

/* --------------------------------- service --------------------------------- */

/** The Prisma row shape returned by every read/include in this module. */
export type ApprovalRequestRow = ApprovalDbRow;

const OPERATOR_SUMMARY = { id: true, role: true, active: true, user: { select: { email: true } } } as const;

function operatorSummary(op: {
  id: string;
  role: string;
  active: boolean;
  user: { email: string } | null;
} | null) {
  if (!op) return null;
  return { id: op.id, email: op.user?.email ?? null, role: op.role, active: op.active };
}

const approvalInclude = {
  requester: { select: OPERATOR_SUMMARY },
  approver: { select: OPERATOR_SUMMARY },
} as const;

type ApprovalDbRow = {
  id: string;
  kind: string;
  payloadJson: string;
  payloadHash: string;
  reason: string;
  status: string;
  requesterId: string;
  approverId: string | null;
  approvalNote: string | null;
  rejectionReason: string | null;
  expiresAt: Date;
  approvedAt: Date | null;
  executedAt: Date | null;
  executeError: string | null;
  createdAt: Date;
  requester: { id: string; role: string; active: boolean; user: { email: string } | null } | null;
  approver: { id: string; role: string; active: boolean; user: { email: string } | null } | null;
};

/** Safe DTO — parsed payload, bounded descriptions, no hash material beyond
 * a short correlation prefix. */
export function approvalDto(row: ApprovalDbRow) {
  let payload: unknown = null;
  let payloadInvalid = false;
  try {
    payload = JSON.parse(row.payloadJson);
  } catch {
    payloadInvalid = true; // impossible by construction; honest flag anyway
  }
  const op = approvalOperationOf(row.kind);
  return {
    id: row.id,
    kind: row.kind,
    kindLabel: op ? op.describe(payload) : row.kind,
    payload: payloadInvalid ? null : payload,
    payloadHashPrefix: row.payloadHash.slice(0, 12),
    reason: row.reason,
    status: row.status,
    requester: operatorSummary(row.requester),
    approver: operatorSummary(row.approver),
    approvalNote: row.approvalNote,
    rejectionReason: row.rejectionReason,
    expiresAt: row.expiresAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    executedAt: row.executedAt?.toISOString() ?? null,
    executeError: row.executeError,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function createApprovalRequest(input: {
  ctx: PlatformContext;
  kind: string;
  payload: unknown;
  reason: string;
}): Promise<ApprovalRequestRow> {
  const op = approvalOperationOf(input.kind);
  if (!op) {
    // Deny by default: unknown kinds can never be requested (§10).
    throw platformError(422, "PLATFORM_INVALID_OPERATION", "Unknown approval operation.");
  }
  // R65 §9.3/§10.1 — CREATING a request is a privileged mutation: it
  // requires platform:approvals:manage AND the operation's own permission
  // (a read-only operator must never be able to mint approval requests,
  // and a BILLING operator must never mint security-domain requests).
  // Enforced HERE (the single service path) — not per-route (§81).
  requireOperationPermission(input.ctx, input.kind);
  const parsed = op.payloadSchema.safeParse(input.payload);
  if (!parsed.success) {
    throw platformError(422, "PLATFORM_INVALID_OPERATION", "The submitted data is invalid.", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const payloadJson = canonicalJson(parsed.data);
  const row = await db.platformApprovalRequest.create({
    data: {
      kind: input.kind,
      payloadJson,
      payloadHash: payloadHashOf(parsed.data),
      reason: input.reason,
      status: "PENDING",
      requesterId: input.ctx.operatorId,
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
    },
    include: approvalInclude,
  });
  return row as ApprovalRequestRow;
}

export async function listApprovalRequests(params: {
  status?: string;
  kind?: string;
  page: number;
  pageSize: number;
  skip: number;
}): Promise<{ rows: ApprovalDbRow[]; total: number }> {
  await sweepExpiredApprovals();
  const where = {
    ...(params.status ? { status: params.status } : {}),
    ...(params.kind ? { kind: params.kind } : {}),
  };
  const [rows, total] = await Promise.all([
    db.platformApprovalRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: params.skip,
      take: params.pageSize,
      include: approvalInclude,
    }),
    db.platformApprovalRequest.count({ where }),
  ]);
  return { rows: rows as ApprovalDbRow[], total };
}

export async function getApprovalRequest(id: string): Promise<ApprovalDbRow | null> {
  await sweepExpiredApprovals();
  const row = await db.platformApprovalRequest.findUnique({
    where: { id },
    include: approvalInclude,
  });
  return (row as ApprovalDbRow) ?? null;
}

async function requireRow(id: string): Promise<ApprovalDbRow> {
  const row = await db.platformApprovalRequest.findUnique({
    where: { id },
    include: approvalInclude,
  });
  if (!row) {
    // No-existence-oracle law (§126): unknown id behaves like a vanished row.
    throw platformError(404, "PLATFORM_NOT_FOUND", "Approval request not found.");
  }
  return row as ApprovalDbRow;
}

/** Both requester-side and approver-side mutations require manage + the
 * operation's own permission (§10.1 — approver must be authorized for the
 * operation itself, not merely for "approving things"). */
function requireOperationPermission(ctx: PlatformContext, kind: string): void {
  const op = approvalOperationOf(kind);
  if (!op) {
    throw platformError(422, "PLATFORM_INVALID_OPERATION", "Unknown approval operation.");
  }
  if (!ctx.permissions.includes("platform:approvals:manage")) {
    throw platformError(403, "PLATFORM_PERMISSION_DENIED", "Your operator role does not allow this action.", {
      permission: "platform:approvals:manage",
    });
  }
  if (!ctx.permissions.includes(op.permission)) {
    throw platformError(403, "PLATFORM_PERMISSION_DENIED", "Your operator role does not allow this action.", {
      permission: op.permission,
    });
  }
}

export async function approveApprovalRequest(input: {
  ctx: PlatformContext;
  id: string;
  note?: string;
}): Promise<ApprovalRequestRow> {
  // Lazy expiry FIRST — an expired PENDING request can never be approved.
  await sweepExpiredApprovals();
  const row = await requireRow(input.id);
  requireOperationPermission(input.ctx, row.kind);
  if (row.status !== "PENDING") {
    throw platformError(409, "PLATFORM_INVALID_STATE", "Only a pending request can be approved.");
  }
  // §10.1 — the approver must be a DIFFERENT operator from the requester.
  // Server-side identity (operator row), never a client-provided id.
  if (row.requesterId === input.ctx.operatorId) {
    throw platformError(403, "PLATFORM_SELF_APPROVAL_DENIED", "The requester cannot approve their own request.");
  }
  const claimed = await db.platformApprovalRequest.updateMany({
    where: { id: row.id, status: "PENDING" },
    data: { status: "APPROVED", approverId: input.ctx.operatorId, approvalNote: input.note ?? null, approvedAt: new Date() },
  });
  if (claimed.count !== 1) {
    throw platformError(409, "PLATFORM_INVALID_STATE", "Only a pending request can be approved.");
  }
  return requireRow(input.id);
}

export async function rejectApprovalRequest(input: {
  ctx: PlatformContext;
  id: string;
  reason: string;
}): Promise<ApprovalRequestRow> {
  // Lazy expiry FIRST — an expired PENDING request can never be rejected.
  await sweepExpiredApprovals();
  const row = await requireRow(input.id);
  requireOperationPermission(input.ctx, row.kind);
  if (row.status !== "PENDING") {
    throw platformError(409, "PLATFORM_INVALID_STATE", "Only a pending request can be rejected.");
  }
  const claimed = await db.platformApprovalRequest.updateMany({
    where: { id: row.id, status: "PENDING" },
    data: { status: "REJECTED", approverId: input.ctx.operatorId, rejectionReason: input.reason },
  });
  if (claimed.count !== 1) {
    throw platformError(409, "PLATFORM_INVALID_STATE", "Only a pending request can be rejected.");
  }
  return requireRow(input.id);
}

export async function cancelApprovalRequest(input: {
  ctx: PlatformContext;
  id: string;
}): Promise<ApprovalRequestRow> {
  const row = await requireRow(input.id);
  // Cancellation is requester-only (§10.1) — a governance action, not an
  // approval action, so the operation permission is NOT required here.
  if (row.requesterId !== input.ctx.operatorId) {
    throw platformError(403, "PLATFORM_PERMISSION_DENIED", "Only the requester can cancel a pending request.");
  }
  if (row.status !== "PENDING") {
    throw platformError(409, "PLATFORM_INVALID_STATE", "Only a pending request can be cancelled.");
  }
  const claimed = await db.platformApprovalRequest.updateMany({
    where: { id: row.id, status: "PENDING" },
    data: { status: "CANCELLED" },
  });
  if (claimed.count !== 1) {
    throw platformError(409, "PLATFORM_INVALID_STATE", "Only a pending request can be cancelled.");
  }
  return requireRow(input.id);
}

export type ApprovalExecuteResult =
  | { ok: true; result: unknown; row: ApprovalDbRow }
  | { ok: false; errorCode: string; row: ApprovalDbRow };

/**
 * Execute an APPROVED request exactly once.
 *
 * Claim: status-conditional updateMany (APPROVED|FAILED → EXECUTING,
 * expiry-guarded in the WHERE) — concurrent executions cannot both claim.
 * The stored payloadHash is re-verified against the stored payload before
 * the operation runs. On success → EXECUTED (terminal); on failure →
 * FAILED with a VALUE-FREE error code (retryable while unexpired).
 */
export async function executeApprovalRequest(input: {
  ctx: PlatformContext;
  id: string;
}): Promise<ApprovalExecuteResult> {
  await sweepExpiredApprovals();
  const row = await requireRow(input.id);
  requireOperationPermission(input.ctx, row.kind);

  // Parse + re-verify the payload BEFORE claiming (a corrupted payload can
  // never execute; the hash binds approval to the exact parameters).
  const op = approvalOperationOf(row.kind);
  if (!op) {
    throw platformError(422, "PLATFORM_INVALID_OPERATION", "Unknown approval operation.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(row.payloadJson);
  } catch {
    throw platformError(409, "PLATFORM_INVALID_STATE", "The stored request payload is invalid.");
  }
  const parsed = op.payloadSchema.safeParse(payload);
  if (!parsed.success || payloadHashOf(parsed.data) !== row.payloadHash) {
    throw platformError(409, "PLATFORM_INVALID_STATE", "The stored request payload is invalid.");
  }

  // Atomic single-run claim (§10.1): exactly one concurrent caller wins.
  const claimed = await db.platformApprovalRequest.updateMany({
    where: {
      id: row.id,
      status: { in: ["APPROVED", "FAILED"] },
      expiresAt: { gt: new Date() },
    },
    data: { status: "EXECUTING", executeError: null },
  });
  if (claimed.count !== 1) {
    throw platformError(409, "PLATFORM_INVALID_STATE", "The request is not in an executable state.");
  }

  try {
    const result = await op.execute(parsed.data, input.ctx);
    await db.platformApprovalRequest.updateMany({
      where: { id: row.id, status: "EXECUTING" },
      data: { status: "EXECUTED", executedAt: new Date() },
    });
    return { ok: true, result, row: await requireRow(input.id) };
  } catch (error) {
    // Value-free failure code only — never the raw error (could carry
    // provider or data detail into the DB/UI, §10/§14 sanitization law).
    const code =
      error && typeof error === "object" && "code" in error && typeof (error as { code: unknown }).code === "string"
        ? (error as { code: string }).code
        : "EXECUTION_FAILED";
    await db.platformApprovalRequest.updateMany({
      where: { id: row.id, status: "EXECUTING" },
      data: { status: "FAILED", executeError: code.slice(0, 64) },
    });
    return { ok: false, errorCode: code, row: await requireRow(input.id) };
  }
}
