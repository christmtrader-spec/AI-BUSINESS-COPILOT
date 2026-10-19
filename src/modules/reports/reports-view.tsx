"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Boxes,
  CalendarDays,
  ChartPie,
  ChevronRight,
  Coins,
  Download,
  HandCoins,
  Layers,
  Loader2,
  Lock,
  Minus,
  Package,
  ReceiptText,
  TrendingUp,
} from "lucide-react";
import { api, ApiClientError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app-store";
import { toast } from "@/hooks/use-toast";
import { useBillingErrorText } from "@/hooks/use-billing-error-text";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable, Ltr } from "@/components/shared/data-table";
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart";
import { EmptyState, PageHeader } from "@/components/shared/primitives";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fmtCount, fmtMoney } from "../finance-shared/finance-kit";
import { InventoryValuationPanel } from "./inventory-valuation-panel";
import { PerformancePanel } from "./performance-panel";
import type { BusinessSummary } from "../shell/types";

/**
 * Phase 04 — Reports. Every figure is fetched from
 * /api/v1/reports/summary, which computes deterministic aggregates from
 * the recorded transactions (Rule 05: the UI never invents numbers).
 */

type Summary = {
  range: { days: number; from: string; to: string; timezone: string };
  kpis: {
    revenueMinor: number;
    salesCount: number;
    avgSaleMinor: number;
    collectedMinor: number;
    expensesMinor: number;
    expensesCount: number;
    paidOutMinor: number;
    netCashMinor: number;
    netAccrualMinor: number;
  };
  timeline: Array<{
    date: string;
    revenueMinor: number;
    expenseMinor: number;
    collectedMinor: number;
    paidOutMinor: number;
  }>;
  // Prompt 50 additive: stable product identity + line-count metadata
  // (name/qty/revenueMinor preserved verbatim for backward compatibility).
  topProducts: Array<{
    name: string;
    qty: number;
    revenueMinor: number;
    productId: string | null;
    kind: "catalog" | "unlinked";
    unit: string | null;
    sku: string | null;
    invoiceCount: number;
  }>;
  expensesByCategory: Array<{ category: string; totalMinor: number }>;
  // Prompt 50 additive — server-computed "Other" bucket: SUM(top slice +
  // Other) === expensesMinor exactly, so displayed shares have an honest
  // denominator (Gate G).
  expensesByCategoryOther: { category: string; totalMinor: number };
  expensesByCategoryTotalMinor: number;
  expensesCategoryCount: number;
  outstanding: {
    receivableMinor: number;
    receivableCount: number;
    payableMinor: number;
    payableCount: number;
  };
  inventory: {
    valueMinor: number;
    productCount: number;
    lowStockCount: number;
    lowStockItems: Array<{
      id: string;
      name: string;
      unit: string | null;
      stockQty: number;
      lowStockAt: number;
    }>;
  };
  // Prompt 20 — ADVANCED_REPORTS entitlement: the server OMITS `advanced`
  // when the plan is not entitled; `advancedAvailable` is always present.
  advancedAvailable: boolean;
  advanced?: AdvancedInsights;
};

/** Mirrors src/lib/reports-advanced.ts (server-computed, deterministic). */
type AdvancedInsights = {
  previousRange: { from: string; to: string };
  growth: {
    revenueMinor: number;
    revenuePrevMinor: number;
    revenueChangePct: number | null;
    salesCount: number;
    salesCountPrev: number;
    salesChangePct: number | null;
    expensesMinor: number;
    expensesPrevMinor: number;
    expensesChangePct: number | null;
  };
  concentration: {
    topCustomers: Array<{
      customerId: string;
      name: string;
      revenueMinor: number;
      sharePct: number;
    }>;
    top5SharePct: number;
    customerCount: number;
    unassignedRevenueMinor: number;
    totalRevenueMinor: number;
  };
};

const RANGES = ["7", "30", "90"] as const;

// ---- Month-over-month --------------------------------------------------------

type MonthlyRow = {
  month: string; // YYYY-MM
  revenueMinor: number;
  salesCount: number;
  expensesMinor: number;
  expensesCount: number;
  collectedMinor: number;
  paidOutMinor: number;
  netCashMinor: number;
  netAccrualMinor: number;
};

type MonthlyData = { months: number; series: MonthlyRow[] };

/** Single-month drill-down (GET /api/v1/reports/monthly/[month]). */
type MonthDetail = {
  month: string;
  timezone: string;
  totals: {
    revenueMinor: number;
    salesCount: number;
    expensesMinor: number;
    expensesCount: number;
    collectedMinor: number;
    paidOutMinor: number;
    netCashMinor: number;
    netAccrualMinor: number;
  };
  sales: Array<{
    number: number;
    issueDate: string;
    customerName: string | null;
    totalMinor: number;
    paidMinor: number;
    balanceMinor: number;
    status: string;
  }>;
  expenses: Array<{
    category: string;
    spentAt: string;
    supplierName: string | null;
    amountMinor: number;
    paidMinor: number;
    balanceMinor: number;
    status: string;
  }>;
  // Prompt 50 (§10) — truthful preview metadata: the row lists are a
  // bounded, DISCLOSED preview of the complete month.
  preview: {
    sales: { totalCount: number; displayedCount: number; hasMore: boolean };
    expenses: { totalCount: number; displayedCount: number; hasMore: boolean };
  };
};

/** Percent change between two minor-unit totals; null when undefined (÷0). */
function pctChange(cur: number, prev: number): number | null {
  if (prev === 0) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

/** Category slice palette (brand hues, no blue). */
const CATEGORY_COLORS = [
  "var(--chart-1)",
  "var(--chart-4)",
  "var(--chart-3)",
  "var(--chart-2)",
  "var(--chart-5)",
  "color-mix(in oklch, var(--chart-1) 55%, var(--muted))",
];

type TooltipEntry = { name?: string; value?: number; color?: string; dataKey?: string | number };

function MoneyTooltip({
  active,
  payload,
  label,
  fmt,
  labelFmt,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
  fmt: (v: number) => string;
  labelFmt?: (v: string) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const labelText =
    labelFmt && typeof label === "string" ? labelFmt(label) : label != null ? String(label) : "";
  return (
    <div className="bg-popover text-popover-foreground rounded-lg border px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium" dir="auto">{labelText}</p>
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

export function ReportsView({ business }: { business: BusinessSummary }) {
  const t = useTranslations("reports");
  const tErrors = useTranslations("errors");
  const billingErrorText = useBillingErrorText();
  const uiLocale = useLocale();
  const navigate = useAppStore((s) => s.navigate);
  const view = useAppStore((s) => s.view);
  const activeId = useAppStore((s) => s.activeBusinessId);
  const [days, setDays] = useState<string>("30");

  // Month drill-down state lives in the URL (store view param) — deep-linkable
  // via #/reports?month=YYYY-MM and sync'd with browser back/forward. The
  // dialog is a DERIVED view of the store: row clicks navigate({param}),
  // close navigates back to the bare module; hashchange (Back/Forward,
  // external deep links) flows through app-root's replaceView into here.
  // Prompt 51: the param can also be "inventory" (the detailed valuation
  // sub-view, #/reports?inventory=1) — the two sub-views are mutually
  // exclusive and only month-SHAPED params open the month dialog.
  const isInvDetail =
    view.kind === "module" && view.module === "reports" && view.param === "inventory";
  const detailMonth =
    view.kind === "module" && view.module === "reports" && view.param && /^\d{4}-\d{2}$/.test(view.param)
      ? view.param
      : null;
  const openMonth = (month: string) =>
    navigate({ kind: "module", module: "reports", param: month }, { replace: true });
  const closeMonth = () =>
    navigate({ kind: "module", module: "reports" }, { replace: true });

  const fmt = (minor: number) => fmtMoney(business, minor);

  const { data, isLoading, error, refetch } = useQuery<Summary>({
    queryKey: ["reports", "summary", days],
    queryFn: () => api(`/api/v1/reports/summary?days=${days}`),
    staleTime: 30_000,
  });

  // Month-over-month series (deterministic server buckets, oldest → newest).
  const { data: monthly } = useQuery<MonthlyData>({
    queryKey: ["reports", "monthly", 6],
    queryFn: () => api("/api/v1/reports/monthly?months=6"),
    staleTime: 60_000,
  });

  // MoM drill-down — clicking a month row navigates to that month's detail
  // (URL becomes #/reports?month=YYYY-MM, shareable + back/forward safe).
  const { data: monthDetail, isLoading: detailLoading } = useQuery<MonthDetail>({
    queryKey: ["reports", "monthDetail", detailMonth],
    queryFn: () => api(`/api/v1/reports/monthly/${detailMonth}`),
    enabled: detailMonth !== null,
    staleTime: 60_000,
  });

  // CSV export — server-generated from the SAME aggregates (single source
  // of truth); the client only streams the blob to a file.
  const csvExport = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v1/reports/export?days=${days}`, {
        credentials: "same-origin",
        headers: activeId ? { "x-business-id": activeId } : undefined,
      });
      if (!res.ok) {
        let message = t("csvFailed");
        try {
          const body = (await res.json()) as { error?: { code?: string; message?: string } };
          if (body.error?.code === "RATE_LIMITED") message = t("csvRateLimited");
          else if (body.error?.message) message = body.error.message;
        } catch {
          // keep default
        }
        throw new Error(message);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const dispo = res.headers.get("content-disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(dispo);
      a.download = match?.[1] ?? `report-${days}d.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => toast({ title: t("csvExportedToast") }),
    onError: (err) =>
      toast({
        title: billingErrorText(err) || (err instanceof Error ? err.message : tErrors("generic")),
        variant: "destructive",
      }),
  });

  // Per-month CSV export (month dialog) — same server builder as the dialog.
  const monthCsvExport = useMutation({
    mutationFn: async (month: string) => {
      const res = await fetch(`/api/v1/reports/monthly/${month}/export`, {
        credentials: "same-origin",
        headers: activeId ? { "x-business-id": activeId } : undefined,
      });
      if (!res.ok) {
        let message = t("csvFailed");
        try {
          const body = (await res.json()) as { error?: { code?: string; message?: string } };
          if (body.error?.code === "RATE_LIMITED") message = t("csvRateLimited");
          else if (body.error?.message) message = body.error.message;
        } catch {
          // keep default
        }
        throw new Error(message);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const dispo = res.headers.get("content-disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(dispo);
      a.download = match?.[1] ?? `report-${month}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => toast({ title: t("csvExportedToast") }),
    onError: (err) =>
      toast({
        title: billingErrorText(err) || (err instanceof Error ? err.message : tErrors("generic")),
        variant: "destructive",
      }),
  });

  const fmtDay = (key: string) => {
    // YYYY-MM-DD -> localized medium date for tooltips (UI locale, not
    // business locale — these are interface labels, not financial data).
    const d = new Date(`${key}T00:00:00Z`);
    return new Intl.DateTimeFormat(uiLocale === "fa" ? "fa-IR" : "en-US", {
      dateStyle: "medium",
      timeZone: "UTC",
    }).format(d);
  };

  const fmtMonth = (key: string) => {
    // YYYY-MM -> localized short month label ("Sep 2026" / "شهریور ۱۴۰۵").
    const d = new Date(`${key}-01T00:00:00Z`);
    return new Intl.DateTimeFormat(uiLocale === "fa" ? "fa-IR" : "en-US", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(d);
  };

  const fmtIsoDate = (iso: string) => {
    // ISO instant -> localized medium date for drill-down lists.
    try {
      return new Intl.DateTimeFormat(uiLocale === "fa" ? "fa-IR" : "en-US", {
        dateStyle: "medium",
        timeZone: business.timezone || "UTC",
      }).format(new Date(iso));
    } catch {
      return iso.slice(0, 10);
    }
  };

  const timelineConfig = {
    revenueMinor: { label: t("legendRevenue"), color: "var(--chart-1)" },
    expenseMinor: { label: t("legendExpenses"), color: "var(--chart-3)" },
  } satisfies ChartConfig;

  const cashConfig = {
    collectedMinor: { label: t("legendCollected"), color: "var(--chart-2)" },
    paidOutMinor: { label: t("legendPaidOut"), color: "var(--chart-5)" },
  } satisfies ChartConfig;

  const momConfig = {
    revenueMinor: { label: t("momRevenue"), color: "var(--chart-1)" },
    expensesMinor: { label: t("momExpenses"), color: "var(--chart-3)" },
    netCashMinor: { label: t("momNetCash"), color: "var(--chart-2)" },
  } satisfies ChartConfig;

  // Chronological context for the MoM DataTable — delta / "new" badge /
  // current-month note key off the month itself (not the displayed row
  // order), so they stay truthful when the user client-sorts the table.
  const momPrevByMonth = new Map<string, MonthlyRow | null>();
  let momCurrentMonth: string | null = null;
  if (monthly) {
    monthly.series.forEach((row, i) => {
      momPrevByMonth.set(row.month, i > 0 ? monthly.series[i - 1] : null);
    });
    momCurrentMonth =
      monthly.series.length > 0
        ? monthly.series[monthly.series.length - 1].month
        : null;
  }

  const hasAnyActivity =
    !!data &&
    (data.kpis.salesCount > 0 ||
      data.kpis.expensesCount > 0 ||
      data.kpis.collectedMinor > 0 ||
      data.kpis.paidOutMinor > 0);

  // Prompt 50 (§9/§E-Gate) — category slices with an HONEST denominator:
  // the donut shows the top slice PLUS a server-computed "Other" bucket,
  // so every percentage is a share of ALL expenses in range and
  // SUM(slices) === kpis.expensesMinor exactly.
  const categorySlices = data
    ? [
        ...data.expensesByCategory.map((c) => ({
          category: c.category,
          totalMinor: c.totalMinor,
          isOther: false,
        })),
        ...(data.expensesByCategoryOther.totalMinor > 0
          ? [
              {
                category: t("categoryOther"),
                totalMinor: data.expensesByCategoryOther.totalMinor,
                isOther: true,
              },
            ]
          : []),
      ]
    : [];
  const categoryDenominator = data?.expensesByCategoryTotalMinor ?? 0;

  const kpiCards = data
    ? [
        {
          icon: ReceiptText,
          label: t("kpiRevenue"),
          value: fmt(data.kpis.revenueMinor),
          hint: t("kpiRevenueHint", { count: fmtCount(uiLocale, data.kpis.salesCount) }),
          tone: "text-emerald-700 dark:text-emerald-400",
        },
        {
          icon: Coins,
          label: t("kpiCollected"),
          value: fmt(data.kpis.collectedMinor),
          hint: t("kpiAvgSale", { value: fmt(data.kpis.avgSaleMinor) }),
          tone: "text-teal-700 dark:text-teal-300",
        },
        {
          icon: ArrowUpRight,
          label: t("kpiExpenses"),
          value: fmt(data.kpis.expensesMinor),
          hint: t("kpiExpensesHint", { count: fmtCount(uiLocale, data.kpis.expensesCount) }),
          tone: "text-rose-700 dark:text-rose-400",
        },
        {
          icon: data.kpis.netCashMinor >= 0 ? TrendingUp : ArrowDownRight,
          label: t("kpiNetCash"),
          value: fmt(data.kpis.netCashMinor),
          hint: t("kpiNetAccrual", { value: fmt(data.kpis.netAccrualMinor) }),
          tone:
            data.kpis.netCashMinor >= 0
              ? "text-emerald-700 dark:text-emerald-400"
              : "text-rose-700 dark:text-rose-400",
        },
      ]
    : [];

  return (
    <div className="space-y-6" data-view="module:reports">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger className="h-9 min-w-0 flex-1 sm:w-44 sm:flex-none" aria-label={t("rangeLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {t(`range_${r}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => csvExport.mutate()}
              disabled={csvExport.isPending}
              title={t("exportCsv")}
            >
              {csvExport.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="size-4" aria-hidden="true" />
              )}
              <span className="hidden sm:inline" aria-hidden="true">
                {csvExport.isPending ? t("exportingCsv") : t("exportCsv")}
              </span>
              <span className="sr-only">{csvExport.isPending ? t("exportingCsv") : t("exportCsv")}</span>
            </Button>
          </div>
        }
      />

      {isInvDetail ? (
        /* Prompt 51 — detailed inventory valuation sub-view (deep-linkable
           via #/reports?inventory=1). Replaces the summary content; the
           panel owns its own loading/error/empty/export states. */
        <InventoryValuationPanel business={business} />
      ) : (
        <>
          {error ? (
            <div className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm">
              {t("loadFailed")}{" "}
              <button className="underline" onClick={() => void refetch()}>
                {t("retry")}
              </button>
            </div>
          ) : null}

          {isLoading ? (
        <div className="space-y-4" aria-busy="true">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-72 rounded-xl" />
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-64 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </div>
        </div>
      ) : !data ? null : !hasAnyActivity ? (
        <EmptyState
          icon={TrendingUp}
          title={t("emptyTitle")}
          description={t("emptyDesc")}
        />
      ) : (
        <>
          {/* KPI strip */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {kpiCards.map((kpi) => (
              <Card key={kpi.label} className="gap-3 py-4">
                <CardContent className="flex items-start gap-3 px-4">
                  <span className="bg-primary/10 text-primary mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg">
                    <kpi.icon className="size-4.5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-muted-foreground truncate text-xs font-medium tracking-wide uppercase">
                      {kpi.label}
                    </p>
                    <p
                      className={`mt-0.5 truncate text-xl font-semibold tabular-nums ${kpi.tone}`}
                      dir="ltr"
                    >
                      {kpi.value}
                    </p>
                    <p className="text-muted-foreground mt-0.5 truncate text-xs">{kpi.hint}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Prompt 20 — advanced insights: rendered ONLY from what the
              server entitled (§26). Locked teaser otherwise. */}
          {data.advancedAvailable && data.advanced ? (
            <>
              <AdvancedInsightsCard data={data.advanced} fmt={fmt} uiLocale={uiLocale} />
              {/* Prompt 50 (§11/§16) — performance detail: same entitlement,
                  source-level drill-down behind the summary. */}
              <PerformancePanel business={business} />
            </>
          ) : (
            <AdvancedLockedCard />
          )}

          {/* Income vs spending timeline */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("timelineTitle")}</CardTitle>
              <CardDescription>
                {t("timelineDesc", {
                  from: fmtDay(data.range.from),
                  to: fmtDay(data.range.to),
                })}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ChartContainer config={timelineConfig} className="h-64 w-full" dir="ltr">
                <AreaChart data={data.timeline} margin={{ left: 4, right: 12, top: 8 }}>
                  <defs>
                    <linearGradient id="fillRevenue" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--color-revenueMinor)" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="var(--color-revenueMinor)" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="fillExpense" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--color-expenseMinor)" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="var(--color-expenseMinor)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    minTickGap={28}
                    tickFormatter={(v: string) => v.slice(5)}
                  />
                  <YAxis
                    width={64}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => fmt(v)}
                  />
                  <ChartTooltip
                    cursor={{ stroke: "var(--border)" }}
                    content={<MoneyTooltip fmt={fmt} labelFmt={fmtDay} />}
                  />
                  <Area
                    dataKey="expenseMinor"
                    type="monotone"
                    stroke="var(--color-expenseMinor)"
                    strokeWidth={2}
                    fill="url(#fillExpense)"
                    name={timelineConfig.expenseMinor.label}
                  />
                  <Area
                    dataKey="revenueMinor"
                    type="monotone"
                    stroke="var(--color-revenueMinor)"
                    strokeWidth={2}
                    fill="url(#fillRevenue)"
                    name={timelineConfig.revenueMinor.label}
                  />
                </AreaChart>
              </ChartContainer>
              {/* Legend (rendered manually so labels localize) */}
              <div className="text-muted-foreground mt-2 flex flex-wrap items-center justify-center gap-4 text-xs">
                {(["revenueMinor", "expenseMinor"] as const).map((key) => (
                  <span key={key} className="flex items-center gap-1.5">
                    <span
                      className="size-2 rounded-[2px]"
                      style={{ background: `var(--color-${key})` }}
                      aria-hidden="true"
                    />
                    {timelineConfig[key].label}
                  </span>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Month-over-month comparison */}
          {monthly && monthly.series.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <TrendingUp className="text-primary size-4" aria-hidden="true" />
                  {t("momTitle")}
                </CardTitle>
                <CardDescription>
                  {t("momDesc", { months: fmtCount(uiLocale, monthly.months) })}
                </CardDescription>
              </CardHeader>
              <CardContent className="min-w-0">
                {/* Companion chart — bars for revenue/expenses, line for net cash. */}
                <ChartContainer
                  config={momConfig}
                  className="mb-4 h-44 w-full sm:h-48"
                  dir="ltr"
                >
                  <ComposedChart data={monthly.series} margin={{ left: 4, right: 12, top: 8 }}>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" />
                    <XAxis
                      dataKey="month"
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      tickFormatter={(v: string) => fmtMonth(v).replace(/\s*\d{4}/, "")}
                    />
                    <YAxis
                      width={64}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v: number) => fmt(v)}
                    />
                    <ChartTooltip
                      cursor={{ fill: "var(--muted)" }}
                      content={
                        <MoneyTooltip fmt={fmt} labelFmt={(v) => fmtMonth(v)} />
                      }
                    />
                    <Bar
                      dataKey="revenueMinor"
                      fill="var(--color-revenueMinor)"
                      radius={3}
                      name={momConfig.revenueMinor.label}
                    />
                    <Bar
                      dataKey="expensesMinor"
                      fill="var(--color-expensesMinor)"
                      radius={3}
                      name={momConfig.expensesMinor.label}
                    />
                    <Line
                      dataKey="netCashMinor"
                      stroke="var(--color-netCashMinor)"
                      strokeWidth={2}
                      dot={{ r: 2.5, strokeWidth: 0, fill: "var(--color-netCashMinor)" }}
                      name={momConfig.netCashMinor.label}
                    />
                  </ComposedChart>
                </ChartContainer>
                <div className="mb-2 flex flex-wrap items-center gap-3">
                  {(Object.keys(momConfig) as Array<keyof typeof momConfig>).map((key) => (
                    <span key={key} className="text-muted-foreground flex items-center gap-1.5 text-xs">
                      <span
                        className="size-2.5 rounded-[2px]"
                        style={{ background: momConfig[key].color }}
                        aria-hidden="true"
                      />
                      {momConfig[key].label}
                    </span>
                  ))}
                </div>
                <DataTable<MonthlyRow>
                  ariaLabel={t("momTitle")}
                  sortLocale={uiLocale}
                  onRowClick={(row) => openMonth(row.month)}
                  columns={[
                    {
                      id: "month",
                      header: t("momMonth"),
                      sortValue: (row) => row.month,
                      cell: (row) => {
                        const isCurrent = row.month === momCurrentMonth;
                        return (
                          <div className="flex min-w-0 items-center">
                            <button
                              type="button"
                              className="hover:text-foreground inline-flex items-center gap-1 rounded font-medium transition-colors focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
                              aria-label={t("momRowOpen", {
                                month: fmtMonth(row.month),
                              })}
                              onClick={(e) => {
                                // The month label OWNS the row's activation
                                // semantics (it reads as the row's "open
                                // details" control). Without its own onClick
                                // the DataTable interactive-element guard
                                // swallows the click and the row never opens
                                // — the visible affordance did nothing.
                                e.stopPropagation();
                                openMonth(row.month);
                              }}
                            >
                              {fmtMonth(row.month)}
                              <ChevronRight
                                className="text-muted-foreground/60 size-3.5 rtl:-scale-x-100"
                                aria-hidden="true"
                              />
                            </button>
                            {isCurrent ? (
                              <span className="text-muted-foreground ms-2 hidden text-[11px] md:inline">
                                · {t("momCurrentNote")}
                              </span>
                            ) : null}
                          </div>
                        );
                      },
                    },
                    {
                      id: "revenue",
                      header: t("momRevenue"),
                      align: "end",
                      sortValue: (row) => row.revenueMinor,
                      defaultSortDir: "desc",
                      cell: (row) => (
                        <Ltr>
                          {fmt(row.revenueMinor)}
                          <span className="text-muted-foreground ms-1.5 hidden text-xs lg:inline">
                            ({fmtCount(uiLocale, row.salesCount)})
                          </span>
                        </Ltr>
                      ),
                    },
                    {
                      id: "expenses",
                      header: t("momExpenses"),
                      align: "end",
                      cell: (row) => <Ltr>{fmt(row.expensesMinor)}</Ltr>,
                    },
                    {
                      id: "netCash",
                      header: t("momNetCash"),
                      align: "end",
                      sortValue: (row) => row.netCashMinor,
                      defaultSortDir: "desc",
                      cell: (row) => (
                        <Ltr
                          className={
                            row.netCashMinor >= 0
                              ? "text-emerald-700 dark:text-emerald-400"
                              : "text-rose-700 dark:text-rose-400"
                          }
                        >
                          {fmt(row.netCashMinor)}
                        </Ltr>
                      ),
                    },
                    {
                      id: "delta",
                      header: (
                        <span title={t("momDeltaVsPrev", { prev: "" })}>
                          <span aria-hidden="true">Δ</span>
                          <span className="sr-only">{t("momTitle")}</span>
                        </span>
                      ),
                      align: "end",
                      className: "w-20",
                      cell: (row) => {
                        // Delta keys off the CHRONOLOGICAL previous month
                        // (momPrevByMonth), so it stays truthful under sorting.
                        const prev = momPrevByMonth.get(row.month) ?? null;
                        const delta = prev
                          ? pctChange(row.revenueMinor, prev.revenueMinor)
                          : null;
                        const deltaTitle = prev
                          ? t("momDeltaVsPrev", { prev: fmtMonth(prev.month) })
                          : undefined;
                        return delta === null ? (
                          prev && prev.revenueMinor === 0 && row.revenueMinor > 0 ? (
                            <Badge
                              variant="outline"
                              title={deltaTitle}
                              className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 gap-0.5 text-[11px] dark:text-emerald-400"
                            >
                              <ArrowUpRight className="size-3" aria-hidden="true" />
                              new
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground/60 inline-flex items-center">
                              <Minus className="size-3" aria-hidden="true" />
                              <span className="sr-only">—</span>
                            </span>
                          )
                        ) : delta > 0 ? (
                          <Badge
                            variant="outline"
                            title={deltaTitle}
                            className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 gap-0.5 text-[11px] tabular-nums dark:text-emerald-400"
                          >
                            <ArrowUpRight className="size-3" aria-hidden="true" />
                            <Ltr>+{delta}%</Ltr>
                          </Badge>
                        ) : delta < 0 ? (
                          <Badge
                            variant="outline"
                            title={deltaTitle}
                            className="border-rose-500/30 bg-rose-500/10 text-rose-700 gap-0.5 text-[11px] tabular-nums dark:text-rose-400"
                          >
                            <ArrowDownRight className="size-3" aria-hidden="true" />
                            <Ltr>{delta}%</Ltr>
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            title={deltaTitle}
                            className="text-muted-foreground gap-0.5 text-[11px] tabular-nums"
                          >
                            <Minus className="size-3" aria-hidden="true" />
                            <Ltr>0%</Ltr>
                          </Badge>
                        );
                      },
                    },
                  ]}
                  rows={monthly.series}
                  getRowId={(row) => row.month}
                />
                <p className="text-muted-foreground mt-2 text-[11px]">
                  {t("momRowHint")}
                </p>
              </CardContent>
            </Card>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Cash collected vs paid out */}
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Coins className="text-primary size-4" aria-hidden="true" />
                  {t("cashTitle")}
                </CardTitle>
                <CardDescription>{t("cashDesc")}</CardDescription>
              </CardHeader>
              <CardContent>
                <ChartContainer config={cashConfig} className="h-56 w-full" dir="ltr">
                  <BarChart data={data.timeline} margin={{ left: 4, right: 12, top: 8 }}>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" />
                    <XAxis
                      dataKey="date"
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      minTickGap={28}
                      tickFormatter={(v: string) => v.slice(5)}
                    />
                    <YAxis
                      width={64}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v: number) => fmt(v)}
                    />
                    <ChartTooltip cursor={{ fill: "var(--muted)" }} content={<MoneyTooltip fmt={fmt} labelFmt={fmtDay} />} />
                    <Bar dataKey="collectedMinor" fill="var(--color-collectedMinor)" radius={3} name={cashConfig.collectedMinor.label} />
                    <Bar dataKey="paidOutMinor" fill="var(--color-paidOutMinor)" radius={3} name={cashConfig.paidOutMinor.label} />
                  </BarChart>
                </ChartContainer>
              </CardContent>
            </Card>

            {/* Expenses by category donut */}
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <ChartPie className="text-primary size-4" aria-hidden="true" />
                  {t("categoryTitle")}
                </CardTitle>
                <CardDescription>{t("categoryDesc")}</CardDescription>
              </CardHeader>
              <CardContent>
                {categorySlices.length === 0 ? (
                  <EmptyState icon={Layers} title={t("categoryEmpty")} className="border-0 p-6" />
                ) : (
                  <div className="flex flex-col items-center gap-4 sm:flex-row">
                    <ChartContainer
                      config={{}}
                      className="aspect-square h-44 w-44 shrink-0"
                      dir="ltr"
                    >
                      <PieChart>
                        <ChartTooltip content={<MoneyTooltip fmt={fmt} />} />
                        <Pie
                          data={categorySlices}
                          dataKey="totalMinor"
                          nameKey="category"
                          innerRadius={45}
                          outerRadius={72}
                          paddingAngle={2}
                          strokeWidth={0}
                        >
                          {categorySlices.map((entry, i) => (
                            <Cell
                              key={`${entry.category}-${i}`}
                              fill={CATEGORY_COLORS[i % CATEGORY_COLORS.length]}
                            />
                          ))}
                        </Pie>
                      </PieChart>
                    </ChartContainer>
                    <ul className="w-full space-y-2">
                      {categorySlices.map((cat, i) => {
                        // Honest denominator (Gate G): the share is of ALL
                        // expenses in range (server total), never of just
                        // the displayed slices.
                        const pct =
                          categoryDenominator > 0
                            ? Math.round((cat.totalMinor / categoryDenominator) * 100)
                            : 0;
                        return (
                          <li key={`${cat.category}-${i}`} className="flex items-center gap-2 text-sm">
                            <span
                              className="size-2.5 shrink-0 rounded-[3px]"
                              style={{ background: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }}
                              aria-hidden="true"
                            />
                            <span className="min-w-0 flex-1 truncate" dir="auto">
                              {cat.category}
                              {cat.isOther ? (
                                <span className="sr-only"> — {t("categoryOtherAria")}</span>
                              ) : null}
                            </span>
                            <span className="text-muted-foreground text-xs tabular-nums">{pct}%</span>
                            <span className="font-medium tabular-nums" dir="ltr">
                              {fmt(cat.totalMinor)}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Top products — catalog rows deep-link by STABLE productId;
                unlinked (no catalog identity) rows carry a truthful badge
                and never fake a destination (§16). */}
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Package className="text-primary size-4" aria-hidden="true" />
                  {t("topProductsTitle")}
                </CardTitle>
                <CardDescription>{t("topProductsDesc")}</CardDescription>
              </CardHeader>
              <CardContent>
                {data.topProducts.length === 0 ? (
                  <EmptyState icon={Package} title={t("topProductsEmpty")} className="border-0 p-6" />
                ) : (
                  <ChartContainer config={{}} className="h-56 w-full" dir="ltr">
                    <BarChart
                      data={data.topProducts}
                      layout="vertical"
                      margin={{ left: 8, right: 16, top: 4 }}
                    >
                      <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                      <XAxis
                        type="number"
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(v: number) => fmt(v)}
                      />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={110}
                        tickLine={false}
                        axisLine={false}
                        tick={{ fontSize: 11 }}
                      />
                      <ChartTooltip
                        cursor={{ fill: "var(--muted)" }}
                        content={<MoneyTooltip fmt={fmt} />}
                      />
                      <Bar dataKey="revenueMinor" fill="var(--chart-1)" radius={4} barSize={18} />
                    </BarChart>
                  </ChartContainer>
                )}
                {data.topProducts.length > 0 ? (
                  <>
                    <ul className="mt-2 space-y-1">
                      {data.topProducts.map((p) => (
                        <li key={p.productId ?? `u:${p.name}`} className="flex items-center justify-between gap-2 text-xs">
                          <span className="flex min-w-0 items-center gap-1.5">
                            {p.productId ? (
                              <button
                                type="button"
                                className="hover:text-foreground truncate rounded font-medium transition-colors focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
                                onClick={() => navigate({ kind: "entity", entity: "product", id: p.productId! })}
                                title={p.sku ? `${p.name} — ${p.sku}` : p.name}
                              >
                                {p.name}
                              </button>
                            ) : (
                              <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
                                {p.name}
                              </Badge>
                            )}
                          </span>
                          <span className="text-muted-foreground shrink-0 tabular-nums" dir="ltr">
                            {fmt(p.revenueMinor)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="text-muted-foreground mt-2 text-center text-xs">
                      {t("topProductsQtyNote", {
                        name: data.topProducts[0].name,
                        qty: fmtCount(uiLocale, data.topProducts[0].qty),
                      })}
                    </p>
                  </>
                ) : null}
              </CardContent>
            </Card>

            {/* Inventory health + outstanding */}
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Boxes className="text-primary size-4" aria-hidden="true" />
                    {t("inventoryTitle")}
                  </CardTitle>
                  <CardDescription>{t("inventoryDesc")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-lg border p-3">
                      <p className="text-muted-foreground text-xs font-medium uppercase">
                        {t("inventoryValue")}
                      </p>
                      <p className="mt-1 text-lg font-semibold tabular-nums" dir="ltr">
                        {fmt(data.inventory.valueMinor)}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {t("inventoryProducts", { count: fmtCount(uiLocale, data.inventory.productCount) })}
                      </p>
                    </div>
                    <div className="rounded-lg border p-3">
                      <p className="text-muted-foreground text-xs font-medium uppercase">
                        {t("lowStock")}
                      </p>
                      <p
                        className={`mt-1 text-lg font-semibold tabular-nums ${
                          data.inventory.lowStockCount > 0
                            ? "text-amber-700 dark:text-amber-400"
                            : "text-emerald-700 dark:text-emerald-400"
                        }`}
                        dir="ltr"
                      >
                        {data.inventory.lowStockCount}
                      </p>
                      <p className="text-muted-foreground text-xs">{t("lowStockHint")}</p>
                    </div>
                  </div>
                  {data.inventory.lowStockItems.length > 0 ? (
                    <ul className="space-y-1.5">
                      {data.inventory.lowStockItems.map((item) => (
                        <li
                          key={item.id}
                          className="flex items-center justify-between gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-1.5 text-sm"
                        >
                          <span className="flex min-w-0 items-center gap-1.5">
                            <AlertTriangle
                              className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
                              aria-hidden="true"
                            />
                            <span className="truncate" dir="auto">{item.name}</span>
                          </span>
                          <Badge
                            variant="outline"
                            className="shrink-0 border-amber-300/60 bg-amber-500/10 text-amber-700 tabular-nums dark:text-amber-400"
                          >
                            {item.stockQty} {item.unit ?? ""}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {/* Prompt 51 (§8.1) — the summary estimate now drills down
                      into the detailed valuation (stable-id navigation). */}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 w-full gap-1.5"
                    data-testid="inventory-valuation-open"
                    onClick={() =>
                      navigate({ kind: "module", module: "reports", param: "inventory" }, { replace: true })
                    }
                  >
                    <Boxes className="size-3.5" aria-hidden="true" />
                    {t("invValViewDetails")}
                    <ChevronRight className="ms-auto size-3.5 rtl:rotate-180" aria-hidden="true" />
                  </Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">{t("outstandingTitle")}</CardTitle>
                  <CardDescription>{t("outstandingDesc")}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => navigate({ kind: "module", module: "receivables" })}
                    className="group rounded-lg border p-3 text-start transition-colors hover:border-emerald-500/40 hover:bg-emerald-500/5"
                  >
                    <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium uppercase">
                      <HandCoins className="size-3.5" aria-hidden="true" />
                      {t("outstandingReceivable")}
                    </p>
                    <p className="text-muted-foreground mt-1 text-lg font-semibold tabular-nums text-amber-700 group-hover:underline dark:text-amber-400" dir="ltr">
                      {fmt(data.outstanding.receivableMinor)}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {t("outstandingBills", { count: fmtCount(uiLocale, data.outstanding.receivableCount) })}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate({ kind: "module", module: "payables" })}
                    className="group rounded-lg border p-3 text-start transition-colors hover:border-rose-500/40 hover:bg-rose-500/5"
                  >
                    <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium uppercase">
                      <ArrowUpRight className="size-3.5" aria-hidden="true" />
                      {t("outstandingPayable")}
                    </p>
                    <p
                      className="mt-1 text-lg font-semibold tabular-nums text-rose-700 group-hover:underline dark:text-rose-400"
                      dir="ltr"
                    >
                      {fmt(data.outstanding.payableMinor)}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {t("outstandingBills", { count: fmtCount(uiLocale, data.outstanding.payableCount) })}
                    </p>
                  </button>
                </CardContent>
              </Card>
            </div>
          </div>

          <p className="text-muted-foreground text-center text-xs">{t("derivedNote")}</p>
        </>
      )}
        </>
      )}

      {/* ---- Single-month drill-down (MoM row click / #?month= deep link) - */}
      <Dialog open={detailMonth !== null} onOpenChange={(open) => !open && closeMonth()}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <CalendarDays className="text-primary size-4" aria-hidden="true" />
              {detailMonth ? t("momDetailTitle", { month: fmtMonth(detailMonth) }) : null}
            </DialogTitle>
            <DialogDescription className="flex flex-wrap items-center justify-between gap-2">
              <span>{t("momDetailDesc")}</span>
              {detailMonth ? (
                <span className="flex flex-wrap items-center gap-1.5">
                  {/* r12: continue from the numbers — jump into the filtered
                      module list for this month (deep-linked, shareable). */}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 text-xs"
                    disabled={monthDetail?.totals.salesCount === 0}
                    onClick={() =>
                      navigate({ kind: "module", module: "sales", param: detailMonth })
                    }
                  >
                    <ReceiptText className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                    {t("openInSales")}
                    <ChevronRight className="size-3 rtl:-scale-x-100" aria-hidden="true" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 text-xs"
                    disabled={monthDetail?.totals.expensesCount === 0}
                    onClick={() =>
                      navigate({ kind: "module", module: "expenses", param: detailMonth })
                    }
                  >
                    <Coins className="size-3.5 text-rose-600 dark:text-rose-400" aria-hidden="true" />
                    {t("openInExpenses")}
                    <ChevronRight className="size-3 rtl:-scale-x-100" aria-hidden="true" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 text-xs"
                    onClick={() => monthCsvExport.mutate(detailMonth)}
                    disabled={monthCsvExport.isPending}
                  >
                    {monthCsvExport.isPending ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                    ) : (
                      <Download className="size-3.5" aria-hidden="true" />
                    )}
                    {t("exportMonthCsv")}
                  </Button>
                </span>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          {detailLoading || !monthDetail ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-10 w-full animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="space-y-5">
              {/* Totals — mirror the MoM row figures. */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  {
                    label: t("momRevenue"),
                    value: monthDetail.totals.revenueMinor,
                    tone: "text-emerald-700 dark:text-emerald-400",
                  },
                  {
                    label: t("momExpenses"),
                    value: monthDetail.totals.expensesMinor,
                    tone: "text-rose-700 dark:text-rose-400",
                  },
                  {
                    label: t("momDetailCollected"),
                    value: monthDetail.totals.collectedMinor,
                    tone: "text-teal-700 dark:text-teal-300",
                  },
                  {
                    label: t("momNetCash"),
                    value: monthDetail.totals.netCashMinor,
                    tone:
                      monthDetail.totals.netCashMinor >= 0
                        ? "text-emerald-700 dark:text-emerald-400"
                        : "text-rose-700 dark:text-rose-400",
                  },
                ].map((cell) => (
                  <div key={cell.label} className="rounded-lg border p-2.5">
                    <p className="text-muted-foreground text-[11px] font-medium uppercase">
                      {cell.label}
                    </p>
                    <p className={cn("mt-0.5 text-sm font-semibold tabular-nums", cell.tone)} dir="ltr">
                      {fmt(cell.value)}
                    </p>
                  </div>
                ))}
              </div>

              {/* Sales in month — bounded, DISCLOSED preview (§10). */}
              <div>
                <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold">
                  <ReceiptText className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                  {t("momDetailSales", { count: fmtCount(uiLocale, monthDetail.totals.salesCount) })}
                </p>
                {monthDetail.preview.sales.hasMore ? (
                  <p className="text-muted-foreground mb-1.5 text-[11px]">
                    {t("momDetailPreview", {
                      shown: fmtCount(uiLocale, monthDetail.preview.sales.displayedCount),
                      total: fmtCount(uiLocale, monthDetail.preview.sales.totalCount),
                    })}
                  </p>
                ) : null}
                {monthDetail.sales.length === 0 ? (
                  <p className="text-muted-foreground rounded-md border border-dashed px-3 py-3 text-xs">
                    {t("momDetailEmpty")}
                  </p>
                ) : (
                  <ul className="max-h-56 space-y-1 overflow-y-auto pe-1">
                    {monthDetail.sales.map((s) => (
                      <li
                        key={`${s.number}-${s.issueDate}`}
                        className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="text-muted-foreground shrink-0 tabular-nums" dir="ltr">
                            #{String(s.number).padStart(4, "0")}
                          </span>
                          <span className="truncate font-medium">
                            {s.customerName ?? t("momDetailNoCustomer")}
                          </span>
                          <span className="text-muted-foreground hidden shrink-0 sm:inline">
                            {fmtIsoDate(s.issueDate)}
                          </span>
                        </span>
                        <span className="shrink-0 tabular-nums" dir="ltr">
                          {fmt(s.totalMinor)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Expenses in month — bounded, DISCLOSED preview (§10). */}
              <div>
                <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold">
                  <Coins className="size-3.5 text-rose-600 dark:text-rose-400" aria-hidden="true" />
                  {t("momDetailExpensesList", {
                    count: fmtCount(uiLocale, monthDetail.totals.expensesCount),
                  })}
                </p>
                {monthDetail.preview.expenses.hasMore ? (
                  <p className="text-muted-foreground mb-1.5 text-[11px]">
                    {t("momDetailPreview", {
                      shown: fmtCount(uiLocale, monthDetail.preview.expenses.displayedCount),
                      total: fmtCount(uiLocale, monthDetail.preview.expenses.totalCount),
                    })}
                  </p>
                ) : null}
                {monthDetail.expenses.length === 0 ? (
                  <p className="text-muted-foreground rounded-md border border-dashed px-3 py-3 text-xs">
                    {t("momDetailEmpty")}
                  </p>
                ) : (
                  <ul className="max-h-56 space-y-1 overflow-y-auto pe-1">
                    {monthDetail.expenses.map((e) => (
                      <li
                        key={`${e.category}-${e.spentAt}-${e.amountMinor}`}
                        className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
                            {e.category}
                          </Badge>
                          <span className="truncate">
                            {e.supplierName ?? t("momDetailNoSupplier")}
                          </span>
                          <span className="text-muted-foreground hidden shrink-0 sm:inline">
                            {fmtIsoDate(e.spentAt)}
                          </span>
                        </span>
                        <span className="shrink-0 tabular-nums" dir="ltr">
                          {fmt(e.amountMinor)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---- Prompt 20: advanced insights (ADVANCED_REPORTS entitlement) -------------

/**
 * Deterministic "beyond the basics" analytics card. Rendered from data the
 * SERVER included (or omitted) per entitlement — the UI never gates
 * anything by itself (§26). When not entitled this renders a small locked
 * teaser; the data block simply is not in the payload.
 */
function AdvancedInsightsCard({
  data,
  fmt,
  uiLocale,
}: {
  data: AdvancedInsights;
  fmt: (minor: number) => string;
  uiLocale: string;
}) {
  const tAdv = useTranslations("billing.advanced");
  const tBilling = useTranslations("billing");
  const t = useTranslations("reports");
  const navigate = useAppStore((s) => s.navigate);

  const pct = (v: number | null) =>
    v === null ? (
      <span className="text-muted-foreground">—</span>
    ) : (
      <span
        className={
          v >= 0
            ? "inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400"
            : "inline-flex items-center gap-0.5 text-destructive"
        }
        dir="ltr"
      >
        {v >= 0 ? (
          <ArrowUpRight className="size-3.5" aria-hidden="true" />
        ) : (
          <ArrowDownRight className="size-3.5" aria-hidden="true" />
        )}
        {Math.abs(v)}%
      </span>
    );

  const g = data.growth;

  return (
    <Card data-testid="advanced-insights">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{tAdv("title")}</CardTitle>
        <CardDescription>{tAdv("vsPrev")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="bg-muted/40 rounded-lg border p-3">
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {tAdv("revenueChange", { days: 30 })}
            </p>
            <p className="mt-1 flex items-center justify-between gap-2 text-sm font-semibold tabular-nums" dir="ltr">
              {fmt(g.revenueMinor)} {pct(g.revenueChangePct)}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs tabular-nums" dir="ltr">
              {fmt(g.revenuePrevMinor)}
            </p>
          </div>
          <div className="bg-muted/40 rounded-lg border p-3">
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {tAdv("salesChange")}
            </p>
            <p className="mt-1 flex items-center justify-between gap-2 text-sm font-semibold tabular-nums" dir="ltr">
              {g.salesCount} {pct(g.salesChangePct)}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs tabular-nums" dir="ltr">
              {g.salesCountPrev}
            </p>
          </div>
          <div className="bg-muted/40 rounded-lg border p-3">
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {tAdv("expensesChange")}
            </p>
            <p className="mt-1 flex items-center justify-between gap-2 text-sm font-semibold tabular-nums" dir="ltr">
              {fmt(g.expensesMinor)} {pct(g.expensesChangePct)}
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs tabular-nums" dir="ltr">
              {fmt(g.expensesPrevMinor)}
            </p>
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-medium">{tAdv("concentration")}</p>
            <p className="text-muted-foreground text-xs tabular-nums">
              {tAdv("top5Share")}: <span className="font-semibold">{data.concentration.top5SharePct}%</span>
            </p>
          </div>
          {data.concentration.topCustomers.length === 0 ? (
            <p className="text-muted-foreground text-sm">{tAdv("noCustomerData")}</p>
          ) : (
            <ul className="space-y-1.5">
              {data.concentration.topCustomers.map((c) => (
                <li key={c.customerId} className="flex items-center gap-3 text-sm">
                  {/* Prompt 50 (§8) — identity-safe drill-down: the row
                      navigates by the STABLE customerId (never the display
                      name), so same-name customers stay distinct. */}
                  <button
                    type="button"
                    className="hover:text-foreground w-28 shrink-0 truncate rounded text-start transition-colors focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2 sm:w-40"
                    title={c.name}
                    onClick={() => navigate({ kind: "entity", entity: "customer", id: c.customerId })}
                  >
                    {c.name}
                  </button>
                  <div className="bg-muted h-1.5 flex-1 overflow-hidden rounded-full">
                    <div
                      className="bg-primary/60 h-full rounded-full"
                      style={{ width: `${Math.min(100, c.sharePct)}%` }}
                    />
                  </div>
                  <span className="text-muted-foreground w-10 shrink-0 text-end text-xs tabular-nums">
                    {c.sharePct}%
                  </span>
                  <span
                    className="w-24 shrink-0 text-end text-xs font-medium tabular-nums"
                    dir="ltr"
                  >
                    {fmt(c.revenueMinor)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {/* §8 — unassigned issued revenue is EXPOSED, never redistributed:
              this is why named customers' shares need not add up to 100%. */}
          {data.concentration.unassignedRevenueMinor > 0 ? (
            <p className="text-muted-foreground mt-2 text-xs tabular-nums" dir="ltr">
              {t("perfColNoCustomer")}: {fmt(data.concentration.unassignedRevenueMinor)}
            </p>
          ) : null}
          <p className="sr-only">
            {tBilling("advancedReports")} — {uiLocale}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/** Locked teaser shown when the plan does not carry ADVANCED_REPORTS. */
function AdvancedLockedCard() {
  const tB = useTranslations("billing");
  const navigate = useAppStore((s) => s.navigate);
  return (
    <Card
      data-testid="advanced-locked"
      className="border-dashed"
    >
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Lock className="size-4 shrink-0" aria-hidden="true" />
          {tB("advancedLocked")}
        </p>
        <Button size="sm" variant="outline" onClick={() => navigate({ kind: "settings:billing" })}>
          {tB("upgrade")}
        </Button>
      </CardContent>
    </Card>
  );
}
