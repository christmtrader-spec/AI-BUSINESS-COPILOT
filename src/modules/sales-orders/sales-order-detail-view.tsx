"use client";

/**
 * Prompt 45 — sales-order detail view (§78–§91).
 *
 * STATUS ACTION VISIBILITY (§87):
 *  - DRAFT: edit header/lines + Confirm + Cancel;
 *  - CONFIRMED: Record Dispatch (only when a line has remaining > 0),
 *    Issue Invoice (only when fully dispatched + no invoice), Cancel
 *    (server re-validates the no-fulfillment guard), Export;
 *  - COMPLETED: linked invoice card + dispatch history + Export;
 *  - CANCELLED: read-only + Export.
 * Confirming states the §77 law verbatim (no reservation, no invoice);
 * the §82/§84 confirmations state the stock/financial consequences.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  ArrowLeft,
  Download,
  FileText,
  Link2,
  Loader2,
  Pencil,
  Plus,
  ReceiptText,
  Truck,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { can, type Role } from "@/lib/rbac";
import { ApiClientError } from "@/lib/api-client";
import { useAppStore } from "@/store/app-store";
import { formatMoney } from "@/lib/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState, PageHeader } from "@/components/shared/primitives";
import { cn } from "@/lib/utils";
import type { SalesOrderLineDto } from "@/lib/sales-orders/dto";
import type { SalesOrderStatus } from "@/lib/sales-orders/types";
import {
  addSalesOrderLine,
  cancelSalesOrder,
  confirmSalesOrder,
  fetchSalesOrder,
  issueOrderInvoice,
  removeSalesOrderLine,
  salesOrderKeys,
  updateSalesOrderDraft,
  updateSalesOrderLine,
} from "./sales-orders-api";
import { SalesOrderProductPicker } from "./sales-order-product-picker";
import {
  SalesOrderLineEditor,
  salesOrderLineErrorText,
} from "./sales-order-line-editor";
import { SalesOrderDispatchDialog } from "./sales-order-dispatch-dialog";

function statusBadge(status: SalesOrderStatus, label: string) {
  const styles: Record<SalesOrderStatus, string> = {
    DRAFT: "bg-muted text-muted-foreground border-border",
    CONFIRMED: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30",
    COMPLETED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
    CANCELLED: "bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30",
  };
  return (
    <Badge variant="outline" className={cn("text-xs font-medium", styles[status])}>
      {label}
    </Badge>
  );
}

export function SalesOrderDetailView({ id, role }: { id: string; role: Role }) {
  const t = useTranslations("salesOrders");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const navigate = useAppStore((s) => s.navigate);
  const businessId = useAppStore((s) => s.activeBusinessId) ?? "";
  const locale = useAppStore((s) => s.locale);
  const queryClient = useQueryClient();
  const writable = can(role, "data:write");

  const detail = useQuery({
    queryKey: salesOrderKeys.detail(businessId, id),
    queryFn: () => fetchSalesOrder(businessId, id),
    retry: false,
  });

  const [pickerOpen, setPickerOpen] = useState(false);
  const [addTarget, setAddTarget] = useState<{ id: string; name: string; sku: string | null; unit: string | null; salePriceMinor: number } | null>(null);
  const [editTarget, setEditTarget] = useState<SalesOrderLineDto | null>(null);
  const [removeTarget, setSalesOrderRemoveTarget] = useState<SalesOrderLineDto | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [editHeaderOpen, setEditHeaderOpen] = useState(false);
  const [headerReference, setHeaderReference] = useState("");
  const [headerNotes, setHeaderNotes] = useState("");
  const [headerDiscount, setHeaderDiscount] = useState("0");
  const [headerError, setHeaderError] = useState<string | null>(null);

  const data = detail.data;
  const isDraft = data?.order.status === "DRAFT";
  const isConfirmed = data?.order.status === "CONFIRMED";
  const hasInvoice = Boolean(data?.invoice);
  const remainingQty = data?.summary.remainingToDispatchQty ?? 0;
  const fullyDispatched = data?.summary.fullyDispatched ?? false;

  const dateFmt = useMemo(() => new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }), []);

  const invalidateAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: salesOrderKeys.all }),
      queryClient.invalidateQueries({ queryKey: ["sales"] }),
      queryClient.invalidateQueries({ queryKey: ["products"] }),
      queryClient.invalidateQueries({ queryKey: ["entities", businessId] }),
    ]);
  };

  const addLine = useMutation({
    mutationFn: (input: { productId: string; orderedQty: number; unitPriceMinor?: number }) =>
      addSalesOrderLine(businessId, id, input),
    onSuccess: async () => {
      toast({ description: t("lineAddedToast") });
      setAddTarget(null);
      await invalidateAll();
    },
  });

  const updateLine = useMutation({
    mutationFn: (input: { lineId: string; orderedQty?: number; unitPriceMinor?: number }) =>
      updateSalesOrderLine(businessId, id, input.lineId, {
        orderedQty: input.orderedQty,
        unitPriceMinor: input.unitPriceMinor,
      }),
    onSuccess: async () => {
      toast({ description: t("lineUpdatedToast") });
      setEditTarget(null);
      await invalidateAll();
    },
  });

  const removeLine = useMutation({
    mutationFn: (lineId: string) => removeSalesOrderLine(businessId, id, lineId),
    onSuccess: async () => {
      toast({ description: t("lineRemovedToast") });
      setSalesOrderRemoveTarget(null);
      await invalidateAll();
    },
  });

  const confirm = useMutation({
    mutationFn: () => confirmSalesOrder(businessId, id),
    onSuccess: async () => {
      toast({ description: t("confirmToast") });
      setConfirmOpen(false);
      await invalidateAll();
    },
    onError: () => {
      setConfirmOpen(false);
      setHeaderError(t("invalidTransition"));
    },
  });

  const cancel = useMutation({
    mutationFn: () => cancelSalesOrder(businessId, id),
    onSuccess: async () => {
      toast({ description: t("cancelToast") });
      setCancelOpen(false);
      await invalidateAll();
    },
    onError: (error) => {
      setCancelOpen(false);
      if (error instanceof ApiClientError && error.code === "SALES_ORDER_HAS_FULFILLMENT") {
        toast({ description: t("cancelBlocked") });
      } else {
        toast({ description: tErrors("generic") });
      }
    },
  });

  const issueInvoice = useMutation({
    mutationFn: () => issueOrderInvoice(businessId, id),
    onSuccess: async (result) => {
      toast({ description: t("invoiceToast", { number: result.invoiceDisplay }) });
      setInvoiceOpen(false);
      await invalidateAll();
    },
    onError: (error) => {
      setInvoiceOpen(false);
      if (error instanceof ApiClientError && error.code === "SALES_ORDER_NOT_FULLY_DISPATCHED") {
        toast({ description: t("invoiceFullyDispatchedRequired") });
      } else if (error instanceof ApiClientError && error.code === "SALES_ORDER_ALREADY_INVOICED") {
        toast({ description: t("invoiceAlreadyIssued") });
      } else {
        toast({ description: t("invoiceIssueFailed") });
      }
    },
  });

  const updateHeader = useMutation({
    mutationFn: (body: { reference?: string; discountMinor?: number; notes?: string | null }) =>
      updateSalesOrderDraft(businessId, id, body),
    onSuccess: async () => {
      toast({ description: t("updatedToast") });
      setEditHeaderOpen(false);
      await invalidateAll();
    },
    onError: (error) => {
      if (error instanceof ApiClientError && error.code === "SALES_ORDER_DUPLICATE_REFERENCE") {
        setHeaderError(t("duplicateReference"));
      } else if (error instanceof ApiClientError && error.code === "INVALID_DISCOUNT") {
        setHeaderError(t("discountInvalid"));
      } else {
        setHeaderError(tErrors("generic"));
      }
    },
  });

  async function exportCsv() {
    try {
      const res = await fetch(`/api/v1/sales-orders/${id}/export`, {
        headers: { "x-business-id": businessId },
        credentials: "same-origin",
      });
      if (res.status === 403) {
        toast({ description: t("exportForbidden") });
        return;
      }
      if (res.status === 429) {
        toast({ description: t("exportRateLimited") });
        return;
      }
      if (!res.ok) {
        toast({ description: t("exportFailed") });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ description: t("exportToast") });
    } catch {
      toast({ description: t("exportFailed") });
    }
  }

  if (detail.isError) {
    const status = detail.error instanceof ApiClientError ? detail.error.status : 0;
    return (
      <div className="space-y-6" data-view="sales-order-detail">
        <EmptyState
          icon={FileText}
          title={status === 404 ? t("notFoundTitle") : t("notFoundTitle")}
          description={status === 404 ? t("notFoundDesc") : tErrors("generic")}
        />
        <Button type="button" variant="outline" onClick={() => navigate({ kind: "sales-orders" })}>
          <ArrowLeft className="size-4" aria-hidden />
          {t("backToList")}
        </Button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4" data-view="sales-order-detail" aria-busy="true">
        <div className="h-10 animate-pulse rounded-lg bg-muted" />
        <div className="h-40 animate-pulse rounded-xl bg-muted" />
        <div className="h-64 animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }

  const currency = {
    currencyCode: data.order.currencyCodeAtOrder,
    currencySymbol: data.order.currencySymbolAtOrder,
    decimalPrecision: data.order.decimalPrecisionAtOrder,
  };
  // r56 — canonical formatter (money.ts) so RTL word-currencies (e.g. ریال)
  // render suffix-correct on every surface, matching the rest of the app.
  const money = (minor: number) => formatMoney(minor, currency, { locale });

  return (
    <div className="space-y-6" data-view="sales-order-detail">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <button
            type="button"
            className="text-muted-foreground mb-1 flex items-center gap-1 text-sm transition-colors hover:text-foreground"
            onClick={() => navigate({ kind: "sales-orders" })}
          >
            <ArrowLeft className="size-4" aria-hidden />
            {t("backToList")}
          </button>
          <h1 className="text-xl font-semibold tracking-tight" dir="auto">
            {t("title")} · {data.order.reference}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm" dir="auto">
            {t("detailSubtitle", { forCustomer: data.order.customerNameAtOrder ? ` · ${data.order.customerNameAtOrder}` : "" })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {statusBadge(data.order.status, t(`status_${data.order.status}`))}
          {isDraft && writable ? (
            <>
              <Button type="button" size="sm" onClick={() => setConfirmOpen(true)} data-testid="sales-order-confirm">
                {t("confirmAction")}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setCancelOpen(true)}>
                {t("cancelAction")}
              </Button>
            </>
          ) : null}
          {isConfirmed && writable ? (
            <>
              {remainingQty > 0 ? (
                <Button type="button" size="sm" variant="outline" onClick={() => setDispatchOpen(true)} data-testid="sales-order-record-dispatch">
                  <Truck className="size-4" aria-hidden />
                  {t("recordDispatch")}
                </Button>
              ) : null}
              {fullyDispatched && !hasInvoice ? (
                <Button type="button" size="sm" onClick={() => setInvoiceOpen(true)} data-testid="sales-order-issue-invoice">
                  <ReceiptText className="size-4" aria-hidden />
                  {t("issueInvoice")}
                </Button>
              ) : null}
              {/* §49/§87 — cancel is offered only while it can actually
                  succeed (no POSTED fulfillment, no invoice): the established
                  hide-pattern, matching Record dispatch / Issue invoice. The
                  server law remains the authority (defense in depth). */}
              {data.summary.dispatchedQty === 0 && !hasInvoice ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setCancelOpen(true)}
                  data-testid="sales-order-cancel-confirmed"
                >
                  {t("cancelAction")}
                </Button>
              ) : null}
            </>
          ) : null}
          <Button type="button" size="sm" variant="outline" onClick={exportCsv} data-testid="sales-order-export">
            <Download className="size-4" aria-hidden />
            {t("exportAction")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              void navigator.clipboard?.writeText(`${window.location.origin}/#/sales-orders/${id}`);
              toast({ description: t("copyLink") });
            }}
            aria-label={t("copyLink")}
          >
            <Link2 className="size-4" aria-hidden />
          </Button>
        </div>
      </div>

      {/* Order header card */}
      <Card>
        <CardContent className="grid gap-4 pt-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-muted-foreground text-xs">{t("reference")}</p>
            <p className="text-sm font-medium" dir="auto">{data.order.reference}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">{t("customer")}</p>
            <p className="text-sm font-medium" dir="auto">{data.order.customerNameAtOrder || "—"}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">{t("orderDate")}</p>
            <p className="text-sm" dir="ltr">{dateFmt.format(new Date(data.order.orderDate))}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">{t("expectedDate")}</p>
            <p className="text-sm" dir="ltr">
              {data.order.expectedDate ? dateFmt.format(new Date(data.order.expectedDate)) : "—"}
            </p>
          </div>
          {data.order.notes ? (
            <div className="sm:col-span-2 lg:col-span-4">
              <p className="text-muted-foreground text-xs">{t("notes")}</p>
              <p className="text-sm" dir="auto">{data.order.notes}</p>
            </div>
          ) : null}
          {isDraft && writable ? (
            <div className="sm:col-span-2 lg:col-span-4">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setHeaderReference(data.order.reference);
                  setHeaderNotes(data.order.notes ?? "");
                  setHeaderDiscount(String(data.order.discountMinor));
                  setHeaderError(null);
                  setEditHeaderOpen(true);
                }}
              >
                <Pencil className="size-3.5" aria-hidden />
                {t("editTitle")}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Fulfillment summary (§78) */}
      <Card data-testid="sales-order-fulfillment">
        <CardContent className="pt-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t("summaryTitle")}</h2>
            <Badge variant="outline" className="text-xs">
              {fullyDispatched
                ? t("fullyDispatched")
                : data.summary.dispatchedQty > 0
                  ? t("partiallyDispatched")
                  : t("nothingDispatched")}
            </Badge>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3 text-center">
            <div className="rounded-lg border p-3">
              <p className="text-muted-foreground text-xs">{t("orderedLabel")}</p>
              <p className="text-lg font-semibold tabular-nums" dir="ltr">{data.summary.totalQty}</p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-muted-foreground text-xs">{t("dispatchedLabel")}</p>
              <p className="text-lg font-semibold tabular-nums text-emerald-700 dark:text-emerald-300" dir="ltr">
                {data.summary.dispatchedQty}
              </p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-muted-foreground text-xs">{t("remainingLabel")}</p>
              <p className="text-lg font-semibold tabular-nums text-amber-700 dark:text-amber-300" dir="ltr">
                {data.summary.remainingToDispatchQty}
              </p>
            </div>
          </div>
          <Separator className="my-4" />
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("subtotal")}</span>
              <span className="tabular-nums" dir="ltr">{money(data.summary.subtotalMinor)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("discount")}</span>
              <span className="tabular-nums" dir="ltr">−{money(data.order.discountMinor)}</span>
            </div>
            <div className="flex justify-between font-semibold">
              <span>{t("total")}</span>
              <span className="tabular-nums" dir="ltr">{money(data.summary.totalMinor)}</span>
            </div>
          </div>
          {isDraft ? (
            <p className="text-muted-foreground mt-4 text-xs">{t("confirmNote")}</p>
          ) : null}
        </CardContent>
      </Card>

      {/* Lines */}
      <Card>
        <CardContent className="pt-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t("linesTitle")}</h2>
            {isDraft && writable ? (
              <Button type="button" size="sm" variant="outline" onClick={() => setPickerOpen(true)} data-testid="sales-order-add-line">
                <Plus className="size-4" aria-hidden />
                {t("addLine")}
              </Button>
            ) : null}
          </div>
          {data.lines.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-sm">{t("noLines")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" aria-label={t("linesTitle")}>
                <thead>
                  <tr className="text-muted-foreground border-b text-start text-xs">
                    <th className="py-2 text-start font-medium">{t("product")}</th>
                    <th className="py-2 text-end font-medium">{t("qty")}</th>
                    <th className="hidden py-2 text-end font-medium sm:table-cell">{t("dispatchedLabel")}</th>
                    <th className="hidden py-2 text-end font-medium sm:table-cell">{t("remainingLabel")}</th>
                    <th className="hidden py-2 text-end font-medium md:table-cell">{t("unitPrice")}</th>
                    <th className="py-2 text-end font-medium">{t("lineTotal")}</th>
                    {isDraft && writable ? <th className="py-2 text-end font-medium" aria-label="actions" /> : null}
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((line) => (
                    <tr key={line.id} className="border-b last:border-0">
                      <td className="py-2 pe-2" dir="auto">
                        <span className="font-medium">{line.productNameAtOrder}</span>
                        {line.skuAtOrder ? <span className="text-muted-foreground text-xs"> · {line.skuAtOrder}</span> : null}
                        {line.unitAtOrder ? <span className="text-muted-foreground text-xs"> · {line.unitAtOrder}</span> : null}
                      </td>
                      <td className="py-2 text-end tabular-nums" dir="ltr">{line.orderedQty}</td>
                      <td className="hidden py-2 text-end tabular-nums sm:table-cell" dir="ltr">{line.dispatchedQty}</td>
                      <td className="hidden py-2 text-end tabular-nums sm:table-cell" dir="ltr">{line.remainingToDispatchQty}</td>
                      <td className="hidden py-2 text-end tabular-nums md:table-cell" dir="ltr">{money(line.unitPriceMinor)}</td>
                      <td className="py-2 text-end tabular-nums" dir="ltr">{money(line.lineTotalMinor)}</td>
                      {isDraft && writable ? (
                        <td className="py-2 text-end">
                          <div className="flex justify-end gap-1">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => setEditTarget(line)}
                              aria-label={t("editLine")}
                            >
                              <Pencil className="size-3.5" aria-hidden />
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => setSalesOrderRemoveTarget(line)}
                              aria-label={t("removeLine")}
                            >
                              ×
                            </Button>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Linked invoice (§83/§85/§91) */}
      <Card data-testid="sales-order-linked-invoice">
        <CardContent className="pt-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t("linkedInvoice")}</h2>
            {hasInvoice ? (
              <Badge
                variant="outline"
                className={cn(
                  "text-xs",
                  data.invoice?.status === "PAID"
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
                )}
              >
                {t(`invoiceStatus_${data.invoice?.status ?? "UNPAID"}`)}
              </Badge>
            ) : null}
          </div>
          {hasInvoice && data.invoice ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium" dir="ltr">
                  {`INV-${String(data.invoice.number).padStart(4, "0")}`}
                </p>
                <p className="text-muted-foreground text-xs tabular-nums" dir="ltr">
                  {money(data.invoice.totalMinor)} · {t("paidLabel")}: {data.invoice.paidMinor}/{data.invoice.totalMinor}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => navigate({ kind: "entity", entity: "sale", id: data.invoice!.id })}
                data-testid="sales-order-view-invoice"
              >
                {t("viewInvoice")}
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground mt-2 text-sm">{t("noInvoiceYet")}</p>
          )}
        </CardContent>
      </Card>

      {/* Linked dispatch history (§90) */}
      <Card>
        <CardContent className="pt-4">
          <h2 className="mb-3 text-sm font-semibold">{t("linkedDispatches")}</h2>
          {data.recentDispatches.length === 0 ? (
            <p className="text-muted-foreground py-4 text-center text-sm">{t("noLinkedDispatches")}</p>
          ) : (
            <div className="space-y-1.5">
              {data.recentDispatches.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className="flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-start text-sm transition-colors hover:bg-muted/40"
                  onClick={() => navigate({ kind: "inventory-goods-dispatch", id: d.id })}
                  data-testid={`sales-order-dispatch-row-${d.reference}`}
                >
                  <span className="font-medium" dir="auto">{d.reference}</span>
                  <span className="text-muted-foreground text-xs tabular-nums" dir="ltr">
                    {d.totalDispatchedQty} · {d.postedAt ? dateFmt.format(new Date(d.postedAt)) : d.status}
                  </span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Product picker (bounded §76) */}
      {pickerOpen ? (
        <SalesOrderProductPicker
          businessId={businessId}
          existingProductIds={new Set(data.lines.map((l) => l.productId))}
          formatPrice={money}
          onPick={(p) => {
            setPickerOpen(false);
            setAddTarget(p);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}

      {/* Add line editor */}
      {addTarget ? (
        <SalesOrderLineEditor
          title={t("addLineTitle")}
          description={t("addLineSearch")}
          productName={addTarget.name}
          unit={addTarget.unit}
          initial={{ orderedQty: 1, unitPriceMinor: addTarget.salePriceMinor }}
          submitting={addLine.isPending}
          formatTotal={money}
          errorText={
            addLine.error
              ? salesOrderLineErrorText(addLine.error, {
                  duplicate: t("duplicateProduct"),
                  lineLimit: t("lineLimit"),
                  immutable: t("immutable"),
                  generic: tErrors("generic"),
                })
              : null
          }
          onSubmit={(value) =>
            addLine.mutate({
              productId: addTarget.id,
              orderedQty: value.orderedQty,
              unitPriceMinor: value.unitPriceMinor,
            })
          }
          onClose={() => {
            setAddTarget(null);
            addLine.reset();
          }}
        />
      ) : null}

      {/* Edit line editor */}
      {editTarget ? (
        <SalesOrderLineEditor
          title={t("editLineTitle")}
          description={t("editLine")}
          productName={editTarget.productNameAtOrder}
          unit={editTarget.unitAtOrder}
          initial={{ orderedQty: editTarget.orderedQty, unitPriceMinor: editTarget.unitPriceMinor }}
          submitting={updateLine.isPending}
          formatTotal={money}
          errorText={
            updateLine.error
              ? salesOrderLineErrorText(updateLine.error, {
                  duplicate: t("duplicateProduct"),
                  lineLimit: t("lineLimit"),
                  immutable: t("immutable"),
                  generic: tErrors("generic"),
                })
              : null
          }
          onSubmit={(value) =>
            updateLine.mutate({
              lineId: editTarget.id,
              orderedQty: value.orderedQty,
              unitPriceMinor: value.unitPriceMinor,
            })
          }
          onClose={() => {
            setEditTarget(null);
            updateLine.reset();
          }}
        />
      ) : null}

      {/* Remove line confirm */}
      <AlertDialog
        open={Boolean(removeTarget)}
        onOpenChange={(open) => !open && setSalesOrderRemoveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeLineTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("removeLineDesc", { product: removeTarget?.productNameAtOrder ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (removeTarget) removeLine.mutate(removeTarget.id);
              }}
            >
              {removeLine.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t("removeAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit header dialog (DRAFT-only, §26) */}
      <Dialog open={editHeaderOpen} onOpenChange={(open) => !open && setEditHeaderOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("editTitle")}</DialogTitle>
            <DialogDescription>{t("referenceHint")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="so-edit-reference">{t("reference")}</Label>
              <Input
                id="so-edit-reference"
                value={headerReference}
                onChange={(e) => setHeaderReference(e.target.value)}
                dir="auto"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="so-edit-discount">{t("discount")}</Label>
              <Input
                id="so-edit-discount"
                type="number"
                min={0}
                step={1}
                value={headerDiscount}
                onChange={(e) => setHeaderDiscount(e.target.value)}
                dir="ltr"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="so-edit-notes">{t("notes")}</Label>
              <Input
                id="so-edit-notes"
                value={headerNotes}
                onChange={(e) => setHeaderNotes(e.target.value)}
                dir="auto"
              />
            </div>
            {headerError ? <p className="text-destructive text-sm" role="alert">{headerError}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditHeaderOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button
              type="button"
              disabled={updateHeader.isPending}
              onClick={() => {
                setHeaderError(null);
                updateHeader.mutate({
                  ...(headerReference.trim() !== data.order.reference
                    ? { reference: headerReference.trim() || undefined }
                    : {}),
                  ...(Number(headerDiscount) !== data.order.discountMinor &&
                  Number.isSafeInteger(Number(headerDiscount)) &&
                  Number(headerDiscount) >= 0
                    ? { discountMinor: Number(headerDiscount) }
                    : {}),
                  notes: headerNotes.trim() || null,
                });
              }}
            >
              {updateHeader.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {tCommon("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* §77 — confirm dialog */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid="sales-order-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("confirmDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                confirm.mutate();
              }}
            >
              {confirm.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t("confirmConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* §49 — cancel dialog */}
      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent data-testid="sales-order-cancel-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("cancelTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("cancelDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-600 dark:hover:bg-rose-700"
              onClick={(e) => {
                e.preventDefault();
                cancel.mutate();
              }}
            >
              {cancel.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t("cancelConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* §84 — invoice confirmation */}
      <AlertDialog open={invoiceOpen} onOpenChange={setInvoiceOpen}>
        <AlertDialogContent data-testid="sales-order-invoice-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("issueInvoiceTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("issueInvoiceDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                issueInvoice.mutate();
              }}
            >
              {issueInvoice.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t("issueInvoice")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* §79–§82 — linked dispatch flow */}
      {dispatchOpen ? (
        <SalesOrderDispatchDialog order={data} onClose={() => setDispatchOpen(false)} />
      ) : null}
    </div>
  );
}
