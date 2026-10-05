"use client";

/**
 * Prompt 40 — stocktake detail view (§74/§81–§89/§136).
 *
 * STATE BEHAVIOR:
 *  - DRAFT: add products (bounded picker), remove lines, Start counting.
 *  - COUNTING: count lines, Review (enabled only when pending = 0, §85),
 *    Cancel.
 *  - REVIEW: recount lines (§31), Finalize (§86 confirmation), Reopen,
 *    Cancel.
 *  - FINALIZED / CANCELLED: fully read-only (§50/§51) with per-line
 *    adjustment outcome (§88) / canceled-at (§89).
 *  - Stale count (§87): 409 STOCKTAKE_STALE_COUNT renders the localized
 *    message + per-product recount affordance; the stocktake stays REVIEW.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Download,
  Loader2,
  Minus,
  PackageSearch,
  Play,
  ScanSearch,
  Trash2,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { can, type Role } from "@/lib/rbac";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState, PageHeader } from "@/components/shared/primitives";
import type { StocktakeDetailDto, StocktakeLineDto } from "@/lib/inventory/stocktake/dto";
import type { StocktakeStatus } from "@/lib/inventory/stocktake/types";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app-store";
import {
  fetchStocktake,
  inventoryKeys,
  removeStocktakeLine,
  transitionStocktake,
} from "./stocktake-api";
import { StocktakeProductPicker } from "./stocktake-product-picker";
import { StocktakeCountDialog, type CountTarget } from "./stocktake-count-dialog";
import { StocktakeFinalizeDialog, type StaleProduct } from "./stocktake-finalize-dialog";

const LINES_PAGE_SIZE = 50; // §65 — default 50, max 100

export function StocktakeDetailView({ id, role }: { id: string; role: Role }) {
  const t = useTranslations("inventory.stocktakes");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const locale = useLocale();
  const queryClient = useQueryClient();
  const businessId = useAppStore((s) => s.activeBusinessId) ?? "";
  const navigate = useAppStore((s) => s.navigate);
  const dateFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }),
    [],
  );

  const writable = can(role, "data:write");
  const [linePage, setLinePage] = useState(1);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [countTarget, setCountTarget] = useState<CountTarget | null>(null);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [staleProducts, setStaleProducts] = useState<StaleProduct[]>([]);

  const detail = useQuery({
    queryKey: inventoryKeys.stocktakeLines(businessId, id, linePage, LINES_PAGE_SIZE),
    queryFn: () => fetchStocktake(businessId, id, linePage, LINES_PAGE_SIZE),
    retry: (count, err) => (err instanceof ApiClientError && err.status >= 500 ? count < 2 : false),
  });

  const data = detail.data;
  const notFound = detail.isError && detail.error instanceof ApiClientError && detail.error.status === 404;

  const transition = useMutation({
    mutationFn: async (action: "start" | "review" | "reopen" | "cancel") =>
      transitionStocktake(businessId, id, action),
    onSuccess: async (_res, action) => {
      toast({ title: t(`${action}Toast`) });
      await queryClient.invalidateQueries({ queryKey: inventoryKeys.all });
    },
    onError: (err) => {
      if (err instanceof ApiClientError && err.status === 422) {
        toast({ title: t("invalidTransition"), variant: "destructive" });
      } else {
        toast({ title: tErrors("generic"), variant: "destructive" });
      }
    },
  });

  const removeLine = useMutation({
    mutationFn: async (lineId: string) => removeStocktakeLine(businessId, id, lineId),
    onSuccess: async () => {
      toast({ title: t("lineRemovedToast") });
      await queryClient.invalidateQueries({ queryKey: inventoryKeys.all });
    },
    onError: () => toast({ title: tErrors("generic"), variant: "destructive" }),
  });

  // CSV export (§76–§83 conventions): server builds the FULL line set from
  // the SAME store the detail API reads — the browser only downloads it.
  const exportCsv = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/v1/inventory/stocktakes/${id}/export?locale=${locale}`,
        {
          credentials: "same-origin",
          headers: businessId ? { "x-business-id": businessId } : undefined,
        },
      );
      if (!res.ok) {
        let message = t("exportFailed");
        try {
          const body = (await res.json()) as { error?: { code?: string } } | null;
          if (body?.error?.code === "RATE_LIMITED") message = t("exportRateLimited");
        } catch {
          /* non-JSON error body — keep the generic message */
        }
        throw new Error(message);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const dispo = res.headers.get("content-disposition") ?? "";
      a.download = /filename="([^"]+)"/.exec(dispo)?.[1] ?? `stocktake-${id}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => toast({ title: t("exportToast") }),
    onError: (err) =>
      toast({ title: err instanceof Error ? err.message : t("exportFailed"), variant: "destructive" }),
  });

  const openCount = (line: StocktakeLineDto) =>
    setCountTarget({
      lineId: line.id,
      productName: line.productNameAtCount,
      systemQtyAtCount: line.systemQtyAtCount,
      currentStockQty: line.currentStockQty,
      countedQty: line.countedQty,
      stocktakeId: id,
      stocktakeStatus: (data?.status ?? "DRAFT") as StocktakeStatus,
    });

  const statusBadge = (status: StocktakeStatus) => {
    const styles: Record<StocktakeStatus, string> = {
      DRAFT: "bg-muted text-muted-foreground border-border",
      COUNTING: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30",
      REVIEW: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30",
      FINALIZED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
      CANCELLED: "bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30",
    };
    return (
      <Badge variant="outline" className={cn("text-xs font-medium", styles[status])}>
        {t(`status_${status}`)}
      </Badge>
    );
  };

  const varianceCell = (line: StocktakeLineDto) => {
    if (line.varianceQty == null) return <span className="text-muted-foreground">—</span>;
    const v = line.varianceQty;
    return (
      <span className="inline-flex items-center gap-1.5" dir="ltr">
        {v > 0 ? (
          <ArrowUp className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
        ) : v < 0 ? (
          <ArrowDown className="size-3.5 text-amber-600 dark:text-amber-400" aria-hidden />
        ) : (
          <Minus className="size-3.5 text-muted-foreground" aria-hidden />
        )}
        <span
          className={cn(
            "font-medium tabular-nums",
            v > 0 && "text-emerald-600 dark:text-emerald-400",
            v < 0 && "text-amber-600 dark:text-amber-400",
          )}
        >
          {v > 0 ? `+${v}` : `${v}`}
        </span>
        <span className="sr-only">{v > 0 ? t("increase") : v < 0 ? t("decrease") : t("zeroVariance")}</span>
      </span>
    );
  };

  if (notFound) {
    return (
      <div className="space-y-6" data-view="inventory-stocktake">
        <Button variant="ghost" onClick={() => navigate({ kind: "inventory-stocktakes" })}>
          <ArrowLeft className="size-4" aria-hidden />
          {t("backToList")}
        </Button>
        <EmptyState
          icon={PackageSearch}
          title={t("notFoundTitle")}
          description={t("notFoundDesc")}
        />
      </div>
    );
  }

  if (detail.isLoading || !data) {
    return (
      <div className="space-y-4" data-view="inventory-stocktake" aria-busy="true">
        <div className="h-8 w-40 animate-pulse rounded bg-muted" />
        <div className="h-28 animate-pulse rounded-xl bg-muted" />
        <div className="h-64 animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }

  const s = data.summary;
  const status = data.status;
  const readOnly = status === "FINALIZED" || status === "CANCELLED";
  const linesTotal = data.linesPage.total;
  const linePageCount = Math.max(1, Math.ceil(linesTotal / LINES_PAGE_SIZE));

  const columns = [
    {
      id: "product",
      header: t("product"),
      cell: (l: StocktakeLineDto) => (
        <div className="min-w-0">
          <p className="truncate font-medium" dir="auto">{l.productNameAtCount}</p>
          {l.unitAtCount ? (
            <p className="text-xs text-muted-foreground">{l.unitAtCount}</p>
          ) : null}
        </div>
      ),
    },
    {
      id: "sku",
      header: t("sku"),
      hideBelow: "md" as const,
      cell: (l: StocktakeLineDto) => (
        <span className="text-xs text-muted-foreground" dir="ltr">{l.skuAtCount ?? "—"}</span>
      ),
    },
    {
      id: "system",
      header: t("systemQuantity"),
      align: "end" as const,
      cell: (l: StocktakeLineDto) => (
        <span className="tabular-nums" dir="ltr">
          {l.countedAt == null ? "—" : l.systemQtyAtCount}
        </span>
      ),
    },
    {
      id: "counted",
      header: t("countedQuantity"),
      align: "end" as const,
      cell: (l: StocktakeLineDto) => (
        <span className="tabular-nums" dir="ltr">{l.countedQty ?? "—"}</span>
      ),
    },
    {
      id: "variance",
      header: t("variance"),
      align: "end" as const,
      cell: varianceCell,
    },
    {
      id: "countedBy",
      header: t("countedBy"),
      hideBelow: "lg" as const,
      cell: (l: StocktakeLineDto) => (
        <span className="text-xs text-muted-foreground">
          {l.countedBy?.name ?? l.countedBy?.email ?? "—"}
        </span>
      ),
    },
    {
      id: "countedAt",
      header: t("countedAt"),
      hideBelow: "lg" as const,
      cell: (l: StocktakeLineDto) => (
        <span className="text-xs text-muted-foreground" dir="ltr">
          {l.countedAt ? dateFmt.format(new Date(l.countedAt)) : "—"}
        </span>
      ),
    },
    ...(readOnly
      ? [
          {
            id: "adjustment",
            header: t("adjustment"),
            align: "end" as const,
            cell: (l: StocktakeLineDto) =>
              l.varianceQty != null && l.varianceQty !== 0 ? (
                <Badge variant="outline" className="text-xs">{t("adjustmentApplied")}</Badge>
              ) : (
                <span className="text-xs text-muted-foreground">{t("noAdjustmentNeeded")}</span>
              ),
          },
        ]
      : [
          {
            id: "actions",
            header: "",
            align: "end" as const,
            cell: (l: StocktakeLineDto) => (
              <div className="flex justify-end gap-1.5">
                {writable && (status === "COUNTING" || status === "REVIEW") ? (
                  <Button
                    type="button"
                    size="sm"
                    variant={l.countedQty == null ? "default" : "outline"}
                    onClick={() => openCount(l)}
                    aria-label={`${l.countedQty == null ? t("countProduct") : t("recount")}: ${l.productNameAtCount}`}
                    className="min-h-8"
                  >
                    {l.countedQty == null ? t("countProduct") : t("recount")}
                  </Button>
                ) : null}
                {writable && status === "DRAFT" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={removeLine.isPending}
                    onClick={() => removeLine.mutate(l.id)}
                    aria-label={`${t("removeProduct")}: ${l.productNameAtCount}`}
                    className="min-h-8 text-destructive hover:text-destructive"
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                ) : null}
              </div>
            ),
          },
        ]),
  ];

  return (
    <div className="space-y-6" data-view="inventory-stocktake">
      <Button
        variant="ghost"
        className="-ms-2"
        onClick={() => navigate({ kind: "inventory-stocktakes" })}
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t("backToList")}
      </Button>

      <PageHeader
        title={data.reference}
        subtitle={t("detailSubtitle", { countType: t("countTypeSelected") })}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => exportCsv.mutate()}
              disabled={exportCsv.isPending}
              data-testid="stocktake-export"
              aria-label={`${t("export")}: ${data.reference}`}
            >
              {exportCsv.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Download className="size-4" aria-hidden />
              )}
              {exportCsv.isPending ? t("exporting") : t("export")}
            </Button>
            {statusBadge(status)}
          </>
        }
      />

      <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">{t("createdBy")}</p>
          <p className="font-medium">{data.createdBy?.name ?? data.createdBy?.email ?? "—"}</p>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">{t("createdAt")}</p>
          <p className="font-medium" dir="ltr">{dateFmt.format(new Date(data.createdAt))}</p>
        </div>
        {data.startedAt ? (
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">{t("startedAt")}</p>
            <p className="font-medium" dir="ltr">{dateFmt.format(new Date(data.startedAt))}</p>
          </div>
        ) : null}
        {data.reviewedAt ? (
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">{t("reviewedAt")}</p>
            <p className="font-medium" dir="ltr">{dateFmt.format(new Date(data.reviewedAt))}</p>
          </div>
        ) : null}
        {data.finalizedAt ? (
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">{t("finalizedAt")}</p>
            <p className="font-medium" dir="ltr">{dateFmt.format(new Date(data.finalizedAt))}</p>
          </div>
        ) : null}
        {data.canceledAt ? (
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">{t("canceledAt")}</p>
            <p className="font-medium" dir="ltr">{dateFmt.format(new Date(data.canceledAt))}</p>
          </div>
        ) : null}
        {data.notes ? (
          <div className="rounded-lg border p-3 sm:col-span-2 lg:col-span-4">
            <p className="text-xs text-muted-foreground">{t("stocktakeNotes")}</p>
            <p className="whitespace-pre-wrap" dir="auto">{data.notes}</p>
          </div>
        ) : null}
      </div>

      {/* §82 — summary cards; operational counts only, NO monetary values. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: t("products"), value: s.lineCount },
          { label: t("counted"), value: s.countedLineCount },
          { label: t("pending"), value: s.pendingLineCount },
          { label: t("increase"), value: `+${s.increaseVarianceUnits}`, tone: "text-emerald-600 dark:text-emerald-400" },
          { label: t("decrease"), value: `-${s.decreaseVarianceUnits}`, tone: "text-amber-600 dark:text-amber-400" },
          { label: t("netVariance"), value: `${s.netVarianceUnits > 0 ? "+" : ""}${s.netVarianceUnits}` },
        ].map((card) => (
          <Card key={card.label} className="py-3">
            <CardContent className="px-3">
              <p className="text-xs text-muted-foreground">{card.label}</p>
              <p className={cn("text-xl font-semibold tabular-nums", card.tone)} dir="ltr">
                {card.value}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {staleProducts.length > 0 ? (
        <Alert variant="destructive" className="border-amber-500/40 bg-amber-500/5 text-amber-900 dark:text-amber-200">
          <AlertTriangle className="size-4" aria-hidden />
          <AlertTitle>{t("inventoryChangedAfterCount")}</AlertTitle>
          <AlertDescription>
            <p>{t("recountRequired")}</p>
            <ul className="mt-2 space-y-1">
              {staleProducts.map((p) => (
                <li key={p.productId} className="flex flex-wrap items-center gap-2 text-sm" dir="auto">
                  <span className="font-medium">{p.productName}</span>
                  <span dir="ltr" className="text-xs text-muted-foreground">
                    {t("systemQuantity")}: {p.systemQtyAtCount} → {t("currentStock")}: {p.currentQty}
                  </span>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {writable && status === "DRAFT" ? (
          <>
            <Button type="button" onClick={() => setPickerOpen((v) => !v)}>
              <PackageSearch className="size-4" aria-hidden />
              {t("addProduct")}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={transition.isPending || s.lineCount < 1}
              onClick={() => transition.mutate("start")}
            >
              <Play className="size-4" aria-hidden />
              {t("startCounting")}
            </Button>
          </>
        ) : null}
        {writable && status === "COUNTING" ? (
          <Button
            type="button"
            disabled={transition.isPending || s.pendingLineCount > 0}
            title={s.pendingLineCount > 0 ? t("reviewBlockedPending", { count: s.pendingLineCount }) : undefined}
            onClick={() => transition.mutate("review")}
          >
            <ScanSearch className="size-4" aria-hidden />
            {t("reviewStocktake")}
          </Button>
        ) : null}
        {writable && status === "REVIEW" ? (
          <>
            <Button type="button" onClick={() => setFinalizeOpen(true)}>
              {t("finalizeStocktake")}
            </Button>
            <Button type="button" variant="outline" disabled={transition.isPending} onClick={() => transition.mutate("reopen")}>
              {t("reopenCounting")}
            </Button>
          </>
        ) : null}
        {writable && (status === "DRAFT" || status === "COUNTING" || status === "REVIEW") ? (
          <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" disabled={transition.isPending} onClick={() => transition.mutate("cancel")}>
            {t("cancelStocktake")}
          </Button>
        ) : null}
        <p className="ms-auto text-xs text-muted-foreground" aria-live="polite">
          {t("lineLimitInfo", { current: s.lineCount })}
        </p>
      </div>

      {pickerOpen && status === "DRAFT" && writable ? (
        <Card>
          <CardContent className="pt-4">
            <p className="mb-2 text-sm font-medium">{t("addProduct")}</p>
            <StocktakeProductPicker
              businessId={businessId}
              onPick={async (product) => {
                try {
                  await api(`/api/v1/inventory/stocktakes/${id}/lines`, {
                    method: "POST",
                    body: JSON.stringify({ productId: product.id }),
                  });
                  toast({ title: t("lineAddedToast") });
                  await queryClient.invalidateQueries({ queryKey: inventoryKeys.all });
                } catch (err) {
                  if (err instanceof ApiClientError && err.status === 409) {
                    toast({ title: t("duplicateProduct"), variant: "destructive" });
                  } else if (err instanceof ApiClientError && err.status === 422) {
                    toast({ title: t("productNotCountable"), variant: "destructive" });
                  } else {
                    toast({ title: tErrors("generic"), variant: "destructive" });
                  }
                }
              }}
            />
          </CardContent>
        </Card>
      ) : null}

      {s.lineCount === 0 ? (
        <EmptyState
          icon={PackageSearch}
          title={t("noStocktakeLines")}
          description={t("noStocktakeLinesDesc")}
        />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={data.lines}
            getRowId={(l) => l.id}
            ariaLabel={t("stocktake")}
            empty={null}
            refreshing={detail.isFetching}
          />
          {linePageCount > 1 ? (
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {t("linesPageInfo", {
                  from: (linePage - 1) * LINES_PAGE_SIZE + 1,
                  to: Math.min(linePage * LINES_PAGE_SIZE, linesTotal),
                  total: linesTotal,
                })}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={linePage <= 1} onClick={() => setLinePage((v) => Math.max(1, v - 1))}>
                  {tCommon("previous")}
                </Button>
                <Button variant="outline" size="sm" disabled={linePage >= linePageCount} onClick={() => setLinePage((v) => Math.min(linePageCount, v + 1))}>
                  {tCommon("next")}
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}

      {countTarget ? (
        <StocktakeCountDialog
          key={countTarget.lineId}
          businessId={businessId}
          target={countTarget}
          onClose={() => setCountTarget(null)}
        />
      ) : null}
      {finalizeOpen ? (
        <StocktakeFinalizeDialog
          businessId={businessId}
          stocktakeId={id}
          onClose={() => setFinalizeOpen(false)}
          onStale={(products) => {
            setStaleProducts(products);
            toast({ title: t("inventoryChangedAfterCount"), variant: "destructive" });
          }}
          onFinalized={() => setStaleProducts([])}
        />
      ) : null}
    </div>
  );
}
