/**
 * Prompt 36 — Activity request schemas (§14/§19/§21/§22).
 *
 * Zod is the boundary: the type vocabulary is a closed z.enum so arbitrary
 * strings never reach services. Title 2–160; description optional ≤4000;
 * durationMinutes integer 1–1440 (§14); occurredAt is a required datetime
 * string parsed into a UTC instant by the service (§16 — real instants,
 * the Prompt 35 date-only midnoon rule does NOT apply here).
 *
 * CLIENT-SAFE (pure zod) — but only server routes consume these.
 */
import { z } from "zod";
import { ACTIVITY_TYPES } from "./activity-types";

/** ≤64-char context ids; empty → null normalization everywhere. */
const contextIdSchema = z.string().trim().max(64).nullish().transform((v) => v || null);

/** Occurred-at raw string — length-bounded here, instant-parsed server-side. */
const occurredAtSchema = z
  .string()
  .trim()
  .min(1, "occurredAt is required")
  .max(40);

const durationSchema = z
  .number()
  .int()
  .min(1, "Duration must be at least 1 minute")
  .max(1440, "Duration cannot exceed 1440 minutes")
  .nullish()
  .transform((v) => v ?? null);

/** §21 — the client controls exactly these fields; business/actor are set by the server. */
export const activityCreateSchema = z.object({
  type: z.enum(ACTIVITY_TYPES),
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().max(4000).nullish().transform((v) => v || null),
  occurredAt: occurredAtSchema,
  durationMinutes: durationSchema,
  customerId: contextIdSchema,
  leadId: contextIdSchema,
  opportunityId: contextIdSchema,
});
export type ActivityCreateInput = z.infer<typeof activityCreateSchema>;

/**
 * §22 — generic PATCH may change type/title/description/occurredAt/
 * duration ONLY. Context change is intentionally NOT writable: an activity
 * attached to the wrong entity must be deleted and re-created so timeline
 * semantics and audit stay clean.
 */
export const activityUpdateSchema = z.object({
  type: z.enum(ACTIVITY_TYPES).optional(),
  title: z.string().trim().min(2).max(160).optional(),
  description: z.string().trim().max(4000).nullish().transform((v) => v || null),
  occurredAt: occurredAtSchema.optional(),
  durationMinutes: durationSchema,
});
export type ActivityUpdateInput = z.infer<typeof activityUpdateSchema>;
