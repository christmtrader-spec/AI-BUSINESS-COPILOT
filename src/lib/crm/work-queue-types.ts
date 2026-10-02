/**
 * Prompt 36 — client-safe work-queue response types (§30/§117).
 *
 * Pure types only — the DB service (work-queue.ts, server-only) imports and
 * re-exports these so client and server can never drift. No raw Prisma
 * relations: each row carries exactly the §30 allowlist.
 */
import type { CrmContextType } from "./activity-types";

export type WorkQueueTask = {
  id: string;
  title: string;
  priority: string;
  status: string;
  dueAt: string | null;
  assignedTo: { id: string; name: string | null; email: string } | null;
  contextType: CrmContextType;
  contextId: string;
  contextTitle: string;
  // Prompt 37 (§62) — reminder flags for an optional accessible badge.
  reminderEnabled: boolean;
  overdueAlertEnabled: boolean;
};

export type WorkQueueResponse = {
  overdue: WorkQueueTask[];
  today: WorkQueueTask[];
  upcoming: WorkQueueTask[];
  unscheduled: WorkQueueTask[];
  /** §88 — server-computed counts for the resolved assignee scope. */
  counts: {
    myOpenTaskCount: number;
    myOverdueTaskCount: number;
    myDueTodayCount: number;
  };
  assignedToUserId: string;
};
