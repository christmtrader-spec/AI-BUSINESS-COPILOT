"use client";

/**
 * Prompt 44 — goods-dispatch create dialog.
 *
 * The optional customer picker shows active customers over a bounded page
 * (never the full dataset). The client submits ONLY customerId/reference/
 * notes — snapshots, status and creator are server-derived. The document
 * starts DRAFT with zero lines; stock changes only when it is posted.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api-client";
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
import { ApiClientError } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { createGoodsDispatch } from "./goods-dispatches-api";

type CustomerOption = { id: string; name: string };

export function GoodsDispatchCreateDialog({
  businessId,
  onClose,
  onCreated,
}: {
  businessId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const t = useTranslations("goodsDispatches");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");

  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<CustomerOption | null>(null);
  const [reference, setReference] = useState("");
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
    queryKey: ["goods-dispatches", "customer-options", businessId, debouncedQ, page],
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
      const created = await createGoodsDispatch(businessId, {
        customerId: selected?.id,
        reference: reference.trim() || undefined,
        notes: notes.trim() || null,
      });
      toast({ description: t("createdToast", { reference: created.reference }) });
      onCreated(created.id);
    } catch (error) {
      if (error instanceof ApiClientError) {
        if (error.code === "GOODS_DISPATCH_DUPLICATE_REFERENCE") {
          setDomainError(t("duplicateReference"));
        } else if (error.status === 404) {
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
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg" data-testid="goods-dispatch-create-dialog">
        <DialogHeader>
          <DialogTitle>{t("createTitle")}</DialogTitle>
          <DialogDescription>{t("createDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="gds-customer-search">{t("customerOptional")}</Label>
            <Input
              id="gds-customer-search"
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
                  <span className="font-medium">{selected.name}</span>
                </span>
              </button>
            ) : null}
          </div>

          {!selected ? (
            <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border p-2" role="listbox" aria-label={t("customer")}>
              {customers.isLoading ? (
                <div className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                </div>
              ) : items.length === 0 ? (
                <p className="text-muted-foreground py-6 text-center text-sm">{t("customerPlaceholder")}</p>
              ) : (
                items.map((customer) => (
                  <button
                    key={customer.id}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="flex w-full items-center justify-between rounded-md px-2 py-2 text-start text-sm transition-colors hover:bg-muted/60 motion-reduce:transition-none"
                    onClick={() => setSelected(customer)}
                  >
                    <span dir="auto" className="min-w-0 truncate font-medium">
                      {customer.name}
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
            <Label htmlFor="gds-reference">{t("referenceOptional")}</Label>
            <Input
              id="gds-reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={t("referencePlaceholder")}
              maxLength={96}
              autoComplete="off"
            />
            <p className="text-muted-foreground text-xs">{t("referenceHint")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="gds-notes">{t("notes")}</Label>
            <textarea
              id="gds-notes"
              className="border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-20 w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:opacity-50"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("notesPlaceholder")}
              maxLength={2016}
            />
          </div>

          {domainError ? (
            <p className="text-sm text-destructive" role="alert">{domainError}</p>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            {tCommon("cancel")}
          </Button>
          <Button type="button" onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {t("createAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
