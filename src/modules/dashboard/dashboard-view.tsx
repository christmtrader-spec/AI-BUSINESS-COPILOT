"use client";

import {
  AlertTriangle,
  Banknote,
  Bot,
  CheckCircle2,
  ClipboardList,
  Coins,
  Map,
  Plus,
  ReceiptText,
  Settings2,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Trophy,
  Users,
  Wallet,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { useAppStore } from "@/store/app-store";
import { asRole, can, type Role } from "@/lib/rbac";
import { api } from "@/lib/api-client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart";
import { PageHeader } from "@/components/shared/primitives";
import { Skeleton } from "@/components/ui/skeleton";
// R116 — the ONE trend chip shared with the Reports KPI strip: the visual
// language cannot drift between surfaces (one component, one honesty law).
import { TrendChip } from "@/components/shared/trend-chip";
import { OnboardingTour } from "@/modules/shell/onboarding-tour";
import { useSession } from "next-auth/react";
import { fmtCount, fmtMoney } from "../finance-shared/finance-kit";
// R103 — the ONE share law (the tile's % rides the same helper as the
// reports summary card and the copilot chips — never a second math).
import { stockSharePercent } from "@/lib/stock-facts";
import type { BusinessListItem, BusinessSummary } from "../shell/types";

type ReportsSummary = {
  range: { days: number; from: string; to: string };
  kpis: {
    revenueMinor: number;
    salesCount: number;
    collectedMinor: number;
    expensesMinor: number;
    expensesCount: number;
    netCashMinor: number;
  };
  timeline: Array<{ date: string; revenueMinor: number; expenseMinor: number }>;
  inventory: {
    lowStockCount: number;
    lowStockItems: Array<{ id: string; name: string; stockQty: number; unit: string | null }>;
    // R103 — the ADDITIVE fields: older cached responses honestly omit
    // them (the tile's skeleton gates on exactly `valueMinor === undefined`,
    // never on summary absence — the rest of the dashboard keeps working).
    valueMinor?: number;
    productCount?: number;
    topValueProducts?: Array<{
      productId: string;
      name: string;
      estimatedValueMinor: number;
    }>;
  };
  // R115/R116 — the additive previous-window comparison block (server
  // truth: the same-LENGTH window immediately before `range`, L8-honest
  // pcts). OPTIONAL on the view type: older cached summary responses
  // honestly omit it — the trend chips simply never render, never a
  // fabricated comparison.
  trend?: {
    revenuePrevMinor: number;
    expensesPrevMinor: number;
    collectedPrevMinor: number;
    paidOutPrevMinor: number;
    netCashPrevMinor: number;
    revenueChangePct: number | null;
    expensesChangePct: number | null;
    collectedChangePct: number | null;
    netCashChangePct: number | null;
    salesCountPrev: number;
    expensesCountPrev: number;
    previousRange: { from: string; to: string };
  };
};

/**
 * R103 — the At-a-glance quad's throne citation: the CURRENT stock-value
 * leader (rank 1) as a focusable deep-link into the detailed valuation
 * (?inventory=1 — the SAME closed token the copilot chips land). Laws
 * (battery: scripts/r103-tile-unit.ts D5–D11):
 * - gate is `value > 0` on the head AND an honest share basis — an absent/
 *   zero fact renders NEVER (honest silence, never a fabricated leader);
 * - the share rides the ONE helper (stockSharePercent) against the SAME
 *   response's own inventory total;
 * - the tooltip is formatted INSIDE the component (the R99 law) with the
 *   business's EXACT money; the compact % rides UI-locale digits (R94).
 */
function InventoryLeaderCitation({
  summary,
  membership,
}: {
  summary: ReportsSummary;
  membership: BusinessListItem;
}) {
  const t = useTranslations("dashboard");
  const uiLocale = useLocale();
  const navigate = useAppStore((s) => s.navigate);
  const head = summary.inventory.topValueProducts?.[0];
  if (!head || !(head.estimatedValueMinor > 0)) return null;
  const share = stockSharePercent(
    head.estimatedValueMinor,
    summary.inventory.valueMinor!,
  );
  if (share === null) return null;
  const tooltip = t("statInventoryLeaderTooltip", {
    name: head.name,
    money: fmtMoney(membership.business, head.estimatedValueMinor),
  });
  return (
    <button
      type="button"
      data-testid="leader-inventory"
      title={tooltip}
      aria-label={tooltip}
      onClick={() => navigate({ kind: "module", module: "reports", param: "inventory" })}
      className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 mt-1 flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-start text-[11px] text-sky-700 transition-colors hover:bg-sky-600/10 dark:text-sky-400"
    >
      <Trophy className="size-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate" dir="auto">
        {head.name}
      </span>
      <span
        className="ms-auto inline-flex min-w-0 items-center gap-1"
        aria-hidden="true"
      >
        <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-sky-600/15">
          <span
            className="h-1 rounded-full bg-sky-500/60"
            style={{ width: `${share}%` }}
          />
        </span>
      </span>
      <span className="shrink-0 tabular-nums">
        {t("statLeaderShareShort", { percent: fmtCount(uiLocale, share) })}
      </span>
    </button>
  );
}

function MiniMoneyTooltip({
  active,
  payload,
  label,
  fmt,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string; dataKey?: string | number }>;
  label?: string | number;
  fmt: (v: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="bg-popover text-popover-foreground rounded-lg border px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium tabular-nums" dir="ltr">{String(label ?? "")}</p>
      {payload.map((entry) => (
        <p key={String(entry.dataKey)} className="flex items-center gap-1.5 tabular-nums">
          <span
            className="size-2 shrink-0 rounded-[2px]"
            style={{ background: entry.color }}
            aria-hidden="true"
          />
          {entry.name}: <span dir="ltr">{fmt(entry.value ?? 0)}</span>
        </p>
      ))}
    </div>
  );
}

export function DashboardView({ membership }: { membership: BusinessListItem }) {
  const t = useTranslations("dashboard");
  const tSettings = useTranslations("settings");
  const tCommon = useTranslations("common");
  const uiLocale = useLocale();
  const navigate = useAppStore((s) => s.navigate);
  const fireQuickIntent = useAppStore((s) => s.fireQuickIntent);
  const { data: session } = useSession();

  const business: BusinessSummary = membership.business;
  const fmt = (minor: number) => fmtMoney(business, minor);

  // Real, derived numbers from transaction modules (no placeholder figures).
  const { data: recv } = useQuery({
    queryKey: ["receivables", "dashboard"],
    queryFn: () => api<{ totalOutstandingMinor: number; openCount: number }>("/api/v1/receivables"),
    staleTime: 30_000,
  });
  const { data: pay } = useQuery({
    queryKey: ["payables", "dashboard"],
    queryFn: () => api<{ totalOutstandingMinor: number; openCount: number }>("/api/v1/payables"),
    staleTime: 30_000,
  });
  const { data: payStats } = useQuery({
    queryKey: ["payments", "dashboard"],
    queryFn: () => api<{ total: number }>("/api/v1/payments?page=1&pageSize=1"),
    staleTime: 30_000,
  });
  // Phase 04 — 30-day performance + inventory health (shared cache with Reports).
  const { data: summary } = useQuery<ReportsSummary>({
    queryKey: ["reports", "summary", "30"],
    queryFn: () => api("/api/v1/reports/summary?days=30"),
    staleTime: 30_000,
  });
  // Getting-started: has the user recorded at least one sale (ever)?
  const { data: salesProbe } = useQuery({
    queryKey: ["sales", "probe"],
    queryFn: () => api<{ total: number }>("/api/v1/sales?page=1&pageSize=1"),
    staleTime: 30_000,
  });

  const role: Role = asRole(membership.role);
  const firstSaleDone = (salesProbe?.total ?? 0) > 0;

  const steps = [
    { done: true, icon: CheckCircle2, label: t("stepBusinessDone"), action: null as null | { label: string; view: Parameters<typeof navigate>[0] } },
    { done: false, icon: Settings2, label: t("stepSettings"), action: { label: t("openSettings"), view: { kind: "settings:business" } as const } },
    { done: false, icon: Users, label: t("stepInvite"), action: can(role, "members:manage") ? { label: t("openMembers"), view: { kind: "settings:members" } as const } : null },
    { done: firstSaleDone, icon: ClipboardList, label: t("stepSales"), action: { label: t("openSales"), view: { kind: "module", module: "sales" } as const } },
  ];

  const perfConfig = {
    revenueMinor: { label: t("perfRevenue"), color: "var(--chart-1)" },
    expenseMinor: { label: t("perfExpenses"), color: "var(--chart-3)" },
  } satisfies ChartConfig;

  const lowStock = summary?.inventory.lowStockItems ?? [];

  return (
    <div className="space-y-6" data-view="dashboard">
      {/* Prompt 52 §F7 — first-visit tour (once per browser, desktop only,
          skippable everywhere; render-gated to data-writers so the anchors
          it points at actually exist for this user). */}
      {can(role, "data:write") ? <OnboardingTour enabled={true} /> : null}
      <PageHeader
        title={`${t("welcomeBack")}${session?.user?.name ? `, ${session.user.name.split(" ")[0]}` : ""}`}
        titleClassName="gradient-shimmer"
        subtitle={t("subtitle")}
        actions={
          <Badge variant="outline" className="gap-1.5 px-3 py-1.5">
            <ShieldCheck className="size-3.5 text-emerald-600" aria-hidden="true" />
            {tSettings(`roles.${role}` as "OWNER")}
          </Badge>
        }
      />

      {/* Low-stock alert (only when it exists — no fake urgency) */}
      {lowStock.length > 0 ? (
        <div
          className="flex flex-col gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 sm:flex-row sm:items-center sm:justify-between"
          role="alert"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                {t("lowStockAlertTitle", { count: summary?.inventory.lowStockCount ?? 0 })}
              </p>
              <p className="text-muted-foreground text-xs" dir="auto">
                {t("lowStockAlertDesc", {
                  items: lowStock
                    .slice(0, 3)
                    .map((i) => i.name)
                    .join("، "),
                })}
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 border-amber-500/40 text-amber-800 hover:bg-amber-500/10 dark:text-amber-300"
            onClick={() => navigate({ kind: "module", module: "products" })}
          >
            {t("lowStockAlertAction")}
          </Button>
        </div>
      ) : null}

      {/* Prompt 52 §F2 — quick actions: one-click paths to the money flows.
          Each fires a cross-view intent so the target module opens its
          create dialog immediately (role-gated to keep the row honest). */}
      {can(role, "data:write") ? (
        <div
          className="grid grid-cols-1 gap-2 sm:grid-cols-3"
          role="toolbar"
          aria-label={t("quickActions")}
          data-tour="quick-actions"
        >
          <Button
            className="h-11 justify-start gap-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-sm hover:from-emerald-700 hover:to-teal-700 dark:from-emerald-500 dark:to-teal-500 dark:hover:from-emerald-600 dark:hover:to-teal-600"
            onClick={() => {
              fireQuickIntent("new-sale");
              navigate({ kind: "module", module: "sales" });
            }}
          >
            <span aria-hidden="true" className="bg-white/15 grid size-6 place-items-center rounded-md">
              <ReceiptText className="size-4" />
            </span>
            {t("quickNewInvoice")}
            <Plus className="ms-auto size-4 opacity-80" aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            className="h-11 justify-start gap-2.5 border-emerald-600/30 hover:bg-emerald-600/5"
            onClick={() => {
              fireQuickIntent("new-payment");
              navigate({ kind: "module", module: "payments" });
            }}
          >
            <span aria-hidden="true" className="bg-emerald-600/10 text-emerald-600 grid size-6 place-items-center rounded-md">
              <Banknote className="size-4" />
            </span>
            {t("quickRecordPayment")}
            <Plus className="ms-auto size-4 opacity-60" aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            className="h-11 justify-start gap-2.5 border-rose-600/30 hover:bg-rose-600/5"
            onClick={() => {
              fireQuickIntent("new-expense");
              navigate({ kind: "module", module: "expenses" });
            }}
          >
            <span aria-hidden="true" className="bg-rose-600/10 text-rose-600 grid size-6 place-items-center rounded-md">
              <Wallet className="size-4" />
            </span>
            {t("quickNewExpense")}
            <Plus className="ms-auto size-4 opacity-60" aria-hidden="true" />
          </Button>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Getting started */}
        <Card className="transition-shadow duration-200 hover:shadow-md lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Map className="text-primary size-4" aria-hidden="true" />
              {t("gettingStarted")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-3">
              {steps.map((step, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span
                    className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full ${
                      step.done ? "bg-emerald-600/10 text-emerald-600" : "bg-muted text-muted-foreground"
                    }`}
                    aria-hidden="true"
                  >
                    <step.icon className="size-3.5" />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
                    <span className={`text-sm ${step.done ? "text-muted-foreground line-through" : ""}`}>
                      {step.label}
                    </span>
                    {step.action ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 shrink-0"
                        onClick={() => navigate(step.action!.view)}
                      >
                        {step.action.label}
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>

        {/* Copilot — live in Phase 05 */}
        <Card className="from-primary/5 border-primary/20 bg-gradient-to-br to-transparent transition-shadow duration-200 hover:shadow-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="text-primary size-4" aria-hidden="true" />
              {/* Gradient only on the words — the icon must keep its own color */}
              <span className="gradient-warm">{t("copilotTeaser")}</span>
            </CardTitle>
            <CardDescription>{t("copilotTeaserDesc")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="secondary"
              size="sm"
              className="w-full"
              disabled={!can(role, "copilot:use")}
              onClick={() => navigate({ kind: "module", module: "copilot" })}
            >
              <Sparkles className="size-4" aria-hidden="true" />
              {can(role, "copilot:use") ? t("copilotTeaserAction") : tCommon("comingSoon")}
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Phase 04 — 30-day performance (real data, deterministic) */}
      {summary && (summary.kpis.salesCount > 0 || summary.kpis.expensesCount > 0) ? (
        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2 text-base">
                <TrendingUp className="text-primary size-4" aria-hidden="true" />
                {t("perfTitle")}
              </CardTitle>
              <CardDescription>{t("perfSubtitle")}</CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => navigate({ kind: "module", module: "reports" })}
            >
              {t("perfOpenReports")}
            </Button>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 lg:grid-cols-5">
              <div className="lg:col-span-3" dir="ltr">
                <ChartContainer config={perfConfig} className="h-44 w-full">
                  <AreaChart data={summary.timeline} margin={{ left: 4, right: 8, top: 8 }}>
                    <defs>
                      <linearGradient id="dashRev" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--color-revenueMinor)" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="var(--color-revenueMinor)" stopOpacity={0.02} />
                      </linearGradient>
                      <linearGradient id="dashExp" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="var(--color-expenseMinor)" stopOpacity={0.22} />
                        <stop offset="95%" stopColor="var(--color-expenseMinor)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" />
                    <XAxis
                      dataKey="date"
                      tickLine={false}
                      axisLine={false}
                      tickMargin={6}
                      minTickGap={40}
                      tickFormatter={(v: string) => v.slice(5)}
                    />
                    <YAxis
                      width={60}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v: number) => fmt(v)}
                    />
                    <ChartTooltip
                      cursor={{ stroke: "var(--border)" }}
                      content={<MiniMoneyTooltip fmt={fmt} />}
                    />
                    <Area
                      dataKey="expenseMinor"
                      type="monotone"
                      stroke="var(--color-expenseMinor)"
                      strokeWidth={1.5}
                      fill="url(#dashExp)"
                      name={perfConfig.expenseMinor.label}
                    />
                    <Area
                      dataKey="revenueMinor"
                      type="monotone"
                      stroke="var(--color-revenueMinor)"
                      strokeWidth={1.5}
                      fill="url(#dashRev)"
                      name={perfConfig.revenueMinor.label}
                    />
                  </AreaChart>
                </ChartContainer>
              </div>
              <div className="grid grid-cols-2 gap-3 lg:col-span-2 lg:grid-cols-2">
                {[
                  {
                    label: t("perfRevenue"),
                    value: summary.kpis.revenueMinor,
                    cls: "gradient-pos",
                    // R115 — the chip rides the server's RAW prev total + L8
                    // pct; riseIsGood follows the METRIC's meaning (more
                    // revenue is good, more expenses is NOT).
                    trend: summary.trend
                      ? {
                          pct: summary.trend.revenueChangePct,
                          prev: summary.trend.revenuePrevMinor,
                          cur: summary.kpis.revenueMinor,
                          riseIsGood: true,
                          previousRange: summary.trend.previousRange,
                        }
                      : null,
                  },
                  {
                    label: t("perfCollected"),
                    value: summary.kpis.collectedMinor,
                    cls: "gradient-pos",
                    trend: summary.trend
                      ? {
                          pct: summary.trend.collectedChangePct,
                          prev: summary.trend.collectedPrevMinor,
                          cur: summary.kpis.collectedMinor,
                          riseIsGood: true,
                          previousRange: summary.trend.previousRange,
                        }
                      : null,
                  },
                  {
                    label: t("perfExpenses"),
                    value: summary.kpis.expensesMinor,
                    cls: "gradient-neg",
                    trend: summary.trend
                      ? {
                          pct: summary.trend.expensesChangePct,
                          prev: summary.trend.expensesPrevMinor,
                          cur: summary.kpis.expensesMinor,
                          riseIsGood: false,
                          previousRange: summary.trend.previousRange,
                        }
                      : null,
                  },
                  {
                    label: t("perfNetCash"),
                    value: summary.kpis.netCashMinor,
                    cls:
                      summary.kpis.netCashMinor >= 0
                        ? "gradient-pos"
                        : "gradient-neg",
                    trend: summary.trend
                      ? {
                          pct: summary.trend.netCashChangePct,
                          prev: summary.trend.netCashPrevMinor,
                          cur: summary.kpis.netCashMinor,
                          riseIsGood: true,
                          previousRange: summary.trend.previousRange,
                        }
                      : null,
                  },
                ].map((stat) => (
                  <div key={stat.label} className="rounded-lg border p-3">
                    <p className="text-muted-foreground text-xs font-medium uppercase">{stat.label}</p>
                    <div className="mt-1 flex min-w-0 items-center gap-1.5">
                      <p className={`min-w-0 truncate text-base font-semibold tabular-nums ${stat.cls}`} dir="ltr">
                        {fmt(stat.value)}
                      </p>
                      {stat.trend ? (
                        <TrendChip
                          pct={stat.trend.pct}
                          prev={stat.trend.prev}
                          cur={stat.trend.cur}
                          riseIsGood={stat.trend.riseIsGood}
                          previousRange={stat.trend.previousRange}
                        />
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <p className="text-muted-foreground mt-3 flex items-center gap-1.5 text-xs">
              <Coins className="size-3.5" aria-hidden="true" />
              {t("metricsNote")}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* At a glance — real derived figures (Rule 05: no fake numbers) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("atAGlance")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border p-3">
                <p className="text-muted-foreground text-xs font-medium uppercase">{t("statReceivable")}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-amber-700 dark:text-amber-400" dir="ltr">
                  {fmtMoney(membership.business, recv?.totalOutstandingMinor ?? 0)}
                </p>
                <p className="text-muted-foreground text-xs">{t("statReceivableHint", { count: fmtCount(uiLocale, recv?.openCount ?? 0) })}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-muted-foreground text-xs font-medium uppercase">{t("statPayable")}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-rose-700 dark:text-rose-400" dir="ltr">
                  {fmtMoney(membership.business, pay?.totalOutstandingMinor ?? 0)}
                </p>
                <p className="text-muted-foreground text-xs">{t("statPayableHint", { count: fmtCount(uiLocale, pay?.openCount ?? 0) })}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-muted-foreground text-xs font-medium uppercase">{t("statPayments")}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-emerald-700 dark:text-emerald-400" dir="ltr">
                  {payStats?.total ?? 0}
                </p>
                <p className="text-muted-foreground text-xs">{t("statPaymentsHint")}</p>
              </div>
              {/* R103 — the inventory tile: the sky cell of the balanced quad.
                  The money skeleton gates on the ADDITIVE field (older cached
                  summaries stay honest — D3/D4); zero stock is a REAL fact and
                  renders the honest zero (no >0 gate on the money). */}
              <div className="rounded-lg border border-sky-600/25 bg-sky-600/[0.03] p-3" data-testid="stat-inventory-tile">
                <p className="text-muted-foreground text-xs font-medium uppercase">{t("statInventory")}</p>
                {summary === undefined || summary.inventory.valueMinor === undefined ? (
                  <Skeleton className="mt-2 h-7 w-24 rounded-md bg-sky-500/60" aria-hidden="true" />
                ) : (
                  <p className="mt-1 text-lg font-semibold tabular-nums text-sky-700 dark:text-sky-400" dir="ltr">
                    {fmtMoney(membership.business, summary.inventory.valueMinor)}
                  </p>
                )}
                {summary ? (
                  <p className="text-muted-foreground text-xs">
                    {t("statInventoryHint", { count: fmtCount(uiLocale, summary.inventory.productCount ?? 0) })}
                  </p>
                ) : null}
                {summary ? (
                  <InventoryLeaderCitation summary={summary} membership={membership} />
                ) : null}
              </div>
            </div>
            <p className="text-muted-foreground mt-3 text-xs">{t("metricsNote")}</p>
          </CardContent>
        </Card>

        {/* Roadmap */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("roadmap")}</CardTitle>
            <CardDescription>
              {t("phaseNotice")} — {t("phaseNoticeDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {(["p1", "p2", "p3", "p4", "p5", "p6"] as const).map((k) => (
                <li
                  key={k}
                  className={`rounded-md border px-3 py-2 ${
                    k === "p6"
                      ? "border-primary/30 bg-primary/5 font-medium"
                      : "text-muted-foreground border-emerald-500/20 bg-emerald-500/5"
                  }`}
                >
                  {t(`roadmapItems.${k}`)}
                  {k !== "p6" ? (
                    <CheckCircle2 className="ms-1.5 inline size-3.5 text-emerald-600" aria-hidden="true" />
                  ) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
