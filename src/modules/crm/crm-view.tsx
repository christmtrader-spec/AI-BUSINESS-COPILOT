"use client";

/**
 * Prompt 35 — CRM module view (§36/§37/§136).
 *
 * Visual hierarchy (§136): summary strip (forecast metrics, clearly
 * labeled) → tabs (Leads | Pipeline | Opportunities) → tab content.
 * Sales revenue NEVER mixes into CRM cards (§136/§45).
 *
 * Tab state rides the hash (#/crm?tab=…) through the store (§37): the tab
 * is store-driven so deep links, back/forward and refresh all land on the
 * same tab deterministically.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Handshake, Target, TrendingUp, UserPlus } from "lucide-react";
import { useAppStore, type CrmTab } from "@/store/app-store";
import type { BusinessSummary } from "../shell/types";
import type { Role } from "@/lib/rbac";
import { PageHeader } from "@/components/shared/primitives";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { EntityMetricCard } from "../entities/entity-metric-card";
import { api } from "@/lib/api-client";
import {
  useCrmLeads,
  useCrmOpportunities,
  useCrmSummary,
} from "./crm-api";
import { LeadsTable } from "./leads-table";
import { OpportunitiesTable } from "./opportunities-table";
import { PipelineBoard, type PipelineStageColumn } from "./pipeline-board";
import { fmtCount, fmtMoney } from "../finance-shared/finance-kit";
import { OPPORTUNITY_STAGES } from "@/lib/crm/types";

type Option = { id: string; name: string };

/**
 * Tenant-safe customer option list (id/name only — §80). Loads once per
 * mount via useEffect — render phase stays pure (React hooks law).
 */
function useCustomerOptions(enabled: boolean): Option[] {
  const [customers, setCustomers] = useState<Option[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void api<{ items: { id: string; name: string }[] }>("/api/v1/customers?pageSize=100")
      .then((res) => {
        if (!cancelled) setCustomers(res.items);
      })
      .catch(() => {
        if (!cancelled) setCustomers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return customers;
}

function useLeadOptions(enabled: boolean): Option[] {
  const [leads, setLeads] = useState<Option[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void api<{ items: { id: string; name: string }[] }>("/api/v1/crm/leads?pageSize=100")
      .then((res) => {
        if (!cancelled) setLeads(res.items);
      })
      .catch(() => {
        if (!cancelled) setLeads([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return leads;
}

export function CrmView({
  business,
  role,
  tab,
}: {
  business: BusinessSummary;
  role: Role;
  tab: CrmTab;
}) {
  const t = useTranslations("crm");
  const tSummary = useTranslations("crm.summary");
  const navigate = useAppStore((s) => s.navigate);
  const uiLocale = useAppStore((s) => s.locale);

  const summary = useCrmSummary();
  const customers = useCustomerOptions(true);
  const leads = useLeadOptions(true);

  // Pipeline board data: first 100 opportunities grouped by the closed
  // stage. The server summary remains the authority for headline metrics.
  const board = useCrmOpportunities({ page: 1, pageSize: 100 });

  const columns: PipelineStageColumn[] = OPPORTUNITY_STAGES.map((stage) => {
    const items = (board.data?.items ?? []).filter((o) => o.stage === stage);
    return {
      stage,
      items: items.map((o) => ({
        id: o.id,
        title: o.title,
        stage: o.stage,
        probabilityPct: o.probabilityPct,
        expectedValueMinor: o.expectedValueMinor,
        currencyCode: o.currencyCode,
        expectedCloseDate: o.expectedCloseDate,
        createdAt: o.createdAt,
      })),
      totalValueMinor: items.reduce((acc, o) => acc + o.expectedValueMinor, 0),
    };
  });

  const switchTab = (next: string) => {
    // §37 — closed tab vocabulary; the store owns the hash update.
    navigate({ kind: "crm", tab: next as CrmTab });
  };

  const s = summary.data;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {/* §136 — forecast summary strip. ALL CRM metrics, clearly labeled. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {summary.isPending ? (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)
        ) : s ? (
          <>
            <EntityMetricCard
              label={tSummary("openPipeline")}
              value={fmtMoney(business, s.opportunities.openPipelineValueMinor)}
              icon={TrendingUp}
              hint={tSummary("openOpportunities", { count: s.opportunities.openCount })}
            />
            <EntityMetricCard
              label={tSummary("weightedPipeline")}
              value={fmtMoney(business, s.opportunities.weightedPipelineValueMinor)}
              icon={Handshake}
              hint={tSummary("forecastNote")}
            />
            <EntityMetricCard
              label={tSummary("won")}
              value={fmtCount(uiLocale, s.opportunities.wonCount)}
              icon={Target}
              hint={tSummary("lost", { count: s.opportunities.lostCount })}
            />
            <EntityMetricCard
              label={tSummary("newLeads")}
              value={fmtCount(uiLocale, s.leads.total)}
              icon={UserPlus}
              hint={tSummary("newLeadsHint", { count: s.newLeadsInPeriod })}
            />
          </>
        ) : null}
      </div>

      <Tabs value={tab} onValueChange={switchTab}>
        <TabsList aria-label={t("title")}>
          <TabsTrigger value="leads">{t("tabs.leads")}</TabsTrigger>
          <TabsTrigger value="pipeline">{t("tabs.pipeline")}</TabsTrigger>
          <TabsTrigger value="opportunities">{t("tabs.opportunities")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "leads" ? (
        <LeadsTable business={business} role={role} customers={customers} />
      ) : tab === "pipeline" ? (
        <div className="flex flex-col gap-3">
          <PipelineBoard
            business={business}
            columns={columns}
            onOpen={(id) => navigate({ kind: "entity", entity: "opportunity", id })}
            loading={board.isPending}
          />
          <p className="text-muted-foreground text-xs">{t("pipelineNote")}</p>
        </div>
      ) : (
        <OpportunitiesTable
          business={business}
          role={role}
          customers={customers}
          leads={leads}
        />
      )}
    </div>
  );
}
