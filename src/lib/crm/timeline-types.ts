/**
 * Prompt 36 — client-safe timeline response types (§35/§117).
 *
 * Pure types only — the service (timeline.ts, server-only) imports and
 * re-exports these. Unified DTO per §35: no raw internal fields.
 */
import type { ActivityType, CrmContextType } from "./activity-types";
import type { TaskPriority, TaskStatus } from "./task-types";

export type TimelineItem = {
  kind: "ACTIVITY" | "TASK";
  id: string;
  title: string;
  description: string | null;
  /** occurredAt for activities, createdAt for tasks (§35). */
  timestamp: string;
  activityType: ActivityType | null;
  taskStatus: TaskStatus | null;
  priority: TaskPriority | null;
  dueAt: string | null;
  completedAt: string | null;
  durationMinutes: number | null;
  actor: { id: string; name: string | null } | null;
  assignee: { id: string; name: string | null } | null;
};

export type TimelineResponse = {
  items: TimelineItem[];
  page: number;
  pageSize: number;
  /** Size of the merged candidate window actually fetched (≤ 2×50). */
  windowSize: number;
  /** True when either source hit its candidate window (more history may exist). */
  hasMore: boolean;
};

/** Context param helper used by hooks + entity-detail sections. */
export type TimelineContextInput = {
  type: CrmContextType;
  id: string;
};

export type TimelineFilters = {
  contextType: CrmContextType;
  contextId: string;
  page: number;
  pageSize: number;
};
