/**
 * Prompt 35 — CRM summary (§34/§35/§83/§127).
 *
 * Deterministic, server-side aggregates over the CALLER's business only.
 * Every value here is a CRM FORECAST metric — never accounting revenue.
 * Uses groupBy (single round trips, no N+1) and exact integer weighted
 * math (§35: value × probability / 100 — never floats).
 */
import "server-only";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/api-helpers";
import { weightedValue } from "./normalization";
import { LEAD_STATUSES, OPPORTUNITY_STAGES, stageCategory, type CrmSummary, type LeadStatus, type OpportunityStage } from "./types";

/** Rolling period for "new leads" (§34: "current period" = last 30 days). */
const NEW_LEAD_PERIOD_DAYS = 30;
/** Expected-close horizon (§34: "next 30 days"). */
const CLOSE_HORIZON_DAYS = 30;

export async function computeCrmSummary(businessId: string): Promise<CrmSummary> {
  const business = await db.business.findUnique({
    where: { id: businessId },
    select: { currencyCode: true },
  });
  if (!business) throw new ApiError(404, "NOT_FOUND", "Business not found.");

  const now = new Date();
  const periodStart = new Date(now.getTime() - NEW_LEAD_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  const horizonEnd = new Date(now.getTime() + CLOSE_HORIZON_DAYS * 24 * 60 * 60 * 1000);

  const [leadBuckets, stageBuckets, closeWindow, newLeads] = await Promise.all([
    // §83 — lead counts by status (tenant-scoped, soft-delete filtered).
    db.crmLead.groupBy({
      by: ["status"],
      where: { businessId, deletedAt: null },
      _count: { _all: true },
    }),
    // §34 — opportunity stage buckets with expected-value sums.
    db.crmOpportunity.groupBy({
      by: ["stage"],
      where: { businessId, deletedAt: null },
      _count: { _all: true },
      _sum: { expectedValueMinor: true },
    }),
    // §34 — open opportunities expected to close within the next 30 days.
    db.crmOpportunity.aggregate({
      where: {
        businessId,
        deletedAt: null,
        stage: { in: ["DISCOVERY", "QUALIFIED", "PROPOSAL", "NEGOTIATION"] },
        expectedCloseDate: { gte: now, lte: horizonEnd },
      },
      _sum: { expectedValueMinor: true },
    }),
    // §34 — new leads in the rolling period.
    db.crmLead.count({
      where: { businessId, deletedAt: null, createdAt: { gte: periodStart } },
    }),
  ]);

  // Exact weighted pipeline (§35) with a BOUNDED aggregate (§127): groupBy
  // probabilityPct (integer 0–100 → ≤101 groups) summing expectedValueMinor,
  // then weight each group sum — value×prob/100 per group in exact integer
  // math. Σ over rows == Σ over groups because weightedValue is linear.
  const probGroups = await db.crmOpportunity.groupBy({
    by: ["probabilityPct"],
    where: {
      businessId,
      deletedAt: null,
      stage: { in: ["DISCOVERY", "QUALIFIED", "PROPOSAL", "NEGOTIATION"] },
    },
    _sum: { expectedValueMinor: true },
  });
  let weightedPipelineValueMinor = 0;
  for (const group of probGroups) {
    weightedPipelineValueMinor = weightedPipelineValueMinor + weightedValue(group._sum.expectedValueMinor ?? 0, group.probabilityPct);
  }

  const leadCounts = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0])) as Record<LeadStatus, number>;
  let leadTotal = 0;
  for (const bucket of leadBuckets) {
    const status = (LEAD_STATUSES as readonly string[]).includes(bucket.status)
      ? (bucket.status as LeadStatus)
      : null;
    if (!status) continue;
    leadCounts[status] = bucket._count._all;
    leadTotal += bucket._count._all;
  }

  let openCount = 0;
  let wonCount = 0;
  let lostCount = 0;
  let openPipelineValueMinor = 0;
  let wonValueMinor = 0;
  for (const bucket of stageBuckets) {
    const stage = (OPPORTUNITY_STAGES as readonly string[]).includes(bucket.stage)
      ? (bucket.stage as OpportunityStage)
      : null;
    if (!stage) continue;
    const category = stageCategory(stage);
    const value = bucket._sum.expectedValueMinor ?? 0;
    if (category === "OPEN") {
      openCount += bucket._count._all;
      openPipelineValueMinor += value;
    } else if (category === "WON") {
      wonCount += bucket._count._all;
      wonValueMinor += value;
    } else {
      lostCount += bucket._count._all;
    }
  }

  return {
    leads: { ...leadCounts, total: leadTotal },
    opportunities: {
      openCount,
      wonCount,
      lostCount,
      openPipelineValueMinor,
      weightedPipelineValueMinor,
      expectedCloseValueMinor: closeWindow._sum.expectedValueMinor ?? 0,
      wonValueMinor,
    },
    newLeadsInPeriod: newLeads,
    currencyCode: business.currencyCode,
  };
}
