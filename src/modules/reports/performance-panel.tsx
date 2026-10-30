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
  Bot,
  ChevronLeft,
  ChevronRight,
  Coins,
  Crown,
  Download,
  ExternalLink,
  Loader2,
  ReceiptText,
  TriangleAlert,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { JalaliRangePresets } from "@/components/shared/jalali-range-presets";
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
// R101 (restored R136) — the leader fact: the panel cites its OWN rank 1
// (the R99 throne grammar's fourth surface). The extractor NEVER re-ranks
// — groups[0] verbatim under the silence laws.
import { perfLeaderFact, type PerfLeaderDrill, type PerfLeaderFact } from "@/lib/perf-leader";
// The ONE share law (stock-facts): the crown's % rides the SAME capped,
// non-positive-denominator-silent math as the inventory throne.
import { stockSharePercent } from "@/lib/stock-facts";

export type SalesGroupBy = "product" | "customer" | "day" | "month";
export type ExpenseGroupBy = "category" | "supplier" | "day" | "month";
export type PerfKind = "sales" | "expenses" | "cashflow";

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

export function PerformancePanel({
  business,
  initialKind,
  initialWindow,
  initialDirection,
  onCommitState,
}: {
  business: BusinessSummary;
  /** R136 — the perf sub-view's preselection (the store's closed-token
   *  grammar reader). Undefined on the inline (advanced-insights) mount —
   *  the panel then behaves exactly as before (local state only). */
  initialKind?: PerfKind;
  initialWindow?: { from: string; to: string };
  initialDirection?: "IN" | "OUT";
  /** R136 — sub-view write-back: the hash IS the state. Every USER-driven
   *  kind/window/direction change is echoed to the URL so the perf deep
   *  link's copy button shares the truth the user is looking at. */
  onCommitState?: (s: {
    kind: PerfKind;
    window: { from: string; to: string };
    direction: "all" | "IN" | "OUT";
  }) => void;
}) {
  const t = useTranslations("reports");
  const tErrors = useTranslations("errors");
  const billingErrorText = useBillingErrorText();
  const uiLocale = useLocale();
  const navigate = useAppStore((s) => s.navigate);

  const [kind, setKind] = useState<PerfKind>(initialKind ?? "sales");
  const [salesGroup, setSalesGroup] = useState<SalesGroupBy>("product");
  const [expenseGroup, setExpenseGroup] = useState<ExpenseGroupBy>("category");
  const [direction, setDirection] = useState<"all" | "IN" | "OUT">(initialDirection ?? "all");

  // Default window: the last 30 business-local days (display default only —
  // the server re-validates and re-derives every boundary). The sub-view's
  // preselected window (the deep link's own BOTH-or-nothing pair) wins.
  const today = localTodayKey(business.timezone || "UTC");
  const [fromInput, setFromInput] = useState(initialWindow?.from ?? addDaysKey(today, -29));
  const [toInput, setToInput] = useState(initialWindow?.to ?? today);
  const [applied, setApplied] = useState({
    from: initialWindow?.from ?? addDaysKey(today, -29),
    to: initialWindow?.to ?? today,
  });
  const [invalidRange, setInvalidRange] = useState(false);

  // Cash-flow keyset page stack ("Load more" appends; Reset returns to page 1).
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);

  // R136 — external preselection ADOPTION (the R100 re-entry law): a SECOND
  // chip with a different window must re-preselect an ALREADY-MOUNTED
  // panel. Uses React's sanctioned render-time adjustment pattern (the
  // previous-value STATE law — the auth-view adoptedStoreMode precedent;
  // a setState-in-effect is a cascading-render hazard the lint forbids).
  // Our OWN write-back echoes the same signature back — the pushed-sig
  // STATE swallows that echo (no reset of the user's other local state).
  const extSig = `${initialKind ?? ""}|${initialWindow?.from ?? ""}|${initialWindow?.to ?? ""}|${initialDirection ?? ""}`;
  const [adoptedSig, setAdoptedSig] = useState<string | null>(initialKind ? extSig : null);
  const [pushedSig, setPushedSig] = useState<string | null>(null);
  if (initialKind && adoptedSig !== extSig) {
    setAdoptedSig(extSig);
    if (pushedSig !== extSig) {
      setKind(initialKind);
      if (initialWindow) {
        setFromInput(initialWindow.from);
        setToInput(initialWindow.to);
        setApplied({ from: initialWindow.from, to: initialWindow.to });
        setCursorStack([null]);
      }
      setDirection(initialDirection ?? "all");
    }
  }

  /** The sub-view write-back (no-op inline): the URL receives EXACTLY the
   *  grammar the parser accepts — the window only as a complete ordered
   *  pair, the direction cashflow-only. The signature is remembered so
   *  the echo never re-preselects. */
  const pushUrlState = (k: PerfKind, win: { from: string; to: string }, dir: "all" | "IN" | "OUT") => {
    if (!onCommitState) return;
    setPushedSig(`${k}|${win.from}|${win.to}|${dir}`);
    onCommitState({ kind: k, window: win, direction: dir });
  };

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
    pushUrlState(kind, { from: fromInput, to: toInput }, direction);
  };

  // §F4 — apply an explicit window (used by the Jalali presets).
  const applyRangeWith = (from: string, to: string) => {
    setFromInput(from);
    setToInput(to);
    setInvalidRange(false);
    setApplied({ from, to });
    setCursorStack([null]);
    pushUrlState(kind, { from, to }, direction);
  };

  const setQuickRange = (days: number) => {
    const to = localTodayKey(business.timezone || "UTC");
    const from = addDaysKey(to, -(days - 1));
    setFromInput(from);
    setToInput(to);
    setInvalidRange(false);
    setApplied({ from, to });
    setCursorStack([null]);
    pushUrlState(kind, { from, to }, direction);
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

  // R144 — the ASK-THE-COPILOT handoff (the reverse of R143's perf chips:
  // those navigate copilot → reports, this one reports → copilot). The
  // composed question names ONLY what the copilot's own grounded facts can
  // honestly answer (top product / biggest expense category / recorded
  // payments over the copilot's OWN default window) — it never promises
  // the panel's custom range, because the copilot's tools compute their
  // own window. The navigation PRE-SEEDS the composer draft (?ask=…); the
  // send stays the user's action (seed-not-send, the meter law).
  const askQuestion =
    kind === "sales"
      ? t("perfAskSales")
      : kind === "expenses"
        ? t("perfAskExpenses")
        : t("perfAskCashflow");
  const askCopilot = () => navigate({ kind: "module", module: "copilot", ask: askQuestion });

  return (
    <Card data-testid="performance-panel">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <BarChart3 className="text-primary size-4" aria-hidden="true" />
          {t("perfTitle")}
          <Button
            variant="outline"
            size="sm"
            className="text-primary hover:bg-primary/5 border-primary/30 hover:border-primary/50 ms-auto h-7 gap-1.5 rounded-full px-2.5 text-[11px] font-medium"
            onClick={askCopilot}
            title={t("perfAskHint")}
            aria-label={t("perfAskHint")}
            data-testid="perf-ask-copilot"
          >
            <Bot className="size-3.5" aria-hidden="true" />
            {t("perfAskCopilot")}
          </Button>
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
                pushUrlState(v as PerfKind, applied, direction);
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
                  pushUrlState(kind, applied, v as "all" | "IN" | "OUT");
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
          {/* Prompt 52 §F4 — Jalali presets fill the Gregorian inputs
              (server stays the single date authority). */}
          <JalaliRangePresets
            className="w-full"
            value={{ from: fromInput, to: toInput }}
            onChange={(r) => {
              if (r) {
                setFromInput(r.from);
                setToInput(r.to);
                applyRangeWith(r.from, r.to);
              }
            }}
          />
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
    // R101 — the panel cites its OWN rank 1 (groups[0] verbatim — the
    // server's value-DESC head; the extractor never re-ranks). The
    // unassigned mass is crowned under the table's own fallback label.
    const leader = perfLeaderFact(r, t("perfColNoCustomer"));
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
        {leader ? (
          <LeaderStrip
            fact={leader}
            tone="emerald"
            fmt={fmt}
            uiLocale={uiLocale}
            onDrill={(d) => openEntity(d.entity, d.id)}
          />
        ) : null}
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
    // R101 — the expense side crowns under the supplier fallback (the
    // anonymous supplier mass can legitimately lead — citation, never a
    // fake destination).
    const leader = perfLeaderFact(r, t("perfColNoSupplier"));
    return (
      <div className="space-y-3">
        <TotalsStrip
          cells={[
            { label: t("perfExpenseAmount"), value: fmt(r.totals.amountMinor) },
            { label: t("perfExpenseCount", { count: fmtCount(uiLocale, r.totals.expenseCount) }), value: "" },
          ]}
          notes={[t("perfBasisExpense")]}
        />
        {leader ? (
          <LeaderStrip
            fact={leader}
            tone="violet"
            fmt={fmt}
            uiLocale={uiLocale}
            onDrill={(d) => openEntity(d.entity, d.id)}
          />
        ) : null}
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

/**
 * R101 (restored R136) — THE LEADER STRIP: the performance panel cites its
 * OWN rank 1 — the R99 throne grammar's fourth surface (summary card chips,
 * dashboard tile, copilot chips, and now the perf table's own crown).
 *
 * Laws (each pinned by scripts/r101-leader-unit.ts):
 * - DIMENSION tones: sales = emerald, expenses = violet — the strip speaks
 *   the same tone families as the tables it crowns (never a second hue);
 * - the share bar is the ONE share law (stockSharePercent — the throne's
 *   own math) gated by the same-basis law (totalMinor > 0 && valueMinor
 *   > 0) and hidden below sm (the mobile law — a crown never crowds a
 *   320px row);
 * - the tooltip is formatted INSIDE the component (the R99
 *   FORMATTING_ERROR lesson): the drill variant names the destination,
 *   the plain variant is the honest citation;
 * - identity law: a rank-1 WITH a stable id renders a real button that
 *   drills (product/customer/supplier entity routes); WITHOUT one renders
 *   a static citation (cursor-default, no chevron, no fake page);
 * - the chevron is RTL-mirrored with the hover nudge (W20's throne law);
 * - money is exact LTR (dir="ltr"), counts localize via fmtCount.
 */
function LeaderStrip({
  fact,
  tone,
  fmt,
  uiLocale,
  onDrill,
}: {
  fact: PerfLeaderFact;
  tone: "emerald" | "violet";
  fmt: (minor: number) => string;
  uiLocale: string;
  onDrill: (drill: PerfLeaderDrill) => void;
}) {
  const t = useTranslations("reports");
  const { name, valueMinor, totalMinor, drill } = fact;
  const money = fmt(valueMinor);
  const tooltip = drill
    ? t("perfLeaderTooltipDrill", { name, money })
    : t("perfLeaderTooltipPlain", { name, money });
  const share = stockSharePercent(valueMinor, totalMinor);
  const TONES = {
    emerald: {
      icon: "text-emerald-600 dark:text-emerald-400",
      text: "text-emerald-800 dark:text-emerald-300",
      border: "border-emerald-600/25",
      borderHover: "hover:border-emerald-600/45",
      bg: "bg-emerald-600/[0.04] hover:bg-emerald-600/10",
      track: "bg-emerald-600/15",
      fill: "bg-emerald-600/60",
    },
    violet: {
      icon: "text-violet-600 dark:text-violet-400",
      text: "text-violet-800 dark:text-violet-300",
      border: "border-violet-600/25",
      borderHover: "hover:border-violet-600/45",
      bg: "bg-violet-600/[0.04] hover:bg-violet-600/10",
      track: "bg-violet-600/15",
      fill: "bg-violet-600/60",
    },
  } as const;
  const tn = TONES[tone];
  const body = (
    <>
      <Crown className={`size-3.5 shrink-0 ${tn.icon}`} aria-hidden="true" />
      <span className={`min-w-0 truncate text-xs font-medium ${tn.text}`}>
        {t("perfLeaderCaption", { name })}
      </span>
      {/* The share bar renders only on an honest same-basis denominator:
          totalMinor > 0 && valueMinor > 0 (the throne's own gate; the
          stockSharePercent math is silent on the same cases — belt and
          suspenders that can never disagree). */}
      {totalMinor > 0 && valueMinor > 0 ? (
        <span
          className="hidden min-w-0 flex-1 items-center gap-1.5 sm:flex"
          aria-hidden="true"
          title={share !== null ? t("perfShareTooltip", { percent: fmtCount(uiLocale, share) }) : undefined}
        >
          <span className={`h-1 min-w-0 flex-1 overflow-hidden rounded-full ${tn.track}`}>
            <span
              className={`h-1 rounded-full transition-[width] duration-500 motion-reduce:transition-none ${tn.fill}`}
              style={{ width: `${share ?? 0}%` }}
            />
          </span>
          {share !== null ? (
            <span className={`shrink-0 text-[10px] tabular-nums ${tn.text}`}>
              {t("perfLeaderShareShort", { percent: fmtCount(uiLocale, share) })}
            </span>
          ) : null}
        </span>
      ) : null}
      <span className={`shrink-0 text-xs font-semibold tabular-nums ${tn.text}`} dir="ltr">
        {money}
      </span>
    </>
  );
  if (!drill) {
    return (
      <div
        className={`flex w-full cursor-default items-center gap-2 rounded-lg border px-3 py-1.5 ${tn.border} bg-muted/30`}
        title={tooltip}
        data-testid={`perf-leader-${tone}`}
      >
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onDrill(drill)}
      className={`group flex w-full items-center gap-2 rounded-lg border px-3 py-1.5 text-start transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background ${tn.border} ${tn.borderHover} ${tn.bg}`}
      title={tooltip}
      aria-label={tooltip}
      data-testid={`perf-leader-${tone}`}
    >
      {body}
      <ChevronRight
        className={`size-3.5 shrink-0 opacity-70 transition-transform rtl:-scale-x-100 group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5 ${tn.icon}`}
        aria-hidden="true"
      />
    </button>
  );
}
