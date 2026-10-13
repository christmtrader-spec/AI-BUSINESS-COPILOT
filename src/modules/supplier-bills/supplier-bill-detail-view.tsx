"use client";

/**
 * Prompt 48 — supplier-bill detail view.
 *
 * STATUS ACTION VISIBILITY: DRAFT → edit header/lines + Post + Cancel;
 * POSTED → Export + linked-payable view ONLY (immutable §10);
 * CANCELLED → Export ONLY.
 *
 * The post confirmation states the consequence VERBATIM (§16): posting
 * creates exactly ONE payable through the existing Expense; it does not
 * receive goods, does not change stock, does not create a payment, and the
 * posted bill is immutable. The linked payable card reads the LIVE Expense
 * (§12/§18) — paid amount and outstanding come from the financial
 * authority, never from a copied mutable balance.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  ArrowLeft,
  Download,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Wallet,
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
import { Separator } from "@/components/ui/separator";
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
import { EntityNotFound } from "@/modules/entities/entity-not-found";
import { FinanceStatusBadge } from "@/modules/finance-shared/finance-kit";
import { cn } from "@/lib/utils";
import type { SupplierBillDetailDto, SupplierBillLineDto } from "@/lib/supplier-bills/dto";
import type { SupplierBillStatus } from "@/lib/supplier-bills/types";
import {
  cancelSupplierBill,
  fetchSupplierBill,
  postSupplierBill,
  removeSupplierBillLine,
  supplierBillKeys,
  updateSupplierBillDraft,
  type PoBillableLine,
} from "./supplier-bills-api";
import { SupplierBillLinePicker } from "./supplier-bill-line-picker";
import { SupplierBillLineDialog } from "./supplier-bill-line-dialog";

function statusBadge(status: SupplierBillStatus, label: string) {
  const styles: Record<SupplierBillStatus, string> = {
    DRAFT: "bg-muted text-muted-foreground border-border",
    POSTED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
    CANCELLED: "bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30",
  };
  return (
    <Badge variant="outline" className={cn("text-xs font-medium", styles[status])}>
      {label}
    </Badge>
  );
}

export function SupplierBillDetailView({ id, role }: { id: string; role: Role }) {
  const t = useTranslations("supplierBills");
  const tCommon = useTranslations("common");
  const tNav = useTranslations("nav");
  const tErrors = useTranslations("errors");
  const navigate = useAppStore((s) => s.navigate);
  const businessId = useAppStore((s) => s.activeBusinessId) ?? "";
  const queryClient = useQueryClient();
  const writable = can(role, "data:write");

  const detail = useQuery({
    queryKey: supplierBillKeys.detail(businessId, id),
    queryFn: () => fetchSupplierBill(businessId, id),
    retry: false,
  });

  const [pickerOpen, setPickerOpen] = useState(false);
  const [addTarget, setAddTarget] = useState<PoBillableLine | null>(null);
  const [editTarget, setEditTarget] = useState<SupplierBillLineDto | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SupplierBillLineDto | null>(null);
  const [postOpen, setPostOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [editHeaderOpen, setEditHeaderOpen] = useState(false);
  const [headerInvoiceRef, setHeaderInvoiceRef] = useState("");
  const [headerBillDate, setHeaderBillDate] = useState("");
  const [headerDueDate, setHeaderDueDate] = useState("");
  const [headerDiscount, setHeaderDiscount] = useState("");
  const [headerNotes, setHeaderNotes] = useState("");

  const data = detail.data;
  const isDraft = data?.status === "DRAFT";

  const invalidateAll = async () => {
    // Refresh the bill, its PO (billing summary), the payable surfaces
    // (a posted bill creates a payable through the existing Expense) and
    // the Supplier 360 family.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: supplierBillKeys.all }),
      queryClient.invalidateQueries({
        queryKey: ["purchase-orders", "detail", businessId, data?.purchaseOrderId],
      }),
      queryClient.invalidateQueries({ queryKey: ["expenses"] }),
      queryClient.invalidateQueries({ queryKey: ["payables"] }),
      queryClient.invalidateQueries({ queryKey: ["aging"] }),
      queryClient.invalidateQueries({ queryKey: ["statements"] }),
      queryClient.invalidateQueries({ queryKey: ["entities", businessId] }),
    ]);
  };

  // Mutations ---------------------------------------------------------------

  const removeLine = useMutation({
    mutationFn: (lineId: string) =>
      import("./supplier-bills-api").then((m) => m.removeSupplierBillLine(businessId, id, lineId)),
    onSuccess: async () => {
      setRemoveTarget(null);
      toast({ description: t("lineRemovedToast") });
      await invalidateAll();
    },
    onError: () => toast({ title: tErrors("generic"), variant: "destructive" }),
  });

  const post = useMutation({
    mutationFn: () => postSupplierBill(businessId, id),
    onSuccess: async () => {
      setPostOpen(false);
      toast({ description: t("postedToast", { reference: data?.reference ?? "" }) });
      await invalidateAll();
    },
    onError: (error) => {
      setPostOpen(false);
      if (error instanceof ApiClientError) {
        const code = error.code;
        if (code === "SUPPLIER_BILL_ALREADY_POSTED" || code === "SUPPLIER_BILL_ALREADY_LINKED") {
          toast({ title: t("alreadyPosted"), variant: "destructive" });
        } else if (code === "SUPPLIER_BILL_QUANTITY_EXCEEDS_AVAILABLE") {
          const available = (error.details as { availableQty?: number } | undefined)?.availableQty ?? 0;
          toast({ title: t("qtyExceedsAvailable", { available }), variant: "destructive" });
        } else if (code === "SUPPLIER_BILL_QUANTITY_EXCEEDS_RECEIVED") {
          toast({ title: t("qtyExceedsReceived", { received: "" }).replace(/\s*$/, ""), variant: "destructive" });
        } else if (code === "SUPPLIER_BILL_RETURNED_QUANTITY") {
          toast({ title: t("returnedQuantity", { returned: "" }).replace(/\s*$/, ""), variant: "destructive" });
        } else if (code === "SUPPLIER_BILL_ZERO_TOTAL") {
          toast({ title: t("zeroTotal"), variant: "destructive" });
        } else if (code === "SUPPLIER_BILL_CURRENCY_MISMATCH") {
          toast({ title: t("currencyMismatch"), variant: "destructive" });
        } else if (code === "SUPPLIER_BILL_EMPTY") {
          toast({ title: t("emptyCannotPost"), variant: "destructive" });
        } else if (code === "SUPPLIER_BILL_INVALID_TRANSITION") {
          toast({ title: t("invalidTransition"), variant: "destructive" });
        } else {
          toast({ title: tErrors("generic"), variant: "destructive" });
        }
      } else {
        toast({ title: tErrors("generic"), variant: "destructive" });
      }
      detail.refetch();
    },
  });

  const cancel = useMutation({
    mutationFn: () => cancelSupplierBill(businessId, id),
    onSuccess: async () => {
      setCancelOpen(false);
      toast({ description: t("cancelledToast") });
      await invalidateAll();
    },
    onError: (error) => {
      setCancelOpen(false);
      if (error instanceof ApiClientError && error.code === "SUPPLIER_BILL_INVALID_TRANSITION") {
        toast({ title: t("invalidTransition"), variant: "destructive" });
      } else {
        toast({ title: tErrors("generic"), variant: "destructive" });
      }
      detail.refetch();
    },
  });

  const updateHeader = useMutation({
    mutationFn: (body: {
      supplierInvoiceReference?: string | null;
      billDate?: string;
      dueDate?: string | null;
      discountMinor?: number;
      internalNotes?: string | null;
    }) => updateSupplierBillDraft(businessId, id, body),
    onSuccess: async () => {
      setEditHeaderOpen(false);
      toast({ description: t("updatedToast") });
      await invalidateAll();
    },
    onError: (error) => {
      if (error instanceof ApiClientError) {
        if (error.code === "SUPPLIER_BILL_DUPLICATE_INVOICE_REFERENCE") {
          toast({ title: t("duplicateInvoiceReference"), variant: "destructive" });
        } else if (error.code === "SUPPLIER_BILL_IMMUTABLE") {
          toast({ title: t("immutable"), variant: "destructive" });
        } else {
          toast({ title: tErrors("generic"), variant: "destructive" });
        }
      } else {
        toast({ title: tErrors("generic"), variant: "destructive" });
      }
    },
  });

  async function exportCsv() {
    try {
      const res = await fetch(`/api/v1/supplier-bills/${id}/export`, {
        headers: { "x-business-id": businessId },
      });
      if (res.status === 429) {
        toast({ title: t("exportRateLimited"), variant: "destructive" });
        return;
      }
      if (res.status === 403) {
        toast({ title: t("exportForbidden"), variant: "destructive" });
        return;
      }
      if (!res.ok) {
        toast({ title: t("exportFailed"), variant: "destructive" });
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = match?.[1] ?? "supplier-bill.csv";
      a.click();
      URL.revokeObjectURL(url);
      toast({ description: t("exportToast") });
    } catch {
      toast({ title: t("exportFailed"), variant: "destructive" });
    }
  }

  const dateFmt = useMemo(() => new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }), []);
  const dateTimeFmt = useMemo(
    () => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }),
    [],
  );

  if (detail.isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-10 w-40 animate-pulse rounded-lg bg-muted" />
        <div className="h-40 animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }

  if (detail.isError || !data) {
    const notFound =
      detail.error instanceof ApiClientError &&
      (detail.error.status === 404 ||
        detail.error.code === "SUPPLIER_BILL_NOT_FOUND" ||
        detail.error.code === "SUPPLIER_BILL_INVALID_PERSISTED_STATUS" ||
        detail.error.code === "SUPPLIER_BILL_CORRUPT_HISTORY");
    return notFound ? (
      <EntityNotFound
        backToList={t("backToList")}
        onBackToList={() => navigate({ kind: "supplier-bills" })}
        dashboardLabel={tNav("dashboard")}
        onDashboard={() => navigate({ kind: "dashboard" })}
      />
    ) : (
      <EmptyState title={t("loadFailed")} description={tCommon("retry")} />
    );
  }

  const precision = data.decimalPrecisionAtBill;
  const fmt = (minor: number) => `${(minor / 10 ** precision).toFixed(precision)} ${data.currencySymbolAtBill}`;
  const dayFmt = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

  function openEditHeader() {
    if (!data) return;
    setHeaderInvoiceRef(data.supplierInvoiceReference ?? "");
    setHeaderBillDate(dayFmt(data.billDate));
    setHeaderDueDate(dayFmt(data.dueDate) !== "—" ? dayFmt(data.dueDate) : "");
    setHeaderDiscount(String(data.discountMinor));
    setHeaderNotes(data.internalNotes ?? "");
    setEditHeaderOpen(true);
  }

  function submitHeaderEdit() {
    if (!data || updateHeader.isPending) return;
    const discount = Number.parseInt(headerDiscount, 10);
    updateHeader.mutate({
      supplierInvoiceReference: headerInvoiceRef.trim() || null,
      billDate: headerBillDate || undefined,
      dueDate: headerDueDate || null,
      discountMinor: Number.isInteger(discount) && discount >= 0 ? discount : undefined,
      internalNotes: headerNotes.trim() || null,
    });
  }

  const lineColumns = [
    {
      id: "product",
      header: t("product"),
      cell: (r: SupplierBillLineDto) => (
        <div className="min-w-0">
          <span className="block truncate font-medium" dir="auto">{r.productNameAtBill}</span>
          {r.skuAtBill ? (
            <span className="text-muted-foreground block text-xs" dir="auto">{r.skuAtBill}</span>
          ) : null}
        </div>
      ),
    },
    {
      id: "qty",
      header: t("billedQty"),
      align: "end" as const,
      cell: (r: SupplierBillLineDto) => (
        <span className="tabular-nums" dir="ltr">{r.billedQty}</span>
      ),
    },
    {
      id: "poPrice",
      header: t("poUnitPrice"),
      align: "end" as const,
      hideBelow: "lg" as const,
      cell: (r: SupplierBillLineDto) => (
        <span className="text-muted-foreground tabular-nums" dir="ltr">
          {(r.purchaseOrderUnitPriceMinor / 10 ** precision).toFixed(precision)}
        </span>
      ),
    },
    {
      id: "unitPrice",
      header: t("unitPrice"),
      align: "end" as const,
      cell: (r: SupplierBillLineDto) => (
        <span className="tabular-nums" dir="ltr">
          {(r.unitPriceMinor / 10 ** precision).toFixed(precision)}
        </span>
      ),
    },
    {
      id: "variance",
      header: t("priceVariance"),
      align: "end" as const,
      hideBelow: "lg" as const,
      cell: (r: SupplierBillLineDto) => {
        const variance = r.unitPriceMinor - r.purchaseOrderUnitPriceMinor;
        return (
          <span
            className={cn("tabular-nums", variance !== 0 && "font-medium text-amber-600 dark:text-amber-400")}
            dir="ltr"
          >
            {variance > 0 ? "+" : ""}
            {(variance / 10 ** precision).toFixed(precision)}
          </span>
        );
      },
    },
    {
      id: "lineTotal",
      header: t("lineTotal"),
      align: "end" as const,
      cell: (r: SupplierBillLineDto) => (
        <span className="font-medium tabular-nums" dir="ltr">
          {(r.lineTotalMinor / 10 ** precision).toFixed(precision)}
        </span>
      ),
    },
    ...(isDraft && writable
      ? [
          {
            id: "rowActions",
            header: "",
            align: "end" as const,
            cell: (r: SupplierBillLineDto) => (
              <div className="flex items-center justify-end gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t("editLine")}
                  onClick={() => setEditTarget(r)}
                >
                  <Pencil className="size-4" aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t("removeLine")}
                  onClick={() => setRemoveTarget(r)}
                >
                  <Trash2 className="size-4 text-destructive" aria-hidden />
                </Button>
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6" data-view="supplier-bill-detail">
      <PageHeader
        title={data.reference}
        subtitle={t("detailSubtitle")}
        actions={
          <>
            <Button type="button" variant="ghost" onClick={() => navigate({ kind: "supplier-bills" })}>
              <ArrowLeft className="size-4" aria-hidden />
              {t("backToList")}
            </Button>
            <Button type="button" variant="outline" onClick={exportCsv}>
              <Download className="size-4" aria-hidden />
              {t("exportAction")}
            </Button>
            {isDraft && writable ? (
              <>
                <Button type="button" variant="outline" onClick={openEditHeader}>
                  <Pencil className="size-4" aria-hidden />
                  {t("editTitle")}
                </Button>
                <Button type="button" variant="outline" onClick={() => setCancelOpen(true)}>
                  {t("cancelAction")}
                </Button>
                <Button type="button" onClick={() => setPostOpen(true)} data-testid="sb-post-action">
                  {t("postAction")}
                </Button>
              </>
            ) : null}
          </>
        }
      />

      {/* Summary strip */}
      <Card>
        <CardContent className="grid gap-4 pt-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="sb-summary">
          <div>
            <p className="text-muted-foreground text-xs">{t("status")}</p>
            <div className="mt-1">{statusBadge(data.status, t(`status_${data.status}`))}</div>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">{t("purchaseOrder")}</p>
            <button
              type="button"
              className="mt-1 text-sm font-medium underline-offset-2 hover:underline"
              onClick={() => navigate({ kind: "purchase-order", id: data.purchaseOrderId })}
              data-testid="sb-po-link"
            >
              {data.purchaseOrderReferenceAtBill}
            </button>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">{t("supplier")}</p>
            <p className="mt-1 text-sm" dir="auto">{data.supplierNameAtBill}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">{t("supplierInvoiceReference")}</p>
            <p className="mt-1 text-sm" dir="auto">
              {data.supplierInvoiceReference ?? "—"}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">{t("billDate")}</p>
            <p className="mt-1 text-sm tabular-nums" dir="ltr">{dayFmt(data.billDate)}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">{t("dueDate")}</p>
            <p className="mt-1 text-sm tabular-nums" dir="ltr">{dayFmt(data.dueDate)}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">{t("createdBy")}</p>
            <p className="mt-1 truncate text-sm" dir="auto">
              {data.createdBy?.name ?? data.createdBy?.email ?? "—"}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground text-xs">
              {data.status === "POSTED"
                ? t("postedAtLabel")
                : data.status === "CANCELLED"
                  ? t("cancelledAtLabel")
                  : t("createdAtLabel")}
            </p>
            <p className="mt-1 text-sm tabular-nums" dir="ltr">
              {dateTimeFmt.format(
                new Date(data.postedAt ?? data.cancelledAt ?? data.createdAt),
              )}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Lines */}
      <Card>
        <CardContent className="pt-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">{t("linesTitle")}</h2>
            {isDraft && writable ? (
              <Button type="button" size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
                <Plus className="size-4" aria-hidden />
                {t("addLine")}
              </Button>
            ) : null}
          </div>
          {data.lines.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-sm">
              {t("noLines")} {isDraft ? t("noLinesDesc") : null}
            </p>
          ) : (
            <DataTable
              columns={lineColumns}
              rows={data.lines}
              getRowId={(r) => r.id}
              ariaLabel={t("linesTitle")}
            />
          )}

          {/* Totals */}
          <div className="mt-4 space-y-1.5 border-t pt-4 text-sm" data-testid="sb-totals">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("subtotal")}</span>
              <span className="tabular-nums" dir="ltr">{fmt(data.subtotalMinor)}</span>
            </div>
            {data.discountMinor !== 0 ? (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t("discount")}</span>
                <span className="tabular-nums" dir="ltr">−{fmt(data.discountMinor)}</span>
              </div>
            ) : null}
            <Separator />
            <div className="flex items-center justify-between text-base font-semibold">
              <span>{t("total")}</span>
              <span className="tabular-nums" dir="ltr">{fmt(data.totalMinor)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Linked payable (POSTED only) — read from the LIVE Expense */}
      {data.payable ? (
        <Card data-testid="sb-payable-card">
          <CardContent className="pt-4">
            <div className="mb-3 flex items-center gap-2">
              <Wallet className="text-muted-foreground size-4" aria-hidden />
              <h2 className="text-sm font-semibold">{t("payableTitle")}</h2>
              <FinanceStatusBadge status={data.payable.status} />
            </div>
            <p className="text-muted-foreground mb-4 text-xs">{t("payableDesc")}</p>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-muted-foreground text-xs">{t("payableAmount")}</p>
                <p className="mt-1 text-sm font-medium tabular-nums" dir="ltr">
                  {fmt(data.payable.amountMinor)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">{t("paidAmount")}</p>
                <p className="mt-1 text-sm tabular-nums" dir="ltr">{fmt(data.payable.paidMinor)}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">{t("outstandingAmount")}</p>
                <p className="mt-1 text-sm font-medium tabular-nums" dir="ltr">
                  {fmt(data.payable.outstandingMinor)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs">{t("dueDate")}</p>
                <p className="mt-1 text-sm tabular-nums" dir="ltr">{dayFmt(data.payable.dueDate)}</p>
              </div>
            </div>

            {/* Payments against the linked payable */}
            <div className="mt-5">
              <h3 className="mb-2 text-xs font-semibold">{t("paymentsTitle")}</h3>
              {data.payments.length === 0 ? (
                <p className="text-muted-foreground text-xs">{t("noPayments")}</p>
              ) : (
                <ul className="divide-y rounded-lg border">
                  {data.payments.map((p) => (
                    <li key={p.id} className="flex items-center justify-between px-3 py-2 text-sm">
                      <span className="tabular-nums" dir="ltr">{fmt(p.amountMinor)}</span>
                      <span className="text-muted-foreground text-xs" dir="ltr">
                        {dateTimeFmt.format(new Date(p.paidAt))} · {p.method}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-muted-foreground mt-2 text-xs">{t("openPaymentsHint")}</p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Internal notes (staff-only) */}
      {data.internalNotes ? (
        <Card>
          <CardContent className="pt-4">
            <h2 className="text-sm font-semibold">{t("internalNotes")}</h2>
            <p className="text-muted-foreground mt-1 text-xs">{t("internalNotesHint")}</p>
            <p className="mt-2 whitespace-pre-wrap text-sm" dir="auto">{data.internalNotes}</p>
          </CardContent>
        </Card>
      ) : null}

      {/* Picker */}
      {pickerOpen && data.purchaseOrderId ? (
        <Dialog open onOpenChange={(open) => !open && setPickerOpen(false)}>
          <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{t("addLineTitle")}</DialogTitle>
              <DialogDescription>{t("matchingHint")}</DialogDescription>
            </DialogHeader>
            <SupplierBillLinePicker
              businessId={businessId}
              purchaseOrderId={data.purchaseOrderId}
              onPick={(line) => {
                setPickerOpen(false);
                setAddTarget(line);
              }}
              onError={() => undefined}
            />
          </DialogContent>
        </Dialog>
      ) : null}

      {/* Add / edit line dialog */}
      {addTarget ? (
        <SupplierBillLineDialog
          businessId={businessId}
          billId={id}
          line={addTarget}
          onClose={() => setAddTarget(null)}
          onSaved={async () => {
            setAddTarget(null);
            toast({ description: t("lineAddedToast") });
            await invalidateAll();
          }}
        />
      ) : null}
      {editTarget ? (
        <SupplierBillLineDialog
          businessId={businessId}
          billId={id}
          existingLine={{
            id: editTarget.id,
            productNameAtBill: editTarget.productNameAtBill,
            billedQty: editTarget.billedQty,
            unitPriceMinor: editTarget.unitPriceMinor,
            purchaseOrderUnitPriceMinor: editTarget.purchaseOrderUnitPriceMinor,
          }}
          onClose={() => setEditTarget(null)}
          onSaved={async () => {
            setEditTarget(null);
            toast({ description: t("lineUpdatedToast") });
            await invalidateAll();
          }}
        />
      ) : null}

      {/* Remove line confirm */}
      <Dialog open={removeTarget !== null} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("removeLineTitle")}</DialogTitle>
            <DialogDescription>
              {t("removeLineDesc", { product: removeTarget?.productNameAtBill ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => setRemoveTarget(null)}>
              {tCommon("cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={removeLine.isPending}
              onClick={() => removeTarget && removeLine.mutate(removeTarget.id)}
            >
              {removeLine.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t("removeAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Post confirmation — the verbatim consequence text (§16) */}
      <Dialog open={postOpen} onOpenChange={setPostOpen}>
        <DialogContent className="sm:max-w-md" data-testid="sb-post-dialog">
          <DialogHeader>
            <DialogTitle>{t("postTitle")}</DialogTitle>
            <DialogDescription>{t("postDesc")}</DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border bg-muted/30 p-3 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("lines")}</span>
              <span className="tabular-nums" dir="ltr">{data.lines.length}</span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-muted-foreground">{t("total")}</span>
              <span className="font-medium tabular-nums" dir="ltr">{fmt(data.totalMinor)}</span>
            </div>
            <p className="text-muted-foreground mt-2">{t("postDocsNote")}</p>
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => setPostOpen(false)} disabled={post.isPending}>
              {tCommon("cancel")}
            </Button>
            <Button type="button" onClick={() => post.mutate()} disabled={post.isPending} data-testid="sb-post-confirm">
              {post.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t("postAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel confirmation */}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("cancelTitle")}</DialogTitle>
            <DialogDescription>{t("cancelDesc")}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => setCancelOpen(false)} disabled={cancel.isPending}>
              {tCommon("cancel")}
            </Button>
            <Button type="button" variant="destructive" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
              {cancel.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t("cancelAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Header edit dialog */}
      <Dialog open={editHeaderOpen} onOpenChange={setEditHeaderOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("editTitle")}</DialogTitle>
            <DialogDescription>{t("editDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="sb-edit-invoice">{t("supplierInvoiceReferenceOptional")}</Label>
              <Input
                id="sb-edit-invoice"
                value={headerInvoiceRef}
                onChange={(e) => setHeaderInvoiceRef(e.target.value)}
                maxLength={96}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="sb-edit-bill-date">{t("billDate")}</Label>
                <Input
                  id="sb-edit-bill-date"
                  type="date"
                  value={headerBillDate}
                  onChange={(e) => setHeaderBillDate(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sb-edit-due">{t("dueDateOptional")}</Label>
                <Input
                  id="sb-edit-due"
                  type="date"
                  value={headerDueDate}
                  onChange={(e) => setHeaderDueDate(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sb-edit-discount">{t("discount")}</Label>
              <Input
                id="sb-edit-discount"
                type="number"
                min={0}
                step={1}
                value={headerDiscount}
                onChange={(e) => setHeaderDiscount(e.target.value)}
                inputMode="numeric"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sb-edit-notes">{t("internalNotes")}</Label>
              <textarea
                id="sb-edit-notes"
                className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-20 w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:opacity-50"
                value={headerNotes}
                onChange={(e) => setHeaderNotes(e.target.value)}
                maxLength={2016}
              />
              <p className="text-muted-foreground text-xs">{t("internalNotesHint")}</p>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => setEditHeaderOpen(false)} disabled={updateHeader.isPending}>
              {tCommon("cancel")}
            </Button>
            <Button type="button" onClick={submitHeaderEdit} disabled={updateHeader.isPending || !headerBillDate}>
              {updateHeader.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t("saveAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
