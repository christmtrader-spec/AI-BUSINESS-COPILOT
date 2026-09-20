"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, Boxes, Package } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { can, type Role } from "@/lib/rbac";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { DataTable, Ltr } from "@/components/shared/data-table";
import { EmptyState, PageHeader } from "@/components/shared/primitives";
import { Pagination, SearchInput } from "@/components/shared/table-kit";
import { StockDialog } from "../products/stock-dialog";
import type { Product } from "../products/products-view";
import type { BusinessSummary } from "../shell/types";

type ProductPage = { items: Product[]; total: number; page: number; pageSize: number };

type AdjustmentItem = {
  id: string;
  delta: number;
  reason: string;
  createdAt: string;
  product: { name: string; unit: string | null; sku: string | null };
  actor: { name: string | null; email: string } | null;
};

export function InventoryView({
  business,
  role,
}: {
  business: BusinessSummary;
  role: Role;
}) {
  const t = useTranslations("inventory");
  const tErrors = useTranslations("errors");
  const tCommon = useTranslations("common");

  const writable = can(role, "data:write");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [stockTarget, setStockTarget] = useState<Product | null>(null);
  const products = useQuery<ProductPage>({
    queryKey: ["products", q, page],
    queryFn: () => api(`/api/v1/products?q=${encodeURIComponent(q)}&page=${page}&pageSize=10`),
  });

  const adjustments = useQuery<{ items: AdjustmentItem[] }>({
    queryKey: ["adjustments"],
    queryFn: () => api("/api/v1/inventory/adjustments?take=20"),
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
                        <Ltr className="font-semibold">{p.stockQty}</Ltr>{" "}
                        <span className="text-muted-foreground text-xs">{p.unit ?? t("units")}</span>
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
          <h2 className="mb-4 text-base font-semibold">{t("history")}</h2>
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
        </CardContent>
      </Card>

      {stockTarget ? (
        <StockDialog product={stockTarget} onClose={() => setStockTarget(null)} />
      ) : null}
    </div>
  );
}
