"use client";

/**
 * Prompt 51 (§8) — Detailed Inventory Valuation panel for the Reports
 * module. The row-level truth behind the summary's operational inventory
 * estimate: current stock × current cost for EVERY included product.
 *
 * Every figure comes from /api/v1/reports/inventory-valuation — the UI
 * never recomputes anything (Rule 05). Sorting is server-side over the
 * COMPLETE matching set; the client never sorts one page and implies it
 * sorted the whole result (§6.3 — no client sortValue is wired).
 *
 * LAWS (ADR 0051):
 *  - The valuation basis disclosure is always visible (§8.6) and the
 *    wording never claims accounting concepts (no asset value, FIFO,
 *    balance sheet, COGS, profit).
 *  - Zero current cost is a neutral review flag — never an accusation,
 *    never auto-corrected, no purchase price is ever suggested (§8.5).
 *  - Products navigate by STABLE id (entity route) — never by name.
 *  - Filters refetch server-authoritative data; no stale totals are shown
 *    under a new filter selection (no placeholderData).
 *  - Quantities of different units are never summed into one grand total.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import {
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Info,
  Link2,
  Loader2,
  PackageSearch,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { api } from "@/lib/api-client";
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
import { EmptyState } from "@/components/shared/primitives";
import { cn } from "@/lib/utils";
import { fmtCount, fmtMoney } from "../finance-shared/finance-kit";
import type { BusinessSummary } from "../shell/types";

type InvValRow = {
  id: string;
  name: string;
  sku: string | null;
  unit: string | null;
  stockQty: number;
  lowStockAt: number;
  costPriceMinor: number;
  estimatedValueMinor: number;
  isActive: boolean;
  stockState: "POSITIVE_STOCK" | "LOW_STOCK" | "ZERO_STOCK" | "NEGATIVE_STOCK";
  costState: "POSITIVE_COST" | "ZERO_COST";
};

type InvValReport = {
  basis: "current_operational_estimate";
  formula: string;
  currencyCode: string;
  decimalPrecision: number;
  filters: {
    q: string | null;
    costState: string;
    stockState: string;
    activity: string;
    sort: string;
    page: number;
    pageSize: number;
  };
  filtersActive: boolean;
  totals: {
    estimatedValueMinor: number;
    productCount: number;
    positiveStockCount: number;
    zeroStockCount: number;
    negativeStockCount: number;
    zeroCostPositiveStockCount: number;
    inactiveCount: number;
    lowStockCount: number;
  };
  scan: { complete: true; cap: number };
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
    hasMore: boolean;
  };
  rows: InvValRow[];
};

const SORTS = [
  "VALUE_DESC",
  "VALUE_ASC",
  "NAME_ASC",
  "NAME_DESC",
  "QUANTITY_DESC",
  "QUANTITY_ASC",
  "COST_DESC",
] as const;
const PAGE_SIZES = ["10", "25", "50", "100"] as const;

/** Explicit sort-key → i18n key map (never string-derived — typo-proof). */
const SORT_LABEL_KEYS: Record<Sort, string> = {
  VALUE_DESC: "invValSortValueDesc",
  VALUE_ASC: "invValSortValueAsc",
  NAME_ASC: "invValSortNameAsc",
  NAME_DESC: "invValSortNameDesc",
  QUANTITY_DESC: "invValSortQtyDesc",
  QUANTITY_ASC: "invValSortQtyAsc",
  COST_DESC: "invValSortCostDesc",
};

type CostState = "ALL" | "POSITIVE_COST" | "ZERO_COST";
type StockState = "ALL" | "POSITIVE_STOCK" | "ZERO_STOCK" | "LOW_STOCK";
type Activity = "ALL" | "ACTIVE" | "INACTIVE";
type Sort = (typeof SORTS)[number];

export function InventoryValuationPanel({ business }: { business: BusinessSummary }) {
  const t = useTranslations("reports");
  const tErrors = useTranslations("errors");
  const billingErrorText = useBillingErrorText();
  const uiLocale = useLocale();
  const navigate = useAppStore((s) => s.navigate);

  // Filter state — the DEFAULT state is documented: everything included,
  // value descending. Reset returns exactly here.
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState<string | null>(null);
  const [costState, setCostState] = useState<CostState>("ALL");
  const [stockState, setStockState] = useState<StockState>("ALL");
  const [activity, setActivity] = useState<Activity>("ALL");
  const [sort, setSort] = useState<Sort>("VALUE_DESC");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  // R103 — the copy-deep-link inline feedback (2s icon+label swap).
  const [linkCopied, setLinkCopied] = useState(false);

  // Debounced search — 300 ms after the last keystroke.
  useEffect(() => {
    const handle = setTimeout(() => {
      const trimmed = searchInput.trim();
      setQ(trimmed === "" ? null : trimmed);
      setPage(1);
    }, 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const changeFilter = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setPage(1); // a dataset change always restarts pagination
  };

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (costState !== "ALL") params.set("costState", costState);
  if (stockState !== "ALL") params.set("stockState", stockState);
  if (activity !== "ALL") params.set("activity", activity);
  if (sort !== "VALUE_DESC") params.set("sort", sort);
  params.set("page", String(page));
  params.set("pageSize", String(pageSize));

  // The export carries ONLY the dataset filters — pagination state is
  // meaningless for a complete-file export (the server exports every
  // matching row regardless of the current page).
  const exportParams = new URLSearchParams();
  if (q) exportParams.set("q", q);
  if (costState !== "ALL") exportParams.set("costState", costState);
  if (stockState !== "ALL") exportParams.set("stockState", stockState);
  if (activity !== "ALL") exportParams.set("activity", activity);
  if (sort !== "VALUE_DESC") exportParams.set("sort", sort);

  const { data, isLoading, error, refetch, isFetching } = useQuery<InvValReport>({
    queryKey: ["reports", "inventory-valuation", q, costState, stockState, activity, sort, page, pageSize],
    queryFn: () => api(`/api/v1/reports/inventory-valuation?${params.toString()}`),
    staleTime: 15_000,
    // No placeholderData: a NEW filter selection must never display the
    // PREVIOUS selection's financial totals (§8.7).
  });

  const resetFilters = () => {
    setSearchInput("");
    setQ(null);
    setCostState("ALL");
    setStockState("ALL");
    setActivity("ALL");
    setSort("VALUE_DESC");
    setPage(1);
    setPageSize(25);
  };

  // CSV export — server-generated from the SAME calculation (single source
  // of truth); the client only streams the blob to a file.
  const exportCsv = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v1/reports/inventory-valuation/export?${exportParams.toString()}`, {
        credentials: "same-origin",
        headers: useAppStore.getState().activeBusinessId
          ? { "x-business-id": useAppStore.getState().activeBusinessId ?? "" }
          : undefined,
      });
      if (!res.ok) {
        let message = t("invValExportFailed");
        let code = "";
        try {
          const body = (await res.json()) as { error?: { code?: string; message?: string } };
          code = body.error?.code ?? "";
          if (code === "RATE_LIMITED") message = t("csvRateLimited");
          else if (code === "EXPORT_TOO_LARGE" || code === "REPORT_TOO_LARGE") message = t("invValExportTooLarge");
          else if (body.error?.message) message = body.error.message;
        } catch {
          // keep default
        }
        throw Object.assign(new Error(message), { code });
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const dispo = res.headers.get("content-disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(dispo);
      a.download = match?.[1] ?? "inventory-valuation.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => toast({ title: t("invValExportedToast") }),
    onError: (err) =>
      toast({
        title: billingErrorText(err) || (err instanceof Error ? err.message : tErrors("generic")),
        variant: "destructive",
      }),
  });

  const fmt = (minor: number) => fmtMoney(business, minor);
  const count = (n: number) => fmtCount(uiLocale, n);

  // R103/P1 — the CANONICAL constructed URL (NEVER the raw href): the panel
  // also mounts INLINE under the summary sub-view, where window.location.href
  // would copy a summary URL — a lie. The constructed form always lands the
  // closed token this panel owns (#/reports?inventory=1).
  const copyLink = async () => {
    const url = window.location.origin + window.location.pathname + "#/reports?inventory=1";
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        // Clipboard API denied/unavailable — the established textarea
        // fallback (same law as the setup-gate command chip). Silent fail
        // → the catch toasts; the URL stays real either way.
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const okFallback = document.execCommand("copy");
        ta.remove();
        if (!okFallback) throw new Error("copy rejected");
      }
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      // P3 — clipboard denial is the environment speaking: toast destructive.
      toast({ title: t("invValCopyFailed"), variant: "destructive" });
    }
  };

  const columns = [
    {
      id: "product",
      header: t("invValColProduct"),
      align: "start" as const,
      cell: (r: InvValRow) => (
        <div className="flex min-w-0 flex-col">
          <button
            type="button"
            className="hover:text-foreground max-w-[22rem] truncate rounded text-start font-medium transition-colors focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
            title={r.sku ? `${r.name} — ${r.sku}` : r.name}
            aria-label={`${t("invValOpenProduct")}: ${r.name}`}
            onClick={() => navigate({ kind: "entity", entity: "product", id: r.id })}
          >
            {r.name}
          </button>
          {r.sku ? (
            <span className="text-muted-foreground max-w-[22rem] truncate text-xs" dir="ltr">
              {r.sku}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      id: "qty",
      header: t("invValColQty"),
      align: "end" as const,
      cell: (r: InvValRow) => (
        // P51-R1: the number AND its unit live inside ONE directional
        // boundary. Previously only the number was isolated (<Ltr>) while
        // the unit sat outside; in RTL paragraphs the isolate severed the
        // bidi run and the unit could visually jump BEFORE the number
        // (e.g. "m ۳"). One LTR boundary locks the logical order
        // (quantity → unit) for Latin and Persian unit labels alike —
        // the unit text itself still renders RTL internally when Persian —
        // and keeps negative quantities from splitting ("۵-").
        <Ltr>
          {count(r.stockQty)}
          {r.unit ? <span className="text-muted-foreground ms-1 text-xs">{r.unit}</span> : null}
        </Ltr>
      ),
    },
    {
      id: "unitCost",
      header: t("invValColUnitCost"),
      align: "end" as const,
      cell: (r: InvValRow) => (
        <Ltr className="tabular-nums">{fmt(r.costPriceMinor)}</Ltr>
      ),
    },
    {
      id: "value",
      header: t("invValColValue"),
      align: "end" as const,
      cell: (r: InvValRow) => (
        <span className="font-medium tabular-nums">
          <Ltr>{fmt(r.estimatedValueMinor)}</Ltr>
        </span>
      ),
    },
    {
      id: "costState",
      header: t("invValColStatus"),
      align: "start" as const,
      hideBelow: "md" as const,
      cell: (r: InvValRow) => (
        <div className="flex flex-wrap items-center gap-1">
          {r.stockState === "NEGATIVE_STOCK" ? (
            <Badge
              variant="outline"
              className="border-destructive/40 bg-destructive/5 shrink-0 px-1.5 py-0 text-[10px] text-destructive"
            >
              {t("invValStateNegativeStock")}
            </Badge>
          ) : null}
          {r.costState === "ZERO_COST" ? (
            <Badge
              variant="outline"
              className="shrink-0 border-amber-300/60 bg-amber-500/10 px-1.5 py-0 text-[10px] text-amber-700 dark:text-amber-400"
            >
              {t("invValStateZeroCost")}
            </Badge>
          ) : null}
          <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
            {r.isActive ? t("invValStateActive") : t("invValStateInactive")}
          </Badge>
        </div>
      ),
    },
  ];

  const pg = data?.pagination;
  const from = pg && pg.totalCount > 0 ? (pg.page - 1) * pg.pageSize + 1 : 0;
  const to = pg ? Math.min(pg.page * pg.pageSize, pg.totalCount) : 0;

  return (
    <Card data-testid="inventory-valuation" data-view="module:reports:inventory">
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground -ms-2 mb-1 h-8 gap-1.5"
              onClick={() => navigate({ kind: "module", module: "reports" }, { replace: true })}
            >
              <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
              {t("invValBack")}
            </Button>
            <CardTitle className="flex items-center gap-2 text-lg">
              <PackageSearch className="text-primary size-5" aria-hidden="true" />
              {t("invValTitle")}
            </CardTitle>
            <CardDescription className="mt-1">{t("invValDesc")}</CardDescription>
          </div>
          <div className="flex items-center gap-1.5">
            {/* R146 — the THIRD ?ask= producer: the inventory-valuation panel
                hands the copilot an honest stock-VALUE question (the snapshot's
                inventory block — valueAtCost, pre-formatted — is the proven
                answer domain; system rule 6b keeps the framing operational).
                The gate translates the R145 family law to this panel's own
                data presence: a loaded, non-error dataset with at least one
                included row (pg.totalCount) — a filtered-to-zero view or a
                failed fetch never shows an ask affordance. The question names
                the WHOLE current book, never the panel's active filters (the
                R144 honesty law — the copilot computes its own whole-book
                fact). Seed-not-send, always. */}
            {!error && (pg?.totalCount ?? 0) > 0 ? (
              <Button
                variant="outline"
                size="sm"
                className="text-primary hover:bg-primary/5 border-primary/30 hover:border-primary/50 h-7 gap-1.5 rounded-full px-2.5 text-[11px] font-medium"
                onClick={() =>
                  navigate({ kind: "module", module: "copilot", ask: t("inventoryAskQuestion") })
                }
                title={t("askCopilotHint")}
                aria-label={t("askCopilotHint")}
                data-testid="inventory-valuation-ask-copilot"
              >
                <Bot className="size-3.5" aria-hidden="true" />
                {t("askCopilotLabel")}
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => void copyLink()}
              disabled={isLoading || Boolean(error)}
              title={t("invValCopyLink")}
              aria-label={t("invValCopyLink")}
              data-testid="inv-val-copy-link"
            >
              {linkCopied ? (
                <Check className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
              ) : (
                <Link2 className="size-4" aria-hidden="true" />
              )}
              <span aria-hidden="true">{linkCopied ? t("invValCopiedToast") : t("invValCopyLink")}</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => exportCsv.mutate()}
              disabled={exportCsv.isPending || isLoading || Boolean(error)}
              title={t("invValExport")}
            >
              {exportCsv.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="size-4" aria-hidden="true" />
              )}
              <span aria-hidden="true">{exportCsv.isPending ? t("invValExporting") : t("invValExport")}</span>
            </Button>
          </div>
        </div>

        {/* §8.6 — the valuation-basis disclosure: always visible, never an
            accounting claim. */}
        <div
          className="bg-muted/50 text-muted-foreground flex items-start gap-2 rounded-lg border px-3 py-2 text-xs"
          data-testid="inventory-valuation-basis"
        >
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <p>{t("invValBasis")}</p>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Filters (§8.3) — closed vocabularies mirrored from the API. */}
        <div className="flex flex-wrap items-end gap-2" role="search" aria-label={t("invValSearch")}>
          <div className="min-w-[10rem] flex-1 sm:max-w-xs">
            <label htmlFor="inv-val-search" className="text-muted-foreground mb-1 block text-xs font-medium">
              {t("invValSearch")}
            </label>
            <Input
              id="inv-val-search"
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t("invValSearchPlaceholder")}
              className="h-9"
              maxLength={80}
            />
          </div>
          <div className="w-[8.5rem]">
            <label className="text-muted-foreground mb-1 block text-xs font-medium" htmlFor="inv-val-cost">
              {t("invValCostState")}
            </label>
            <Select value={costState} onValueChange={(v) => changeFilter(setCostState)(v as CostState)}>
              <SelectTrigger id="inv-val-cost" className="h-9" aria-label={t("invValCostState")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("invValFilterAll")}</SelectItem>
                <SelectItem value="POSITIVE_COST">{t("invValFilterPositiveCost")}</SelectItem>
                <SelectItem value="ZERO_COST">{t("invValFilterZeroCost")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="w-[8.5rem]">
            <label className="text-muted-foreground mb-1 block text-xs font-medium" htmlFor="inv-val-stock">
              {t("invValStockState")}
            </label>
            <Select value={stockState} onValueChange={(v) => changeFilter(setStockState)(v as StockState)}>
              <SelectTrigger id="inv-val-stock" className="h-9" aria-label={t("invValStockState")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("invValFilterAll")}</SelectItem>
                <SelectItem value="POSITIVE_STOCK">{t("invValFilterPositiveStock")}</SelectItem>
                <SelectItem value="ZERO_STOCK">{t("invValFilterZeroStock")}</SelectItem>
                <SelectItem value="LOW_STOCK">{t("invValFilterLowStock")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="w-[8.5rem]">
            <label className="text-muted-foreground mb-1 block text-xs font-medium" htmlFor="inv-val-activity">
              {t("invValActivity")}
            </label>
            <Select value={activity} onValueChange={(v) => changeFilter(setActivity)(v as Activity)}>
              <SelectTrigger id="inv-val-activity" className="h-9" aria-label={t("invValActivity")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("invValFilterAll")}</SelectItem>
                <SelectItem value="ACTIVE">{t("invValFilterActive")}</SelectItem>
                <SelectItem value="INACTIVE">{t("invValFilterInactive")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="w-[10.5rem]">
            <label className="text-muted-foreground mb-1 block text-xs font-medium" htmlFor="inv-val-sort">
              {t("invValSort")}
            </label>
            <Select value={sort} onValueChange={(v) => changeFilter(setSort)(v as Sort)}>
              <SelectTrigger id="inv-val-sort" className="h-9" aria-label={t("invValSort")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORTS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(SORT_LABEL_KEYS[s])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-[6.5rem]">
            <label className="text-muted-foreground mb-1 block text-xs font-medium" htmlFor="inv-val-pagesize">
              {t("invValPerPage")}
            </label>
            <Select
              value={String(pageSize)}
              onValueChange={(v) => changeFilter(setPageSize)(Number(v))}
            >
              <SelectTrigger id="inv-val-pagesize" className="h-9" aria-label={t("invValPerPage")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground h-9 gap-1.5"
            onClick={resetFilters}
            title={t("invValReset")}
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            {t("invValReset")}
          </Button>
        </div>

        {error ? (
          <div className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm" role="alert">
            {t("invValLoadFailed")}{" "}
            <button className="underline" onClick={() => void refetch()}>
              {t("retry")}
            </button>
          </div>
        ) : isLoading || !data ? (
          <div className="space-y-3" aria-busy="true">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-20 rounded-xl" />
              ))}
            </div>
            <Skeleton className="h-64 rounded-xl" />
          </div>
        ) : (
          <>
            {/* §8.4 — summary cards ALWAYS describe the current (filtered)
                dataset; the note states the convention explicitly. */}
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="inventory-valuation-cards">
              {/* R146 styling — the KPI cards join the R145 semantic hover
                  family (reorder panel): the hue repeats each card's own
                  semantic — primary on the three neutral figures, amber on
                  the zero-cost review flag (whose conditional border is
                  untouched and merely deepens on hover). */}
              <div className="bg-card rounded-lg border p-3 transition-colors hover:border-primary/25">
                <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  {t("invValCardValue")}
                </p>
                <p className="mt-1 text-lg font-semibold tabular-nums" dir="ltr">
                  {fmt(data.totals.estimatedValueMinor)}
                </p>
                <p className="text-muted-foreground text-xs">{t("invValCardValueHint")}</p>
              </div>
              <div className="bg-card rounded-lg border p-3 transition-colors hover:border-primary/25">
                <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  {t("invValCardProducts")}
                </p>
                <p className="mt-1 text-lg font-semibold tabular-nums" dir="ltr">
                  {count(data.totals.productCount)}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t("invValCardProductsHint", { count: count(data.totals.inactiveCount) })}
                </p>
              </div>
              <div className="bg-card rounded-lg border p-3 transition-colors hover:border-primary/25">
                <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  {t("invValCardPositiveStock")}
                </p>
                <p className="text-foreground mt-1 text-lg font-semibold tabular-nums" dir="ltr">
                  {count(data.totals.positiveStockCount)}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t("invValCardPositiveStockHint", { count: count(data.totals.lowStockCount) })}
                </p>
              </div>
              <div
                className={cn(
                  "bg-card rounded-lg border p-3 transition-colors hover:border-amber-500/40",
                  data.totals.zeroCostPositiveStockCount > 0 && "border-amber-500/30 bg-amber-500/5",
                )}
              >
                <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  {t("invValCardZeroCost")}
                </p>
                <p
                  className={cn(
                    "mt-1 text-lg font-semibold tabular-nums",
                    data.totals.zeroCostPositiveStockCount > 0
                      ? "text-amber-700 dark:text-amber-400"
                      : "text-emerald-700 dark:text-emerald-400",
                  )}
                  dir="ltr"
                >
                  {count(data.totals.zeroCostPositiveStockCount)}
                </p>
                <p className="text-muted-foreground text-xs">{t("invValCardZeroCostHint")}</p>
              </div>
            </div>
            <p className="text-muted-foreground text-xs">
              {data.filtersActive ? t("invValFilteredNote") : t("invValAllNote")}
            </p>

            {/* §8.5 — the cost-quality notice: a review request, never an
                accusation and never a cost suggestion. */}
            {data.totals.zeroCostPositiveStockCount > 0 ? (
              <div
                className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
                data-testid="inventory-zero-cost-notice"
                role="status"
              >
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                <p>{t("invValZeroCostNotice", { count: count(data.totals.zeroCostPositiveStockCount) })}</p>
              </div>
            ) : null}
            {data.totals.negativeStockCount > 0 ? (
              <div
                className="text-destructive bg-destructive/5 flex items-start gap-2 rounded-lg border border-destructive/30 px-3 py-2 text-xs"
                role="status"
              >
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <p>{t("invValNegativeStockNotice", { count: count(data.totals.negativeStockCount) })}</p>
              </div>
            ) : null}

            {data.totals.productCount === 0 ? (
              data.filtersActive ? (
                <EmptyState
                  icon={PackageSearch}
                  title={t("invValNoMatch")}
                  action={
                    <Button variant="outline" size="sm" onClick={resetFilters}>
                      <RotateCcw className="size-3.5" aria-hidden="true" />
                      {t("invValNoMatchReset")}
                    </Button>
                  }
                />
              ) : (
                <EmptyState icon={PackageSearch} title={t("invValEmpty")} />
              )
            ) : (
              <>
                <div>
                  <DataTable
                    rows={data.rows}
                    columns={columns}
                    getRowId={(r) => r.id}
                    ariaLabel={t("invValTitle")}
                    refreshing={isFetching}
                    maxHeightClass="max-h-[36rem]"
                    stickyHeader
                  />
                </div>

                {/* Pagination (§8) — deterministic server pages. */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-muted-foreground text-xs tabular-nums" aria-live="polite">
                    {t("invValShowing", {
                      from: count(from),
                      to: count(to),
                      total: count(pg!.totalCount),
                    })}
                    {" · "}
                    {t("invValPageOf", { page: count(pg!.page), total: count(Math.max(pg!.totalPages, 1)) })}
                  </p>
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1"
                      disabled={pg!.page <= 1 || isFetching}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      aria-label={t("invValPagePrev")}
                    >
                      <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
                      {t("invValPagePrev")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1"
                      disabled={!pg!.hasMore || isFetching}
                      onClick={() => setPage((p) => p + 1)}
                      aria-label={t("invValPageNext")}
                    >
                      {t("invValPageNext")}
                      <ChevronRight className="size-4 rtl:rotate-180" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
