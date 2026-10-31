"use client";

/**
 * Prompt 45 — sales-order create dialog (§75 steps 1–6).
 *
 * The optional customer picker shows active customers over a bounded page
 * (never the full dataset). The client submits ONLY customerId/reference/
 * orderDate/expectedDate/notes — status, currency snapshot, customer
 * snapshot and creator are server-derived (§112). The order starts DRAFT
 * with zero lines: NO stock mutation, NO financial record (§4/§30).
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
import { toast } from "@/hooks/use-toast";
import { isValidCalendarDate } from "@/lib/sales-orders/types";
import { createSalesOrder } from "./sales-orders-api";

type CustomerOption = { id: string; name: string };

export function SalesOrderCreateDialog({
  businessId,
  onClose,
  onCreated,
}: {
  businessId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const t = useTranslations("salesOrders");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");

  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<CustomerOption | null>(null);
  const [reference, setReference] = useState("");
  const [orderDate, setOrderDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [expectedDate, setExpectedDate] = useState("");
  const [notes, setNotes] = useState("");
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
    queryKey: ["sales-orders", "customer-options", businessId, debouncedQ, page],
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

  async function submit() {
    if (submitting) return;
    setSubmitting(true);
    setDomainError(null);
    try {
      if (orderDate && !isValidCalendarDate(orderDate)) {
        setDomainError(t("invalidDate"));
        return;
      }
      if (expectedDate && !isValidCalendarDate(expectedDate)) {
        setDomainError(t("invalidDate"));
        return;
      }
      const created = await createSalesOrder(businessId, {
        customerId: selected?.id,
        reference: reference.trim() || undefined,
        orderDate: orderDate || undefined,
        expectedDate: expectedDate || undefined,
        notes: notes.trim() || null,
      });
      toast({ description: t("createdToast", { reference: created.reference }) });
      onCreated(created.id);
    } catch (error) {
      if (error instanceof ApiClientError) {
        if (error.code === "SALES_ORDER_DUPLICATE_REFERENCE") {
          setDomainError(t("duplicateReference"));
        } else if (error.code === "SALES_ORDER_CUSTOMER_NOT_FOUND" || error.status === 404) {
          setDomainError(t("invalidCustomer"));
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
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg" data-testid="sales-order-create-dialog">
        <DialogHeader>
          <DialogTitle>{t("createTitle")}</DialogTitle>
          <DialogDescription>{t("createDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Customer picker (optional) — bounded, debounced, server search. */}
          {selected ? (
            <div className="space-y-1.5">
              <Label htmlFor="so-customer">{t("customer")}</Label>
              <div className="flex items-center gap-2">
                <Input id="so-customer" value={selected.name} readOnly dir="auto" />
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
              <Label htmlFor="so-customer-search">{t("customerOptional")}</Label>
              <Input
                id="so-customer-search"
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
            <Label htmlFor="so-reference">{t("referenceOptional")}</Label>
            <Input
              id="so-reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={t("referencePlaceholder")}
              dir="auto"
            />
            <p className="text-muted-foreground text-xs">{t("referenceHint")}</p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="so-order-date">{t("orderDate")}</Label>
              <Input
                id="so-order-date"
                type="date"
                value={orderDate}
                onChange={(e) => setOrderDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="so-expected-date">{t("expectedDateOptional")}</Label>
              <Input
                id="so-expected-date"
                type="date"
                value={expectedDate}
                onChange={(e) => setExpectedDate(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="so-notes">{t("notes")}</Label>
            <Input
              id="so-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("notesPlaceholder")}
              dir="auto"
            />
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
