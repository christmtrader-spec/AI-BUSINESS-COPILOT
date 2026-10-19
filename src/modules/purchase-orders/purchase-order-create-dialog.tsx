"use client";

/**
 * Prompt 41 — create-purchase-order dialog (§76).
 * Flow: pick supplier (bounded, §77) → optional reference (blank → the
 * server generates PO-<date>-<token>, §13) → order date (defaults to today
 * server-side) → optional expected date (strict calendar input) → notes.
 * The dialog creates a DRAFT; lines are added on the detail screen.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Loader2, Truck } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { ApiClientError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  PURCHASE_ORDER_NOTES_MAX,
  PURCHASE_ORDER_REFERENCE_MAX,
} from "@/lib/purchase-orders/types";
import { createPurchaseOrder, purchaseOrderKeys } from "./purchase-orders-api";
import { PurchaseOrderSupplierPicker } from "./purchase-order-supplier-picker";

export function PurchaseOrderCreateDialog({
  businessId,
  onClose,
  onCreated,
}: {
  businessId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const t = useTranslations("purchaseOrders");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const queryClient = useQueryClient();

  const [supplier, setSupplier] = useState<{ id: string; name: string } | null>(null);
  const [reference, setReference] = useState("");
  const [orderedAt, setOrderedAt] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [notes, setNotes] = useState("");

  const mutation = useMutation({
    mutationFn: async () =>
      createPurchaseOrder(businessId, {
        supplierId: supplier!.id,
        reference: reference.trim() || undefined, // blank → §13 server generation
        orderedAt: orderedAt || undefined,
        expectedDate: expectedDate || null,
        notes: notes.trim() ? notes.trim() : null,
      }),
    onSuccess: async (row) => {
      toast({ title: t("createdToast", { reference: row.reference }) });
      await queryClient.invalidateQueries({ queryKey: purchaseOrderKeys.all });
      onCreated(row.id);
    },
    onError: (err) => {
      if (err instanceof ApiClientError && err.status === 404) {
        toast({ title: t("invalidSupplier"), variant: "destructive" });
      } else if (err instanceof ApiClientError && err.status === 409) {
        toast({ title: t("duplicateReference"), variant: "destructive" });
      } else if (err instanceof ApiClientError && err.status === 422) {
        toast({ title: t("invalidDate"), variant: "destructive" });
      } else {
        toast({ title: tErrors("generic"), variant: "destructive" });
      }
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] gap-0 overflow-y-auto p-6 pb-0 sm:max-w-lg">
        <DialogHeader className="gap-3 text-start">
          <DialogTitle className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-600 to-teal-600 text-white shadow-sm dark:from-emerald-500 dark:to-teal-400"
            >
              <Truck className="size-4.5" />
            </span>
            {t("createTitle")}
          </DialogTitle>
          <DialogDescription>{t("createDesc")}</DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 space-y-4 pb-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (supplier && !mutation.isPending) mutation.mutate();
          }}
        >
          <div className="space-y-2">
            <Label>{t("supplier")}</Label>
            {supplier ? (
              <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2.5">
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  <Truck className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate font-medium" dir="auto">{supplier.name}</span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSupplier(null)}
                >
                  {tCommon("change")}
                </Button>
              </div>
            ) : (
              <PurchaseOrderSupplierPicker
                businessId={businessId}
                selectedId={null}
                onSelect={setSupplier}
              />
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="po-reference">{t("referenceOptional")}</Label>
            <Input
              id="po-reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={t("referencePlaceholder")}
              maxLength={PURCHASE_ORDER_REFERENCE_MAX}
              dir="auto"
            />
            <p className="text-xs text-muted-foreground">{t("referenceHint")}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="po-ordered-at">{t("orderedAt")}</Label>
              <Input
                id="po-ordered-at"
                type="date"
                value={orderedAt}
                onChange={(e) => setOrderedAt(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("orderedAtHint")}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="po-expected">{t("expectedDate")}</Label>
              <Input
                id="po-expected"
                type="date"
                value={expectedDate}
                onChange={(e) => setExpectedDate(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="po-notes">{t("notes")}</Label>
            <Textarea
              id="po-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("notesPlaceholder")}
              maxLength={PURCHASE_ORDER_NOTES_MAX}
              rows={3}
              dir="auto"
            />
          </div>

          <DialogFooter className="sticky bottom-0 -mx-6 border-t bg-background/95 px-6 py-4 backdrop-blur sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={onClose}>
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={!supplier || mutation.isPending} className="min-w-32">
              {mutation.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Truck className="size-4" aria-hidden />}
              {t("createAction")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
