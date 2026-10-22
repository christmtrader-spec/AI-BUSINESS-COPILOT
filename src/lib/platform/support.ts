import "server-only";
/**
 * Support Center service — Prompt 62 (§10).
 *
 * THE single ticketing subsystem. Every support mutation — operator or
 * requester-side — funnels through here so the state machine, visibility
 * law and audit law cannot be bypassed by a route handler.
 *
 * STATE MACHINE (§10.1) — explicit allowlist, deny-by-default:
 *   OPEN → TRIAGED | IN_PROGRESS | WAITING_FOR_CUSTOMER | WAITING_FOR_INTERNAL_ACTION | RESOLVED | CLOSED
 *   TRIAGED → IN_PROGRESS | WAITING_FOR_CUSTOMER | WAITING_FOR_INTERNAL_ACTION | RESOLVED | CLOSED
 *   IN_PROGRESS → TRIAGED | WAITING_FOR_CUSTOMER | WAITING_FOR_INTERNAL_ACTION | RESOLVED | CLOSED
 *   WAITING_FOR_CUSTOMER → TRIAGED | IN_PROGRESS | RESOLVED | CLOSED
 *   WAITING_FOR_INTERNAL_ACTION → TRIAGED | IN_PROGRESS | RESOLVED | CLOSED
 *   RESOLVED → OPEN (reopen) | CLOSED
 *   CLOSED → (terminal — no transitions out; the requester opens a new ticket)
 *
 * VISIBILITY LAW (§10.2): INTERNAL messages are operator notes. The TENANT
 * API surface (src/app/api/v1/support/**) never receives them — the filter
 * lives HERE at the service layer, not in the route.
 *
 * AUDIT LAW (§15): every OPERATOR mutation writes a PlatformAuditLog row
 * with before/after snapshots (sanitized in lib/platform/audit). Requester
 * actions are not operator actions — the thread itself is their record.
 *
 * NOTIFICATION LAW (§18): requester-facing events go through the existing
 * notification platform via notifyFailSafe (never throws into the domain
 * flow — §72).
 */
import { db } from "@/lib/db";
import { notifyFailSafe } from "@/lib/notifications";
import { ApiError } from "@/lib/api-helpers";
import type { PlatformOperator, SupportTicket, SupportTicketMessage } from "@prisma/client";

/* ------------------------------- closed sets ------------------------------ */

export const SUPPORT_TICKET_STATUSES = [
  "OPEN",
  "TRIAGED",
  "IN_PROGRESS",
  "WAITING_FOR_CUSTOMER",
  "WAITING_FOR_INTERNAL_ACTION",
  "RESOLVED",
  "CLOSED",
] as const;
export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number];

/**
 * Prompt 62 §7.2 — the "unresolved" subset used by platform diagnostics
 * (overview cards). RESOLVED/CLOSED are terminal and never counted as open.
 */
export const SUPPORT_TICKET_OPEN_STATUSES = [
  "OPEN",
  "TRIAGED",
  "IN_PROGRESS",
  "WAITING_FOR_CUSTOMER",
  "WAITING_FOR_INTERNAL_ACTION",
] as const;

export const SUPPORT_TICKET_CATEGORIES = [
  "BILLING",
  "TECHNICAL",
  "ACCOUNT",
  "AI_COPILOT",
  "FEATURE_REQUEST",
  "OTHER",
] as const;
export type SupportTicketCategory = (typeof SUPPORT_TICKET_CATEGORIES)[number];

export const SUPPORT_TICKET_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export type SupportTicketPriority = (typeof SUPPORT_TICKET_PRIORITIES)[number];

export const SUPPORT_MESSAGE_VISIBILITIES = ["CUSTOMER", "INTERNAL"] as const;
export type SupportMessageVisibility = (typeof SUPPORT_MESSAGE_VISIBILITIES)[number];

export const SUPPORT_AUTHOR_KINDS = ["REQUESTER", "OPERATOR"] as const;
export type SupportAuthorKind = (typeof SUPPORT_AUTHOR_KINDS)[number];

/** §10.1 — explicit transition matrix; anything not listed is DENIED. */
export const SUPPORT_TRANSITIONS: Readonly<
  Record<SupportTicketStatus, readonly SupportTicketStatus[]>
> = {
  OPEN: ["TRIAGED", "IN_PROGRESS", "WAITING_FOR_CUSTOMER", "WAITING_FOR_INTERNAL_ACTION", "RESOLVED", "CLOSED"],
  TRIAGED: ["IN_PROGRESS", "WAITING_FOR_CUSTOMER", "WAITING_FOR_INTERNAL_ACTION", "RESOLVED", "CLOSED"],
  IN_PROGRESS: ["TRIAGED", "WAITING_FOR_CUSTOMER", "WAITING_FOR_INTERNAL_ACTION", "RESOLVED", "CLOSED"],
  WAITING_FOR_CUSTOMER: ["TRIAGED", "IN_PROGRESS", "RESOLVED", "CLOSED"],
  WAITING_FOR_INTERNAL_ACTION: ["TRIAGED", "IN_PROGRESS", "RESOLVED", "CLOSED"],
  RESOLVED: ["OPEN", "CLOSED"],
  CLOSED: [],
};

export function canTransition(from: SupportTicketStatus, to: SupportTicketStatus): boolean {
  if (from === to) return false;
  return SUPPORT_TRANSITIONS[from].includes(to);
}

export function allowedTransitionsOf(status: SupportTicketStatus): readonly SupportTicketStatus[] {
  return SUPPORT_TRANSITIONS[status];
}

export function isSupportStatus(v: unknown): v is SupportTicketStatus {
  return typeof v === "string" && (SUPPORT_TICKET_STATUSES as readonly string[]).includes(v);
}
export function isSupportCategory(v: unknown): v is SupportTicketCategory {
  return typeof v === "string" && (SUPPORT_TICKET_CATEGORIES as readonly string[]).includes(v);
}
export function isSupportPriority(v: unknown): v is SupportTicketPriority {
  return typeof v === "string" && (SUPPORT_TICKET_PRIORITIES as readonly string[]).includes(v);
}
export function isSupportVisibility(v: unknown): v is SupportMessageVisibility {
  return typeof v === "string" && (SUPPORT_MESSAGE_VISIBILITIES as readonly string[]).includes(v);
}

/* --------------------------------- errors --------------------------------- */

/** Extends ApiError so `route()` maps it to the standard envelope. */
export class SupportError extends ApiError {
  constructor(
    status: number,
    code:
      | "SUPPORT_TICKET_NOT_FOUND"
      | "SUPPORT_INVALID_TRANSITION"
      | "SUPPORT_RESOLUTION_REQUIRED"
      | "SUPPORT_NOT_REQUESTER"
      | "SUPPORT_TICKET_CLOSED"
      | "SUPPORT_NUMBER_COLLISION",
    message: string,
  ) {
    super(status, code, message);
    this.name = "SupportError";
  }
}

/* ------------------------------ bounds (§22) ------------------------------ */

export const SUPPORT_SUBJECT_MAX = 140;
export const SUPPORT_DESCRIPTION_MAX = 5_000;
export const SUPPORT_MESSAGE_MAX = 2_000;
export const SUPPORT_RESOLUTION_MIN = 10;
export const SUPPORT_RESOLUTION_MAX = 2_000;
/** List pages never return more than the platform MAX_PAGE_SIZE. */
export const SUPPORT_LIST_MAX = 100;
/** Bounded diagnostics windows (§10.3/§22) — no unbounded scans. */
const DIAGNOSTICS_LIMIT = 10;

/* ------------------------------ actor contexts ---------------------------- */

export type OperatorActor = {
  kind: "OPERATOR";
  operatorId: string;
  operatorRole: string;
  userId: string;
  name: string | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

export type RequesterActor = {
  kind: "REQUESTER";
  userId: string;
  name: string | null;
};

/* -------------------------------- creation -------------------------------- */

export type CreateTicketInput = {
  requesterId: string;
  businessId?: string | null;
  subject: string;
  description: string;
  category: SupportTicketCategory;
  priority?: SupportTicketPriority;
  actor: OperatorActor | RequesterActor;
};

export type TicketNumberCollision = { code: "SUPPORT_NUMBER_COLLISION"; retryable: true };

/**
 * Create a ticket. The requester identity is resolved SERVER-SIDE by the
 * caller (session user for the tenant route; an explicitly validated user
 * id for the operator "open on behalf of a caller" flow — §79/§132: a
 * request body can never mint someone else's identity).
 */
export async function createSupportTicket(
  input: CreateTicketInput,
): Promise<SupportTicket | TicketNumberCollision> {
  const requester = await db.user.findUnique({
    where: { id: input.requesterId },
    select: { id: true, email: true, name: true, suspendedAt: true },
  });
  if (!requester) {
    throw new SupportError(404, "SUPPORT_TICKET_NOT_FOUND", "Requester user not found.");
  }
  // A suspended account cannot open tickets (§8.3 — capabilities restricted).
  if (requester.suspendedAt) {
    throw new SupportError(403, "SUPPORT_NOT_REQUESTER", "This account is suspended.");
  }

  let businessName: string | null = null;
  if (input.businessId) {
    const business = await db.business.findUnique({
      where: { id: input.businessId },
      select: { id: true, name: true },
    });
    if (!business) {
      throw new SupportError(404, "SUPPORT_TICKET_NOT_FOUND", "Business not found.");
    }
    businessName = business.name;
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const ticket = await db.$transaction(async (tx) => {
        const max = await tx.supportTicket.aggregate({ _max: { number: true } });
        const number = (max._max.number ?? 0) + 1;
        return tx.supportTicket.create({
          data: {
            number,
            requesterId: requester.id,
            requesterEmailAtCreation: requester.email,
            requesterNameAtCreation: requester.name,
            businessId: input.businessId ?? null,
            businessNameAtCreation: businessName,
            subject: input.subject.trim(),
            description: input.description.trim(),
            category: input.category,
            priority: input.priority ?? "NORMAL",
            status: "OPEN",
          },
        });
      });

      await auditFor(
        input.actor,
        "support.ticket.create",
        ticket.id,
        { targetUserId: requester.id, targetBusinessId: input.businessId ?? null },
        null,
        {
          subject: ticket.subject,
          category: ticket.category,
          priority: ticket.priority,
          status: ticket.status,
        },
      );

      // Acknowledge to the requester (§18) — deduped by sourceEventId.
      await notifyFailSafe({
        userId: requester.id,
        businessId: input.businessId ?? null,
        type: "SUPPORT_TICKET_CREATED",
        sourceEventId: `support:created:${ticket.id}`,
        data: {
          ticketId: ticket.id,
          ticketNumber: ticket.number,
          subject: ticket.subject,
        },
        requestId: input.actor.kind === "OPERATOR" ? (input.actor.requestId ?? null) : null,
      });

      return ticket;
    } catch (error) {
      // SQLite unique collision on `number` (two concurrent creates) — the
      // transaction rolled back cleanly; retry with a fresh max (§19.2).
      if (
        error instanceof Object &&
        "code" in error &&
        (error as { code?: string }).code === "P2002"
      ) {
        if (attempt === 3) return { code: "SUPPORT_NUMBER_COLLISION", retryable: true };
        continue;
      }
      throw error;
    }
  }
  return { code: "SUPPORT_NUMBER_COLLISION", retryable: true };
}

/* --------------------------------- reads ---------------------------------- */

export type ListTicketFilters = {
  status?: SupportTicketStatus;
  priority?: SupportTicketPriority;
  category?: SupportTicketCategory;
  /** "me" | "unassigned" | an operator id (allowlisted semantics only). */
  assignee?: string;
  /** The calling operator's id — resolves the "me" filter server-side. */
  callerOperatorId?: string;
  businessId?: string;
  requesterId?: string;
  q?: string;
  createdFrom?: Date;
  createdTo?: Date;
  page: number;
  pageSize: number;
};

export async function listSupportTickets(filters: ListTicketFilters) {
  const where = {
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.priority ? { priority: filters.priority } : {}),
    ...(filters.category ? { category: filters.category } : {}),
    ...(filters.assignee === "me"
      ? { assigneeOperatorId: filters.callerOperatorId ?? "__none__" }
      : filters.assignee === "unassigned"
        ? { assigneeOperatorId: null }
        : filters.assignee
          ? { assigneeOperatorId: filters.assignee }
          : {}),
    ...(filters.businessId ? { businessId: filters.businessId } : {}),
    ...(filters.requesterId ? { requesterId: filters.requesterId } : {}),
    ...(filters.q
      ? {
          OR: [
            { subject: { contains: filters.q } },
            { description: { contains: filters.q } },
          ],
        }
      : {}),
    ...(filters.createdFrom || filters.createdTo
      ? {
          createdAt: {
            ...(filters.createdFrom ? { gte: filters.createdFrom } : {}),
            ...(filters.createdTo ? { lte: filters.createdTo } : {}),
          },
        }
      : {}),
  };

  const pageSize = Math.min(Math.max(filters.pageSize, 1), SUPPORT_LIST_MAX);
  const skip = (Math.max(filters.page, 1) - 1) * pageSize;

  const [rows, total] = await Promise.all([
    db.supportTicket.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: pageSize,
      skip,
      include: {
        assignee: { select: { id: true, role: true } },
      },
    }),
    db.supportTicket.count({ where }),
  ]);

  return {
    tickets: rows.map(ticketListItemDto),
    page: { page: Math.max(filters.page, 1), pageSize, total, hasNext: skip + pageSize < total, hasPrev: Math.max(filters.page, 1) > 1 },
  };
}

export function ticketListItemDto(t: SupportTicket & { assignee?: { id: string; role: string } | null }) {
  // Date fields are ISO-stringified HERE — platformOk's BigInt-safe walker
  // treats a raw Date as a plain object and would destroy it (platform DTO
  // law: explicit serializers only, same as platformUserDto).
  return {
    id: t.id,
    number: t.number,
    reference: `SUP-${String(t.number).padStart(4, "0")}`,
    subject: t.subject,
    category: t.category,
    priority: t.priority,
    status: t.status,
    requesterEmail: t.requesterEmailAtCreation,
    requesterName: t.requesterNameAtCreation,
    businessName: t.businessNameAtCreation,
    businessId: t.businessId,
    assigneeOperatorId: t.assigneeOperatorId,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    firstResponseAt: t.firstResponseAt ? t.firstResponseAt.toISOString() : null,
    resolvedAt: t.resolvedAt ? t.resolvedAt.toISOString() : null,
  };
}

export async function getSupportTicket(id: string) {
  return db.supportTicket.findUnique({
    where: { id },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
      assignee: { select: { id: true, role: true, userId: true } },
    },
  });
}

/** Operator detail: EVERYTHING (internal notes included — §10.2). */
export function ticketOperatorDetailDto(
  t: NonNullable<Awaited<ReturnType<typeof getSupportTicket>>>,
) {
  return {
    ...ticketListItemDto(t),
    description: t.description,
    resolutionSummary: t.resolutionSummary,
    closedAt: t.closedAt,
    assigneeRole: t.assignee?.role ?? null,
    allowedTransitions: allowedTransitionsOf(isSupportStatus(t.status) ? t.status : "OPEN"),
    messages: t.messages.map((m) => ticketMessageDto(m, { includeInternal: true })),
  };
}

/** Requester detail: CUSTOMER-visibility messages ONLY — the filter is
 *  HERE so no future route can accidentally leak internal notes (§10.2). */
export function ticketRequesterDetailDto(t: NonNullable<Awaited<ReturnType<typeof getSupportTicket>>>) {
  return {
    id: t.id,
    number: t.number,
    reference: `SUP-${String(t.number).padStart(4, "0")}`,
    subject: t.subject,
    category: t.category,
    status: t.status,
    priority: t.priority,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    resolutionSummary: t.status === "RESOLVED" || t.status === "CLOSED" ? t.resolutionSummary : null,
    description: t.description,
    messages: t.messages
      .filter((m) => m.visibility === "CUSTOMER")
      .map((m) => ticketMessageDto(m, { includeInternal: false })),
  };
}

export function ticketMessageDto(
  m: SupportTicketMessage,
  opts: { includeInternal: boolean },
) {
  return {
    id: m.id,
    authorKind: m.authorKind,
    authorName: m.authorNameAtPost,
    visibility: opts.includeInternal ? m.visibility : "CUSTOMER",
    body: m.body,
    createdAt: m.createdAt.toISOString(),
  };
}

/* ------------------------------- mutations -------------------------------- */

export type TransitionResult = SupportTicket;

export async function transitionSupportTicket(params: {
  ticketId: string;
  to: SupportTicketStatus;
  actor: OperatorActor;
  resolutionSummary?: string;
  reason?: string | null;
}): Promise<TransitionResult> {
  const ticket = await db.supportTicket.findUnique({ where: { id: params.ticketId } });
  if (!ticket) {
    throw new SupportError(404, "SUPPORT_TICKET_NOT_FOUND", "Ticket not found.");
  }
  const from = isSupportStatus(ticket.status) ? ticket.status : "OPEN";
  if (!canTransition(from, params.to)) {
    throw new SupportError(
      422,
      "SUPPORT_INVALID_TRANSITION",
      `Transition ${from} → ${params.to} is not allowed.`,
      );
  }
  if (params.to === "RESOLVED" && !(params.resolutionSummary ?? "").trim()) {
    throw new SupportError(
      422,
      "SUPPORT_RESOLUTION_REQUIRED",
      "A resolution summary is required to resolve a ticket (§10.4).",
    );
  }

  const now = new Date();
  const updated = await db.supportTicket.update({
    where: { id: ticket.id },
    data: {
      status: params.to,
      ...(params.to === "RESOLVED"
        ? { resolvedAt: now, resolutionSummary: params.resolutionSummary!.trim(), closedAt: null }
        : {}),
      ...(params.to === "CLOSED" ? { closedAt: now } : {}),
      ...(params.to === "OPEN" ? { resolvedAt: null, resolutionSummary: null, closedAt: null } : {}),
    },
  });

  await auditFor(params.actor, "support.ticket.transition", ticket.id, {
    targetUserId: ticket.requesterId,
    targetBusinessId: ticket.businessId,
    reason: params.reason ?? null,
  }, { status: ticket.status, resolutionSummary: ticket.resolutionSummary }, {
    status: updated.status,
    resolutionSummary: updated.resolutionSummary,
  });

  if (params.to === "RESOLVED" && ticket.requesterId) {
    await notifyFailSafe({
      userId: ticket.requesterId,
      businessId: ticket.businessId,
      type: "SUPPORT_TICKET_RESOLVED",
      sourceEventId: `support:resolved:${ticket.id}:${now.getTime()}`,
      data: {
        ticketId: ticket.id,
        ticketNumber: ticket.number,
        subject: ticket.subject,
        summary: params.resolutionSummary!.trim().slice(0, 300),
      },
      requestId: params.actor.requestId ?? null,
    });
  }

  return updated;
}

export async function setTicketPriority(params: {
  ticketId: string;
  priority: SupportTicketPriority;
  actor: OperatorActor;
}): Promise<SupportTicket> {
  const ticket = await db.supportTicket.findUnique({ where: { id: params.ticketId } });
  if (!ticket) throw new SupportError(404, "SUPPORT_TICKET_NOT_FOUND", "Ticket not found.");
  if (ticket.priority === params.priority) return ticket; // idempotent no-op
  const updated = await db.supportTicket.update({
    where: { id: ticket.id },
    data: { priority: params.priority },
  });
  await auditFor(params.actor, "support.ticket.priority", ticket.id, {
    targetUserId: ticket.requesterId,
    targetBusinessId: ticket.businessId,
  }, { priority: ticket.priority }, { priority: updated.priority });
  return updated;
}

export async function assignTicket(params: {
  ticketId: string;
  /** operator id or null to unassign (the caller resolves "me"). */
  assigneeOperatorId: string | null;
  actor: OperatorActor;
}): Promise<SupportTicket> {
  const ticket = await db.supportTicket.findUnique({ where: { id: params.ticketId } });
  if (!ticket) throw new SupportError(404, "SUPPORT_TICKET_NOT_FOUND", "Ticket not found.");

  if (params.assigneeOperatorId) {
    const operator = await db.platformOperator.findUnique({
      where: { id: params.assigneeOperatorId },
      select: { id: true, active: true, role: true },
    });
    if (!operator || !operator.active) {
      throw new SupportError(422, "SUPPORT_INVALID_TRANSITION", "Assignee must be an active platform operator.");
    }
  }
  if (ticket.assigneeOperatorId === params.assigneeOperatorId) return ticket; // idempotent

  const updated = await db.supportTicket.update({
    where: { id: ticket.id },
    data: { assigneeOperatorId: params.assigneeOperatorId },
  });
  await auditFor(params.actor, "support.ticket.assign", ticket.id, {
    targetUserId: ticket.requesterId,
    targetBusinessId: ticket.businessId,
  }, { assigneeOperatorId: ticket.assigneeOperatorId }, { assigneeOperatorId: updated.assigneeOperatorId });
  return updated;
}

export async function addOperatorMessage(params: {
  ticketId: string;
  body: string;
  visibility: SupportMessageVisibility;
  actor: OperatorActor;
}): Promise<SupportTicketMessage> {
  const ticket = await db.supportTicket.findUnique({ where: { id: params.ticketId } });
  if (!ticket) throw new SupportError(404, "SUPPORT_TICKET_NOT_FOUND", "Ticket not found.");
  if (ticket.status === "CLOSED") {
    throw new SupportError(409, "SUPPORT_TICKET_CLOSED", "Reopen the ticket before continuing the thread.");
  }

  const message = await db.supportTicketMessage.create({
    data: {
      ticketId: ticket.id,
      authorUserId: params.actor.userId,
      authorKind: "OPERATOR",
      authorNameAtPost: params.actor.name,
      visibility: params.visibility,
      body: params.body.trim(),
    },
  });

  // First CUSTOMER-facing operator response starts the response clock (§10.1).
  if (params.visibility === "CUSTOMER" && !ticket.firstResponseAt) {
    await db.supportTicket.update({
      where: { id: ticket.id },
      data: { firstResponseAt: message.createdAt },
    });
  }

  await auditFor(params.actor, "support.ticket.message", ticket.id, {
    targetUserId: ticket.requesterId,
    targetBusinessId: ticket.businessId,
  }, null, { visibility: params.visibility, bodyLength: params.body.trim().length });

  if (params.visibility === "CUSTOMER" && ticket.requesterId) {
    await notifyFailSafe({
      userId: ticket.requesterId,
      businessId: ticket.businessId,
      type: "SUPPORT_TICKET_REPLY",
      sourceEventId: `support:reply:${message.id}`,
      data: {
        ticketId: ticket.id,
        ticketNumber: ticket.number,
        subject: ticket.subject,
      },
      requestId: params.actor.requestId ?? null,
    });
  }

  return message;
}

/** Requester reply (tenant route). INTERNAL leakage is impossible: the
 *  visibility is fixed server-side and the requester identity is fixed by
 *  the session (§79). A reply on a RESOLVED ticket reopens it (→ OPEN). */
export async function addRequesterMessage(params: {
  ticketId: string;
  requesterId: string;
  body: string;
}): Promise<SupportTicketMessage> {
  const ticket = await db.supportTicket.findUnique({ where: { id: params.ticketId } });
  if (!ticket) throw new SupportError(404, "SUPPORT_TICKET_NOT_FOUND", "Ticket not found.");
  if (ticket.requesterId !== params.requesterId) {
    // IDOR guard — do not reveal existence to a non-requester (§5.2).
    throw new SupportError(404, "SUPPORT_TICKET_NOT_FOUND", "Ticket not found.");
  }
  if (ticket.status === "CLOSED") {
    throw new SupportError(409, "SUPPORT_TICKET_CLOSED", "This ticket is closed. Please open a new ticket.");
  }

  const requester = await db.user.findUnique({
    where: { id: params.requesterId },
    select: { name: true },
  });

  const [, message] = await db.$transaction([
    db.supportTicket.update({
      where: { id: ticket.id },
      // RESOLVED → OPEN on requester reply (the transition matrix's reopen
      // edge, exercised by the requester instead of an operator).
      data: ticket.status === "RESOLVED" ? { status: "OPEN", resolvedAt: null, resolutionSummary: null } : {},
    }),
    db.supportTicketMessage.create({
      data: {
        ticketId: ticket.id,
        authorUserId: params.requesterId,
        authorKind: "REQUESTER",
        authorNameAtPost: requester?.name ?? null,
        visibility: "CUSTOMER",
        body: params.body.trim(),
      },
    }),
  ]);
  return message;
}

/* ------------------------------- diagnostics ------------------------------ */

/**
 * Ticket diagnostics (§10.3) — bounded, redacted, permission-conditional.
 * Confirmed facts only (subscription state, delivery failures, ticket
 * history); no speculative root-cause claims, no raw payloads.
 */
export async function getTicketDiagnostics(ticket: {
  requesterId: string | null;
  businessId: string | null;
  requesterEmailAtCreation: string;
}, opts: { canReadSecurity: boolean; canReadAudit: boolean }) {
  const [subscription, requesterTicketCount, recentRequesterTickets, failedDeliveries, securityEvents, recentTargetedAudit] =
    await Promise.all([
      ticket.businessId
        ? db.subscription.findFirst({
            where: { businessId: ticket.businessId },
            orderBy: { createdAt: "desc" },
            select: {
              status: true,
              plan: { select: { name: true } },
              currentPeriodStart: true,
              currentPeriodEnd: true,
              trialEnd: true,
            },
          })
        : Promise.resolve(null),
      ticket.requesterId
        ? db.supportTicket.count({ where: { requesterId: ticket.requesterId } })
        : Promise.resolve(0),
      ticket.requesterId
        ? db.supportTicket.findMany({
            where: { requesterId: ticket.requesterId },
            orderBy: { createdAt: "desc" },
            take: 5,
            select: { id: true, number: true, subject: true, status: true, createdAt: true },
          }).then((rows) => rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })))
        : Promise.resolve([]),
      ticket.requesterId
        ? db.notificationDelivery.findMany({
            where: { notification: { userId: ticket.requesterId }, status: "FAILED" },
            orderBy: { createdAt: "desc" },
            take: DIAGNOSTICS_LIMIT,
            select: {
              channel: true,
              status: true,
              failureCode: true,
              createdAt: true,
              notification: { select: { type: true } },
            },
          }).then((rows) => rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })))
        : Promise.resolve([]),
      opts.canReadSecurity && ticket.requesterId
        ? db.securityEvent.findMany({
            where: { userId: ticket.requesterId },
            orderBy: { createdAt: "desc" },
            take: DIAGNOSTICS_LIMIT,
            select: { eventType: true, success: true, createdAt: true },
          }).then((rows) => rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })))
        : Promise.resolve(null),
      opts.canReadAudit
        ? db.platformAuditLog.findMany({
            where: { targetUserId: ticket.requesterId },
            orderBy: { createdAt: "desc" },
            take: DIAGNOSTICS_LIMIT,
            select: { action: true, createdAt: true, operatorRole: true },
          }).then((rows) => rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })))
        : Promise.resolve(null),
    ]);

  return {
    subscription: subscription
      ? {
          status: subscription.status,
          planName: subscription.plan?.name ?? null,
          currentPeriodStart: subscription.currentPeriodStart ? subscription.currentPeriodStart.toISOString() : null,
          currentPeriodEnd: subscription.currentPeriodEnd ? subscription.currentPeriodEnd.toISOString() : null,
          trialEndsAt: subscription.trialEnd ? subscription.trialEnd.toISOString() : null,
        }
      : null,
    requester: {
      totalTickets: requesterTicketCount,
      recentTickets: recentRequesterTickets,
    },
    failedDeliveries: failedDeliveries.map((d) => ({
      notificationType: d.notification.type,
      channel: d.channel,
      status: d.status,
      failureCode: d.failureCode,
      createdAt: d.createdAt,
    })),
    securityEvents,
    recentTargetedAudit,
    windows: { diagnosticsLimit: DIAGNOSTICS_LIMIT },
  };
}

/* ---------------------------------- audit --------------------------------- */

async function auditFor(
  actor: OperatorActor | RequesterActor,
  action: string,
  entityId: string,
  extra: { targetUserId?: string | null; targetBusinessId?: string | null; reason?: string | null },
  before: unknown,
  after: unknown,
): Promise<void> {
  if (actor.kind !== "OPERATOR") return; // requester actions are not privileged actions
  const { platformAudit } = await import("./audit");
  await platformAudit({
    operatorId: actor.operatorId,
    operatorRole: actor.operatorRole,
    action,
    entityType: "SupportTicket",
    entityId,
    targetUserId: extra.targetUserId ?? null,
    targetBusinessId: extra.targetBusinessId ?? null,
    reason: extra.reason ?? null,
    before,
    after,
    requestId: actor.requestId ?? null,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent ?? null,
  });
}

/* --------------------------- operator reference --------------------------- */

/** Operators assignable to tickets (active only) — bounded, minimal fields. */
export async function listAssignableOperators(): Promise<
  Array<Pick<PlatformOperator, "id" | "role"> & { userId: string }>
> {
  return db.platformOperator.findMany({
    where: { active: true },
    select: { id: true, role: true, userId: true },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
}
