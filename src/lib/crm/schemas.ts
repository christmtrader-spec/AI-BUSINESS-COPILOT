/**
 * Prompt 35 — request schemas (§13/§14/§22/§23/§31/§32).
 *
 * Zod is the boundary: closed enums here mean arbitrary status/stage
 * strings can never reach the services. Money arrives as integer MINOR
 * units (A08) — decimals are rejected by `.int()`. Probability is an
 * integer 0–100 (150/-10/NaN/decimal all fail — §7).
 */
import { z } from "zod";
import { optionalPreserved } from "./schema-presence";
import { LEAD_SOURCES, OPPORTUNITY_STAGES, CONVERSION_MODES } from "./types";
import { PROBABILITY_MIN, PROBABILITY_MAX } from "./constants";
import { optionalEmail } from "../schemas";

/* ---------------------------------- leads ---------------------------------- */

export const leadCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  companyName: z.string().trim().max(160).nullish().transform((v) => v || null),
  phone: z.string().trim().max(40).nullish().transform((v) => v || null),
  email: optionalEmail,
  source: z.enum(LEAD_SOURCES),
  sourceDetail: z.string().trim().max(120).nullish().transform((v) => v || null),
  note: z.string().trim().max(2000).nullish().transform((v) => v || null),
  assignedToUserId: z.string().trim().max(64).nullish().transform((v) => v || null),
});
export type LeadCreateInput = z.infer<typeof leadCreateSchema>;

/** §21 — generic PATCH never touches status/customerId/convertedAt. */
export const leadUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  companyName: optionalPreserved(z.string().trim().max(160)),
  phone: optionalPreserved(z.string().trim().max(40)),
  email: optionalEmail,
  source: z.enum(LEAD_SOURCES).optional(),
  sourceDetail: optionalPreserved(z.string().trim().max(120)),
  note: optionalPreserved(z.string().trim().max(2000)),
  assignedToUserId: optionalPreserved(z.string().trim().max(64)),
});
export type LeadUpdateInput = z.infer<typeof leadUpdateSchema>;

/** §22 — status changes ride the dedicated transition endpoint only. */
export const leadStatusSchema = z.object({
  status: z.custom<string>(
    (v) => typeof v === "string",
    "status must be a string",
  ),
});
export type LeadStatusInput = z.infer<typeof leadStatusSchema>;

/** §23 — conversion input. */
export const leadConvertSchema = z
  .object({
    mode: z.enum(CONVERSION_MODES),
    customerId: z.string().trim().max(64).nullish().transform((v) => v || null),
    customer: z
      .object({
        name: z.string().trim().min(1).max(120),
        phone: z.string().trim().max(40).nullish().transform((v) => v || null),
        email: optionalEmail,
      })
      .nullish(),
    opportunityTitle: z.string().trim().max(160).nullish().transform((v) => v || null),
  })
  .refine((v) => v.mode !== "EXISTING_CUSTOMER" || Boolean(v.customerId), {
    message: "customerId is required for EXISTING_CUSTOMER mode.",
    path: ["customerId"],
  })
  .refine((v) => v.mode !== "CREATE_CUSTOMER" || Boolean(v.customer), {
    message: "customer fields are required for CREATE_CUSTOMER mode.",
    path: ["customer"],
  });
export type LeadConvertInput = z.infer<typeof leadConvertSchema>;

/* ------------------------------- opportunities ------------------------------ */

const stageEnum = z.enum(OPPORTUNITY_STAGES);
const probabilitySchema = z
  .number()
  .int()
  .min(PROBABILITY_MIN)
  .max(PROBABILITY_MAX);
/** Optional date-only string (YYYY-MM-DD) or full ISO — normalized later (§84). */
const closeDateSchema = optionalPreserved(z.string().trim().max(40));

export const opportunityCreateSchema = z.object({
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().max(4000).nullish().transform((v) => v || null),
  leadId: z.string().trim().max(64).nullish().transform((v) => v || null),
  customerId: z.string().trim().max(64).nullish().transform((v) => v || null),
  stage: stageEnum.default("DISCOVERY"),
  probabilityPct: probabilitySchema.optional(),
  expectedValueMinor: z.number().int().min(0).max(9_000_000_000).optional(),
  expectedCloseDate: closeDateSchema,
  assignedToUserId: z.string().trim().max(64).nullish().transform((v) => v || null),
});
export type OpportunityCreateInput = z.infer<typeof opportunityCreateSchema>;

/** §31 — generic PATCH never changes stage (dedicated /stage endpoint). */
export const opportunityUpdateSchema = z.object({
  title: z.string().trim().min(2).max(160).optional(),
  description: optionalPreserved(z.string().trim().max(4000)),
  leadId: optionalPreserved(z.string().trim().max(64)),
  customerId: optionalPreserved(z.string().trim().max(64)),
  probabilityPct: probabilitySchema.optional(),
  expectedValueMinor: z.number().int().min(0).max(9_000_000_000).optional(),
  expectedCloseDate: closeDateSchema,
  assignedToUserId: optionalPreserved(z.string().trim().max(64)),
});
export type OpportunityUpdateInput = z.infer<typeof opportunityUpdateSchema>;

/** §32 — stage transition input. lostReason required only when stage=LOST. */
export const opportunityStageSchema = z
  .object({
    stage: stageEnum,
    probabilityPct: probabilitySchema.optional(),
    lostReason: z.string().trim().max(1000).nullish().transform((v) => v || null),
  })
  .refine((v) => v.stage !== "LOST" || Boolean(v.lostReason), {
    message: "A lost reason is required when moving to LOST.",
    path: ["lostReason"],
  });
export type OpportunityStageInput = z.infer<typeof opportunityStageSchema>;
