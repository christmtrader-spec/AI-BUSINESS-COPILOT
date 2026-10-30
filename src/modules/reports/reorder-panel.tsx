"use client";

/**
 * Prompt 55 (§X2) — Reorder suggestions panel for the Reports module.
 * Deep-linkable via #/reports?reorder=1. The row-level decision aid behind
 * the summary's low-stock signal: which products are at/below their
 * threshold, how many units top them back up, and what that top-up is
 * estimated to cost.
 *
 * Every figure comes from /api/v1/reports/reorder-suggestions — the UI
 * never recomputes anything (Rule 05). This panel NEVER places an order:
 * no purchase order is created, no stock is adjusted — it navigates the
 * user to the products module to act deliberately.
 */

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { Bot, ChevronLeft, Info, PackagePlus, TriangleAlert, Wrench } from "lucide-react";
import { api } from "@/lib/api-client";
import { useAppStore } from "@/store/app-store";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable, Ltr } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/primitives";
import { ListExportButton } from "@/components/shared/list-export-button";
import { fmtCount, fmtMoney } from "../finance-shared/finance-kit";
import type { BusinessSummary } from "../shell/types";

type ReorderRow = {
  id: string;
  name: string;
  sku: string | null;
  unit: string | null;
  stockQty: number;
  lowStockAt: number;
  costPriceMinor: number;
  suggestedQty: number;
  estimatedCostMinor: number | null;
  severity: "OUT_OF_STOCK" | "AT_OR_BELOW_THRESHOLD";
};

type ReorderReport = {
  basis: "low_stock_topup_suggestion";
  formula: string;
  currencyCode: string;
  decimalPrecision: number;
  rows: ReorderRow[];
  totals: {
    suggestionCount: number;
    outOfStockCount: number;
    estimatedTotalMinor: number | null;
  };
  scan: { complete: boolean; cap: number };
};

export function ReorderSuggestionsPanel({ business }: { business: BusinessSummary }) {
  const t = useTranslations("reports");
  const uiLocale = useLocale();
  const navigate = useAppStore((s) => s.navigate);

  const { data, isLoading, error, refetch } = useQuery<ReorderReport>({
    queryKey: ["reports", "reorder-suggestions"],
    queryFn: () => api("/api/v1/reports/reorder-suggestions"),
    staleTime: 15_000,
  });

  const fmt = (minor: number) => fmtMoney(business, minor);
  const count = (n: number) => fmtCount(uiLocale, n);

  const columns = [
    {
      id: "product",
      header: t("reorderColProduct"),
      align: "start" as const,
      cell: (r: ReorderRow) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{r.name}</p>
          {r.sku ? <Ltr className="text-muted-foreground text-xs">{r.sku}</Ltr> : null}
        </div>
      ),
    },
    {
      id: "stock",
      header: t("reorderColStock"),
      align: "start" as const,
      cell: (r: ReorderRow) => (
        <Ltr className="tabular-nums">
          {count(r.stockQty)}
          {r.unit ? ` ${r.unit}` : ""}
        </Ltr>
      ),
    },
    {
      id: "threshold",
      header: t("reorderColThreshold"),
      align: "start" as const,
      hideBelow: "md" as const,
      cell: (r: ReorderRow) => <Ltr className="text-muted-foreground tabular-nums">{count(r.lowStockAt)}</Ltr>,
    },
    {
      id: "suggested",
      header: t("reorderColSuggested"),
      align: "start" as const,
      cell: (r: ReorderRow) => (
        <span className="font-semibold tabular-nums">
          <Ltr>
            +{count(r.suggestedQty)}
            {r.unit ? ` ${r.unit}` : ""}
          </Ltr>
        </span>
      ),
    },
    {
      id: "unitCost",
      header: t("reorderColUnitCost"),
      align: "end" as const,
      hideBelow: "md" as const,
      cell: (r: ReorderRow) => <Ltr className="tabular-nums">{fmt(r.costPriceMinor)}</Ltr>,
    },
    {
      id: "estCost",
      header: t("reorderColEstCost"),
      align: "end" as const,
      cell: (r: ReorderRow) =>
        r.estimatedCostMinor == null ? (
          <span className="text-muted-foreground text-xs">{t("reorderEstUnavailable")}</span>
        ) : (
          <span className="font-medium tabular-nums">
            <Ltr>{fmt(r.estimatedCostMinor)}</Ltr>
          </span>
        ),
    },
    {
      id: "severity",
      header: t("reorderColStatus"),
      align: "start" as const,
      hideBelow: "sm" as const,
      cell: (r: ReorderRow) =>
        r.severity === "OUT_OF_STOCK" ? (
          <Badge
            variant="outline"
            className="border-destructive/40 bg-destructive/5 shrink-0 px-1.5 py-0 text-[10px] text-destructive"
          >
            {t("reorderStateOutOfStock")}
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="shrink-0 border-amber-300/60 bg-amber-500/10 px-1.5 py-0 text-[10px] text-amber-700 dark:text-amber-400"
          >
            {t("reorderStateLow")}
          </Badge>
        ),
    },
  ];

  const exportRows = data?.rows ?? [];
  const totals = data?.totals;

  return (
    <Card data-testid="reorder-suggestions" data-view="module:reports:reorder">
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
              <PackagePlus className="text-primary size-5" aria-hidden="true" />
              {t("reorderTitle")}
            </CardTitle>
            <CardDescription className="mt-1">{t("reorderDesc")}</CardDescription>
          </div>
          {(exportRows.length > 0 && !error) ? (
            <div className="flex shrink-0 items-center gap-2">
              {/* R145 — the SECOND ?ask= producer: the reorder panel hands the
                  copilot an honest low-stock question (the copilot's grounded
                  stock facts are the proven answer domain). The gate mirrors
                  the export button's law — an ask affordance rides only where
                  the panel's own data exists. Seed-not-send, always. */}
              <Button
                variant="outline"
                size="sm"
                className="text-primary hover:bg-primary/5 border-primary/30 hover:border-primary/50 h-7 gap-1.5 rounded-full px-2.5 text-[11px] font-medium"
                onClick={() =>
                  navigate({ kind: "module", module: "copilot", ask: t("reorderAskQuestion") })
                }
                title={t("askCopilotHint")}
                aria-label={t("askCopilotHint")}
                data-testid="reorder-ask-copilot"
              >
                <Bot className="size-3.5" aria-hidden="true" />
                {t("askCopilotLabel")}
              </Button>
              <ListExportButton
              filename="reorder-suggestions"
              sheetName={t("reorderSheetName")}
              columns={[
                { header: t("reorderColProduct"), value: (r: ReorderRow) => r.name },
                { header: t("reorderColSku"), value: (r: ReorderRow) => r.sku ?? "" },
                { header: t("reorderColUnit"), value: (r: ReorderRow) => r.unit ?? "" },
                { header: t("reorderColStock"), value: (r: ReorderRow) => r.stockQty },
                { header: t("reorderColThreshold"), value: (r: ReorderRow) => r.lowStockAt },
                { header: t("reorderColSuggested"), value: (r: ReorderRow) => r.suggestedQty },
                { header: t("reorderColUnitCost"), value: (r: ReorderRow) => r.costPriceMinor / 10 ** business.decimalPrecision },
                {
                  header: t("reorderColEstCost"),
                  value: (r: ReorderRow) =>
                    r.estimatedCostMinor == null ? "" : r.estimatedCostMinor / 10 ** business.decimalPrecision,
                },
                { header: t("reorderColStatus"), value: (r: ReorderRow) => r.severity },
              ]}
              fetchRows={async () => ({ rows: exportRows, total: exportRows.length, truncated: false })}
              />
            </div>
          ) : null}
        </div>

        {/* Decision-aid disclosure: always visible — this report suggests,
            it never orders (no side effects, Rule 05). R145 styling: the
            primary-tinted edge ties the disclosure to the panel's ask
            affordance without stealing the KPI strip's contrast. */}
        <div
          className="bg-muted/50 text-muted-foreground flex items-start gap-2 rounded-lg border border-primary/15 px-3 py-2 text-xs"
          data-testid="reorder-basis"
        >
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <p>{t("reorderBasis")}</p>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {error ? (
          <div className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm">
            {t("reorderLoadFailed")}{" "}
            <button className="underline" onClick={() => void refetch()}>
              {t("retry")}
            </button>
          </div>
        ) : null}

        {isLoading ? (
          <div className="space-y-3" aria-busy="true">
            <div className="grid gap-3 sm:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-16 rounded-lg" />
              ))}
            </div>
            <Skeleton className="h-64 rounded-lg" />
          </div>
        ) : !data || data.rows.length === 0 ? (
          <EmptyState
            icon={PackagePlus}
            title={t("reorderEmptyTitle")}
            description={t("reorderEmptyDesc")}
          />
        ) : (
          <>
            {/* KPI strip — server-computed totals only. R145 styling: the
                Info icon chips carry the semantic hue per KPI and the cards
                ride a subtle tabular rhythm (values already tabular-nums). */}
            <div className="grid gap-3 sm:grid-cols-3" data-testid="reorder-kpis">
              <div className="bg-card rounded-lg border p-3 transition-colors hover:border-primary/25">
                <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  {t("reorderKpiItems")}
                </p>
                <p className="mt-0.5 text-xl font-semibold tabular-nums" dir="ltr">
                  {count(totals?.suggestionCount ?? 0)}
                </p>
              </div>
              <div className="bg-card rounded-lg border p-3 transition-colors hover:border-destructive/30">
                <p className="text-muted-foreground flex items-center gap-1 text-xs font-medium tracking-wide uppercase">
                  <TriangleAlert className="size-3 text-destructive" aria-hidden="true" />
                  {t("reorderKpiOutOfStock")}
                </p>
                <p className="text-destructive mt-0.5 text-xl font-semibold tabular-nums" dir="ltr">
                  {count(totals?.outOfStockCount ?? 0)}
                </p>
              </div>
              <div className="bg-card rounded-lg border p-3 transition-colors hover:border-primary/25">
                <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  {t("reorderKpiEstTotal")}
                </p>
                {totals?.estimatedTotalMinor == null ? (
                  <p className="text-muted-foreground mt-1 flex items-center gap-1 text-xs">
                    <Wrench className="size-3 shrink-0" aria-hidden="true" />
                    {t("reorderEstUnavailable")}
                  </p>
                ) : (
                  <p className="mt-0.5 text-xl font-semibold tabular-nums" dir="ltr">
                    {fmt(totals.estimatedTotalMinor)}
                  </p>
                )}
              </div>
            </div>

            <DataTable
              columns={columns}
              rows={data.rows}
              getRowId={(r: ReorderRow) => r.id}
              empty={null}
              ariaLabel={t("reorderTitle")}
              /* R152 — the THIRD LEVEL of the low-stock journey: the
                 dashboard alert lands THIS panel (R151), and each row now
                 opens the product's OWN surface — the entity detail where
                 stock is adjusted (the StockDialog) and the threshold is
                 edited. The gate rides the row's own proof (the server-sent
                 id — the perf-panel gate grammar); the hash is built by the
                 store's entityToHash authority (never a hand-built
                 #/products/…). Navigation is not mutation: the report still
                 never places an order nor changes stock (the R145 promise).
                 The hover tint is HONEST — the row really navigates — and
                 joins the motion-safety unification family. */
              onRowClick={(r) =>
                r.id ? navigate({ kind: "entity", entity: "product", id: r.id }) : undefined
              }
              rowClassName={() => "transition-colors hover:bg-muted/40 motion-reduce:transition-none"}
            />
            {/* R152 — the affordance's ONE discovery hint: names what a row
                opens, never what the report does (no mutation wording). */}
            <p className="text-muted-foreground text-xs" data-testid="reorder-drill-hint">
              {t("reorderDrillHint")}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
