"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Boxes, ClipboardList, Download, Loader2, Package } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api } from "@/lib/api-client";
import { can, type Role } from "@/lib/rbac";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { DataTable, Ltr } from "@/components/shared/data-table";
import { EmptyState, PageHeader } from "@/components/shared/primitives";
import { Pagination, SearchInput } from "@/components/shared/table-kit";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StockDialog } from "../products/stock-dialog";
import { useAppStore } from "@/store/app-store";
import type { Product } from "../products/products-view";
import type { BusinessSummary } from "../shell/types";

type ProductPage = { items: Product[]; total: number; page: number; pageSize: number };

type AdjustmentItem = {
  id: string;
  delta: number;
  reason: string;
  createdAt: string;
  productId: string;
  product: { name: string; unit: string | null; sku: string | null };
  actor: { name: string | null; email: string } | null;
};

type AdjustmentPage = {
  items: AdjustmentItem[];
  total: number;
  page: number;
  pageSize: number;
};

const HISTORY_PAGE_SIZE = 20;

export function InventoryView({
  business,
  role,
}: {
  business: BusinessSummary;
  role: Role;
}) {
  const t = useTranslations("inventory");
  const tStocktakes = useTranslations("inventory.stocktakes");
  const tErrors = useTranslations("errors");
  const tCommon = useTranslations("common");
  const navigate = useAppStore((s) => s.navigate);
  const activeBusinessId = useAppStore((s) => s.activeBusinessId);

  const writable = can(role, "data:write");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [stockTarget, setStockTarget] = useState<Product | null>(null);
  // History card state — server-side filters/pagination (never client-sliced:
  // the feed is business-wide and must stay honest about totals).
  const [adjDirection, setAdjDirection] = useState<"ALL" | "INCREASE" | "DECREASE">("ALL");
  const [adjQ, setAdjQ] = useState("");
  const [adjPage, setAdjPage] = useState(1);
  const products = useQuery<ProductPage>({
    queryKey: ["products", q, page],
    queryFn: () => api(`/api/v1/products?q=${encodeURIComponent(q)}&page=${page}&pageSize=10`),
  });

  const adjustments = useQuery<AdjustmentPage>({
    queryKey: ["adjustments", activeBusinessId, adjDirection, adjQ, adjPage],
    queryFn: () => {
      const p = new URLSearchParams({
        page: String(adjPage),
        pageSize: String(HISTORY_PAGE_SIZE),
      });
      if (adjDirection !== "ALL") p.set("direction", adjDirection);
      if (adjQ.trim()) p.set("q", adjQ.trim());
      return api(`/api/v1/inventory/adjustments?${p.toString()}`);
    },
  });

  // History CSV export (§76–§83 conventions) — same filters the card shows;
  // the server pages through ALL matching rows (cap 1,000, honestly audited).
  const exportHistory = useMutation({
    mutationFn: async () => {
      const locale = business.locale === "fa" ? "fa" : "en";
      const p = new URLSearchParams({ format: "csv", locale });
      if (adjDirection !== "ALL") p.set("direction", adjDirection);
      if (adjQ.trim()) p.set("q", adjQ.trim());
      const res = await fetch(`/api/v1/inventory/adjustments?${p.toString()}`, {
        credentials: "same-origin",
        headers: activeBusinessId ? { "x-business-id": activeBusinessId } : undefined,
      });
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
      a.download = /filename="([^"]+)"/.exec(dispo)?.[1] ?? "inventory-adjustments.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => toast({ title: t("exportToast") }),
    onError: (err) =>
      toast({ title: err instanceof Error ? err.message : t("exportFailed"), variant: "destructive" }),
  });

  // Prompt 40 (§91) — "Open stocktakes" operational metric. Deliberately
  // NOT beside Revenue/Profit/Cash figures: it is a count of active count
  // sessions, never a financial KPI.
  const openStocktakes = useQuery<{ items: Array<{ id: string }>; total: number }>({
    queryKey: ["inventory", "stocktakes-open", activeBusinessId],
    queryFn: async () => {
      const first = await api<{ items: Array<{ id: string }>; total: number; page: number; pageSize: number }>(
        `/api/v1/inventory/stocktakes?status=DRAFT&page=1&pageSize=1`,
      );
      const counting = await api<{ items: Array<{ id: string }>; total: number; page: number; pageSize: number }>(
        `/api/v1/inventory/stocktakes?status=COUNTING&page=1&pageSize=1`,
      );
      const review = await api<{ items: Array<{ id: string }>; total: number; page: number; pageSize: number }>(
        `/api/v1/inventory/stocktakes?status=REVIEW&page=1&pageSize=1`,
      );
      return {
        items: [...first.items, ...counting.items, ...review.items],
        total: first.total + counting.total + review.total,
      };
    },
    staleTime: 15_000,
    enabled: Boolean(activeBusinessId),
  });

  // Mutations invalidate their own caches from within StockDialog.

  const dateFmt = new Intl.DateTimeFormat(business.locale === "fa" ? "fa-IR" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const items = products.data?.items ?? [];

  return (
    <div className="space-y-6" data-view="module:inventory">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {/* Prompt 40 (§75/§91) — Stocktakes tab card: open-session metric + CTA. */}
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="bg-primary/10 flex size-10 shrink-0 items-center justify-center rounded-lg">
              <ClipboardList className="text-primary size-5" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-semibold">{tStocktakes("stocktakes")}</p>
              <p className="text-xs text-muted-foreground">{tStocktakes("listSubtitle")}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="rounded-lg border px-3 py-1.5 text-center" aria-live="polite">
              <p className="text-xs text-muted-foreground">{tStocktakes("openStocktakes")}</p>
              <p className="text-lg font-semibold tabular-nums" dir="ltr">
                {openStocktakes.isLoading ? "—" : (openStocktakes.data?.total ?? 0)}
              </p>
            </div>
            <Button variant="outline" onClick={() => navigate({ kind: "inventory-stocktakes" })}>
              <ClipboardList className="size-4" aria-hidden />
              {tStocktakes("stocktakes")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="mb-4">
            <SearchInput
              value={q}
              onChange={(v) => {
                setQ(v);
                setPage(1);
              }}
              placeholder={tCommon("search")}
            />
          </div>

          {products.error ? (
            <div className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm">
              {tErrors("loadFailed")}{" "}
              <button className="underline" onClick={() => void products.refetch()}>
                {tCommon("retry")}
              </button>
            </div>
          ) : (
            <>
              <DataTable<Product>
                ariaLabel={t("currentStock")}
                sortLocale={business.locale}
                refreshing={products.isFetching && !products.isLoading}
                columns={[
                  {
                    id: "product",
                    header: t("colProduct"),
                    cell: (p) => (
                      <div className="flex items-center gap-3">
                        <div className="bg-primary/10 flex size-9 shrink-0 items-center justify-center rounded-lg">
                          <Boxes className="text-primary size-4" aria-hidden="true" />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate font-medium">{p.name}</p>
                          {p.sku ? (
                            <p className="text-muted-foreground text-xs">
                              <Ltr>{p.sku}</Ltr>
                            </p>
                          ) : null}
                        </div>
                      </div>
                    ),
                  },
                  {
                    id: "stock",
                    header: t("currentStock"),
                    align: "end",
                    sortValue: (p) => p.stockQty,
                    cell: (p) => (
                      <>
                        {/* P51-R1: number AND unit inside ONE directional
                        boundary — with the unit outside the isolate, RTL
                        bidi placed the unit BEFORE the number for Latin
                        unit labels (verified live: "kg 3"). Same correction
                        as the inventory-valuation panel. */}
                        <Ltr className="font-semibold">
                          {p.stockQty}
                          <span className="text-muted-foreground ms-1 text-xs font-normal">{p.unit ?? t("units")}</span>
                        </Ltr>{" "}
                        {p.stockQty <= 0 ? (
                          <Badge variant="destructive" className="ms-2">{t("stockOut")}</Badge>
                        ) : p.stockQty <= p.lowStockAt ? (
                          <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-700 ms-2 dark:text-amber-400">
                            {t("stockLow")}
                          </Badge>
                        ) : null}
                      </>
                    ),
                  },
                  ...(writable
                    ? [
                        {
                          id: "actions",
                          header: tCommon("actions"),
                          align: "end" as const,
                          cell: (p: Product) => (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setStockTarget(p)}
                            >
                              {t("adjust")}
                            </Button>
                          ),
                        },
                      ]
                    : []),
                ]}
                rows={items}
                getRowId={(p) => p.id}
                loading={products.isLoading}
                skeletonRows={4}
                empty={
                  <EmptyState
                    icon={Package}
                    title={t("currentStock")}
                    description={t("emptyAdjustmentsDesc")}
                  />
                }
              />
              <Pagination
                page={page}
                pageSize={10}
                total={products.data?.total ?? 0}
                onPage={setPage}
                labels={{ prev: tCommon("previous"), next: tCommon("next") }}
              />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold">{t("history")}</h2>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-8"
              onClick={() => exportHistory.mutate()}
              disabled={exportHistory.isPending}
              data-testid="adjustments-export"
              aria-label={t("export")}
            >
              {exportHistory.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="size-4" aria-hidden="true" />
              )}
              {exportHistory.isPending ? t("exporting") : t("export")}
            </Button>
          </div>
          <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_11rem]">
            <SearchInput
              value={adjQ}
              onChange={(v) => {
                setAdjQ(v);
                setAdjPage(1);
              }}
              placeholder={t("historySearchPlaceholder")}
            />
            <Select
              value={adjDirection}
              onValueChange={(v) => {
                setAdjDirection(v as typeof adjDirection);
                setAdjPage(1);
              }}
            >
              <SelectTrigger id="adjustment-direction" className="w-full" aria-label={t("historyFilterAll")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{t("historyFilterAll")}</SelectItem>
                <SelectItem value="INCREASE">{t("historyFilterIncrease")}</SelectItem>
                <SelectItem value="DECREASE">{t("historyFilterDecrease")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DataTable<AdjustmentItem>
            ariaLabel={t("history")}
            sortLocale={business.locale}
            maxHeightClass="max-h-96"
            stickyHeader
            refreshing={adjustments.isFetching && !adjustments.isLoading}
            columns={[
              {
                id: "when",
                header: t("colWhen"),
                className: "w-40",
                sortValue: (a) => a.createdAt,
                defaultSortDir: "desc",
                cell: (a) => (
                  <span className="text-muted-foreground whitespace-nowrap text-xs tabular-nums">
                    {dateFmt.format(new Date(a.createdAt))}
                  </span>
                ),
              },
              {
                id: "product",
                header: t("colProduct"),
                cell: (a) => <span className="text-sm font-medium">{a.product.name}</span>,
              },
              {
                id: "change",
                header: t("colChange"),
                align: "end",
                sortValue: (a) => a.delta,
                cell: (a) => (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 text-sm font-semibold",
                      a.delta > 0 ? "text-emerald-600" : "text-destructive",
                    )}
                  >
                    {a.delta > 0 ? (
                      <ArrowUp className="size-3.5 rtl:-scale-x-100" aria-hidden="true" />
                    ) : (
                      <ArrowDown className="size-3.5 rtl:-scale-x-100" aria-hidden="true" />
                    )}
                    <Ltr>{a.delta > 0 ? `+${a.delta}` : a.delta}</Ltr>
                  </span>
                ),
              },
              {
                id: "reason",
                header: t("colReason"),
                hideBelow: "md",
                cell: (a) => (
                  <div className="text-muted-foreground max-w-56 truncate text-sm">{a.reason}</div>
                ),
              },
              {
                id: "by",
                header: t("colBy"),
                hideBelow: "sm",
                cell: (a) => (
                  <span className="text-muted-foreground text-sm">
                    {a.actor?.name ?? a.actor?.email ?? "—"}
                  </span>
                ),
              },
            ]}
            rows={adjustments.data?.items ?? []}
            getRowId={(a) => a.id}
            loading={adjustments.isLoading}
            skeletonRows={3}
            empty={
              <EmptyState
                icon={Boxes}
                title={t("emptyAdjustments")}
                description={t("emptyAdjustmentsDesc")}
              />
            }
          />
          {(adjustments.data?.total ?? 0) > HISTORY_PAGE_SIZE ? (
            <div className="mt-4">
              <Pagination
                page={adjPage}
                pageSize={HISTORY_PAGE_SIZE}
                total={adjustments.data?.total ?? 0}
                onPage={(p) => setAdjPage(p)}
                labels={{ prev: tCommon("previous"), next: tCommon("next") }}
              />
            </div>
          ) : null}
        </CardContent>
      </Card>

      {stockTarget ? (
        <StockDialog product={stockTarget} onClose={() => setStockTarget(null)} />
      ) : null}
    </div>
  );
}
