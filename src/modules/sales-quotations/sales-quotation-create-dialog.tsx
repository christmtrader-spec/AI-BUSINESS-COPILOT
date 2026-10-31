"use client";

/**
 * Prompt 47 — sales-quotation create dialog (§17).
 *
 * The optional customer picker shows active customers over a bounded page
 * (never the full dataset). The client submits ONLY
 * customerId/reference/quotationDate/validUntilDate/expectedDeliveryDate/
 * notes — status, currency snapshot, customer snapshot and creator are
 * server-derived (§15). validUntilDate is REQUIRED (the offer's validity
 * is the point of a quotation §10) and must not precede the quotation
 * date — the server re-validates the ordering law (§9). The quotation
 * starts DRAFT with zero lines: NO stock mutation, NO financial record.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { api, ApiClientError } from "@/lib/api-client";
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
import { toast } from "@/hooks/use-toast";
import { isValidCalendarDate } from "@/lib/sales-quotations/types";
import { createSalesQuotation } from "./sales-quotations-api";

type CustomerOption = { id: string; name: string };

export function SalesQuotationCreateDialog({
  businessId,
  onClose,
  onCreated,
}: {
  businessId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const t = useTranslations("salesQuotations");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");

  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<CustomerOption | null>(null);
  const [reference, setReference] = useState("");
  const [quotationDate, setQuotationDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [validUntilDate, setValidUntilDate] = useState("");
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState("");
  const [customerNotes, setCustomerNotes] = useState("");
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

  const customers = useQuery({
    queryKey: ["sales-quotations", "customer-options", businessId, debouncedQ, page],
    queryFn: () =>
      api<{ items: CustomerOption[]; total: number; page: number; pageSize: number }>(
        `/api/v1/customers?q=${encodeURIComponent(debouncedQ)}&page=${page}&pageSize=10`,
      ),
    staleTime: 5_000,
    enabled: !selected,
  });

  const items = customers.data?.items ?? [];
  const hasMore = useMemo(() => {
    if (!customers.data) return false;
    return page * (customers.data.pageSize ?? 10) < (customers.data.total ?? 0);
  }, [customers.data, page]);

  const dateRangeValid =
    !!validUntilDate &&
    isValidCalendarDate(validUntilDate) &&
    isValidCalendarDate(quotationDate) &&
    validUntilDate >= quotationDate;

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    setDomainError(null);
    try {
      if (quotationDate && !isValidCalendarDate(quotationDate)) {
        setDomainError(t("invalidDate"));
        return;
      }
      if (!validUntilDate || !isValidCalendarDate(validUntilDate)) {
        setDomainError(t("invalidDate"));
        return;
      }
      if (!dateRangeValid) {
        setDomainError(t("invalidDateRange"));
        return;
      }
      const created = await createSalesQuotation(businessId, {
        customerId: selected?.id,
        reference: reference.trim() || undefined,
        quotationDate: quotationDate || undefined,
        validUntilDate,
        expectedDeliveryDate: expectedDeliveryDate || undefined,
        customerNotes: customerNotes.trim() || null,
        internalNotes: internalNotes.trim() || null,
      });
      toast({ description: t("createdToast", { reference: created.reference }) });
      onCreated(created.id);
    } catch (error) {
      if (error instanceof ApiClientError) {
        if (error.code === "SALES_QUOTATION_DUPLICATE_REFERENCE") {
          setDomainError(t("duplicateReference"));
        } else if (error.code === "SALES_QUOTATION_CUSTOMER_NOT_FOUND" || error.status === 404) {
          setDomainError(t("invalidCustomer"));
        } else if (error.code === "SALES_QUOTATION_INVALID_DATE_RANGE") {
          setDomainError(t("invalidDateRange"));
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
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg" data-testid="sales-quotation-create-dialog">
        <DialogHeader>
          <DialogTitle>{t("createTitle")}</DialogTitle>
          <DialogDescription>{t("createDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Customer picker (optional) — bounded, debounced, server search. */}
          {selected ? (
            <div className="space-y-1.5">
              <Label htmlFor="sq-customer">{t("customer")}</Label>
              <div className="flex items-center gap-2">
                <Input id="sq-customer" value={selected.name} readOnly dir="auto" />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSelected(null);
                    setQ("");
                    setPage(1);
                  }}
                >
                  {tCommon("cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="sq-customer-search">{t("customerOptional")}</Label>
              <Input
                id="sq-customer-search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t("customerPlaceholder")}
                autoComplete="off"
              />
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border p-1" role="listbox" aria-label={t("customer")}>
                {items.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="w-full rounded-md px-2 py-1.5 text-start text-sm transition-colors hover:bg-muted/60 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                    onClick={() => setSelected(c)}
                  >
                    <span dir="auto">{c.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="sq-reference">{t("referenceOptional")}</Label>
            <Input
              id="sq-reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={t("referencePlaceholder")}
              dir="auto"
            />
            <p className="text-muted-foreground text-xs">{t("referenceHint")}</p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sq-quotation-date">{t("quotationDate")}</Label>
              <Input
                id="sq-quotation-date"
                type="date"
                value={quotationDate}
                onChange={(e) => setQuotationDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sq-valid-until">{t("validUntil")}</Label>
              <Input
                id="sq-valid-until"
                type="date"
                value={validUntilDate}
                onChange={(e) => setValidUntilDate(e.target.value)}
                aria-invalid={!!validUntilDate && !dateRangeValid}
              />
              <p className="text-muted-foreground text-xs">{t("validUntilHint")}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sq-expected-date">{t("expectedDeliveryOptional")}</Label>
              <Input
                id="sq-expected-date"
                type="date"
                value={expectedDeliveryDate}
                onChange={(e) => setExpectedDeliveryDate(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sq-customer-notes">{t("customerNotes")}</Label>
            <Textarea
              id="sq-customer-notes"
              value={customerNotes}
              onChange={(e) => setCustomerNotes(e.target.value)}
              placeholder={t("customerNotesPlaceholder")}
              rows={2}
              dir="auto"
            />
            <p className="text-muted-foreground text-xs">{t("customerNotesHint")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sq-internal-notes">{t("internalNotes")}</Label>
            <Textarea
              id="sq-internal-notes"
              value={internalNotes}
              onChange={(e) => setInternalNotes(e.target.value)}
              placeholder={t("internalNotesPlaceholder")}
              rows={2}
              dir="auto"
            />
            <p className="text-muted-foreground text-xs">{t("internalNotesHint")}</p>
          </div>

          {domainError ? (
            <p className="text-destructive text-sm" role="alert">{domainError}</p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            {tCommon("cancel")}
          </Button>
          <Button type="button" onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {tCommon("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
