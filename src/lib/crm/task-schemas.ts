/**
 * Prompt 36 — Task request schemas (§15/§25/§26/§27).
 *
 * Closed vocabularies via z.enum. The generic PATCH never carries status
 * (§26 — status rides POST /status only, server state machine §13). dueAt
 * is an optional datetime string parsed server-side into a UTC instant.
 *
 * CLIENT-SAFE (pure zod).
 */
import { z } from "zod";
import { TASK_PRIORITIES } from "./task-types";

const contextIdSchema = z.string().trim().max(64).nullish().transform((v) => v || null);

/** Optional due-at raw string — length-bounded here, instant-parsed server-side. */
const dueAtSchema = z.string().trim().max(40).nullish().transform((v) => v || null);

export const taskCreateSchema = z.object({
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().max(4000).nullish().transform((v) => v || null),
  priority: z.enum(TASK_PRIORITIES).default("NORMAL"),
  dueAt: dueAtSchema,
  assignedToUserId: z.string().trim().max(64).nullish().transform((v) => v || null),
  customerId: contextIdSchema,
  leadId: contextIdSchema,
  opportunityId: contextIdSchema,
});
export type TaskCreateInput = z.infer<typeof taskCreateSchema>;

/** §26 — title/description/priority/dueAt/assignee only; never status, never context. */
export const taskUpdateSchema = z.object({
  title: z.string().trim().min(2).max(160).optional(),
  description: z.string().trim().max(4000).nullish().transform((v) => v || null),
  priority: z.enum(TASK_PRIORITIES).optional(),
  dueAt: dueAtSchema,
  assignedToUserId: z.string().trim().max(64).nullish().transform((v) => v || null),
});
export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;

/** §27 — status payload; the server validates vocabulary + transition. */
export const taskStatusSchema = z.object({
  status: z.string().trim().max(20),
});
export type TaskStatusInput = z.infer<typeof taskStatusSchema>;
