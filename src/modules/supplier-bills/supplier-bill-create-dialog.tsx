"use client";

/**
 * Prompt 48 — supplier-bill create dialog.
 *
 * The picker shows ONLY billable purchase orders (CONFIRMED or CLOSED —
 * the documented billing gate) with remaining invoiceable quantities over
 * a bounded page. The client submits ONLY purchaseOrderId/reference/
 * supplierInvoiceReference/billDate/dueDate/discountMinor/internalNotes —
 * supplier/currency snapshots, status and creator are server-derived.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiClientError } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { createSupplierBill, fetchPoOptionsForBilling, type PoOption } from "./supplier-bills-api";

function todayCalendarDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function SupplierBillCreateDialog({
  businessId,
  presetPo,
  onClose,
  onCreated,
}: {
  businessId: string;
  /** When opened FROM a purchase order, preselect it. */
  presetPo?: { id: string; reference: string; supplierNameAtOrder: string; availableQty: number };
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const t = useTranslations("supplierBills");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");

  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<PoOption | null>(
    presetPo
      ? {
          id: presetPo.id,
          reference: presetPo.reference,
          supplierNameAtOrder: presetPo.supplierNameAtOrder,
          status: "CONFIRMED",
          availableQty: presetPo.availableQty,
        }
      : null,
  );
  const [reference, setReference] = useState("");
  const [invoiceRef, setInvoiceRef] = useState("");
  const [billDate, setBillDate] = useState(todayCalendarDate());
  const [dueDate, setDueDate] = useState("");
  const [internalNotes, setInternalNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [domainError, setDomainError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedQ(q);
      setPage(1);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [q]);

  const pos = useQuery({
    queryKey: ["supplier-bills", "po-options", businessId, debouncedQ, page],
    queryFn: () => fetchPoOptionsForBilling(businessId, debouncedQ, page),
    staleTime: 5_000,
  });

  const items = pos.data?.items ?? [];
  const hasMore = useMemo(() => {
    if (!pos.data) return false;
    return page * (pos.data.pageSize ?? 10) < (pos.data.total ?? 0);
  }, [pos.data, page]);

  async function submit() {
    if (!selected || submitting) return;
    setSubmitting(true);
    setDomainError(null);
    try {
      const created = await createSupplierBill(businessId, {
        purchaseOrderId: selected.id,
        reference: reference.trim() || undefined,
        supplierInvoiceReference: invoiceRef.trim() || null,
        billDate,
        dueDate: dueDate || undefined,
        internalNotes: internalNotes.trim() || null,
      });
      toast({ description: t("createdToast", { reference: created.reference }) });
      onCreated(created.id);
    } catch (error) {
      if (error instanceof ApiClientError) {
        if (error.code === "SUPPLIER_BILL_DUPLICATE_REFERENCE") {
          setDomainError(t("duplicateReference"));
        } else if (error.code === "SUPPLIER_BILL_DUPLICATE_INVOICE_REFERENCE") {
          setDomainError(t("duplicateInvoiceReference"));
        } else if (error.code === "SUPPLIER_BILL_PURCHASE_ORDER_NOT_BILLABLE") {
          setDomainError(t("poNotBillable"));
        } else if (error.code === "VALIDATION_ERROR") {
          setDomainError(t("invalidDate"));
        } else if (error.status === 404) {
          setDomainError(t("notFoundDesc"));
        } else {
          setDomainError(tErrors("generic"));
        }
      } else {
        setDomainError(tErrors("generic"));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg" data-testid="supplier-bill-create-dialog">
        <DialogHeader>
          <DialogTitle>{t("createTitle")}</DialogTitle>
          <DialogDescription>{t("createDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="sb-po-search">{t("purchaseOrder")}</Label>
            <Input
              id="sb-po-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("searchPlaceholder")}
              autoComplete="off"
            />
            {selected ? (
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-start text-sm"
                onClick={() => setSelected(null)}
              >
                <span dir="auto" className="min-w-0 truncate">
                  <span className="font-medium">{selected.reference}</span>
                  <span className="text-muted-foreground"> · {selected.supplierNameAtOrder}</span>
                </span>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums" dir="ltr">
                  {t("availableQty")}: {selected.availableQty}
                </span>
              </button>
            ) : null}
          </div>

          {!selected ? (
            <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border p-2" role="listbox" aria-label={t("purchaseOrder")}>
              {pos.isLoading ? (
                <div className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                </div>
              ) : items.length === 0 ? (
                <p className="text-muted-foreground py-6 text-center text-sm">{t("noLinesFound")}</p>
              ) : (
                items.map((po) => (
                  <button
                    key={po.id}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="flex w-full items-center justify-between rounded-md px-2 py-2 text-start text-sm transition-colors hover:bg-muted/60 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                    onClick={() => setSelected(po)}
                  >
                    <span dir="auto" className="min-w-0 truncate">
                      <span className="font-medium">{po.reference}</span>
                      <span className="text-muted-foreground"> · {po.supplierNameAtOrder}</span>
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums" dir="ltr">
                      {t("availableQty")}: {po.availableQty}
                    </span>
                  </button>
                ))
              )}
              {items.length > 0 ? (
                <div className="flex items-center justify-between pt-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    ‹
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!hasMore}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    ›
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="sb-reference">{t("referenceOptional")}</Label>
            <Input
              id="sb-reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={t("referencePlaceholder")}
              maxLength={96}
              autoComplete="off"
            />
            <p className="text-muted-foreground text-xs">{t("referenceHint")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sb-invoice-ref">{t("supplierInvoiceReferenceOptional")}</Label>
            <Input
              id="sb-invoice-ref"
              value={invoiceRef}
              onChange={(e) => setInvoiceRef(e.target.value)}
              placeholder={t("supplierInvoiceReferencePlaceholder")}
              maxLength={96}
              autoComplete="off"
            />
            <p className="text-muted-foreground text-xs">{t("supplierInvoiceReferenceHint")}</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sb-bill-date">{t("billDate")}</Label>
              <Input
                id="sb-bill-date"
                type="date"
                value={billDate}
                onChange={(e) => setBillDate(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sb-due-date">{t("dueDateOptional")}</Label>
              <Input
                id="sb-due-date"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sb-notes">{t("internalNotes")}</Label>
            <Textarea
              id="sb-notes"
              className="min-h-20"
              value={internalNotes}
              onChange={(e) => setInternalNotes(e.target.value)}
              placeholder={t("internalNotesPlaceholder")}
              maxLength={2016}
            />
            <p className="text-muted-foreground text-xs">{t("internalNotesHint")}</p>
          </div>

          {domainError ? (
            <p className="text-sm text-destructive" role="alert">{domainError}</p>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            {tCommon("cancel")}
          </Button>
          <Button type="button" onClick={submit} disabled={!selected || submitting || !billDate}>
            {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {t("createAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
