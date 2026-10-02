/**
 * Prompt 36 — Task request schemas (§15/§25/§26/§27).
 *
 * Closed vocabularies via z.enum. The generic PATCH never carries status
 * (§26 — status rides POST /status only, server state machine §13). dueAt
 * is an optional datetime string parsed server-side into a UTC instant.
 *
 * Prompt 37 (§91/§92) — reminder configuration rides the SAME task
 * create/patch bodies; there is no separate /api/v1/reminders API.
 * reminderMinutesBefore is a STRICT integer allowlist (§7/§92) — arbitrary
 * values never reach the service. Cross-field consistency (reminder needs
 * dueAt, offset needs reminderEnabled) is enforced SERVER-side in
 * normalizeReminderConfig / task-service (§8/§94).
 *
 * CLIENT-SAFE (pure zod).
 */
import { z } from "zod";
import { REMINDER_OFFSET_MINUTES, TASK_PRIORITIES } from "./task-types";
import { optionalPreserved } from "./schema-presence";

// Prompt 37 bug fix — these are ABSENCE-PRESERVING: an omitted key stays
// absent so a generic PATCH can never clear stored values it did not send.
const contextIdSchema = optionalPreserved(z.string().trim().max(64));

/** Optional due-at raw string — length-bounded here, instant-parsed server-side. */
const dueAtSchema = optionalPreserved(z.string().trim().max(40));

/** §92 — strict integer allowlist; anything outside the closed vocabulary fails. */
const reminderOffsetSchema = optionalPreserved(
  z.number().int().refine((v) => (REMINDER_OFFSET_MINUTES as readonly number[]).includes(v)),
);

/** §163 — reminder fields are OPTIONAL on create; defaults false/null/false. */
export const taskCreateSchema = z.object({
  title: z.string().trim().min(2).max(160),
  description: optionalPreserved(z.string().trim().max(4000)),
  priority: z.enum(TASK_PRIORITIES).default("NORMAL"),
  dueAt: dueAtSchema,
  assignedToUserId: optionalPreserved(z.string().trim().max(64)),
  customerId: contextIdSchema,
  leadId: contextIdSchema,
  opportunityId: contextIdSchema,
  // Prompt 37 (§5/§91) — per-task reminder configuration.
  reminderEnabled: z.boolean().nullish(),
  reminderMinutesBefore: reminderOffsetSchema,
  overdueAlertEnabled: z.boolean().nullish(),
});
export type TaskCreateInput = z.infer<typeof taskCreateSchema>;

/**
 * §26 — title/description/priority/dueAt/assignee only; never status, never
 * context. §164 — a PATCH without reminder fields behaves exactly as before.
 */
export const taskUpdateSchema = z.object({
  title: z.string().trim().min(2).max(160).optional(),
  description: optionalPreserved(z.string().trim().max(4000)),
  priority: z.enum(TASK_PRIORITIES).optional(),
  dueAt: dueAtSchema,
  assignedToUserId: optionalPreserved(z.string().trim().max(64)),
  // Prompt 37 (§5/§91) — per-task reminder configuration.
  reminderEnabled: z.boolean().nullish(),
  reminderMinutesBefore: reminderOffsetSchema,
  overdueAlertEnabled: z.boolean().nullish(),
});
export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;

/** §27 — status payload; the server validates vocabulary + transition. */
export const taskStatusSchema = z.object({
  status: z.string().trim().max(20),
});
export type TaskStatusInput = z.infer<typeof taskStatusSchema>;
