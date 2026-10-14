"use client";

/**
 * Prompt 50 (§11/§13) — Performance detail panel for the Reports module.
 *
 * The source records behind the summary KPIs, grouped by CLOSED dimensions
 * and bounded server-side (scan cap + group cap + keyset cash-flow pages).
 * Every figure comes from /api/v1/reports/performance — the UI never
 * recomputes anything (Rule 05 / §16).
 *
 * Gating: the parent renders this panel ONLY when the server-included
 * summary says `advancedAvailable` (ADVANCED_REPORTS). The endpoint
 * enforces the entitlement server-side anyway (§11) — this panel is never
 * the gate.
 *
 * Drill-down law (§16): deep links carry STABLE IDs (entity routes) — a
 * row without a stable identity (unlinked line, unassigned customer) never
 * fakes a destination.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import {
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Coins,
  Download,
  ExternalLink,
  Loader2,
  ReceiptText,
  TriangleAlert,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app-store";
import { toast } from "@/hooks/use-toast";
import { useBillingErrorText } from "@/hooks/use-billing-error-text";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable, Ltr } from "@/components/shared/data-table";
import { fmtCount, fmtMoney } from "../finance-shared/finance-kit";
import type { BusinessSummary } from "../shell/types";

type SalesGroupBy = "product" | "customer" | "day" | "month";
type ExpenseGroupBy = "category" | "supplier" | "day" | "month";
type PerfKind = "sales" | "expenses" | "cashflow";

type SalesPerf = {
  kind: "sales";
  groupBy: SalesGroupBy;
  range: { from: string; to: string; timezone: string };
  totals: {
    revenueMinor: number;
    invoiceCount: number;
    lineValueMinor: number;
    discountMinor: number;
    netLineValueMinor: number;
  };
  groups: Array<
    | {
        dimension: "product";
        productId: string | null;
        kind: "catalog" | "unlinked";
        name: string;
        sku: string | null;
        unit: string | null;
        qtySold: number;
        invoiceCount: number;
        lineValueMinor: number;
        netValueMinor: number;
      }
    | { dimension: "customer"; customerId: string | null; name: string | null; invoiceCount: number; revenueMinor: number }
    | { dimension: "day"; date: string; invoiceCount: number; revenueMinor: number }
    | { dimension: "month"; month: string; invoiceCount: number; revenueMinor: number }
  >;
  groupTruncated: boolean;
  truncated: boolean;
  discountBasis: "net_allocated";
};

type ExpensePerf = {
  kind: "expenses";
  groupBy: ExpenseGroupBy;
  range: { from: string; to: string; timezone: string };
  basis: "recorded_expense_on_spentAt";
  totals: { amountMinor: number; expenseCount: number };
  groups: Array<
    | { dimension: "category"; category: string; expenseCount: number; amountMinor: number }
    | { dimension: "supplier"; supplierId: string | null; name: string | null; expenseCount: number; amountMinor: number }
    | { dimension: "day"; date: string; expenseCount: number; amountMinor: number }
    | { dimension: "month"; month: string; expenseCount: number; amountMinor: number }
  >;
  groupTruncated: boolean;
  truncated: boolean;
};

type CashFlowPage = {
  kind: "cashflow";
  range: { from: string; to: string; timezone: string };
  direction: "IN" | "OUT" | null;
  totals: { collectedMinor: number; paidOutMinor: number; netCashMinor: number; paymentCount: number };
  rows: Array<{
    id: string;
    date: string;
    direction: "IN" | "OUT";
    amountMinor: number;
    method: string;
    sale: { id: string; number: number } | null;
    expense: { id: string; reference: string | null; category: string } | null;
  }>;
  nextCursor: string | null;
  truncated: false;
};

/** Business-local "today" for display defaults (server remains the authority). */
function localTodayKey(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function addDaysKey(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

const SALES_GROUPS: SalesGroupBy[] = ["product", "customer", "day", "month"];
const EXPENSE_GROUPS: ExpenseGroupBy[] = ["category", "supplier", "day", "month"];

export function PerformancePanel({ business }: { business: BusinessSummary }) {
  const t = useTranslations("reports");
  const tErrors = useTranslations("errors");
  const billingErrorText = useBillingErrorText();
  const uiLocale = useLocale();
  const navigate = useAppStore((s) => s.navigate);

  const [kind, setKind] = useState<PerfKind>("sales");
  const [salesGroup, setSalesGroup] = useState<SalesGroupBy>("product");
  const [expenseGroup, setExpenseGroup] = useState<ExpenseGroupBy>("category");
  const [direction, setDirection] = useState<"all" | "IN" | "OUT">("all");

  // Default window: the last 30 business-local days (display default only —
  // the server re-validates and re-derives every boundary).
  const today = localTodayKey(business.timezone || "UTC");
  const [fromInput, setFromInput] = useState(addDaysKey(today, -29));
  const [toInput, setToInput] = useState(today);
  const [applied, setApplied] = useState({ from: addDaysKey(today, -29), to: today });
  const [invalidRange, setInvalidRange] = useState(false);

  // Cash-flow keyset page stack ("Load more" appends; Reset returns to page 1).
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);

  const groupBy = kind === "sales" ? salesGroup : kind === "expenses" ? expenseGroup : null;

  const perfUrl = useMemo(() => {
    const p = new URLSearchParams({ kind, from: applied.from, to: applied.to });
    if (kind === "sales") p.set("groupBy", salesGroup);
    if (kind === "expenses") p.set("groupBy", expenseGroup);
    if (kind === "cashflow") {
      p.set("limit", "25");
      if (direction !== "all") p.set("direction", direction);
    }
    return `/api/v1/reports/performance?${p.toString()}`;
  }, [kind, applied.from, applied.to, salesGroup, expenseGroup, direction]);

  const perfQuery = useQuery<SalesPerf | ExpensePerf | CashFlowPage>({
    queryKey: ["reports", "performance", kind, applied.from, applied.to, salesGroup, expenseGroup, direction],
    queryFn: () => api(perfUrl),
    staleTime: 30_000,
    retry: false,
  });

  // Cursor pages keyed by the stack depth — changing filters resets the stack.
  const cursor = cursorStack[cursorStack.length - 1] ?? null;
  const cashflowQuery = useQuery<CashFlowPage>({
    queryKey: ["reports", "performance", "cashflow-page", applied.from, applied.to, direction, cursorStack.length],
    queryFn: () =>
      api(
        `${perfUrl}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    enabled: kind === "cashflow",
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    retry: false,
  });

  const applyRange = () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromInput) || !/^\d{4}-\d{2}-\d{2}$/.test(toInput)) {
      setInvalidRange(true);
      return;
    }
    if (fromInput > toInput) {
      setInvalidRange(true);
      return;
    }
    setInvalidRange(false);
    setApplied({ from: fromInput, to: toInput });
    setCursorStack([null]);
  };

  const setQuickRange = (days: number) => {
    const to = localTodayKey(business.timezone || "UTC");
    const from = addDaysKey(to, -(days - 1));
    setFromInput(from);
    setToInput(to);
    setInvalidRange(false);
    setApplied({ from, to });
    setCursorStack([null]);
  };

  const fmt = (minor: number) => fmtMoney(business, minor);

  const exportPerf = useMutation({
    mutationFn: async () => {
      const p = new URLSearchParams({ kind, from: applied.from, to: applied.to });
      if (kind === "sales") p.set("groupBy", salesGroup);
      if (kind === "expenses") p.set("groupBy", expenseGroup);
      const res = await fetch(`/api/v1/reports/performance/export?${p.toString()}`, {
        credentials: "same-origin",
        headers: { "x-business-id": business.id },
      });
      if (!res.ok) {
        let message = t("perfExportFailed");
        try {
          const body = (await res.json()) as { error?: { code?: string; message?: string } };
          if (body.error?.code === "EXPORT_TOO_LARGE" || body.error?.code === "EXPORT_INCOMPLETE") {
            message = t("perfExportTooLarge");
          } else if (body.error?.code === "RATE_LIMITED") message = t("csvRateLimited");
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
      a.download = match?.[1] ?? `performance-${kind}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => toast({ title: t("perfExportedToast") }),
    onError: (err) =>
      toast({
        title: billingErrorText(err) || (err instanceof Error ? err.message : tErrors("generic")),
        variant: "destructive",
      }),
  });

  const openEntity = (
    entity: "customer" | "supplier" | "product" | "sale" | "expense" | "payment",
    id: string,
  ) =>
    navigate({ kind: "entity", entity, id });

  const data = perfQuery.data;

  return (
    <Card data-testid="performance-panel">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <BarChart3 className="text-primary size-4" aria-hidden="true" />
          {t("perfTitle")}
        </CardTitle>
        <CardDescription>{t("perfDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Controls */}
        <div className="flex flex-col gap-2 lg:flex-row lg:items-end">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={kind}
              onValueChange={(v) => {
                setKind(v as PerfKind);
                setCursorStack([null]);
              }}
            >
              <SelectTrigger className="h-9 w-full sm:w-44" aria-label={t("perfKind")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sales">{t("perfKindSales")}</SelectItem>
                <SelectItem value="expenses">{t("perfKindExpenses")}</SelectItem>
                <SelectItem value="cashflow">{t("perfKindCashflow")}</SelectItem>
              </SelectContent>
            </Select>
            {kind === "sales" ? (
              <Select
                value={salesGroup}
                onValueChange={(v) => setSalesGroup(v as SalesGroupBy)}
              >
                <SelectTrigger className="h-9 w-full sm:w-40" aria-label={t("perfGroupBy")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="product">{t("perfGroupProduct")}</SelectItem>
                  <SelectItem value="customer">{t("perfGroupCustomer")}</SelectItem>
                  <SelectItem value="day">{t("perfGroupDay")}</SelectItem>
                  <SelectItem value="month">{t("perfGroupMonth")}</SelectItem>
                </SelectContent>
              </Select>
            ) : null}
            {kind === "expenses" ? (
              <Select
                value={expenseGroup}
                onValueChange={(v) => setExpenseGroup(v as ExpenseGroupBy)}
              >
                <SelectTrigger className="h-9 w-full sm:w-40" aria-label={t("perfGroupBy")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="category">{t("perfGroupCategory")}</SelectItem>
                  <SelectItem value="supplier">{t("perfGroupSupplier")}</SelectItem>
                  <SelectItem value="day">{t("perfGroupDay")}</SelectItem>
                  <SelectItem value="month">{t("perfGroupMonth")}</SelectItem>
                </SelectContent>
              </Select>
            ) : null}
            {kind === "cashflow" ? (
              <Select
                value={direction}
                onValueChange={(v) => {
                  setDirection(v as "all" | "IN" | "OUT");
                  setCursorStack([null]);
                }}
              >
                <SelectTrigger className="h-9 w-full sm:w-40" aria-label={t("perfColDirection")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("perfColDirection")}</SelectItem>
                  <SelectItem value="IN">{t("perfDirectionIn")}</SelectItem>
                  <SelectItem value="OUT">{t("perfDirectionOut")}</SelectItem>
                </SelectContent>
              </Select>
            ) : null}
          </div>
          <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
            <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <span>{t("perfFrom")}</span>
              <Input
                type="date"
                value={fromInput}
                max={toInput}
                onChange={(e) => setFromInput(e.target.value)}
                className="h-9 w-36"
                dir="ltr"
                aria-label={t("perfFrom")}
              />
            </label>
            <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <span>{t("perfTo")}</span>
              <Input
                type="date"
                value={toInput}
                min={fromInput}
                onChange={(e) => setToInput(e.target.value)}
                className="h-9 w-36"
                dir="ltr"
                aria-label={t("perfTo")}
              />
            </label>
            <Button size="sm" className="h-9" onClick={applyRange}>
              {t("perfApply")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => exportPerf.mutate()}
              disabled={exportPerf.isPending || !!data?.truncated}
              title={t("perfExport")}
            >
              {exportPerf.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="size-4" aria-hidden="true" />
              )}
              <span className="hidden sm:inline">{t("perfExport")}</span>
              <span className="sr-only">{t("perfExport")}</span>
            </Button>
          </div>
        </div>

        {/* Quick ranges (7/30/90 — same presets as the summary) */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground text-xs">{t("perfPresets")}:</span>
          {[7, 30, 90].map((d) => (
            <Button
              key={d}
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => setQuickRange(d)}
            >
              {t(`range_${d}`)}
            </Button>
          ))}
        </div>

        {invalidRange ? (
          <p role="alert" className="text-destructive text-sm">
            {t("perfInvalidRange")}
          </p>
        ) : null}

        {perfQuery.isLoading || (kind === "cashflow" && cashflowQuery.isLoading) ? (
          <div className="space-y-2" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : perfQuery.error ? (
          <div className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm">
            {t("perfLoadFailed")}{" "}
            <button className="underline" onClick={() => void perfQuery.refetch()}>
              {t("retry")}
            </button>
          </div>
        ) : !data ? null : (
          <PerfBody
            data={data}
            cashflow={kind === "cashflow" ? cashflowQuery.data ?? null : null}
            fmt={fmt}
            uiLocale={uiLocale}
            openEntity={openEntity}
            onLoadMore={() => {
              if (cashflowQuery.data?.nextCursor) {
                setCursorStack((s) => [...s, cashflowQuery.data.nextCursor]);
              }
            }}
            canLoadMore={!!cashflowQuery.data?.nextCursor}
            onPrevPage={() => setCursorStack((s) => (s.length > 1 ? s.slice(0, -1) : s))}
            pagesUsed={cursorStack.length}
          />
        )}
      </CardContent>
    </Card>
  );
}

function PerfBody({
  data,
  cashflow,
  fmt,
  uiLocale,
  openEntity,
  onLoadMore,
  canLoadMore,
  onPrevPage,
  pagesUsed,
}: {
  data: SalesPerf | ExpensePerf | CashFlowPage;
  cashflow: CashFlowPage | null;
  fmt: (minor: number) => string;
  uiLocale: string;
  openEntity: (
    entity: "customer" | "supplier" | "product" | "sale" | "expense" | "payment",
    id: string,
  ) => void;
  onLoadMore: () => void;
  canLoadMore: boolean;
  onPrevPage: () => void;
  pagesUsed: number;
}) {
  const t = useTranslations("reports");
  const fmtDay = (key: string) => {
    try {
      return new Intl.DateTimeFormat(uiLocale === "fa" ? "fa-IR" : "en-US", {
        dateStyle: "medium",
        timeZone: "UTC",
      }).format(new Date(`${key}T00:00:00Z`));
    } catch {
      return key;
    }
  };
  const fmtMonth = (key: string) => {
    try {
      return new Intl.DateTimeFormat(uiLocale === "fa" ? "fa-IR" : "en-US", {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${key}-01T00:00:00Z`));
    } catch {
      return key;
    }
  };

  if (data.kind === "sales") {
    const r = data;
    return (
      <div className="space-y-3">
        <TotalsStrip
          cells={[
            { label: t("perfRevenue"), value: fmt(r.totals.revenueMinor) },
            { label: t("perfInvoices", { count: fmtCount(uiLocale, r.totals.invoiceCount) }), value: "" },
            { label: t("perfLineValue"), value: fmt(r.totals.lineValueMinor) },
            { label: t("perfDiscount"), value: fmt(r.totals.discountMinor) },
            { label: t("perfNetValue"), value: fmt(r.totals.netLineValueMinor) },
          ]}
          notes={[t("perfBasisRevenue"), r.groupBy === "product" ? t("perfBasisNet") : null]}
        />
        {r.truncated ? (
          <p className="text-amber-700 dark:text-amber-400 flex items-center gap-1.5 text-xs">
            <TriangleAlert className="size-3.5" aria-hidden="true" />
            {t("perfTruncated", { cap: 20000 })}
          </p>
        ) : null}
        {r.groupTruncated ? (
          <p className="text-muted-foreground text-xs">{t("perfGroupTruncated", { cap: 500 })}</p>
        ) : null}
        {r.groups.length === 0 ? (
          <p className="text-muted-foreground rounded-md border border-dashed px-3 py-4 text-sm">
            {t("perfEmpty")}
          </p>
        ) : r.groupBy === "product" ? (
          <DataTable<Extract<(typeof r.groups)[number], { dimension: "product" }>>
            ariaLabel={t("perfKindSales")}
            sortLocale={uiLocale}
            maxHeightClass="max-h-96"
            onRowClick={(row) =>
              row.productId ? openEntity("product", row.productId) : undefined
            }
            columns={[
              {
                id: "name",
                header: t("perfColProduct"),
                cell: (row) => (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate" dir="auto">{row.name}</span>
                    {row.kind === "unlinked" ? (
                      <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
                        {t("perfColUnlinked")}
                      </Badge>
                    ) : null}
                  </span>
                ),
              },
              {
                id: "qty",
                header: t("perfColQty"),
                align: "end",
                sortValue: (row) => row.qtySold,
                cell: (row) => <Ltr>{fmtCount(uiLocale, row.qtySold)}</Ltr>,
              },
              {
                id: "invoices",
                header: t("perfColInvoices"),
                align: "end",
                sortValue: (row) => row.invoiceCount,
                cell: (row) => <Ltr>{fmtCount(uiLocale, row.invoiceCount)}</Ltr>,
              },
              {
                id: "lineValue",
                header: t("perfColLineValue"),
                align: "end",
                sortValue: (row) => row.lineValueMinor,
                cell: (row) => <Ltr>{fmt(row.lineValueMinor)}</Ltr>,
              },
              {
                id: "netValue",
                header: t("perfColNetValue"),
                align: "end",
                defaultSortDir: "desc",
                sortValue: (row) => row.netValueMinor,
                cell: (row) => <Ltr className="font-medium">{fmt(row.netValueMinor)}</Ltr>,
              },
            ]}
            rows={r.groups.filter((g): g is Extract<(typeof r.groups)[number], { dimension: "product" }> => g.dimension === "product")}
            getRowId={(row) => row.productId ?? `u:${row.name}`}
          />
        ) : r.groupBy === "customer" ? (
          <DataTable<Extract<(typeof r.groups)[number], { dimension: "customer" }>>
            ariaLabel={t("perfKindSales")}
            sortLocale={uiLocale}
            maxHeightClass="max-h-96"
            onRowClick={(row) =>
              row.customerId ? openEntity("customer", row.customerId) : undefined
            }
            columns={[
              {
                id: "name",
                header: t("perfColCustomer"),
                cell: (row) => (
                  <span className="truncate" dir="auto">
                    {row.name ?? t("perfColNoCustomer")}
                  </span>
                ),
              },
              {
                id: "invoices",
                header: t("perfColInvoices"),
                align: "end",
                sortValue: (row) => row.invoiceCount,
                cell: (row) => <Ltr>{fmtCount(uiLocale, row.invoiceCount)}</Ltr>,
              },
              {
                id: "revenue",
                header: t("perfColRevenue"),
                align: "end",
                defaultSortDir: "desc",
                sortValue: (row) => row.revenueMinor,
                cell: (row) => <Ltr className="font-medium">{fmt(row.revenueMinor)}</Ltr>,
              },
            ]}
            rows={r.groups.filter((g): g is Extract<(typeof r.groups)[number], { dimension: "customer" }> => g.dimension === "customer")}
            getRowId={(row) => row.customerId ?? "__unassigned__"}
          />
        ) : (
          <DataTable<Extract<(typeof r.groups)[number], { dimension: "day" | "month" }>>
            ariaLabel={t("perfKindSales")}
            sortLocale={uiLocale}
            maxHeightClass="max-h-96"
            columns={[
              {
                id: "bucket",
                header: r.groupBy === "day" ? t("perfColDate") : t("perfColMonth"),
                cell: (row) => (
                  <span dir="auto">
                    {"date" in row ? fmtDay(row.date) : fmtMonth(row.month)}
                  </span>
                ),
              },
              {
                id: "invoices",
                header: t("perfColInvoices"),
                align: "end",
                sortValue: (row) => row.invoiceCount,
                cell: (row) => <Ltr>{fmtCount(uiLocale, row.invoiceCount)}</Ltr>,
              },
              {
                id: "revenue",
                header: t("perfColRevenue"),
                align: "end",
                sortValue: (row) => row.revenueMinor,
                cell: (row) => <Ltr className="font-medium">{fmt(row.revenueMinor)}</Ltr>,
              },
            ]}
            rows={r.groups.filter((g): g is Extract<(typeof r.groups)[number], { dimension: "day" | "month" }> => g.dimension === "day" || g.dimension === "month")}
            getRowId={(row) => ("date" in row ? row.date : row.month)}
          />
        )}
      </div>
    );
  }

  if (data.kind === "expenses") {
    const r = data;
    return (
      <div className="space-y-3">
        <TotalsStrip
          cells={[
            { label: t("perfExpenseAmount"), value: fmt(r.totals.amountMinor) },
            { label: t("perfExpenseCount", { count: fmtCount(uiLocale, r.totals.expenseCount) }), value: "" },
          ]}
          notes={[t("perfBasisExpense")]}
        />
        {r.truncated ? (
          <p className="text-amber-700 dark:text-amber-400 flex items-center gap-1.5 text-xs">
            <TriangleAlert className="size-3.5" aria-hidden="true" />
            {t("perfTruncated", { cap: 20000 })}
          </p>
        ) : null}
        {r.groupTruncated ? (
          <p className="text-muted-foreground text-xs">{t("perfGroupTruncated", { cap: 500 })}</p>
        ) : null}
        {r.groups.length === 0 ? (
          <p className="text-muted-foreground rounded-md border border-dashed px-3 py-4 text-sm">
            {t("perfEmpty")}
          </p>
        ) : r.groupBy === "category" ? (
          <DataTable<Extract<(typeof r.groups)[number], { dimension: "category" }>>
            ariaLabel={t("perfKindExpenses")}
            sortLocale={uiLocale}
            maxHeightClass="max-h-96"
            columns={[
              {
                id: "category",
                header: t("perfColCategory"),
                cell: (row) => <span className="truncate" dir="auto">{row.category}</span>,
              },
              {
                id: "count",
                header: t("perfExpenseCount", { count: "" }),
                align: "end",
                sortValue: (row) => row.expenseCount,
                cell: (row) => <Ltr>{fmtCount(uiLocale, row.expenseCount)}</Ltr>,
              },
              {
                id: "amount",
                header: t("perfColAmount"),
                align: "end",
                defaultSortDir: "desc",
                sortValue: (row) => row.amountMinor,
                cell: (row) => <Ltr className="font-medium">{fmt(row.amountMinor)}</Ltr>,
              },
            ]}
            rows={r.groups.filter((g): g is Extract<(typeof r.groups)[number], { dimension: "category" }> => g.dimension === "category")}
            getRowId={(row) => row.category}
          />
        ) : r.groupBy === "supplier" ? (
          <DataTable<Extract<(typeof r.groups)[number], { dimension: "supplier" }>>
            ariaLabel={t("perfKindExpenses")}
            sortLocale={uiLocale}
            maxHeightClass="max-h-96"
            onRowClick={(row) =>
              row.supplierId ? openEntity("supplier", row.supplierId) : undefined
            }
            columns={[
              {
                id: "name",
                header: t("perfColSupplier"),
                cell: (row) => (
                  <span className="truncate" dir="auto">
                    {row.name ?? t("perfColNoSupplier")}
                  </span>
                ),
              },
              {
                id: "count",
                header: t("perfExpenseCount", { count: "" }),
                align: "end",
                sortValue: (row) => row.expenseCount,
                cell: (row) => <Ltr>{fmtCount(uiLocale, row.expenseCount)}</Ltr>,
              },
              {
                id: "amount",
                header: t("perfColAmount"),
                align: "end",
                defaultSortDir: "desc",
                sortValue: (row) => row.amountMinor,
                cell: (row) => <Ltr className="font-medium">{fmt(row.amountMinor)}</Ltr>,
              },
            ]}
            rows={r.groups.filter((g): g is Extract<(typeof r.groups)[number], { dimension: "supplier" }> => g.dimension === "supplier")}
            getRowId={(row) => row.supplierId ?? "__unassigned__"}
          />
        ) : (
          <DataTable<Extract<(typeof r.groups)[number], { dimension: "day" | "month" }>>
            ariaLabel={t("perfKindExpenses")}
            sortLocale={uiLocale}
            maxHeightClass="max-h-96"
            columns={[
              {
                id: "bucket",
                header: r.groupBy === "day" ? t("perfColDate") : t("perfColMonth"),
                cell: (row) => (
                  <span dir="auto">{"date" in row ? fmtDay(row.date) : fmtMonth(row.month)}</span>
                ),
              },
              {
                id: "count",
                header: t("perfExpenseCount", { count: "" }),
                align: "end",
                sortValue: (row) => row.expenseCount,
                cell: (row) => <Ltr>{fmtCount(uiLocale, row.expenseCount)}</Ltr>,
              },
              {
                id: "amount",
                header: t("perfColAmount"),
                align: "end",
                sortValue: (row) => row.amountMinor,
                cell: (row) => <Ltr className="font-medium">{fmt(row.amountMinor)}</Ltr>,
              },
            ]}
            rows={r.groups.filter((g): g is Extract<(typeof r.groups)[number], { dimension: "day" | "month" }> => g.dimension === "day" || g.dimension === "month")}
            getRowId={(row) => ("date" in row ? row.date : row.month)}
          />
        )}
      </div>
    );
  }

  // cashflow
  const page = cashflow ?? (data as CashFlowPage);
  return (
    <div className="space-y-3">
      <TotalsStrip
        cells={[
          { label: t("perfCollected"), value: fmt(page.totals.collectedMinor) },
          { label: t("perfPaidOut"), value: fmt(page.totals.paidOutMinor) },
          {
            label: t("perfNetCash"),
            value: fmt(page.totals.netCashMinor),
            tone:
              page.totals.netCashMinor >= 0
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-rose-700 dark:text-rose-400",
          },
          { label: t("perfPayments", { count: fmtCount(uiLocale, page.totals.paymentCount) }), value: "" },
        ]}
        notes={[t("perfBasisCash")]}
      />
      {page.rows.length === 0 ? (
        <p className="text-muted-foreground rounded-md border border-dashed px-3 py-4 text-sm">
          {t("perfEmpty")}
        </p>
      ) : (
        <DataTable<(typeof page.rows)[number]>
          ariaLabel={t("perfKindCashflow")}
          sortLocale={uiLocale}
          maxHeightClass="max-h-96"
          onRowClick={(row) =>
            row.sale ? openEntity("sale", row.sale.id)
            : row.expense ? openEntity("expense", row.expense.id)
            : openEntity("payment", row.id)
          }
          columns={[
            {
              id: "date",
              header: t("perfColDate"),
              sortValue: (row) => row.date,
              cell: (row) => <span dir="auto">{fmtDay(row.date)}</span>,
            },
            {
              id: "direction",
              header: t("perfColDirection"),
              cell: (row) => (
                <Badge
                  variant="outline"
                  className={
                    row.direction === "IN"
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 text-[11px] dark:text-emerald-400"
                      : "border-rose-500/30 bg-rose-500/10 text-rose-700 text-[11px] dark:text-rose-400"
                  }
                >
                  {row.direction === "IN" ? t("perfDirectionIn") : t("perfDirectionOut")}
                </Badge>
              ),
            },
            {
              id: "amount",
              header: t("perfColAmount"),
              align: "end",
              defaultSortDir: "desc",
              sortValue: (row) => row.amountMinor,
              cell: (row) => <Ltr className="font-medium">{fmt(row.amountMinor)}</Ltr>,
            },
            {
              id: "method",
              header: t("perfColMethod"),
              cell: (row) => <span className="text-muted-foreground text-xs">{row.method}</span>,
            },
            {
              id: "source",
              header: t("perfColSource"),
              cell: (row) =>
                row.sale ? (
                  <span className="flex items-center gap-1 text-xs">
                    <ReceiptText className="size-3 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                    <Ltr>#{String(row.sale.number).padStart(4, "0")}</Ltr>
                  </span>
                ) : row.expense ? (
                  <span className="flex min-w-0 items-center gap-1 text-xs">
                    <Coins className="size-3 shrink-0 text-rose-600 dark:text-rose-400" aria-hidden="true" />
                    <span className="truncate" dir="auto">
                      {row.expense.reference ?? row.expense.category}
                    </span>
                  </span>
                ) : (
                  <span className="text-muted-foreground text-xs">{t("perfNoSource")}</span>
                ),
            },
            {
              id: "open",
              header: <span className="sr-only">{t("perfOpenSource")}</span>,
              align: "end",
              cell: (row) => (
                <span
                  className="text-muted-foreground inline-flex items-center"
                  aria-hidden="true"
                >
                  <ExternalLink className="size-3.5" />
                </span>
              ),
            },
          ]}
          rows={page.rows}
          getRowId={(row) => row.id}
        />
      )}
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">
          {canLoadMore
            ? `${fmtCount(uiLocale, page.rows.length)} · ${pagesUsed}`
            : t("perfEndOfPages")}
        </p>
        <div className="flex items-center gap-2">
          {pagesUsed > 1 ? (
            <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={onPrevPage}>
              <ChevronRight className="size-3 rtl:-scale-x-100" aria-hidden="true" />
              {t("perfPrevPage")}
            </Button>
          ) : null}
          {canLoadMore ? (
            <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={onLoadMore}>
              {t("perfNextPage")}
              <ChevronLeft className="size-3 rtl:-scale-x-100" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TotalsStrip({
  cells,
  notes,
}: {
  cells: Array<{ label: string; value: string; tone?: string }>;
  notes: Array<string | null>;
}) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {cells.map((c) => (
          <div key={c.label} className="bg-muted/40 rounded-lg border p-2.5">
            <p className="text-muted-foreground line-clamp-2 text-[11px] font-medium uppercase">
              {c.label}
            </p>
            {c.value ? (
              <p className={cn("mt-0.5 text-sm font-semibold tabular-nums", c.tone)} dir="ltr">
                {c.value}
              </p>
            ) : null}
          </div>
        ))}
      </div>
      {notes.filter(Boolean).map((n) => (
        <p key={n} className="text-muted-foreground text-[11px]">
          {n}
        </p>
      ))}
    </div>
  );
}
