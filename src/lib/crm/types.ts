/**
 * Prompt 35 — Advanced CRM Foundation: CLOSED domain vocabularies (§6).
 *
 * Law:
 * - The browser can NEVER invent a new status, source or stage. Every
 *   transition validates against these closed sets (server-authoritative).
 * - CRM is operational, NON-accounting data: nothing in this file (or the
 *   whole module) is allowed to touch Sale/Expense/Payment/Receivable/
 *   Payable/Inventory aggregates (§1/§33/§70/§71).
 * - Lead ≠ Customer, Opportunity ≠ Sale (§4). Conversion is explicit.
 */

/** Closed lead status vocabulary (§6/§22). */
export const LEAD_STATUSES = [
  "NEW",
  "CONTACTED",
  "QUALIFIED",
  "DISQUALIFIED",
  "CONVERTED",
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Closed lead source vocabulary (§6) — user-entered classification only. */
export const LEAD_SOURCES = [
  "MANUAL",
  "REFERRAL",
  "WEBSITE",
  "SOCIAL",
  "PARTNER",
  "IMPORT",
  "OTHER",
] as const;

export type LeadSource = (typeof LEAD_SOURCES)[number];

/** Closed opportunity stage vocabulary (§6/§7) — the FIXED pipeline. */
export const OPPORTUNITY_STAGES = [
  "DISCOVERY",
  "QUALIFIED",
  "PROPOSAL",
  "NEGOTIATION",
  "WON",
  "LOST",
] as const;

export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

/** Stage category (§6): open = still in play, WON/LOST = terminal. */
export const STAGE_CATEGORIES = ["OPEN", "WON", "LOST"] as const;
export type OpportunityStageCategory = (typeof STAGE_CATEGORIES)[number];

/** Conversion input modes (§23). */
export const CONVERSION_MODES = ["EXISTING_CUSTOMER", "CREATE_CUSTOMER"] as const;
export type ConversionMode = (typeof CONVERSION_MODES)[number];

/* --------------------------------- guards --------------------------------- */

export function isLeadStatus(value: string): value is LeadStatus {
  return (LEAD_STATUSES as readonly string[]).includes(value);
}

export function isLeadSource(value: string): value is LeadSource {
  return (LEAD_SOURCES as readonly string[]).includes(value);
}

export function isOpportunityStage(value: string): value is OpportunityStage {
  return (OPPORTUNITY_STAGES as readonly string[]).includes(value);
}

export function stageCategory(stage: OpportunityStage): OpportunityStageCategory {
  return stage === "WON" ? "WON" : stage === "LOST" ? "LOST" : "OPEN";
}

/* ------------------------------ server DTOs ------------------------------- */

/** Minimal customer reference embedded in CRM DTOs (§80). */
export type CrmCustomerRef = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
};

/** Minimal assignee reference (§81) — never security/session fields. */
export type CrmAssigneeRef = {
  id: string;
  name: string | null;
  email: string;
  role: string;
};

/** Lead list-row / detail shape (§79). */
export type LeadDTO = {
  id: string;
  name: string;
  companyName: string | null;
  phone: string | null;
  email: string | null;
  source: LeadSource;
  sourceDetail: string | null;
  status: LeadStatus;
  note: string | null;
  assignedTo: CrmAssigneeRef | null;
  customer: CrmCustomerRef | null;
  convertedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Lead detail = list DTO + bounded related opportunities (§41). */
export type LeadDetail = LeadDTO & {
  openOpportunityCount: number;
  opportunityCount: number;
  recentOpportunities: CrmOpportunityRef[];
};

/** Bounded opportunity reference used inside other DTOs (§40/§44/§127). */
export type CrmOpportunityRef = {
  id: string;
  title: string;
  stage: OpportunityStage;
  probabilityPct: number;
  expectedValueMinor: number;
  currencyCode: string;
  expectedCloseDate: string | null;
  createdAt: string;
};

/** Opportunity DTO (§79). */
export type OpportunityDTO = {
  id: string;
  title: string;
  description: string | null;
  stage: OpportunityStage;
  probabilityPct: number;
  expectedValueMinor: number;
  currencyCode: string;
  expectedCloseDate: string | null;
  assignedTo: CrmAssigneeRef | null;
  customer: CrmCustomerRef | null;
  lead: CrmLeadRef | null;
  lostReason: string | null;
  wonAt: string | null;
  lostAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Minimal lead reference embedded in opportunity DTOs (§80). */
export type CrmLeadRef = {
  id: string;
  name: string;
  companyName: string | null;
  status: LeadStatus;
};

/** Opportunity detail = DTO + derived weighted value (§42/§55). */
export type OpportunityDetail = OpportunityDTO & {
  weightedValueMinor: number;
};

/** Lead list page envelope (§19). */
export type LeadListResponse = {
  items: LeadDTO[];
  total: number;
  page: number;
  pageSize: number;
};

/** Opportunity list page envelope (§28). */
export type OpportunityListResponse = {
  items: OpportunityDTO[];
  total: number;
  page: number;
  pageSize: number;
};

/** CRM summary response (§34) — ALL values are CRM forecast metrics. */
export type CrmSummary = {
  leads: {
    NEW: number;
    CONTACTED: number;
    QUALIFIED: number;
    DISQUALIFIED: number;
    CONVERTED: number;
    total: number;
  };
  opportunities: {
    openCount: number;
    wonCount: number;
    lostCount: number;
    /** Σ expectedValueMinor over OPEN opportunities (forecast). */
    openPipelineValueMinor: number;
    /** Σ (expectedValueMinor × probabilityPct / 100) over OPEN (forecast). */
    weightedPipelineValueMinor: number;
    /** Σ expectedValueMinor over OPEN with expectedCloseDate in next 30 days. */
    expectedCloseValueMinor: number;
    wonValueMinor: number;
  };
  /** New leads in the current period (rolling 30 days, §34). */
  newLeadsInPeriod: number;
  /** Currency the forecast values are denominated in (business currency). */
  currencyCode: string;
};
