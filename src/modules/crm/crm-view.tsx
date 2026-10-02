"use client";

/**
 * Prompt 35/36 — CRM module view (§36/§37/§43/§87).
 *
 * Visual hierarchy: forecast summary strip (pipeline values ONLY) →
 * WORK QUEUE summary (task COUNTS, visually separate — §87/§88/§89) →
 * tabs (Leads | Pipeline | Opportunities | Tasks) → tab content.
 * Sales revenue NEVER mixes into CRM cards; task counts never mix into
 * financial metric cards (§87).
 *
 * Tab state rides the hash (#/crm?tab=…) through the store (§37); bare
 * #/crm and unknown tabs land on the default (pipeline).
 */

import { useTranslations } from "next-intl";
import { AlarmClock, BellRing, CalendarClock, Handshake, ListTodo, Target, TrendingUp, UserPlus } from "lucide-react";
import { useAppStore, type CrmTab } from "@/store/app-store";
import type { BusinessSummary } from "../shell/types";
import type { Role } from "@/lib/rbac";
import { PageHeader } from "@/components/shared/primitives";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EntityMetricCard } from "../entities/entity-metric-card";
import {
  useCrmLeads,
  useCrmOpportunities,
  useCrmReminderSummary,
  useCrmSummary,
  useCrmWorkQueue,
} from "./crm-api";
import { useCustomerOptions, useLeadOptions } from "./crm-context-options";
import { LeadsTable } from "./leads-table";
import { OpportunitiesTable } from "./opportunities-table";
import { TasksView } from "./tasks-view";
import { PipelineBoard, type PipelineStageColumn } from "./pipeline-board";
import { fmtCount, fmtMoney } from "../finance-shared/finance-kit";
import { OPPORTUNITY_STAGES } from "@/lib/crm/types";

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
  const tQueue = useTranslations("crm.tasks.queue");
  const tRem = useTranslations("crm.taskReminder");
  const navigate = useAppStore((s) => s.navigate);
  const uiLocale = useAppStore((s) => s.locale);

  const summary = useCrmSummary();
  const customers = useCustomerOptions();
  const leads = useLeadOptions();

  // §88 — server-computed work-queue counts (viewer scope). One bounded
  // request shared by every tab; counts are NEVER merged into money cards.
  const queue = useCrmWorkQueue();
  // Prompt 37 (§63/§64) — reminder CONFIGURATION counts (not notification
  // counts); server-computed, business-scoped, optional UI only.
  const reminderSummary = useCrmReminderSummary();

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
  const q = queue.data;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {/* §136 — forecast summary strip. Financial/forecast metrics only. */}
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

      {/* §87/§88 — separate WORK QUEUE section: task counts, no money. */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ListTodo className="size-4" aria-hidden="true" />
            {tQueue("title")}
          </CardTitle>
          <button
            type="button"
            onClick={() => navigate({ kind: "crm", tab: "tasks" })}
            className="text-primary text-sm underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {tQueue("openQueue")}
          </button>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-3">
          {queue.isPending ? (
            [0, 1, 2].map((i) => <Skeleton key={i} className="h-16 rounded-xl" />)
          ) : q ? (
            <>
              <QueueCount
                label={tQueue("myOpenTasks")}
                count={q.counts.myOpenTaskCount}
                uiLocale={uiLocale}
                icon={ListTodo}
              />
              <QueueCount
                label={tQueue("myOverdueTasks")}
                count={q.counts.myOverdueTaskCount}
                uiLocale={uiLocale}
                icon={AlarmClock}
                alert={q.counts.myOverdueTaskCount > 0}
              />
              <QueueCount
                label={tQueue("myDueToday")}
                count={q.counts.myDueTodayCount}
                uiLocale={uiLocale}
                icon={CalendarClock}
              />
            </>
          ) : null}
        </CardContent>
        {/* Prompt 37 (§63) — optional "Upcoming reminders" line: tasks with
            reminder windows opening in the next 24h. Server-computed;
            never a notification count. */}
        {reminderSummary.data ? (
          <CardContent className="border-t pt-3">
            <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <BellRing className="size-3.5" aria-hidden="true" />
              {tRem("upcoming24h")}
              <span className="text-foreground font-medium">{reminderSummary.data.dueSoonNext24hCount}</span>
              <span className="sr-only">{tRem("upcoming24h")}</span>
            </p>
          </CardContent>
        ) : null}
      </Card>

      <Tabs value={tab} onValueChange={switchTab}>
        <TabsList aria-label={t("title")}>
          <TabsTrigger value="leads">{t("tabs.leads")}</TabsTrigger>
          <TabsTrigger value="pipeline">{t("tabs.pipeline")}</TabsTrigger>
          <TabsTrigger value="opportunities">{t("tabs.opportunities")}</TabsTrigger>
          <TabsTrigger value="tasks">{t("tabs.tasks")}</TabsTrigger>
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
      ) : tab === "tasks" ? (
        <TasksView business={business} role={role} />
      ) : (
        <OpportunitiesTable business={business} role={role} customers={customers} leads={leads} />
      )}
    </div>
  );
}

/** §89 — task-count chip, visually distinct from money metric cards. */
function QueueCount({
  label,
  count,
  uiLocale,
  icon: Icon,
  alert = false,
}: {
  label: string;
  count: number;
  uiLocale: string;
  icon: typeof ListTodo;
  alert?: boolean;
}) {
  return (
    <div className="bg-muted/30 flex min-h-16 flex-col justify-center gap-1 rounded-xl border p-3">
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
        <Icon className="size-3.5" aria-hidden="true" />
        {label}
      </p>
      <p
        className={
          alert
            ? "text-destructive flex items-baseline gap-1.5 text-xl font-semibold"
            : "flex items-baseline gap-1.5 text-xl font-semibold"
        }
      >
        {fmtCount(uiLocale, count)}
        {alert ? <AlarmClock className="size-4" aria-hidden="true" /> : null}
      </p>
    </div>
  );
}
