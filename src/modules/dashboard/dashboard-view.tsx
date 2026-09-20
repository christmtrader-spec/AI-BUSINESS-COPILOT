"use client";

import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ClipboardList,
  Coins,
  Map,
  Settings2,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
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
import { useSession } from "next-auth/react";
import { fmtCount, fmtMoney } from "../finance-shared/finance-kit";
import type { BusinessListItem, BusinessSummary } from "../shell/types";

type ReportsSummary = {
  range: { days: number; from: string; to: string };
  kpis: {
    revenueMinor: number;
    salesCount: number;
    collectedMinor: number;
    expensesMinor: number;
    netCashMinor: number;
  };
  timeline: Array<{ date: string; revenueMinor: number; expenseMinor: number }>;
  inventory: {
    lowStockCount: number;
    lowStockItems: Array<{ id: string; name: string; stockQty: number; unit: string | null }>;
  };
};

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
      <PageHeader
        title={`${t("welcomeBack")}${session?.user?.name ? `, ${session.user.name.split(" ")[0]}` : ""}`}
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

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Getting started */}
        <Card className="lg:col-span-2">
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
        <Card className="from-primary/5 border-primary/20 bg-gradient-to-br to-transparent">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bot className="text-primary size-4" aria-hidden="true" />
              {t("copilotTeaser")}
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
                  { label: t("perfRevenue"), value: summary.kpis.revenueMinor, cls: "text-emerald-700 dark:text-emerald-400" },
                  { label: t("perfCollected"), value: summary.kpis.collectedMinor, cls: "text-teal-700 dark:text-teal-300" },
                  { label: t("perfExpenses"), value: summary.kpis.expensesMinor, cls: "text-rose-700 dark:text-rose-400" },
                  {
                    label: t("perfNetCash"),
                    value: summary.kpis.netCashMinor,
                    cls:
                      summary.kpis.netCashMinor >= 0
                        ? "text-emerald-700 dark:text-emerald-400"
                        : "text-rose-700 dark:text-rose-400",
                  },
                ].map((stat) => (
                  <div key={stat.label} className="rounded-lg border p-3">
                    <p className="text-muted-foreground text-xs font-medium uppercase">{stat.label}</p>
                    <p className={`mt-1 truncate text-base font-semibold tabular-nums ${stat.cls}`} dir="ltr">
                      {fmt(stat.value)}
                    </p>
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
            <div className="grid gap-3 sm:grid-cols-3">
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
