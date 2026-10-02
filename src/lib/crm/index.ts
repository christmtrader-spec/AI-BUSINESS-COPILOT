/**
 * Prompt 35 — Advanced CRM Foundation domain barrel (§5).
 *
 * Layout (§5):
 *   types.ts          closed vocabularies + DTO types
 *   constants.ts      fixed pipeline, probabilities, transition rules
 *   schemas.ts        zod request boundaries
 *   normalization.ts  date-only rule, phone, weighted integer math
 *   dto.ts            explicit row→DTO mappers (never Prisma rows, §79)
 *   service.ts        tenant-scoped validation helpers (§15)
 *   lead-service.ts   lead list/CRUD/status (§18–§22)
 *   opportunity-service.ts  opportunity list/CRUD/stage (§27–§33)
 *   conversion.ts     atomic lead conversion (§23–§26/§75)
 *   summary.ts        CRM forecast summary (§34/§35)
 */
export * from "./types";
export * from "./constants";
export {
  leadCreateSchema,
  leadUpdateSchema,
  leadStatusSchema,
  leadConvertSchema,
  opportunityCreateSchema,
  opportunityUpdateSchema,
  opportunityStageSchema,
} from "./schemas";
export { activityCreateSchema, activityUpdateSchema } from "./activity-schemas";
export { taskCreateSchema, taskUpdateSchema, taskStatusSchema } from "./task-schemas";
export {
  parseExpectedCloseDate,
  normalizePhone,
  weightedValue,
  stageOf,
  leadStatusOf,
  leadSourceOf,
  toIsoOrNull,
} from "./normalization";
export {
  mapLead,
  mapLeadDetail,
  mapOpportunity,
  mapOpportunityRef,
  mapCustomerRef,
  mapAssignee,
  withWeightedValue,
} from "./dto";
export {
  assertAssigneeInBusiness,
  assertCustomerInBusiness,
  assertLeadInBusiness,
  loadLeadOr404,
  loadOpportunityOr404,
  loadCustomerForConversion,
} from "./service";
export {
  listLeads,
  getLeadDetail,
  createLead,
  updateLead,
  changeLeadStatus,
  deleteLead,
  LEAD_PAGE_SIZE_DEFAULT,
  LEAD_PAGE_SIZE_MAX,
} from "./lead-service";
export {
  listOpportunities,
  getOpportunityDetail,
  createOpportunity,
  updateOpportunity,
  changeOpportunityStage,
  deleteOpportunity,
  stageCategoryOf,
  OPPORTUNITY_PAGE_SIZE_DEFAULT,
  OPPORTUNITY_PAGE_SIZE_MAX,
} from "./opportunity-service";
export { convertLead } from "./conversion";
export { computeCrmSummary } from "./summary";

// ---------------------------------------------------------------------------
// Prompt 36 — CRM Activities + Tasks (§17).
//
// SERVER-ONLY LAW (Prompt 35 lesson): UI modules must import the pure
// sub-modules DIRECTLY (activity-types / task-types / activity-dto /
// task-dto / normalization) — never this barrel, which re-exports the
// server services (db/auth/audit would leak into client bundles).
// ---------------------------------------------------------------------------
export {
  ACTIVITY_PAGE_SIZE_DEFAULT,
  ACTIVITY_PAGE_SIZE_MAX,
  listActivities,
  getActivity,
  createActivity,
  updateActivity,
  deleteActivity,
} from "./activity-service";
export {
  TASK_PAGE_SIZE_DEFAULT,
  TASK_PAGE_SIZE_MAX,
  listTasks,
  getTask,
  createTask,
  updateTask,
  changeTaskStatus,
  deleteTask,
} from "./task-service";
export { getWorkQueue, WORK_QUEUE_MAX } from "./work-queue";
export {
  getTimeline,
  TIMELINE_CANDIDATES_PER_SOURCE,
  TIMELINE_PAGE_SIZE_DEFAULT,
  TIMELINE_PAGE_SIZE_MAX,
} from "./timeline";
export {
  assertExactlyOneContext,
  resolveCrmContextInBusiness,
  assertOpportunityInBusiness,
  loadCrmContextOr404,
} from "./service";
