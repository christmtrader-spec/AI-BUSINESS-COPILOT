/**
 * Prompt 37-F — DEFENSIVE RE-CHECK PREDICATES (§16–§20/§31–§36).
 *
 * CLIENT-SAFE pure logic shared by the reminder processor and the task
 * service. Extracted so the race-safety rules are unit-testable without a
 * database while the processor/service apply them against REAL rows.
 *
 * Why these exist: between the moment a candidate/assignment is observed and
 * the moment a notification is attempted, the task may have been completed,
 * canceled, reassigned, rescheduled, reconfigured or soft-deleted by a
 * concurrent actor. A notification must NEVER be built from stale in-memory
 * state (§31–§34/§20). The caller therefore re-reads the minimal fresh task
 * state (never the description — §35) and asks these predicates.
 */

import { isDueSoonNow, isOverdueNow, isReminderOffset } from "./task-types";

/** Minimal fresh task state the processor must re-load before notifying (§35). */
export type FreshReminderTaskState = {
  id: string;
  businessId: string;
  status: string;
  deletedAt: Date | null;
  dueAt: Date | null;
  assignedToUserId: string | null;
  reminderEnabled: boolean;
  reminderMinutesBefore: number | null;
  overdueAlertEnabled: boolean;
};

/** The reminder kind a candidate was classified as during the scan. */
export type ReminderCandidateKind = "DUE_SOON" | "OVERDUE";

/**
 * §31–§35 — is the candidate STILL eligible at notification time?
 *
 * `fresh` is the row re-read from the database immediately before notify
 * (same id + businessId scope). Every rule is defensive: any mismatch
 * between the scanned candidate and the fresh row SKIPS the notification —
 * never half-processed, never stale data sent.
 *
 *  - row gone / soft-deleted (§16/§63)            ⇒ skip
 *  - status left the active set (§31/§32)         ⇒ skip (COMPLETED/CANCELED)
 *  - reassigned to another user (§33)             ⇒ skip (never the wrong user)
 *  - dueAt changed (§29/§62 — new logical identity) ⇒ skip this run
 *  - reminder/overdue config disabled (§34/§30)   ⇒ skip
 *  - window/classification no longer true         ⇒ skip
 */
export function isReminderCandidateStillEligible(
  kind: ReminderCandidateKind,
  fresh: FreshReminderTaskState | null,
  expectedAssigneeUserId: string,
  expectedDueAt: Date,
  now: Date,
): boolean {
  if (!fresh) return false; // deleted or vanished between scan and notify
  if (fresh.deletedAt !== null) return false; // §16/§63 — soft-deleted
  if (fresh.status !== "OPEN" && fresh.status !== "IN_PROGRESS") return false; // §31/§32
  if (!fresh.assignedToUserId || fresh.assignedToUserId !== expectedAssigneeUserId) return false; // §33
  if (!fresh.dueAt || fresh.dueAt.getTime() !== expectedDueAt.getTime()) return false; // §29/§62
  if (kind === "DUE_SOON") {
    if (!fresh.reminderEnabled) return false; // §34 — configuration race
    if (!isReminderOffset(fresh.reminderMinutesBefore)) return false;
    return isDueSoonNow(fresh.dueAt, fresh.reminderMinutesBefore, now); // window still true
  }
  if (!fresh.overdueAlertEnabled) return false; // §34 — configuration race
  return isOverdueNow(fresh.dueAt, now);
}

/** Exactly-one context projection (§8 of prompt 36) — null when unresolvable. */
export type ResolvedContext = {
  type: "CUSTOMER" | "LEAD" | "OPPORTUNITY";
  title: string;
};

/** Minimal context-bearing task projection (fresh read + candidate rows). */
export type ContextBearingTask = {
  customerId: string | null;
  customer: { name: string } | null;
  leadId: string | null;
  lead: { name: string; companyName: string | null } | null;
  opportunityId: string | null;
  opportunity: { title: string } | null;
};

/**
 * §17/§36 — resolve the EXACTLY-ONE context, or null.
 *
 * There is NO default: a missing/deleted context returns null and the caller
 * SKIPS the notification. Never `contextType = CUSTOMER, contextTitle = ""`.
 * Titles are bounded to the notification schema limit (160 chars).
 */
export function resolveExactlyOneContext(task: ContextBearingTask): ResolvedContext | null {
  if (task.customerId && task.customer?.name) {
    return { type: "CUSTOMER", title: task.customer.name.slice(0, 160) };
  }
  if (task.leadId && task.lead && (task.lead.companyName ?? task.lead.name)) {
    return {
      type: "LEAD",
      title: (task.lead.companyName ?? task.lead.name ?? "").slice(0, 160),
    };
  }
  if (task.opportunityId && task.opportunity?.title) {
    return { type: "OPPORTUNITY", title: task.opportunity.title.slice(0, 160) };
  }
  return null;
}

/** Minimal fresh state for the post-commit assignment check (§16/§18/§20). */
export type FreshAssignmentTaskState = {
  id: string;
  businessId: string;
  deletedAt: Date | null;
  assignedToUserId: string | null;
} & ContextBearingTask;

/**
 * §16/§18/§20 — ROW-level post-commit eligibility (WITHOUT the context,
 * which is verified against CURRENT rows by the caller via
 * readLiveTaskContext — a soft-deleted context can only be detected with a
 * deletedAt-filtered read, never from a stale projection).
 *
 *  - task still exists (§18)
 *  - NOT soft-deleted (§16 — "task active")
 *  - same business (§18)
 *  - assignee STILL equals the intended recipient (§18/§20 — a concurrent
 *    reassignment B→C must never produce a notification to B)
 */
export function isAssignmentRowEligible(
  fresh: { id: string; businessId: string; deletedAt: Date | null; assignedToUserId: string | null } | null,
  businessId: string,
  recipientUserId: string,
): boolean {
  if (!fresh) return false;
  if (fresh.deletedAt !== null) return false; // §16 — deleted before notify
  if (fresh.businessId !== businessId) return false; // §18 — same business
  if (!fresh.assignedToUserId || fresh.assignedToUserId !== recipientUserId) return false; // §18/§20
  return true;
}

/**
 * §16/§17/§18/§20 — FULL post-commit deliverability (row checks + the
 * exactly-one context resolvable from the GIVEN projection). The production
 * path uses isAssignmentRowEligible + readLiveTaskContext; this full
 * predicate remains the unit-tested mirror of the law (no CUSTOMER/""
 * fallback, §17).
 */
export function isAssignmentDeliverable(
  fresh: FreshAssignmentTaskState | null,
  businessId: string,
  recipientUserId: string,
): boolean {
  if (!fresh || !isAssignmentRowEligible(fresh, businessId, recipientUserId)) return false;
  return resolveExactlyOneContext(fresh) !== null; // §17/§18 — context still valid
}
