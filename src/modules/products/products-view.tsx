"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ArrowLeftRight, CheckSquare, Copy, Download, Package, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { useBillingErrorText } from "@/hooks/use-billing-error-text";
import { api, ApiClientError } from "@/lib/api-client";
import { can, type Role } from "@/lib/rbac";
import { formatMoney } from "@/lib/money";
import { downloadCsv, exportStamp, fetchAllPages, toCsv } from "@/lib/csv";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { EmptyState, PageHeader } from "@/components/shared/primitives";
import { DataTable, Ltr } from "@/components/shared/data-table";
import { Pagination, SearchInput } from "@/components/shared/table-kit";
import { StockDialog } from "./stock-dialog";
import { ProductFormDialog } from "./product-form-dialog";
import { navigateToEntity } from "@/modules/entities/entity-route";
import { invalidateEntityDetail } from "@/modules/entities/entity-api";
import { useAppStore } from "@/store/app-store";
import { PlanLimitBanner } from "../billing/plan-limit-banner";
import type { BusinessSummary } from "../shell/types";

export type Product = {
  id: string;
  name: string;
  sku: string | null;
  unit: string | null;
  salePriceMinor: number;
  costPriceMinor: number;
  stockQty: number;
  lowStockAt: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

type ProductPage = { items: Product[]; total: number; page: number; pageSize: number };

export function ProductsView({
  business,
  role,
}: {
  business: BusinessSummary;
  role: Role;
}) {
  const t = useTranslations("products");
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const billingErrorText = useBillingErrorText();
  const queryClient = useQueryClient();
  const businessId = useAppStore((s) => s.activeBusinessId);

  const writable = can(role, "data:write");
  const precision = business.decimalPrecision;

  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  // R171 — the product duplicate feeds the SAME dialog instance as
  // create/edit; the three sources are mutually exclusive (the R170
  // expense-repeat law: the mutation keys on `editing` alone, so a
  // duplicate is a plain POST create).
  const [duplicateFrom, setDuplicateFrom] = useState<Product | null>(null);
  const [stockTarget, setStockTarget] = useState<Product | null>(null);
  // R61-6 bulk selection — current-page ids only (honest scope).
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const { data, isLoading, isFetching, error, refetch } = useQuery<ProductPage>({
    queryKey: ["products", q, page],
    queryFn: () => api(`/api/v1/products?q=${encodeURIComponent(q)}&page=${page}&pageSize=10`),
  });

  function openCreate() {
    setEditing(null);
    setDuplicateFrom(null);
    setDialogOpen(true);
  }

  function openEdit(p: Product) {
    setEditing(p);
    setDuplicateFrom(null);
    setDialogOpen(true);
  }

  function openDuplicate(p: Product) {
    setEditing(null);
    setDuplicateFrom(p);
    setDialogOpen(true);
  }

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => api(`/api/v1/products/${id}`, { method: "DELETE" }),
    onSuccess: (_data, id) => {
      toast({ title: t("deletedToast") });
      void queryClient.invalidateQueries({ queryKey: ["products"] });
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
      // Prompt 34 §37 — cached detail must not resurrect a deleted product.
      invalidateEntityDetail(queryClient, businessId, "product", id);
    },
    onError: (err) => {
      toast({
        title: billingErrorText(err) || (err instanceof ApiClientError ? err.message : tErrors("generic")),
        variant: "destructive",
      });
    },
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function togglePage() {
    setSelected((prev) => {
      const allSelected = items.length > 0 && items.every((p) => prev.has(p.id));
      return allSelected ? new Set() : new Set(items.map((p) => p.id));
    });
  }

  const bulkMutation = useMutation({
    mutationFn: async (input: { isActive: boolean }) =>
      api<{ matched: number; requested: number; isActive: boolean }>("/api/v1/products/bulk-status", {
        method: "POST",
        body: JSON.stringify({ ids: [...selected], isActive: input.isActive }),
      }),
    onSuccess: (res) => {
      toast({ title: t("bulkDone", { matched: res.matched }) });
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ["products"] });
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
    },
    onError: (err) => {
      toast({
        title: billingErrorText(err) || (err instanceof ApiClientError ? err.message : tErrors("generic")),
        variant: "destructive",
      });
    },
  });

  const fmt = (minor: number) => formatMoney(minor, business);

  // Export the full catalog (current search applied — the visible list is
  // the mental model) as CSV. fetchAllPages walks the server's 100-row
  // page cap honestly and reports truncation (r23).
  const dateFmt = new Intl.DateTimeFormat(business.locale === "fa" ? "fa-IR" : "en-US", {
    dateStyle: "medium",
  });
  const exportMutation = useMutation({
    mutationFn: async () => {
      const { rows, total: grand, truncated } = await fetchAllPages<Product>((page, pageSize) =>
        api<ProductPage>(
          `/api/v1/products?q=${encodeURIComponent(q)}&page=${page}&pageSize=${pageSize}`,
        ),
      );
      const csv = toCsv(
        [
          t("colProduct"),
          t("sku"),
          t("unit"),
          t("salePrice"),
          t("costPrice"),
          t("colStock"),
          t("lowStockAt"),
          t("colActive"),
          t("colCreated"),
        ],
        rows.map((p) => [
          p.name,
          p.sku ?? "",
          p.unit ?? "",
          fmt(p.salePriceMinor),
          fmt(p.costPriceMinor),
          p.stockQty,
          p.lowStockAt,
          p.isActive ? tCommon("yes") : tCommon("no"),
          dateFmt.format(new Date(p.createdAt)),
        ]),
      );
      downloadCsv(`products-${exportStamp()}.csv`, csv);
      return { exported: rows.length, total: grand, truncated };
    },
    onSuccess: ({ exported, total: grand, truncated }) =>
      toast({
        title: truncated ? tCommon("exportedTruncated", { count: exported, total: grand }) : tCommon("exportedCount", { count: exported }),
      }),
    onError: () => toast({ title: tCommon("exportFailed"), variant: "destructive" }),
  });

  function stockBadge(p: Product) {
    if (p.stockQty <= 0) {
      return <Badge variant="destructive">{t("stockOut")}</Badge>;
    }
    if (p.stockQty <= p.lowStockAt) {
      return (
        <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" variant="outline">
          {t("stockLow")}
        </Badge>
      );
    }
    return null;
  }

  return (
    <div className="space-y-6" data-view="module:products">
      <PageHeader
        title={tNav("products")}
        subtitle={t("priceNote")}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={exportMutation.isPending}
              onClick={() => exportMutation.mutate()}
            >
              <Download className="size-4" aria-hidden="true" />
              {exportMutation.isPending ? tCommon("exportingCsv") : tCommon("exportCsv")}
            </Button>
            {writable ? (
              <Button onClick={openCreate} size="sm">
                <Plus className="size-4" aria-hidden="true" />
                {t("add")}
              </Button>
            ) : null}
          </>
        }
      />

      {/* Prompt 20: informational plan-limit banner (server enforces the
          same limit on create — this only makes the boundary visible). */}
      <PlanLimitBanner code="PRODUCTS_MAX" />

      <Card>
        <CardContent className="pt-6">
          <div className="mb-4">
            <SearchInput
              value={q}
              onChange={(v) => {
                setQ(v);
                setPage(1);
                setSelected(new Set()); // stale cross-page selection is a footgun
              }}
              placeholder={t("searchPlaceholder")}
            />
          </div>

          {error ? (
            <div className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm">
              {tErrors("loadFailed")}{" "}
              <button className="underline" onClick={() => void refetch()}>
                {tCommon("retry")}
              </button>
            </div>
          ) : (
            <>
              {/* R61-6 bulk action bar — only when a writable user has a selection. */}
              {writable && selected.size > 0 ? (
                <div
                  className="bg-primary/5 mb-4 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2"
                  data-testid="bulk-bar"
                >
                  <CheckSquare className="text-primary size-4" aria-hidden="true" />
                  <span className="text-sm font-medium tabular-nums">
                    {t("bulkSelected", { count: selected.size })}
                  </span>
                  <div className="ms-auto flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8"
                      disabled={bulkMutation.isPending}
                      onClick={() => bulkMutation.mutate({ isActive: true })}
                    >
                      {t("bulkActivate")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8"
                      disabled={bulkMutation.isPending}
                      onClick={() => bulkMutation.mutate({ isActive: false })}
                    >
                      {t("bulkDeactivate")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8"
                      onClick={() => setSelected(new Set())}
                    >
                      {tCommon("cancel")}
                    </Button>
                  </div>
                </div>
              ) : null}

              <DataTable<Product>
                ariaLabel={tNav("products")}
                sortLocale={business.locale}
                refreshing={isFetching && !isLoading}
                columns={[
                  ...(writable
                    ? [
                        {
                          id: "select",
                          header: (
                            <input
                              type="checkbox"
                              className="accent-primary size-4 align-middle"
                              checked={items.length > 0 && items.every((p) => selected.has(p.id))}
                              onChange={togglePage}
                              aria-label={t("selectAll")}
                            />
                          ),
                          cell: (p: Product) => (
                            // stopPropagation — the row itself navigates on click.
                            <div onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                className="accent-primary size-4 align-middle"
                                checked={selected.has(p.id)}
                                onChange={() => toggleRow(p.id)}
                                aria-label={t("selectRow", { name: p.name })}
                              />
                            </div>
                          ),
                        },
                      ]
                    : []),
                  {
                    id: "product",
                    header: t("colProduct"),
                    sortValue: (p) => p.name,
                    cell: (p) => (
                      <div className="flex items-center gap-3">
                        <div className="bg-primary/10 flex size-9 shrink-0 items-center justify-center rounded-lg">
                          <Package className="text-primary size-4" aria-hidden="true" />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate font-medium">{p.name}</p>
                          {p.sku ? (
                            <p className="text-muted-foreground text-xs">
                              <Ltr>
                                {p.sku}
                                {p.unit ? ` · ${p.unit}` : ""}
                              </Ltr>
                            </p>
                          ) : p.unit ? (
                            <p className="text-muted-foreground text-xs">{p.unit}</p>
                          ) : null}
                        </div>
                      </div>
                    ),
                  },
                  {
                    id: "price",
                    header: t("colPrice"),
                    align: "end",
                    sortValue: (p) => p.salePriceMinor,
                    cell: (p) => (
                      <div>
                        <Ltr className="font-semibold">{fmt(p.salePriceMinor)}</Ltr>
                        <p className="text-muted-foreground text-xs">
                          <Ltr>{fmt(p.costPriceMinor)}</Ltr>
                        </p>
                      </div>
                    ),
                  },
                  {
                    id: "stock",
                    header: t("colStock"),
                    cell: (p) => (
                      <div className="flex items-center gap-2">
                        <Ltr className="text-sm font-semibold">{p.stockQty}</Ltr>
                        {stockBadge(p)}
                      </div>
                    ),
                  },
                  ...(writable
                    ? [
                        {
                          id: "actions",
                          header: tCommon("actions"),
                          align: "end" as const,
                          cell: (p: Product) => (
                            <div className="flex flex-wrap items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8"
                                onClick={() => setStockTarget(p)}
                                aria-label={t("adjust")}
                                title={t("adjust")}
                              >
                                <ArrowLeftRight className="size-4" aria-hidden="true" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8"
                                onClick={() => openEdit(p)}
                                aria-label={t("edit")}
                                title={t("edit")}
                              >
                                <Pencil className="size-4" aria-hidden="true" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8"
                                onClick={() => openDuplicate(p)}
                                aria-label={t("duplicate")}
                                title={t("duplicate")}
                                data-testid="product-duplicate"
                              >
                                <Copy className="size-4" aria-hidden="true" />
                              </Button>
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="text-destructive size-8 hover:text-destructive"
                                    aria-label={tCommon("delete")}
                                    title={tCommon("delete")}
                                  >
                                    <Trash2 className="size-4" aria-hidden="true" />
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
                                    <AlertDialogDescription>{t("deleteDesc")}</AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
                                    <AlertDialogAction
                                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                      onClick={() => deleteMutation.mutate(p.id)}
                                    >
                                      {tCommon("delete")}
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            </div>
                          ),
                        },
                      ]
                    : []),
                ]}
                rows={items}
                getRowId={(p) => p.id}
                loading={isLoading}
                skeletonRows={4}
                onRowClick={(p) => navigateToEntity("product", p.id)}
                empty={
                  !q ? (
                    <EmptyState
                      icon={Package}
                      title={t("empty")}
                      description={t("emptyDesc")}
                      action={
                        writable ? (
                          <Button size="sm" variant="outline" onClick={openCreate}>
                            <Plus className="size-4" aria-hidden="true" />
                            {t("add")}
                          </Button>
                        ) : null
                      }
                    />
                  ) : (
                    <EmptyState icon={Package} title={tCommon("search")} description={t("searchPlaceholder")} />
                  )
                }
              />
              <Pagination
                page={page}
                pageSize={10}
                total={total}
                onPage={(p) => {
                  setPage(p);
                  setSelected(new Set()); // stale cross-page selection is a footgun
                }}
              />
            </>
          )}
        </CardContent>
      </Card>

      <ProductFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        business={business}
        duplicateFrom={duplicateFrom}
      />

      {stockTarget ? (
        <StockDialog product={stockTarget} onClose={() => setStockTarget(null)} />
      ) : null}
    </div>
  );
}
