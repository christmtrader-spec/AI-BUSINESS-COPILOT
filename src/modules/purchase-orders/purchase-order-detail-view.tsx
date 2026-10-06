"use client";

/**
 * Prompt 41 — purchase-order detail view (§81-§91 + §86-§90 + §169-§170).
 *
 * STATUS ACTION VISIBILITY (§220): DRAFT → Send/Cancel; SENT → Confirm/
 * Cancel; CONFIRMED → Close/Cancel; CLOSED/CANCELLED → Export + copy link
 * only. No invalid action is ever offered; the server re-validates anyway.
 *
 * WORDING LAWS (§16/§202-§204): Send is "Mark as sent" — NEVER "email the
 * supplier". CLOSED is "Closed" — never "Received". No paid/payable/
 * outstanding wording anywhere: a purchase order is a procurement document,
 * not money.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  ArrowLeft,
  CheckCircle2,
  CircleCheck,
  Download,
  Link2,
  Lock,
  PackageSearch,
  Pencil,
  Plus,
  Send,
  Trash2,
  XCircle,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { can, type Role } from "@/lib/rbac";
import { ApiClientError } from "@/lib/api-client";
import { useAppStore } from "@/store/app-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState, PageHeader } from "@/components/shared/primitives";
import { MoneyInput } from "@/components/shared/table-kit";
import { cn } from "@/lib/utils";
import {
  ORDERED_QTY_MAX,
  ORDERED_QTY_MIN,
  UNIT_PRICE_MINOR_MAX,
  type PurchaseOrderStatus,
} from "@/lib/purchase-orders/types";
import type { PurchaseOrderDetailDto, PurchaseOrderLineDto } from "@/lib/purchase-orders/dto";
import {
  addPurchaseOrderLine,
  fetchPurchaseOrder,
  purchaseOrderKeys,
  removePurchaseOrderLine,
  transitionPurchaseOrder,
  updatePurchaseOrderLine,
} from "./purchase-orders-api";
import { PurchaseOrderProductPicker } from "./purchase-order-product-picker";

type LifecycleAction = "send" | "confirm" | "close" | "cancel";

/** Exact decimal-string → integer minor units (never parseFloat, §82). */
function toMinorExact(value: string, precision: number): number | null {
  const trimmed = value.trim();
  if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed === "" || trimmed === ".") return null;
  const negative = trimmed.startsWith("-");
  if (negative) return null;
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > precision) return null; // reject sub-precision digits
  const paddedFrac = frac.padEnd(precision, "0").slice(0, precision);
  const digits = `${whole || "0"}${paddedFrac}`.replace(/^0+(?=\d)/, "");
  const minor = Number(digits);
  if (!Number.isSafeInteger(minor)) return null;
  return minor;
}

export function PurchaseOrderDetailView({ id, role }: { id: string; role: Role }) {
  const t = useTranslations("purchaseOrders");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const queryClient = useQueryClient();
  const navigate = useAppStore((s) => s.navigate);
  const locale = useAppStore((s) => s.locale);
  const businessId = useAppStore((s) => s.activeBusinessId) ?? "";
  const writable = can(role, "data:write");

  const [pickerOpen, setPickerOpen] = useState(false);
  const [addTarget, setAddTarget] = useState<{ id: string; name: string } | null>(null);
  const [editTarget, setEditTarget] = useState<PurchaseOrderLineDto | null>(null);
  const [removeTarget, setRemoveTarget] = useState<{ lineId: string; name: string } | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleAction | null>(null);

  const detail = useQuery({
    queryKey: purchaseOrderKeys.detail(businessId, id),
    queryFn: () => fetchPurchaseOrder(businessId, id),
    retry: (count, err) => (err instanceof ApiClientError && err.status >= 500 ? count < 2 : false),
  });

  const notFound = detail.error instanceof ApiClientError && detail.error.status === 404;
  const data = detail.data;

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: purchaseOrderKeys.all }),
      // Supplier 360 / Product history embed PO rows — refresh them too (§168).
      queryClient.invalidateQueries({ queryKey: ["entities", businessId] }),
    ]);
  };

  /* ----------------------------- mutations ------------------------------ */

  const lifecycleMutation = useMutation({
    mutationFn: async (action: LifecycleAction) =>
      transitionPurchaseOrder(businessId, id, action),
    onSuccess: async (_res, action) => {
      toast({ title: t(`${action}Toast`) });
      setLifecycle(null);
      await invalidate();
    },
    onError: (err) => {
      if (err instanceof ApiClientError && err.status === 422) {
        toast(
          err.code === "PURCHASE_ORDER_EMPTY"
            ? { title: t("emptyOrderError"), variant: "destructive" }
            : { title: t("invalidTransition"), variant: "destructive" },
        );
      } else {
        toast({ title: tErrors("generic"), variant: "destructive" });
      }
    },
  });

  // CSV export (established conventions): server builds the FULL line set;
  // the browser only downloads it. Export never mutates the order (§199).
  const exportCsv = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v1/purchase-orders/${id}/export?locale=${locale}`, {
        credentials: "same-origin",
        headers: businessId ? { "x-business-id": businessId } : undefined,
      });
      if (!res.ok) {
        let message = t("exportFailed");
        try {
          const body = (await res.json()) as { error?: { code?: string } } | null;
          if (body?.error?.code === "RATE_LIMITED") message = t("exportRateLimited");
          else if (body?.error?.code === "ENTITLEMENT_NOT_AVAILABLE") message = t("exportForbidden");
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
      a.download = /filename="([^"]+)"/.exec(dispo)?.[1] ?? `purchase-order-${id}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => toast({ title: t("exportToast") }),
    onError: (err) =>
      toast({ title: err instanceof Error ? err.message : t("exportFailed"), variant: "destructive" }),
  });

  const removeLineMutation = useMutation({
    mutationFn: async (lineId: string) => removePurchaseOrderLine(businessId, id, lineId),
    onSuccess: async () => {
      toast({ title: t("lineRemovedToast") });
      setRemoveTarget(null);
      await invalidate();
    },
    onError: () => toast({ title: tErrors("generic"), variant: "destructive" }),
  });

  const copyLink = async () => {
    const url = `${window.location.origin}${window.location.pathname}#/purchase-orders/${id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: tCommon("copied") });
    } catch {
      toast({ title: tErrors("generic"), variant: "destructive" });
    }
  };

  /* ------------------------------- render ------------------------------- */

  const statusBadge = (status: PurchaseOrderStatus) => {
    const styles: Record<PurchaseOrderStatus, string> = {
      DRAFT: "bg-muted text-muted-foreground border-border",
      SENT: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30",
      CONFIRMED: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30",
      CLOSED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
      CANCELLED: "bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30",
    };
    const icons: Partial<Record<PurchaseOrderStatus, typeof Send>> = {
      SENT: Send,
      CONFIRMED: CheckCircle2,
      CLOSED: CircleCheck,
      CANCELLED: XCircle,
    };
    const Icon = icons[status];
    return (
      <Badge variant="outline" className={cn("gap-1 text-xs font-medium", styles[status])}>
        {Icon ? <Icon className="size-3" aria-hidden /> : null}
        {t(`status_${status}`)}
      </Badge>
    );
  };

  const precision = data?.currency.decimalPrecisionAtOrder ?? 2;
  const symbol = data?.currency.symbolAtOrder ?? "";

  const moneyFmt = useMemo(() => {
    return (minor: number) =>
      // §91/§23 — display uses the ORDER's currency snapshot; integer minor
      // units rendered exactly, never re-interpreted with live precision.
      new Intl.NumberFormat(locale === "fa" ? "fa-IR" : "en-US", {
        minimumFractionDigits: precision,
        maximumFractionDigits: precision,
      }).format(minor / 10 ** precision) + ` ${symbol}`;
  }, [precision, symbol, locale]);

  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : "en-US", { dateStyle: "medium" }),
    [locale],
  );

  if (notFound) {
    return (
      <div className="space-y-6" data-view="purchase-order">
        <Button variant="ghost" onClick={() => navigate({ kind: "purchase-orders" })}>
          <ArrowLeft className="size-4" aria-hidden />
          {t("backToList")}
        </Button>
        <EmptyState icon={PackageSearch} title={t("notFoundTitle")} description={t("notFoundDesc")} />
      </div>
    );
  }

  if (detail.isLoading || !data) {
    return (
      <div className="space-y-4" data-view="purchase-order" aria-busy="true">
        <div className="h-8 w-40 animate-pulse rounded bg-muted" />
        <div className="h-28 animate-pulse rounded-xl bg-muted" />
        <div className="h-64 animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }

  const status = data.status;
  const editable = status === "DRAFT" && writable; // §81/§90
  const summary = data.summary;

  return (
    <div className="space-y-6" data-view="purchase-order" data-testid="po-detail">
      <PageHeader
        title={data.reference}
        subtitle={t("detailSubtitle", { supplier: data.supplier.nameAtOrder })}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {status === "DRAFT" && writable ? (
              <Button type="button" onClick={() => setLifecycle("send")} data-testid="po-send">
                <Send className="size-4" aria-hidden />
                {t("markAsSent")}
              </Button>
            ) : null}
            {status === "SENT" && writable ? (
              <Button type="button" onClick={() => setLifecycle("confirm")} data-testid="po-confirm">
                <CheckCircle2 className="size-4" aria-hidden />
                {t("confirmAction")}
              </Button>
            ) : null}
            {status === "CONFIRMED" && writable ? (
              <Button type="button" onClick={() => setLifecycle("close")} data-testid="po-close">
                <CircleCheck className="size-4" aria-hidden />
                {t("closeAction")}
              </Button>
            ) : null}
            {(status === "DRAFT" || status === "SENT" || status === "CONFIRMED") && writable ? (
              <Button
                type="button"
                variant="outline"
                className="text-destructive hover:text-destructive"
                onClick={() => setLifecycle("cancel")}
                data-testid="po-cancel"
              >
                <XCircle className="size-4" aria-hidden />
                {t("cancelAction")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              onClick={() => exportCsv.mutate()}
              disabled={exportCsv.isPending}
              data-testid="po-export"
              aria-label={`${t("exportAction")}: ${data.reference}`}
            >
              <Download className="size-4" aria-hidden />
              {t("exportAction")}
            </Button>
            <Button type="button" variant="ghost" onClick={copyLink} aria-label={t("copyLink")}>
              <Link2 className="size-4" aria-hidden />
              <span className="sr-only sm:not-sr-only sm:ms-1">{t("copyLink")}</span>
            </Button>
          </div>
        }
      />

      {/* Header card — snapshot identity (§11/§22) + document facts. */}
      <Card>
        <CardContent className="grid gap-4 pt-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("supplier")}</p>
            <p className="mt-1 truncate text-sm font-medium" dir="auto">
              {data.supplier.nameAtOrder}
            </p>
            {data.supplier.stillExists && data.supplier.name && data.supplier.name !== data.supplier.nameAtOrder ? (
              <p className="mt-0.5 truncate text-xs text-muted-foreground" dir="auto">
                {t("supplierRenamed", { name: data.supplier.name })}
              </p>
            ) : !data.supplier.stillExists ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{t("supplierUnavailable")}</p>
            ) : null}
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("status")}</p>
            <div className="mt-1">{statusBadge(status)}</div>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("orderedAt")}</p>
            <p className="mt-1 text-sm tabular-nums" dir="ltr">{dateFmt.format(new Date(data.orderedAt))}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("expectedDate")}</p>
            <p className="mt-1 text-sm tabular-nums" dir="ltr">
              {data.expectedDate ? dateFmt.format(new Date(data.expectedDate)) : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("currency")}</p>
            <p className="mt-1 text-sm" dir="ltr">
              {data.currency.codeAtOrder} · {data.currency.symbolAtOrder} ·{" "}
              {t("precisionN", { count: data.currency.decimalPrecisionAtOrder })}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("lines")}</p>
            <p className="mt-1 text-sm tabular-nums" dir="ltr">{summary.lineCount}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("totalQty")}</p>
            <p className="mt-1 text-sm tabular-nums" dir="ltr">{summary.totalQty}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("orderTotal")}</p>
            <p className="mt-1 text-sm font-semibold tabular-nums" dir="ltr">
              {moneyFmt(summary.totalMinor)}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("orderTotalHint")}</p>
          </div>
        </CardContent>
      </Card>

      {data.notes ? (
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("notes")}</p>
            <p className="mt-1 whitespace-pre-wrap text-sm" dir="auto">{data.notes}</p>
          </CardContent>
        </Card>
      ) : null}

      {/* Lines */}
      <Card>
        <CardContent className="pt-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold">{t("linesTitle")}</h2>
            {editable ? (
              <Button
                type="button"
                size="sm"
                variant={pickerOpen ? "secondary" : "outline"}
                onClick={() => setPickerOpen((v) => !v)}
                data-testid="po-toggle-picker"
              >
                <Plus className="size-4" aria-hidden />
                {t("addLine")}
              </Button>
            ) : null}
          </div>

          {editable && pickerOpen ? (
            <div className="mb-4 rounded-lg border bg-muted/20 p-3">
              <PurchaseOrderProductPicker
                businessId={businessId}
                onPick={(product) => {
                  setPickerOpen(false);
                  setAddTarget({ id: product.id, name: product.name });
                }}
              />
            </div>
          ) : null}

          {data.lines.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t("noLines")}</p>
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block">
                <DataTable
                  columns={[
                    {
                      id: "product",
                      header: t("product"),
                      cell: (l: PurchaseOrderLineDto) => (
                        <div className="min-w-0">
                          <p className="truncate font-medium" dir="auto">{l.productNameAtOrder}</p>
                          {l.unitAtOrder ? (
                            <p className="text-xs text-muted-foreground">{l.unitAtOrder}</p>
                          ) : null}
                        </div>
                      ),
                    },
                    {
                      id: "sku",
                      header: t("sku"),
                      hideBelow: "lg" as const,
                      cell: (l: PurchaseOrderLineDto) => (
                        <span className="text-xs text-muted-foreground" dir="ltr">{l.skuAtOrder ?? "—"}</span>
                      ),
                    },
                    {
                      id: "qty",
                      header: t("orderedQty"),
                      align: "end" as const,
                      cell: (l: PurchaseOrderLineDto) => (
                        <span className="tabular-nums" dir="ltr">{l.orderedQty}</span>
                      ),
                    },
                    {
                      id: "price",
                      header: t("unitPrice"),
                      align: "end" as const,
                      cell: (l: PurchaseOrderLineDto) => (
                        <span className="tabular-nums" dir="ltr">{moneyFmt(l.unitPriceMinor)}</span>
                      ),
                    },
                    {
                      id: "lineTotal",
                      header: t("lineTotal"),
                      align: "end" as const,
                      cell: (l: PurchaseOrderLineDto) => (
                        <span className="font-medium tabular-nums" dir="ltr">{moneyFmt(l.lineTotalMinor)}</span>
                      ),
                    },
                    ...(editable
                      ? [
                          {
                            id: "actions",
                            header: "",
                            align: "end" as const,
                            cell: (l: PurchaseOrderLineDto) => (
                              <div className="flex items-center justify-end gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setEditTarget(l)}
                                  aria-label={`${t("editLine")}: ${l.productNameAtOrder}`}
                                  className="min-h-8"
                                >
                                  <Pencil className="size-4" aria-hidden />
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="min-h-8 text-destructive hover:text-destructive"
                                  onClick={() =>
                                    setRemoveTarget({ lineId: l.id, name: l.productNameAtOrder })
                                  }
                                  aria-label={`${t("removeLine")}: ${l.productNameAtOrder}`}
                                >
                                  <Trash2 className="size-4" aria-hidden />
                                </Button>
                              </div>
                            ),
                          },
                        ]
                      : []),
                  ]}
                  rows={data.lines}
                  getRowId={(l) => l.id}
                  ariaLabel={t("linesTitle")}
                />
              </div>

              {/* Mobile cards */}
              <div className="flex flex-col gap-2 md:hidden">
                {data.lines.map((l) => (
                  <div key={l.id} className="rounded-xl border bg-card p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium" dir="auto">{l.productNameAtOrder}</p>
                        <p className="truncate text-xs text-muted-foreground" dir="ltr">
                          {l.skuAtOrder ?? "—"}{l.unitAtOrder ? ` · ${l.unitAtOrder}` : ""}
                        </p>
                      </div>
                      <span className="shrink-0 text-sm font-medium tabular-nums" dir="ltr">
                        {moneyFmt(l.lineTotalMinor)}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                      <span dir="ltr">{t("orderedQty")}: {l.orderedQty}</span>
                      <span dir="ltr">{t("unitPrice")}: {moneyFmt(l.unitPriceMinor)}</span>
                    </div>
                    {editable ? (
                      <div className="mt-2 flex justify-end gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setEditTarget(l)}
                          aria-label={`${t("editLine")}: ${l.productNameAtOrder}`}
                          className="min-h-8"
                        >
                          <Pencil className="size-4" aria-hidden />
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="min-h-8 text-destructive hover:text-destructive"
                          onClick={() => setRemoveTarget({ lineId: l.id, name: l.productNameAtOrder })}
                          aria-label={`${t("removeLine")}: ${l.productNameAtOrder}`}
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          )}

          {!editable ? (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="size-3.5" aria-hidden />
              {t("readOnlyNote")}
            </p>
          ) : null}

          {/* Document total footer */}
          <div className="mt-4 flex items-center justify-between border-t pt-3">
            <span className="text-sm font-medium">{t("orderTotal")}</span>
            <span className="text-base font-semibold tabular-nums" dir="ltr">
              {moneyFmt(summary.totalMinor)}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t("financialNote")}</p>
        </CardContent>
      </Card>

      {/* Line add dialog — product fixed, qty + price (§83/§82) */}
      {addTarget ? (
        <LineQtyPriceDialog
          businessId={businessId}
          orderId={id}
          productId={addTarget.id}
          productName={addTarget.name}
          precision={precision}
          symbol={symbol}
          onClose={() => setAddTarget(null)}
          onSaved={invalidate}
        />
      ) : null}

      {/* Line edit dialog — qty + price only (§166) */}
      {editTarget ? (
        <LineQtyPriceDialog
          businessId={businessId}
          orderId={id}
          lineId={editTarget.id}
          initialQty={editTarget.orderedQty}
          initialPriceMinor={editTarget.unitPriceMinor}
          productName={editTarget.productNameAtOrder}
          precision={precision}
          symbol={symbol}
          onClose={() => setEditTarget(null)}
          onSaved={invalidate}
        />
      ) : null}

      {/* Line remove confirmation */}
      {removeTarget ? (
        <Dialog open onOpenChange={(open) => !open && setRemoveTarget(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t("removeLineTitle")}</DialogTitle>
              <DialogDescription>
                {t("removeLineDesc", { product: removeTarget.name })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRemoveTarget(null)}>
                {tCommon("cancel")}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={removeLineMutation.isPending}
                onClick={() => removeLineMutation.mutate(removeTarget.lineId)}
              >
                {t("removeAction")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {/* Lifecycle confirmation dialogs (§86-§89) */}
      {lifecycle ? (
        <LifecycleDialog
          action={lifecycle}
          reference={data.reference}
          supplierName={data.supplier.nameAtOrder}
          status={status}
          lineCount={summary.lineCount}
          totalLabel={moneyFmt(summary.totalMinor)}
          expectedDate={data.expectedDate ? dateFmt.format(new Date(data.expectedDate)) : null}
          pending={lifecycleMutation.isPending}
          onConfirm={(action) => lifecycleMutation.mutate(action)}
          onClose={() => setLifecycle(null)}
        />
      ) : null}
    </div>
  );
}

/* ------------------------- line qty/price dialog --------------------------- */

function LineQtyPriceDialog(input: {
  businessId: string;
  orderId: string;
  precision: number;
  symbol: string;
  productName: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  productId?: string; // add path
  lineId?: string; // edit path
  initialQty?: number;
  initialPriceMinor?: number;
}) {
  const { businessId, orderId, precision, symbol, productName, onClose, onSaved, productId, lineId } = input;
  const t = useTranslations("purchaseOrders");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const queryClient = useQueryClient();

  const [qty, setQty] = useState(input.initialQty != null ? String(input.initialQty) : "1");
  const [price, setPrice] = useState(
    input.initialPriceMinor != null ? String(input.initialPriceMinor / 10 ** precision) : "",
  );

  const qtyNum = Number(qty);
  const qtyValid = Number.isInteger(qtyNum) && qtyNum >= ORDERED_QTY_MIN && qtyNum <= ORDERED_QTY_MAX;

  // Money → minor via exact string parsing (never parseFloat, §82).
  const priceMinor = toMinorExact(price, precision);
  const priceValid =
    priceMinor !== null && priceMinor >= 0 && priceMinor <= UNIT_PRICE_MINOR_MAX;

  const mutation = useMutation({
    mutationFn: async () => {
      if (lineId) {
        await updatePurchaseOrderLine(businessId, orderId, lineId, {
          orderedQty: qtyNum,
          unitPriceMinor: priceMinor ?? undefined,
        });
        return;
      }
      await addPurchaseOrderLine(businessId, orderId, {
        productId: productId ?? "",
        orderedQty: qtyNum,
        unitPriceMinor: priceMinor ?? 0,
      });
    },
    onSuccess: async () => {
      toast({ title: t(lineId ? "lineUpdatedToast" : "lineAddedToast") });
      await queryClient.invalidateQueries({ queryKey: purchaseOrderKeys.detail(businessId, orderId) });
      await onSaved();
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiClientError) {
        if (err.code === "DUPLICATE_PURCHASE_ORDER_PRODUCT") {
          toast({ title: t("duplicateProduct"), variant: "destructive" });
          return;
        }
        if (err.code === "PURCHASE_ORDER_LINE_LIMIT_REACHED") {
          toast({ title: t("lineLimit"), variant: "destructive" });
          return;
        }
        if (err.code === "PURCHASE_ORDER_TOTAL_OVERFLOW") {
          toast({ title: t("totalOverflow"), variant: "destructive" });
          return;
        }
        if (err.code === "PURCHASE_ORDER_PRODUCT_INACTIVE" || err.status === 404) {
          toast({ title: t("invalidProduct"), variant: "destructive" });
          return;
        }
      }
      toast({ title: tErrors("generic"), variant: "destructive" });
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{lineId ? t("editLineTitle") : t("addLineTitle")}</DialogTitle>
          <DialogDescription>
            <span dir="auto">{productName}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="po-line-qty">{t("orderedQty")}</Label>
            <Input
              id="po-line-qty"
              type="number"
              inputMode="numeric"
              min={ORDERED_QTY_MIN}
              max={ORDERED_QTY_MAX}
              step={1}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              dir="ltr"
              aria-invalid={!qtyValid}
            />
            {!qtyValid ? (
              <p className="text-xs text-destructive" role="alert">{t("invalidQty")}</p>
            ) : null}
          </div>
          <MoneyInput
            id="po-line-price"
            label={t("unitPrice")}
            symbol={symbol}
            value={price}
            onChange={setPrice}
            precision={precision}
            invalidMsg={priceValid ? undefined : t("invalidPrice")}
            hint={t("unitPriceHint")}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button
            type="button"
            disabled={!qtyValid || !priceValid || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? <Loader2Inline /> : null}
            {t(lineId ? "saveLine" : "addLineAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Loader2Inline() {
  return (
    <span
      className="inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
      aria-hidden
    />
  );
}

/* --------------------------- lifecycle dialogs ----------------------------- */

function LifecycleDialog({
  action,
  reference,
  supplierName,
  status,
  lineCount,
  totalLabel,
  expectedDate,
  pending,
  onConfirm,
  onClose,
}: {
  action: LifecycleAction;
  reference: string;
  supplierName: string;
  status: PurchaseOrderStatus;
  lineCount: number;
  totalLabel: string;
  expectedDate: string | null;
  pending: boolean;
  onConfirm: (action: LifecycleAction) => void;
  onClose: () => void;
}) {
  const t = useTranslations("purchaseOrders");
  const tCommon = useTranslations("common");

  const destructive = action === "cancel";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(`${action}Title`)}</DialogTitle>
          <DialogDescription>{t(`${action}Desc`)}</DialogDescription>
        </DialogHeader>
        <dl className="space-y-1.5 rounded-lg border bg-muted/30 p-3 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{t("reference")}</dt>
            <dd className="font-medium" dir="auto">{reference}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{t("supplier")}</dt>
            <dd className="min-w-0 truncate" dir="auto">{supplierName}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{t("status")}</dt>
            <dd>{t(`status_${status}`)}</dd>
          </div>
          {action === "send" ? (
            <>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t("lines")}</dt>
                <dd className="tabular-nums" dir="ltr">{lineCount}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t("orderTotal")}</dt>
                <dd className="tabular-nums" dir="ltr">{totalLabel}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t("expectedDate")}</dt>
                <dd className="tabular-nums" dir="ltr">{expectedDate ?? "—"}</dd>
              </div>
            </>
          ) : null}
        </dl>
        {action === "send" ? (
          <p className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-2.5 text-xs text-sky-800 dark:text-sky-300">
            {t("sendReadonlyWarning")}
          </p>
        ) : null}
        {action === "confirm" ? (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-800 dark:text-amber-300">
            {t("confirmWarning")}
          </p>
        ) : null}
        {action === "close" ? (
          <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-xs text-emerald-800 dark:text-emerald-300">
            {t("closeWarning")}
          </p>
        ) : null}
        {destructive ? (
          <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-800 dark:text-rose-300">
            {t("cancelTerminalWarning")}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            disabled={pending}
            onClick={() => onConfirm(action)}
            data-testid={`po-lifecycle-${action}-confirm`}
          >
            {pending ? <Loader2Inline /> : null}
            {t(`${action}Confirm`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
