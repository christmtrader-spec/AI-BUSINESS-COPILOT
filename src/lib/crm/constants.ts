/**
 * Prompt 35 — fixed pipeline constants + transition rules (§7/§22/§32).
 *
 * The pipeline is CODE-DEFINED (§8: deliberately no PipelineStage table).
 * These maps are the ONLY authority for default probabilities and the ONLY
 * place transitions are validated. Both are pure — unit-testable without
 * a database (scripts/prompt35-unit.ts areas 3–11).
 */

import {
  LEAD_STATUSES,
  OPPORTUNITY_STAGES,
  stageCategory,
  type LeadStatus,
  type OpportunityStage,
} from "./types";

/** Deterministic board order (§7): DISCOVERY → … → WON, LOST last. */
export const STAGE_ORDER: readonly OpportunityStage[] = OPPORTUNITY_STAGES;

/** Default probability per stage (§7). WON/LOST are FORCED, not defaults. */
export const DEFAULT_STAGE_PROBABILITY: Record<OpportunityStage, number> = {
  DISCOVERY: 10,
  QUALIFIED: 25,
  PROPOSAL: 50,
  NEGOTIATION: 75,
  WON: 100,
  LOST: 0,
};

/** Probability bounds (§7): integer 0–100, decimals/NaN rejected upstream. */
export const PROBABILITY_MIN = 0;
export const PROBABILITY_MAX = 100;

/* ------------------------------ lead transitions --------------------------- */

/**
 * Allowed lead status transitions (§22). Missing keys have no outgoing
 * edges (DISQUALIFIED and CONVERTED are terminal — no reactivation in
 * Prompt 35).
 */
export const LEAD_TRANSITIONS: Readonly<Record<LeadStatus, readonly LeadStatus[]>> = {
  NEW: ["CONTACTED", "QUALIFIED", "DISQUALIFIED", "CONVERTED"],
  CONTACTED: ["QUALIFIED", "DISQUALIFIED", "CONVERTED"],
  QUALIFIED: ["DISQUALIFIED", "CONVERTED"],
  DISQUALIFIED: [],
  CONVERTED: [],
};

/** Pure transition check (§22): invalid → caller maps to 422. */
export function isLeadTransitionValid(from: LeadStatus, to: LeadStatus): boolean {
  return LEAD_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Lead status → whether the lead has been converted (§41 conversion state).
 * Kept as a function so the UI never string-compares raw enums.
 */
export function isLeadConverted(status: LeadStatus): boolean {
  return status === "CONVERTED";
}

/* --------------------------- opportunity transitions ----------------------- */

/**
 * Allowed opportunity stage transitions (§32):
 * OPEN → OPEN, OPEN → WON, OPEN → LOST, WON → OPEN (reopen), LOST → OPEN.
 * WON ↔ LOST directly is NOT allowed (must reopen first).
 */
export function isOpportunityTransitionValid(
  from: OpportunityStage,
  to: OpportunityStage,
): boolean {
  const fromCat = stageCategory(from);
  const toCat = stageCategory(to);
  if (from === to) return false;
  if (fromCat === "OPEN") return true; // OPEN → OPEN | WON | LOST
  // Terminal → only reopening into an OPEN stage (§32).
  return toCat === "OPEN";
}

/**
 * Exhaustive lead status x transition-availability map (useful for the UI
 * "Change status" menu and for unit assertions on closed vocabulary).
 */
export function allowedLeadTargets(from: LeadStatus): LeadStatus[] {
  return [...(LEAD_TRANSITIONS[from] ?? [])];
}

/**
 * Stage order index (§55 aggregates + deterministic ordering). LOST sorts
 * after WON per STAGE_ORDER; list views order by createdAt instead.
 */
export function stageOrderIndex(stage: OpportunityStage): number {
  return STAGE_ORDER.indexOf(stage);
}

/** Guard against accidental vocabulary drift in tests/dev (§109 areas 1–4). */
export function assertVocabularyIntegrity(): void {
  if (LEAD_STATUSES.length !== 5) throw new Error("LeadStatus vocabulary drift");
  if (OPPORTUNITY_STAGES.length !== 6) throw new Error("OpportunityStage drift");
  if (DEFAULT_STAGE_PROBABILITY.WON !== 100 || DEFAULT_STAGE_PROBABILITY.LOST !== 0) {
    throw new Error("Terminal probability drift");
  }
}
