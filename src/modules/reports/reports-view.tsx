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
  ChartPie,
  Coins,
  Download,
  HandCoins,
  Layers,
  Loader2,
  Minus,
  Package,
  ReceiptText,
  TrendingUp,
} from "lucide-react";
import { api, ApiClientError } from "@/lib/api-client";
import { useAppStore } from "@/store/app-store";
import { toast } from "@/hooks/use-toast";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart";
import { EmptyState, PageHeader } from "@/components/shared/primitives";
import { fmtCount, fmtMoney } from "../finance-shared/finance-kit";
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
  topProducts: Array<{ name: string; qty: number; revenueMinor: number }>;
  expensesByCategory: Array<{ category: string; totalMinor: number }>;
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
  const uiLocale = useLocale();
  const navigate = useAppStore((s) => s.navigate);
  const activeId = useAppStore((s) => s.activeBusinessId);
  const [days, setDays] = useState<string>("30");

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
        title: err instanceof Error ? err.message : t("csvFailed"),
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

  const timelineConfig = {
    revenueMinor: { label: t("legendRevenue"), color: "var(--chart-1)" },
    expenseMinor: { label: t("legendExpenses"), color: "var(--chart-3)" },
  } satisfies ChartConfig;

  const cashConfig = {
    collectedMinor: { label: t("legendCollected"), color: "var(--chart-2)" },
    paidOutMinor: { label: t("legendPaidOut"), color: "var(--chart-5)" },
  } satisfies ChartConfig;

  const hasAnyActivity =
    !!data &&
    (data.kpis.salesCount > 0 ||
      data.kpis.expensesCount > 0 ||
      data.kpis.collectedMinor > 0 ||
      data.kpis.paidOutMinor > 0);

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
              <span className="hidden sm:inline">{csvExport.isPending ? t("exportingCsv") : t("exportCsv")}</span>
              <span className="sr-only">{csvExport.isPending ? t("exportingCsv") : t("exportCsv")}</span>
            </Button>
          </div>
        }
      />

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
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("momMonth")}</TableHead>
                        <TableHead className="text-end">{t("momRevenue")}</TableHead>
                        <TableHead className="text-end">{t("momExpenses")}</TableHead>
                        <TableHead className="text-end">{t("momNetCash")}</TableHead>
                        <TableHead className="w-20 text-end" title={t("momDeltaVsPrev", { prev: "" })}>
                          <span aria-hidden="true">Δ</span>
                          <span className="sr-only">{t("momTitle")}</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {monthly.series.map((row, i) => {
                        const prev = i > 0 ? monthly.series[i - 1] : null;
                        const delta = prev ? pctChange(row.revenueMinor, prev.revenueMinor) : null;
                        const isCurrent = i === monthly.series.length - 1;
                        const deltaTitle = prev
                          ? t("momDeltaVsPrev", { prev: fmtMonth(prev.month) })
                          : undefined;
                        return (
                          <TableRow key={row.month} className={isCurrent ? "bg-muted/40" : ""}>
                            <TableCell>
                              <span className="font-medium">{fmtMonth(row.month)}</span>
                              {isCurrent ? (
                                <span className="text-muted-foreground ms-2 hidden text-[11px] md:inline">
                                  · {t("momCurrentNote")}
                                </span>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-end tabular-nums" dir="ltr">
                              {fmt(row.revenueMinor)}
                              <span className="text-muted-foreground ms-1.5 hidden text-xs lg:inline">
                                ({fmtCount(uiLocale, row.salesCount)})
                              </span>
                            </TableCell>
                            <TableCell className="text-end tabular-nums" dir="ltr">
                              {fmt(row.expensesMinor)}
                            </TableCell>
                            <TableCell
                              className={`text-end tabular-nums ${
                                row.netCashMinor >= 0
                                  ? "text-emerald-700 dark:text-emerald-400"
                                  : "text-rose-700 dark:text-rose-400"
                              }`}
                              dir="ltr"
                            >
                              {fmt(row.netCashMinor)}
                            </TableCell>
                            <TableCell className="text-end">
                              {delta === null ? (
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
                                  +{delta}%
                                </Badge>
                              ) : delta < 0 ? (
                                <Badge
                                  variant="outline"
                                  title={deltaTitle}
                                  className="border-rose-500/30 bg-rose-500/10 text-rose-700 gap-0.5 text-[11px] tabular-nums dark:text-rose-400"
                                >
                                  <ArrowDownRight className="size-3" aria-hidden="true" />
                                  {delta}%
                                </Badge>
                              ) : (
                                <Badge
                                  variant="outline"
                                  title={deltaTitle}
                                  className="text-muted-foreground gap-0.5 text-[11px] tabular-nums"
                                >
                                  <Minus className="size-3" aria-hidden="true" />
                                  0%
                                </Badge>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
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
                {data.expensesByCategory.length === 0 ? (
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
                          data={data.expensesByCategory}
                          dataKey="totalMinor"
                          nameKey="category"
                          innerRadius={45}
                          outerRadius={72}
                          paddingAngle={2}
                          strokeWidth={0}
                        >
                          {data.expensesByCategory.map((entry, i) => (
                            <Cell key={entry.category} fill={CATEGORY_COLORS[i % CATEGORY_COLORS.length]} />
                          ))}
                        </Pie>
                      </PieChart>
                    </ChartContainer>
                    <ul className="w-full space-y-2">
                      {data.expensesByCategory.map((cat, i) => {
                        const total = data.expensesByCategory.reduce((s, c) => s + c.totalMinor, 0);
                        const pct = total > 0 ? Math.round((cat.totalMinor / total) * 100) : 0;
                        return (
                          <li key={cat.category} className="flex items-center gap-2 text-sm">
                            <span
                              className="size-2.5 shrink-0 rounded-[3px]"
                              style={{ background: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }}
                              aria-hidden="true"
                            />
                            <span className="min-w-0 flex-1 truncate" dir="auto">
                              {cat.category}
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

            {/* Top products */}
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
                  <p className="text-muted-foreground mt-2 text-center text-xs">
                    {t("topProductsQtyNote", {
                      name: data.topProducts[0].name,
                      qty: fmtCount(uiLocale, data.topProducts[0].qty),
                    })}
                  </p>
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
    </div>
  );
}
