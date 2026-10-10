"use client";

/**
 * Prompt 43 — goods-return create dialog (§56/§92).
 *
 * The picker shows ONLY POSTED goods receipts over a bounded page (§72 —
 * never the full dataset). The client submits ONLY goodsReceiptId/
 * reference/notes — snapshots, status and creator are server-derived
 * (§56). When opened FROM a receipt detail (§87), preselect it.
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
import { ApiClientError } from "@/lib/api-client";
import { toast } from "@/hooks/use-toast";
import { createGoodsReturn, fetchPostedReceiptOptions } from "./goods-returns-api";

export function GoodsReturnCreateDialog({
  businessId,
  presetReceipt,
  onClose,
  onCreated,
}: {
  businessId: string;
  /** §87 — when opened FROM a posted receipt, preselect it. */
  presetReceipt?: { id: string; reference: string; supplierNameAtReceipt: string };
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const t = useTranslations("goodsReturns");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");

  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<{ id: string; reference: string; supplierNameAtReceipt: string } | null>(
    presetReceipt ? { ...presetReceipt } : null,
  );
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

  const receipts = useQuery({
    queryKey: ["goods-returns", "receipt-options", businessId, debouncedQ, page],
    queryFn: () => fetchPostedReceiptOptions(businessId, debouncedQ, page),
    staleTime: 5_000,
    enabled: !selected,
  });

  const items = receipts.data?.items ?? [];
  const hasMore = useMemo(() => {
    if (!receipts.data) return false;
    return page * (receipts.data.pageSize ?? 10) < (receipts.data.total ?? 0);
  }, [receipts.data, page]);

  async function submit() {
    if (!selected || submitting) return;
    setSubmitting(true);
    setDomainError(null);
    try {
      const created = await createGoodsReturn(businessId, {
        goodsReceiptId: selected.id,
        reference: reference.trim() || undefined,
        notes: notes.trim() || null,
      });
      toast({ description: t("createdToast", { reference: created.reference }) });
      onCreated(created.id);
    } catch (error) {
      if (error instanceof ApiClientError) {
        if (error.code === "GOODS_RETURN_DUPLICATE_REFERENCE") {
          setDomainError(t("duplicateReference"));
        } else if (error.code === "GOODS_RETURN_SOURCE_NOT_POSTED") {
          setDomainError(t("sourceNotPosted"));
        } else if (error.status === 404) {
          setDomainError(t("invalidReceipt"));
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
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg" data-testid="goods-return-create-dialog">
        <DialogHeader>
          <DialogTitle>{t("createTitle")}</DialogTitle>
          <DialogDescription>{t("createDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="grt-receipt-search">{t("sourceReceipt")}</Label>
            <Input
              id="grt-receipt-search"
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
                  <span className="text-muted-foreground"> · {selected.supplierNameAtReceipt}</span>
                </span>
              </button>
            ) : null}
          </div>

          {!selected ? (
            <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-lg border p-2" role="listbox" aria-label={t("sourceReceipt")}>
              {receipts.isLoading ? (
                <div className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                </div>
              ) : items.length === 0 ? (
                <p className="text-muted-foreground py-6 text-center text-sm">{t("noLinesFound")}</p>
              ) : (
                items.map((receipt) => (
                  <button
                    key={receipt.id}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="flex w-full items-center justify-between rounded-md px-2 py-2 text-start text-sm transition-colors hover:bg-muted/60"
                    onClick={() => setSelected(receipt)}
                  >
                    <span dir="auto" className="min-w-0 truncate">
                      <span className="font-medium">{receipt.reference}</span>
                      <span className="text-muted-foreground"> · {receipt.supplierNameAtReceipt}</span>
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
            <Label htmlFor="grt-reference">{t("referenceOptional")}</Label>
            <Input
              id="grt-reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={t("referencePlaceholder")}
              maxLength={96}
              autoComplete="off"
            />
            <p className="text-muted-foreground text-xs">{t("referenceHint")}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="grt-notes">{t("notes")}</Label>
            <textarea
              id="grt-notes"
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
          <Button type="button" onClick={submit} disabled={!selected || submitting}>
            {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {t("createAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
