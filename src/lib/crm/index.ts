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
