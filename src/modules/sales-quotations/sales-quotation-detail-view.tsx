"use client";

/**
 * Prompt 47 — sales-quotation detail view (§17).
 *
 * STATUS ACTION VISIBILITY (§17, canonical law — the SERVER re-validates
 * every action):
 *  - DRAFT: edit header/lines/discount + Mark sent + Cancel;
 *  - SENT: terms read-only · Accept/Reject while VALID (hidden once the
 *    offer is effectively expired) · Cancel · Expire (only when the
 *    offer is ACTUALLY past validity) · Print · Export;
 *  - ACCEPTED: immutable terms · Convert to order (exactly once) ·
 *    Cancel-before-conversion · Print · Export;
 *  - REJECTED/EXPIRED/CANCELLED: read-only + Print + Export;
 *  - CONVERTED: read-only + deep link to the ONE converted SalesOrder +
 *    Print + Export (no duplicate-conversion action).
 *
 * HONESTY (§2.7/§17): the mark-sent confirmation states verbatim that the
 * application does NOT deliver an email — SENT is an internal record.
 * The accept confirmation states that acceptance is recorded by an
 * authorized internal user. The convert confirmation states the exact
 * consequences (one CONFIRMED order, no invoice/payment/stock change).
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  ArrowLeft,
  ArrowRightLeft,
  Ban,
  CalendarClock,
  CheckCircle2,
  Download,
  FileText,
  Link2,
  Loader2,
  Pencil,
  Plus,
  Printer,
  Send,
  ShieldCheck,
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
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
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
import { isValidCalendarDate, type SalesQuotationStatus } from "@/lib/sales-quotations/types";
import type { SalesQuotationLineDto } from "@/lib/sales-quotations/dto";
import {
  acceptSalesQuotation,
  addSalesQuotationLine,
  cancelSalesQuotation,
  convertSalesQuotation,
  expireSalesQuotation,
  fetchSalesQuotation,
  markSalesQuotationSent,
  rejectSalesQuotation,
  removeSalesQuotationLine,
  salesQuotationCsvUrl,
  salesQuotationKeys,
  updateSalesQuotationDraft,
  updateSalesQuotationLine,
  type SalesQuotationDetail,
} from "./sales-quotations-api";
import { SalesQuotationProductPicker } from "./sales-quotation-product-picker";
import {
  SalesQuotationLineEditor,
  salesQuotationLineErrorText,
} from "./sales-quotation-line-editor";
import { SalesQuotationPrintDialog } from "./sales-quotation-print";
import { SalesQuotationStatusBadge } from "./sales-quotations-view";

type ProductOption = {
  id: string;
  name: string;
  sku: string | null;
  unit: string | null;
  salePriceMinor: number;
  isActive: boolean;
};

/** The effective status drives ACTION visibility (§17) — a SENT offer
 *  past validity must never offer Accept/Reject. */
function isEffectivelyExpired(detail: SalesQuotationDetail): boolean {
  return (
    detail.quotation.persistedStatus === "SENT" &&
    (detail.quotation.effectiveStatus === "EXPIRED" || detail.quotation.isExpired)
  );
}

export function SalesQuotationDetailView({ id, role }: { id: string; role: Role }) {
  const t = useTranslations("salesQuotations");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const navigate = useAppStore((s) => s.navigate);
  const businessId = useAppStore((s) => s.activeBusinessId) ?? "";
  const locale = useAppStore((s) => s.locale);
  const queryClient = useQueryClient();
  const writable = can(role, "data:write");

  const detail = useQuery({
    queryKey: salesQuotationKeys.detail(businessId, id),
    queryFn: () => fetchSalesQuotation(businessId, id),
    retry: false,
  });

  const [pickerOpen, setPickerOpen] = useState(false);
  const [addTarget, setAddTarget] = useState<ProductOption | null>(null);
  const [editTarget, setEditTarget] = useState<SalesQuotationLineDto | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SalesQuotationLineDto | null>(null);
  const [sentOpen, setSentOpen] = useState(false);
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [expireOpen, setExpireOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [editHeaderOpen, setEditHeaderOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);

  const [headerCustomerId, setHeaderCustomerId] = useState<string | null>(null);
  const [headerCustomerName, setHeaderCustomerName] = useState("");
  const [headerReference, setHeaderReference] = useState("");
  const [headerQuotationDate, setHeaderQuotationDate] = useState("");
  const [headerValidUntil, setHeaderValidUntil] = useState("");
  const [headerExpected, setHeaderExpected] = useState("");
  const [headerDiscount, setHeaderDiscount] = useState("0");
  const [headerCustomerNotes, setHeaderCustomerNotes] = useState("");
  const [headerInternalNotes, setHeaderInternalNotes] = useState("");
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [lineError, setLineError] = useState<string | null>(null);

  const dateFmt = useMemo(() => new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }), []);

  function invalidateQuotationSurfaces(converted = false) {
    void queryClient.invalidateQueries({ queryKey: ["sales-quotations"] });
    void queryClient.invalidateQueries({ queryKey: ["entities", businessId] });
    if (converted) {
      // The new CONFIRMED order joins the sales-orders surfaces (§14).
      void queryClient.invalidateQueries({ queryKey: ["sales-orders"] });
    }
  }

  const markSent = useMutation({
    mutationFn: () => markSalesQuotationSent(businessId, id),
    onSuccess: () => {
      toast({ description: t("sentToast") });
      setSentOpen(false);
      invalidateQuotationSurfaces();
    },
    onError: (error) => {
      setSentOpen(false);
      toast({ description: lifecycleErrorText(error, t, tErrors("generic")), variant: "destructive" });
    },
  });

  const accept = useMutation({
    mutationFn: () => acceptSalesQuotation(businessId, id),
    onSuccess: () => {
      toast({ description: t("acceptedToast") });
      setAcceptOpen(false);
      invalidateQuotationSurfaces();
    },
    onError: (error) => {
      setAcceptOpen(false);
      toast({ description: lifecycleErrorText(error, t, tErrors("generic")), variant: "destructive" });
    },
  });

  const reject = useMutation({
    mutationFn: () => rejectSalesQuotation(businessId, id),
    onSuccess: () => {
      toast({ description: t("rejectedToast") });
      setRejectOpen(false);
      invalidateQuotationSurfaces();
    },
    onError: (error) => {
      setRejectOpen(false);
      toast({ description: lifecycleErrorText(error, t, tErrors("generic")), variant: "destructive" });
    },
  });

  const cancel = useMutation({
    mutationFn: () => cancelSalesQuotation(businessId, id),
    onSuccess: () => {
      toast({ description: t("cancelledToast") });
      setCancelOpen(false);
      invalidateQuotationSurfaces();
    },
    onError: (error) => {
      setCancelOpen(false);
      toast({ description: lifecycleErrorText(error, t, tErrors("generic")), variant: "destructive" });
    },
  });

  const expire = useMutation({
    mutationFn: () => expireSalesQuotation(businessId, id),
    onSuccess: () => {
      toast({ description: t("expiredToast") });
      setExpireOpen(false);
      invalidateQuotationSurfaces();
    },
    onError: (error) => {
      setExpireOpen(false);
      toast({ description: lifecycleErrorText(error, t, tErrors("generic")), variant: "destructive" });
    },
  });

  const convert = useMutation({
    mutationFn: () => convertSalesQuotation(businessId, id),
    onSuccess: (result) => {
      toast({ description: t("convertedToast", { reference: result.salesOrder.reference }) });
      setConvertOpen(false);
      invalidateQuotationSurfaces(true);
    },
    onError: (error) => {
      setConvertOpen(false);
      toast({ description: convertErrorText(error, t), variant: "destructive" });
    },
  });

  const updateHeader = useMutation({
    mutationFn: (input: Parameters<typeof updateSalesQuotationDraft>[2]) =>
      updateSalesQuotationDraft(businessId, id, input),
    onSuccess: () => {
      toast({ description: t("updatedToast") });
      setEditHeaderOpen(false);
      invalidateQuotationSurfaces();
    },
    onError: (error) => {
      if (error instanceof ApiClientError) {
        if (error.code === "SALES_QUOTATION_DUPLICATE_REFERENCE") setHeaderError(t("duplicateReference"));
        else if (error.code === "SALES_QUOTATION_INVALID_DATE_RANGE") setHeaderError(t("invalidDateRange"));
        else if (error.code === "INVALID_DISCOUNT") setHeaderError(t("discountInvalid"));
        else if (error.code === "SALES_QUOTATION_IMMUTABLE") setHeaderError(t("immutable"));
        else setHeaderError(tErrors("generic"));
      } else {
        setHeaderError(tErrors("generic"));
      }
    },
  });

  const addLine = useMutation({
    mutationFn: (input: { productId: string; qty: number; unitPriceMinor: number }) =>
      addSalesQuotationLine(businessId, id, input),
    onSuccess: () => {
      toast({ description: t("lineAddedToast") });
      setAddTarget(null);
      setLineError(null);
      invalidateQuotationSurfaces();
    },
    onError: (error) => {
      setLineError(
        salesQuotationLineErrorText(error, {
          duplicate: t("duplicateProduct"),
          lineLimit: t("lineLimit"),
          immutable: t("immutable"),
          generic: tErrors("generic"),
        }),
      );
    },
  });

  const updateLine = useMutation({
    mutationFn: (input: { lineId: string; qty: number; unitPriceMinor: number }) =>
      updateSalesQuotationLine(businessId, id, input.lineId, { qty: input.qty, unitPriceMinor: input.unitPriceMinor }),
    onSuccess: () => {
      toast({ description: t("lineUpdatedToast") });
      setEditTarget(null);
      setLineError(null);
      invalidateQuotationSurfaces();
    },
    onError: (error) => {
      setLineError(
        salesQuotationLineErrorText(error, {
          duplicate: t("duplicateProduct"),
          lineLimit: t("lineLimit"),
          immutable: t("immutable"),
          generic: tErrors("generic"),
        }),
      );
    },
  });

  const removeLine = useMutation({
    mutationFn: (lineId: string) => removeSalesQuotationLine(businessId, id, lineId),
    onSuccess: () => {
      toast({ description: t("lineRemovedToast") });
      setRemoveTarget(null);
      invalidateQuotationSurfaces();
    },
    onError: () => {
      setRemoveTarget(null);
      toast({ description: tErrors("generic"), variant: "destructive" });
    },
  });

  if (detail.isLoading) {
    return (
      <div className="space-y-4" data-view="sales-quotation-loading">
        <div className="h-10 w-64 animate-pulse rounded-lg bg-muted" />
        <div className="h-64 animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }

  if (detail.isError || !detail.data) {
    const notFound = detail.error instanceof ApiClientError && detail.error.status === 404;
    return (
      <div className="space-y-4" data-view="sales-quotation-not-found">
        <PageHeader title={t("notFoundTitle")} subtitle={t("notFoundDesc")} />
        <Button type="button" variant="outline" onClick={() => navigate({ kind: "sales-quotations" })}>
          <ArrowLeft className="size-4" aria-hidden />
          {t("backToList")}
        </Button>
      </div>
    );
  }

  const data = detail.data;
  const q = data.quotation;
  const status: SalesQuotationStatus = q.effectiveStatus;
  const expiredEffectively = isEffectivelyExpired(data);
  const editable = status === "DRAFT" && writable;
  const existingProductIds = new Set(data.lines.map((l) => l.productId));

  function openEditHeader() {
    setHeaderCustomerId(q.customerId);
    setHeaderCustomerName(q.customerNameAtQuotation);
    setHeaderReference(q.reference);
    setHeaderQuotationDate(q.quotationDate.slice(0, 10));
    setHeaderValidUntil(q.validUntilDate.slice(0, 10));
    setHeaderExpected(q.expectedDeliveryDate?.slice(0, 10) ?? "");
    setHeaderDiscount(String(q.discountMinor));
    setHeaderCustomerNotes(q.customerNotes ?? "");
    setHeaderInternalNotes(q.internalNotes ?? "");
    setHeaderError(null);
    setEditHeaderOpen(true);
  }

  function submitHeader() {
    setHeaderError(null);
    if (!isValidCalendarDate(headerQuotationDate) || !isValidCalendarDate(headerValidUntil)) {
      setHeaderError(t("invalidDate"));
      return;
    }
    if (headerValidUntil < headerQuotationDate) {
      setHeaderError(t("invalidDateRange"));
      return;
    }
    const discount = Number(headerDiscount);
    if (!Number.isSafeInteger(discount) || discount < 0) {
      setHeaderError(t("discountInvalid"));
      return;
    }
    updateHeader.mutate({
      customerId: headerCustomerId,
      reference: headerReference.trim() || undefined,
      quotationDate: headerQuotationDate,
      validUntilDate: headerValidUntil,
      expectedDeliveryDate: headerExpected || null,
      discountMinor: discount,
      customerNotes: headerCustomerNotes.trim() || null,
      internalNotes: headerInternalNotes.trim() || null,
    });
  }

  const lineColumns = [
    {
      id: "product",
      header: t("product"),
      cell: (l: SalesQuotationLineDto) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium" dir="auto">{l.productNameAtQuotation}</span>
          {l.skuAtQuotation ? (
            <span className="text-muted-foreground text-xs" dir="ltr">{l.skuAtQuotation}</span>
          ) : null}
        </span>
      ),
    },
    {
      id: "qty",
      header: t("qty"),
      align: "end" as const,
      cell: (l: SalesQuotationLineDto) => (
        <span className="tabular-nums" dir="ltr">{l.qty}</span>
      ),
    },
    {
      id: "unitPrice",
      header: t("unitPrice"),
      align: "end" as const,
      hideBelow: "md" as const,
      cell: (l: SalesQuotationLineDto) => (
        <span className="tabular-nums" dir="ltr">{l.unitPriceMinor.toLocaleString("en-US")}</span>
      ),
    },
    {
      id: "lineTotal",
      header: t("lineTotal"),
      align: "end" as const,
      cell: (l: SalesQuotationLineDto) => (
        <span className="tabular-nums" dir="ltr">{l.lineTotalMinor.toLocaleString("en-US")}</span>
      ),
    },
    ...(editable
      ? [
          {
            id: "actions",
            header: "",
            align: "end" as const,
            cell: (l: SalesQuotationLineDto) => (
              <span className="flex items-center justify-end gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t("editLine")}
                  onClick={() => {
                    setLineError(null);
                    setEditTarget(l);
                  }}
                >
                  <Pencil className="size-3.5" aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t("removeLine")}
                  onClick={() => setRemoveTarget(l)}
                >
                  <XCircle className="text-destructive size-3.5" aria-hidden />
                </Button>
              </span>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6" data-view="sales-quotation" data-quotation-status={status}>
      <PageHeader
        title={q.reference}
        subtitle={t("detailSubtitle")}
        actions={
          <Button type="button" variant="outline" onClick={() => navigate({ kind: "sales-quotations" })}>
            <ArrowLeft className="size-4" aria-hidden />
            {t("backToList")}
          </Button>
        }
      />

      {/* Header card */}
      <Card>
        <CardContent className="space-y-4 p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {/* Persisted vs effective status are BOTH explicit (§9). */}
              <SalesQuotationStatusBadge status={q.persistedStatus} label={t(`status_${q.persistedStatus}`)} />
              {q.effectiveStatus !== q.persistedStatus ? (
                <>
                  <span className="text-muted-foreground text-xs">→</span>
                  <SalesQuotationStatusBadge status={q.effectiveStatus} label={t(`status_${q.effectiveStatus}`)} />
                  <span className="text-muted-foreground text-xs">{t("effectiveStatusNote")}</span>
                </>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {editable ? (
                <Button type="button" variant="outline" size="sm" onClick={openEditHeader}>
                  <Pencil className="size-4" aria-hidden />
                  {t("editTitle")}
                </Button>
              ) : null}
              <Button type="button" variant="outline" size="sm" onClick={() => setPrintOpen(true)}>
                <Printer className="size-4" aria-hidden />
                {t("printAction")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => window.open(salesQuotationCsvUrl(businessId, id, locale), "_blank")}
              >
                <Download className="size-4" aria-hidden />
                {t("exportAction")}
              </Button>
            </div>
          </div>

          <Separator />

          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-muted-foreground text-xs">{t("customer")}</dt>
              <dd className="font-medium" dir="auto">
                {q.customerNameAtQuotation || <span className="text-muted-foreground">{t("noCustomer")}</span>}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">{t("quotationDate")}</dt>
              <dd dir="ltr">{dateFmt.format(new Date(q.quotationDate))}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">{t("validUntil")}</dt>
              <dd className={cn("flex items-center gap-1.5", expiredEffectively && "font-medium text-orange-700 dark:text-orange-300")} dir="ltr">
                <CalendarClock className="size-3.5" aria-hidden />
                {dateFmt.format(new Date(q.validUntilDate))}
              </dd>
            </div>
            {q.expectedDeliveryDate ? (
              <div>
                <dt className="text-muted-foreground text-xs">{t("expectedDelivery")}</dt>
                <dd dir="ltr">{dateFmt.format(new Date(q.expectedDeliveryDate))}</dd>
              </div>
            ) : null}
            <div>
              <dt className="text-muted-foreground text-xs">{t("currency")}</dt>
              <dd dir="ltr">{q.currencySymbolAtQuotation} · {q.currencyCodeAtQuotation}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">{t("createdAtLabel")}</dt>
              <dd dir="ltr">{dateFmt.format(new Date(q.createdAt))}</dd>
            </div>
            {q.createdBy?.name ? (
              <div>
                <dt className="text-muted-foreground text-xs">{t("createdBy")}</dt>
                <dd dir="auto">{q.createdBy.name}</dd>
              </div>
            ) : null}
            {q.sentAt ? (
              <div>
                <dt className="text-muted-foreground text-xs">{t("sentAtLabel")}</dt>
                <dd dir="ltr">{dateFmt.format(new Date(q.sentAt))}</dd>
              </div>
            ) : null}
            {q.acceptedAt ? (
              <div>
                <dt className="text-muted-foreground text-xs">{t("acceptedAtLabel")}</dt>
                <dd dir="ltr">{dateFmt.format(new Date(q.acceptedAt))}</dd>
              </div>
            ) : null}
            {q.rejectedAt ? (
              <div>
                <dt className="text-muted-foreground text-xs">{t("rejectedAtLabel")}</dt>
                <dd dir="ltr">{dateFmt.format(new Date(q.rejectedAt))}</dd>
              </div>
            ) : null}
            {q.cancelledAt ? (
              <div>
                <dt className="text-muted-foreground text-xs">{t("cancelledAtLabel")}</dt>
                <dd dir="ltr">{dateFmt.format(new Date(q.cancelledAt))}</dd>
              </div>
            ) : null}
            {q.convertedAt ? (
              <div>
                <dt className="text-muted-foreground text-xs">{t("convertedAtLabel")}</dt>
                <dd dir="ltr">{dateFmt.format(new Date(q.convertedAt))}</dd>
              </div>
            ) : null}
          </dl>

          {/* Lifecycle actions */}
          {writable ? (
            <div className="flex flex-wrap items-center gap-2 border-t pt-4">
              {status === "DRAFT" ? (
                <>
                  <Button type="button" size="sm" onClick={() => setSentOpen(true)}>
                    <Send className="size-4" aria-hidden />
                    {t("markSentAction")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setCancelOpen(true)}
                    disabled={cancel.isPending}
                  >
                    <Ban className="size-4" aria-hidden />
                    {t("cancelAction")}
                  </Button>
                </>
              ) : null}

              {q.persistedStatus === "SENT" && !expiredEffectively ? (
                <>
                  <Button type="button" size="sm" onClick={() => setAcceptOpen(true)} disabled={accept.isPending}>
                    <CheckCircle2 className="size-4" aria-hidden />
                    {t("acceptAction")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setRejectOpen(true)}
                    disabled={reject.isPending}
                  >
                    <XCircle className="size-4" aria-hidden />
                    {t("rejectAction")}
                  </Button>
                </>
              ) : null}

              {/* Expire — offered only when the offer is ACTUALLY past
                  validity (the server 409s a force-expire §9). */}
              {expiredEffectively ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setExpireOpen(true)}
                  disabled={expire.isPending}
                >
                  <CalendarClock className="size-4" aria-hidden />
                  {t("expireAction")}
                </Button>
              ) : null}

              {q.persistedStatus === "SENT" || q.persistedStatus === "ACCEPTED" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setCancelOpen(true)}
                  disabled={cancel.isPending}
                >
                  <Ban className="size-4" aria-hidden />
                  {t("cancelAction")}
                </Button>
              ) : null}

              {q.persistedStatus === "ACCEPTED" ? (
                <Button type="button" size="sm" onClick={() => setConvertOpen(true)} disabled={convert.isPending}>
                  <ArrowRightLeft className="size-4" aria-hidden />
                  {t("convertAction")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Converted-order card — appears ONLY when the relation exists (§7). */}
      {data.convertedOrder ? (
        <Card className="border-emerald-500/30 bg-emerald-500/5" data-testid="converted-order-card">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="flex items-center gap-2.5">
              <span className="bg-emerald-500/10 flex size-9 items-center justify-center rounded-lg">
                <ShieldCheck className="text-emerald-600 dark:text-emerald-300 size-4.5" aria-hidden />
              </span>
              <div>
                <p className="text-sm font-medium">{t("convertedOrderTitle")}</p>
                <p className="text-muted-foreground text-xs" dir="auto">
                  {t("convertedOrderDesc", { reference: data.convertedOrder.reference })}
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => navigate({ kind: "sales-order", id: data.convertedOrder!.id })}
            >
              <Link2 className="size-4" aria-hidden />
              {t("openConvertedOrder")}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {/* Lines card */}
      <Card>
        <CardContent className="space-y-4 p-6">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{t("linesTitle")}</h2>
            {editable ? (
              <Button type="button" size="sm" variant="outline" onClick={() => {
                setLineError(null);
                setPickerOpen(true);
              }}>
                <Plus className="size-4" aria-hidden />
                {t("addLine")}
              </Button>
            ) : null}
          </div>

          {data.lines.length === 0 ? (
            <EmptyState icon={FileText} title={t("noLines")} description={t("noLinesDesc")} />
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden md:block">
                <DataTable
                  columns={lineColumns}
                  rows={data.lines}
                  getRowId={(l) => l.id}
                  ariaLabel={t("linesTitle")}
                />
              </div>
              {/* Mobile cards */}
              <div className="flex flex-col gap-2 md:hidden">
                {data.lines.map((l) => (
                  <div key={l.id} className="rounded-xl border p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium" dir="auto">{l.productNameAtQuotation}</p>
                        {l.skuAtQuotation ? (
                          <p className="text-muted-foreground text-xs" dir="ltr">{l.skuAtQuotation}</p>
                        ) : null}
                      </div>
                      <span className="tabular-nums text-sm" dir="ltr">{l.lineTotalMinor.toLocaleString("en-US")}</span>
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs tabular-nums" dir="ltr">
                      {t("qty")}: {l.qty} · {t("unitPrice")}: {l.unitPriceMinor.toLocaleString("en-US")}
                    </p>
                    {editable ? (
                      <div className="mt-2 flex justify-end gap-1">
                        <Button type="button" variant="ghost" size="sm" aria-label={t("editLine")} onClick={() => { setLineError(null); setEditTarget(l); }}>
                          <Pencil className="size-3.5" aria-hidden />
                        </Button>
                        <Button type="button" variant="ghost" size="sm" aria-label={t("removeLine")} onClick={() => setRemoveTarget(l)}>
                          <XCircle className="text-destructive size-3.5" aria-hidden />
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          )}

          <Separator />

          <dl className="ms-auto grid w-full max-w-xs grid-cols-1 gap-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">{t("subtotal")}</dt>
              <dd className="tabular-nums" dir="ltr">{data.summary.subtotalMinor.toLocaleString("en-US")}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">{t("discount")}</dt>
              <dd className="tabular-nums" dir="ltr">-{data.summary.discountMinor.toLocaleString("en-US")}</dd>
            </div>
            <div className="flex justify-between border-t pt-1 font-semibold">
              <dt>{t("total")}</dt>
              <dd className="tabular-nums" dir="ltr">{data.summary.totalMinor.toLocaleString("en-US")}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {/* Notes — customer-visible and INTERNAL are clearly separated (§17). */}
      {q.customerNotes || q.internalNotes ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {q.customerNotes ? (
            <Card>
              <CardContent className="space-y-2 p-4">
                <p className="text-xs font-semibold">{t("customerNotes")}</p>
                <p className="text-sm whitespace-pre-wrap" dir="auto">{q.customerNotes}</p>
                <p className="text-muted-foreground text-xs">{t("customerNotesHint")}</p>
              </CardContent>
            </Card>
          ) : null}
          {q.internalNotes ? (
            <Card className="border-amber-500/30 bg-amber-500/5" data-testid="internal-notes-card">
              <CardContent className="space-y-2 p-4">
                <p className="flex items-center gap-1.5 text-xs font-semibold">
                  <ShieldCheck className="size-3.5" aria-hidden />
                  {t("internalNotes")}
                </p>
                <p className="text-sm whitespace-pre-wrap" dir="auto">{q.internalNotes}</p>
                <p className="text-muted-foreground text-xs">{t("internalNotesStaffOnly")}</p>
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : null}

      {/* Product picker (add line) */}
      {pickerOpen ? (
        <SalesQuotationProductPicker
          businessId={businessId}
          existingProductIds={existingProductIds}
          onPick={(product) => {
            setPickerOpen(false);
            setLineError(null);
            setAddTarget(product);
          }}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}

      {/* Add-line editor (qty + offered price) */}
      {addTarget ? (
        <SalesQuotationLineEditor
          title={t("addLineTitle")}
          description={t("addLineDesc", { product: addTarget.name })}
          productName={addTarget.name}
          unit={addTarget.unit}
          initial={{ qty: 1, unitPriceMinor: addTarget.salePriceMinor }}
          submitting={addLine.isPending}
          errorText={lineError}
          onSubmit={({ qty, unitPriceMinor }) =>
            addLine.mutate({ productId: addTarget.id, qty, unitPriceMinor })
          }
          onClose={() => {
            setAddTarget(null);
            setLineError(null);
          }}
        />
      ) : null}

      {/* Edit-line editor */}
      {editTarget ? (
        <SalesQuotationLineEditor
          title={t("editLineTitle")}
          description={t("editLineDesc", { product: editTarget.productNameAtQuotation })}
          productName={editTarget.productNameAtQuotation}
          unit={editTarget.unitAtQuotation}
          initial={{ qty: editTarget.qty, unitPriceMinor: editTarget.unitPriceMinor }}
          submitting={updateLine.isPending}
          errorText={lineError}
          onSubmit={({ qty, unitPriceMinor }) =>
            updateLine.mutate({ lineId: editTarget.id, qty, unitPriceMinor })
          }
          onClose={() => {
            setEditTarget(null);
            setLineError(null);
          }}
        />
      ) : null}

      {/* Remove-line confirmation */}
      {removeTarget ? (
        <AlertDialog open onOpenChange={(open) => !open && setRemoveTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("removeLineTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("removeLineDesc", { product: removeTarget.productNameAtQuotation })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  removeLine.mutate(removeTarget.id);
                }}
              >
                {removeLine.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                {t("removeAction")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}

      {/* Mark-sent confirmation — §2.7 honesty verbatim. */}
      <AlertDialog open={sentOpen} onOpenChange={setSentOpen}>
        <AlertDialogContent data-testid="mark-sent-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("markSentTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("markSentDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={markSent.isPending}>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                markSent.mutate();
              }}
            >
              {markSent.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t("markSentAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Accept confirmation — §2.7 honesty. */}
      <AlertDialog open={acceptOpen} onOpenChange={setAcceptOpen}>
        <AlertDialogContent data-testid="accept-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("acceptTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("acceptDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={accept.isPending}>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                accept.mutate();
              }}
            >
              {accept.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t("acceptAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reject confirmation */}
      <AlertDialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <AlertDialogContent data-testid="reject-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("rejectTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("rejectDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reject.isPending}>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                reject.mutate();
              }}
            >
              {reject.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t("rejectAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Cancel confirmation */}
      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent data-testid="cancel-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("cancelTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("cancelDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancel.isPending}>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                cancel.mutate();
              }}
            >
              {cancel.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t("cancelAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Expire confirmation — honest about the derivation (§9). */}
      <AlertDialog open={expireOpen} onOpenChange={setExpireOpen}>
        <AlertDialogContent data-testid="expire-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("expireTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("expireDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={expire.isPending}>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                expire.mutate();
              }}
            >
              {expire.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t("expireAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Convert confirmation — exact consequences (§13). */}
      <AlertDialog open={convertOpen} onOpenChange={setConvertOpen}>
        <AlertDialogContent data-testid="convert-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("convertTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("convertDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={convert.isPending}>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                convert.mutate();
              }}
            >
              {convert.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t("convertAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit header dialog (DRAFT only) */}
      <Dialog open={editHeaderOpen} onOpenChange={(open) => !open && setEditHeaderOpen(false)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg" data-testid="sales-quotation-edit-header">
          <DialogHeader>
            <DialogTitle>{t("editTitle")}</DialogTitle>
            <DialogDescription>{t("editDesc")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="sq-edit-customer">{t("customer")}</Label>
              <Input id="sq-edit-customer" value={headerCustomerName} readOnly dir="auto" />
              <p className="text-muted-foreground text-xs">{t("editCustomerHint")}</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sq-edit-reference">{t("reference")}</Label>
              <Input
                id="sq-edit-reference"
                value={headerReference}
                onChange={(e) => setHeaderReference(e.target.value)}
                dir="auto"
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="sq-edit-quotation-date">{t("quotationDate")}</Label>
                <Input
                  id="sq-edit-quotation-date"
                  type="date"
                  value={headerQuotationDate}
                  onChange={(e) => setHeaderQuotationDate(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sq-edit-valid-until">{t("validUntil")}</Label>
                <Input
                  id="sq-edit-valid-until"
                  type="date"
                  value={headerValidUntil}
                  onChange={(e) => setHeaderValidUntil(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sq-edit-expected">{t("expectedDeliveryOptional")}</Label>
                <Input
                  id="sq-edit-expected"
                  type="date"
                  value={headerExpected}
                  onChange={(e) => setHeaderExpected(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sq-edit-discount">{t("discount")}</Label>
                <Input
                  id="sq-edit-discount"
                  type="number"
                  min={0}
                  step={1}
                  value={headerDiscount}
                  onChange={(e) => setHeaderDiscount(e.target.value)}
                  inputMode="numeric"
                  dir="ltr"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sq-edit-customer-notes">{t("customerNotes")}</Label>
              <Textarea
                id="sq-edit-customer-notes"
                value={headerCustomerNotes}
                onChange={(e) => setHeaderCustomerNotes(e.target.value)}
                rows={2}
                dir="auto"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sq-edit-internal-notes">{t("internalNotes")}</Label>
              <Textarea
                id="sq-edit-internal-notes"
                value={headerInternalNotes}
                onChange={(e) => setHeaderInternalNotes(e.target.value)}
                rows={2}
                dir="auto"
              />
              <p className="text-muted-foreground text-xs">{t("internalNotesStaffOnly")}</p>
            </div>

            {headerError ? (
              <p className="text-destructive text-sm" role="alert">{headerError}</p>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditHeaderOpen(false)}
              disabled={updateHeader.isPending}
            >
              {tCommon("cancel")}
            </Button>
            <Button type="button" onClick={submitHeader} disabled={updateHeader.isPending}>
              {updateHeader.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {tCommon("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Printable offer */}
      {printOpen ? (
        <SalesQuotationPrintDialog businessId={businessId} id={id} onClose={() => setPrintOpen(false)} />
      ) : null}
    </div>
  );
}

/** Map a lifecycle domain error to the honest localized message (§22). */
function lifecycleErrorText(
  error: unknown,
  t: ReturnType<typeof useTranslations>,
  generic: string,
): string {
  if (error instanceof ApiClientError) {
    switch (error.code) {
      case "SALES_QUOTATION_INVALID_TRANSITION":
      case "SALES_QUOTATION_INVALID_STATUS":
        return t("invalidTransition");
      case "SALES_QUOTATION_EXPIRED":
        return t("expiredCannotAct");
      case "SALES_QUOTATION_NOT_EXPIRED":
        return t("notExpiredYet");
      case "SALES_QUOTATION_EMPTY":
        return t("emptyCannotSend");
      case "SALES_QUOTATION_IMMUTABLE":
        return t("immutable");
      case "SALES_QUOTATION_CORRUPT_HISTORY":
      case "SALES_QUOTATION_INVALID_PERSISTED_STATUS":
      case "SALES_QUOTATION_LINE_CAP_INVARIANT":
        return t("corruptHistory");
      default:
        return generic;
    }
  }
  return generic;
}

function convertErrorText(error: unknown, t: ReturnType<typeof useTranslations>): string {
  if (error instanceof ApiClientError) {
    if (error.code === "SALES_QUOTATION_ALREADY_CONVERTED") return t("alreadyConverted");
    if (error.code === "SALES_QUOTATION_NOT_ACCEPTED") return t("notAccepted");
    if (error.code === "SALES_QUOTATION_CORRUPT_HISTORY" || error.code === "SALES_QUOTATION_INVALID_PERSISTED_STATUS")
      return t("corruptHistory");
    if (error.code === "SALES_QUOTATION_LINE_CAP_INVARIANT") return t("lineCapInvariant");
  }
  // Conversion failures that are not domain-coded surface the same honest
  // generic error text (never a success toast, never a raw 500).
  return t("conversionFailed");
}
