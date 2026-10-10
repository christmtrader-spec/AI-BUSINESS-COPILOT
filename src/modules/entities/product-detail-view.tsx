"use client";

/**
 * Prompt 34 — Product detail page (§27).
 * Pricing/stock metrics + existing stock-state semantics + recent
 * adjustments + recent sales. Stock Adjustment reuses the EXISTING
 * StockDialog (§27 — no second stock mutation system).
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  ArrowLeftRight,
  Boxes,
  Layers,
  Package,
  PackageCheck,
  Pencil,
  ShoppingCart,
  Tag,
  Trash2,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { can, type Role } from "@/lib/rbac";
import { useAppStore } from "@/store/app-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { fmtCount, fmtDate, fmtMoney } from "../finance-shared/finance-kit";
import type { BusinessSummary } from "../shell/types";
import { invalidateEntityDetail } from "./entity-api";
import { EntityHeader, EntityBreadcrumb, EntityTypeBadge } from "./entity-header";
import { EntityMetricCard } from "./entity-metric-card";
import { EntityDeleteDialog } from "./entity-delete-dialog";
import { RelatedRecordList } from "./related-record-list";
import { navigateToEntity, navigateToEntityList } from "./entity-route";
import { ProductFormDialog } from "../products/product-form-dialog";
import { StockDialog } from "../products/stock-dialog";
import { InfoRow } from "./customer-detail-view";
import type { ProductDetail, StockState } from "@/lib/entities";
import { cn } from "@/lib/utils";

export function stockStateBadge(state: StockState, label: string) {
  const tone =
    state === "OUT_OF_STOCK"
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : state === "LOW_STOCK"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
        : "border-emerald-300/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
  return (
    <Badge variant="outline" className={cn("font-medium", tone)}>
      {label}
    </Badge>
  );
}

export function ProductDetailView({
  data,
  business,
  uiLocale,
  role,
}: {
  data: ProductDetail;
  business: BusinessSummary;
  uiLocale: string;
  role: Role;
}) {
  const t = useTranslations("entityDetail");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const queryClient = useQueryClient();
  const businessId = useAppStore((s) => s.activeBusinessId);
  const navigate = useAppStore((s) => s.navigate);
  const tStock = useTranslations("inventory.stocktakes");
  const tPo = useTranslations("purchaseOrders");
  const tGr = useTranslations("goodsReceipts");
  const tRt = useTranslations("goodsReturns");

  const writable = can(role, "data:write");
  const p = data.product;
  const [editOpen, setEditOpen] = useState(false);
  const [stockOpen, setStockOpen] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: async () => api(`/api/v1/products/${p.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: t("deletedToast", { type: t("product") }) });
      void queryClient.invalidateQueries({ queryKey: ["products"] });
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
      invalidateEntityDetail(queryClient, businessId, "product", p.id);
      navigateToEntityList("product");
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  const stockLabel =
    data.inventory.state === "OUT_OF_STOCK"
      ? t("outOfStock")
      : data.inventory.state === "LOW_STOCK"
        ? t("lowStock")
        : t("healthy");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <EntityBreadcrumb listLabel={t("products")} title={p.name} />
        <EntityHeader
          icon={Package}
          title={p.name}
          subtitle={p.sku ?? p.unit ?? t("noSku")}
          badge={
            p.isActive ? (
              <EntityTypeBadge label={t("active")} />
            ) : (
              <Badge variant="outline" className="text-muted-foreground font-medium">
                {t("inactive")}
              </Badge>
            )
          }
          backLabel={t("backTo", { list: t("products") })}
          onBack={() => navigateToEntityList("product")}
          actions={
            writable ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setStockOpen(true)}>
                  <ArrowLeftRight className="size-4" aria-hidden="true" />
                  {t("adjustStock")}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                  <Pencil className="size-4" aria-hidden="true" />
                  {tCommon("edit")}
                </Button>
                <EntityDeleteDialog
                  triggerLabel={tCommon("delete")}
                  triggerIcon={Trash2}
                  title={t("deleteTitle", { type: t("product") })}
                  description={t("deleteDesc")}
                  confirmLabel={tCommon("delete")}
                  cancelLabel={tCommon("cancel")}
                  pending={deleteMutation.isPending}
                  onConfirm={() => deleteMutation.mutate()}
                />
              </>
            ) : null
          }
        />
      </div>

      {/* Pricing + inventory (§27) — integer minor units via money utils */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <EntityMetricCard
          label={t("salePrice")}
          value={fmtMoney(business, p.salePriceMinor)}
          icon={Tag}
        />
        <EntityMetricCard
          label={t("costPrice")}
          value={fmtMoney(business, p.costPriceMinor)}
          icon={Layers}
        />
        <EntityMetricCard
          label={t("stock")}
          value={fmtCount(uiLocale, data.inventory.stockQty)}
          hint={p.unit ?? undefined}
          icon={Boxes}
        />
        <EntityMetricCard
          label={t("lowStockAt")}
          value={fmtCount(uiLocale, data.inventory.lowStockAt)}
          icon={Boxes}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-sm">{t("stockState")}:</span>
        {stockStateBadge(data.inventory.state, stockLabel)}
      </div>

      <Card>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
          <InfoRow label={t("sku")} value={p.sku} ltr />
          <InfoRow label={t("unit")} value={p.unit} />
        </CardContent>
      </Card>

      {/* Related records (§34) */}
      <RelatedRecordList
        title={t("recentAdjustments")}
        entity={null}
        emptyText={t("noRecentAdjustments")}
        onOpen={navigateToEntity}
        items={data.recentAdjustments.map((a) => ({
          id: a.id,
          icon: ArrowLeftRight,
          primary: a.reason,
          secondary: fmtDate(business, a.createdAt),
          trailing: `${a.delta > 0 ? "+" : ""}${fmtCount(uiLocale, a.delta)}`,
        }))}
      />
      <RelatedRecordList
        title={t("recentSales")}
        entity="sale"
        emptyText={t("noRecentSales")}
        onOpen={navigateToEntity}
        items={data.recentSales.map((s) => ({
          id: s.saleId,
          icon: ShoppingCart,
          primary: `INV-${String(s.number).padStart(4, "0")}`,
          secondary: fmtDate(business, s.issueDate),
          trailing: fmtMoney(business, s.lineTotalMinor),
        }))}
      />

      {/* Prompt 40 (§90) — bounded stocktake history (≤10). Stocktakes are
          NOT entity-router records; navigation uses the dedicated deep link
          (§136) — never the Global Search entity vocabulary (§95). */}
      <Card>
        <CardContent className="pt-6">
          <h2 className="mb-3 text-base font-semibold">{tStock("stocktakeHistory")}</h2>
          {data.recentStocktakes.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tStock("noStocktakeHistory")}</p>
          ) : (
            <ul className="divide-y">
              {data.recentStocktakes.map((st) => (
                <li key={st.stocktakeId}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 py-2.5 text-start transition-colors hover:bg-muted/40"
                    onClick={() => navigate({ kind: "inventory-stocktake", id: st.stocktakeId })}
                    aria-label={`${tStock("stocktakeHistory")}: ${st.reference}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium" dir="auto">{st.reference}</span>
                      <span className="block text-xs text-muted-foreground" dir="ltr">
                        {fmtDate(business, st.countedAt)}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        {st.status === "DRAFT" ? tStock("status_DRAFT")
                          : st.status === "COUNTING" ? tStock("status_COUNTING")
                          : st.status === "REVIEW" ? tStock("status_REVIEW")
                          : st.status === "FINALIZED" ? tStock("status_FINALIZED")
                          : tStock("status_CANCELLED")}
                      </Badge>
                      <span
                        className={cn(
                          "text-sm font-semibold tabular-nums",
                          st.varianceQty > 0 && "text-emerald-600 dark:text-emerald-400",
                          st.varianceQty < 0 && "text-amber-600 dark:text-amber-400",
                        )}
                        dir="ltr"
                      >
                        {st.varianceQty > 0 ? `+${st.varianceQty}` : st.varianceQty}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Prompt 41 (§66) — bounded purchase-order history (≤10). Orders are
          NOT entity-router records; navigation uses the dedicated deep link
          #/purchase-orders/<id>. Line snapshots are historical (§27/§236). */}
      <Card>
        <CardContent className="pt-6">
          <h2 className="mb-3 text-base font-semibold">{tPo("purchaseOrderHistory")}</h2>
          {data.recentPurchaseOrders.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tPo("noPurchaseOrderHistory")}</p>
          ) : (
            <ul className="divide-y">
              {data.recentPurchaseOrders.map((po) => (
                <li key={po.purchaseOrderId}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 py-2.5 text-start transition-colors hover:bg-muted/40"
                    onClick={() => navigate({ kind: "purchase-order", id: po.purchaseOrderId })}
                    aria-label={`${tPo("purchaseOrderHistory")}: ${po.reference}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium" dir="auto">{po.reference}</span>
                      <span className="block truncate text-xs text-muted-foreground" dir="auto">
                        {po.supplierNameAtOrder} · {tPo("orderedQty")}: {po.orderedQty}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        {po.status === "DRAFT" ? tPo("status_DRAFT")
                          : po.status === "SENT" ? tPo("status_SENT")
                          : po.status === "CONFIRMED" ? tPo("status_CONFIRMED")
                          : po.status === "CLOSED" ? tPo("status_CLOSED")
                          : tPo("status_CANCELLED")}
                      </Badge>
                      <span className="text-sm font-semibold tabular-nums" dir="ltr">
                        {po.unitPriceMinor / 10 ** po.decimalPrecisionAtOrder} {po.currencySymbolAtOrder}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Prompt 42 (§120) — bounded goods-receipt history (≤10). Shows the
          receipt reference, received quantity and posted date — NO money. */}
      <Card data-testid="product-goods-receipt-history">
        <CardContent className="pt-6">
          <h2 className="mb-3 text-base font-semibold">{tGr("productHistory")}</h2>
          {!data.recentGoodsReceipts || data.recentGoodsReceipts.length === 0 ? (
            <p className="text-muted-foreground text-sm">{tGr("noProductHistory")}</p>
          ) : (
            <ul className="divide-y">
              {data.recentGoodsReceipts.map((gr) => (
                <li key={`${gr.id}`}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 py-2.5 text-start transition-colors hover:bg-muted/40"
                    onClick={() => navigate({ kind: "inventory-goods-receipt", id: gr.id })}
                    aria-label={`${tGr("productHistory")}: ${gr.reference}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium" dir="auto">{gr.reference}</span>
                      <span className="text-muted-foreground block truncate text-xs" dir="ltr">
                        {gr.postedAt
                          ? `${tGr("postedAtLabel")}: ${new Date(gr.postedAt).toISOString().slice(0, 10)}`
                          : tGr(`status_${gr.status}`)}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="text-sm font-semibold tabular-nums" dir="ltr">
                        +{gr.receivedQty}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Prompt 43 (§99) — bounded goods-return history (≤10). Return
          reference, source receipt, returned quantity, reason and date —
          NO money (returns are inventory events, never financial ones). */}
      <Card data-testid="product-goods-return-history">
        <CardContent className="pt-6">
          <h2 className="mb-3 text-base font-semibold">{tRt("productHistory")}</h2>
          {!data.recentGoodsReturns || data.recentGoodsReturns.length === 0 ? (
            <p className="text-muted-foreground text-sm">{tRt("noProductHistory")}</p>
          ) : (
            <ul className="divide-y">
              {data.recentGoodsReturns.map((ret) => (
                <li key={`${ret.id}`}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 py-2.5 text-start transition-colors hover:bg-muted/40"
                    onClick={() => navigate({ kind: "inventory-goods-return", id: ret.id })}
                    aria-label={`${tRt("productHistory")}: ${ret.reference}`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium" dir="auto">{ret.reference}</span>
                      <span className="text-muted-foreground block truncate text-xs" dir="ltr">
                        {ret.goodsReceiptReferenceAtReturn} · {tRt(`reason_${ret.reasonCode}`)}
                        {ret.postedAt
                          ? ` · ${tRt("postedAtLabel")}: ${new Date(ret.postedAt).toISOString().slice(0, 10)}`
                          : ` · ${tRt(`status_${ret.status}`)}`}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="text-sm font-semibold tabular-nums text-amber-600 dark:text-amber-400" dir="ltr">
                        −{ret.returnedQty}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <ProductFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        editing={{
          id: p.id,
          name: p.name,
          sku: p.sku,
          unit: p.unit,
          salePriceMinor: p.salePriceMinor,
          costPriceMinor: p.costPriceMinor,
          stockQty: data.inventory.stockQty,
          lowStockAt: data.inventory.lowStockAt,
          isActive: p.isActive,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        }}
        business={business}
      />

      {stockOpen ? (
        <StockDialog
          product={{
            id: p.id,
            name: p.name,
            sku: p.sku,
            unit: p.unit,
            salePriceMinor: p.salePriceMinor,
            costPriceMinor: p.costPriceMinor,
            stockQty: data.inventory.stockQty,
            lowStockAt: data.inventory.lowStockAt,
            isActive: p.isActive,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
          }}
          onClose={() => setStockOpen(false)}
        />
      ) : null}
    </div>
  );
}
