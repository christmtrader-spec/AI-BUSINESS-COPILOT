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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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

          {products.isLoading ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="bg-muted/50 h-12 animate-pulse rounded-md" />
              ))}
            </div>
          ) : products.error ? (
            <div className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm">
              {tErrors("loadFailed")}{" "}
              <button className="underline" onClick={() => void products.refetch()}>
                {tCommon("retry")}
              </button>
            </div>
          ) : items.length === 0 ? (
            <EmptyState icon={Package} title={t("currentStock")} description={t("emptyAdjustmentsDesc")} />
          ) : (
            <>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead>{t("colProduct")}</TableHead>
                      <TableHead className="text-end">{t("currentStock")}</TableHead>
                      {writable ? (
                        <TableHead className="text-end">{tCommon("actions")}</TableHead>
                      ) : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((p) => (
                      <TableRow key={p.id} className="hover:bg-muted/40">
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <div className="bg-primary/10 flex size-9 shrink-0 items-center justify-center rounded-lg">
                              <Boxes className="text-primary size-4" aria-hidden="true" />
                            </div>
                            <div className="min-w-0">
                              <p className="truncate font-medium">{p.name}</p>
                              {p.sku ? (
                                <p className="text-muted-foreground text-xs" dir="ltr">{p.sku}</p>
                              ) : null}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-end">
                          <span className="font-semibold tabular-nums">{p.stockQty}</span>{" "}
                          <span className="text-muted-foreground text-xs">{p.unit ?? t("units")}</span>
                          {p.stockQty <= 0 ? (
                            <Badge variant="destructive" className="ms-2">{t("stockOut")}</Badge>
                          ) : p.stockQty <= p.lowStockAt ? (
                            <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-700 ms-2 dark:text-amber-400">
                              {t("stockLow")}
                            </Badge>
                          ) : null}
                        </TableCell>
                        {writable ? (
                          <TableCell className="text-end">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setStockTarget(p)}
                            >
                              {t("adjust")}
                            </Button>
                          </TableCell>
                        ) : null}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
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
          {adjustments.isLoading ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1].map((i) => (
                <div key={i} className="bg-muted/50 h-10 animate-pulse rounded-md" />
              ))}
            </div>
          ) : !adjustments.data || adjustments.data.items.length === 0 ? (
            <EmptyState
              icon={Boxes}
              title={t("emptyAdjustments")}
              description={t("emptyAdjustmentsDesc")}
            />
          ) : (
            <div className="max-h-96 overflow-y-auto rounded-md border">
              <Table>
                <TableHeader className="bg-muted/50 sticky top-0">
                  <TableRow>
                    <TableHead className="w-40">{t("colWhen")}</TableHead>
                    <TableHead>{t("colProduct")}</TableHead>
                    <TableHead className="text-end">{t("colChange")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("colReason")}</TableHead>
                    <TableHead className="hidden sm:table-cell">{t("colBy")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {adjustments.data.items.map((a) => (
                    <TableRow key={a.id} className="hover:bg-muted/40">
                      <TableCell className="text-muted-foreground whitespace-nowrap text-xs tabular-nums">
                        {dateFmt.format(new Date(a.createdAt))}
                      </TableCell>
                      <TableCell className="text-sm font-medium">{a.product.name}</TableCell>
                      <TableCell className="text-end">
                        <span
                          className={`inline-flex items-center gap-1 text-sm font-semibold tabular-nums ${
                            a.delta > 0 ? "text-emerald-600" : "text-destructive"
                          }`}
                        >
                          {a.delta > 0 ? (
                            <ArrowUp className="size-3.5 rtl:-scale-x-100" aria-hidden="true" />
                          ) : (
                            <ArrowDown className="size-3.5 rtl:-scale-x-100" aria-hidden="true" />
                          )}
                          {a.delta > 0 ? `+${a.delta}` : a.delta}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden max-w-56 truncate text-sm md:table-cell" dir="auto">
                        {a.reason}
                      </TableCell>
                      <TableCell className="text-muted-foreground hidden text-sm sm:table-cell">
                        {a.actor?.name ?? a.actor?.email ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {stockTarget ? (
        <StockDialog product={stockTarget} onClose={() => setStockTarget(null)} />
      ) : null}
    </div>
  );
}
