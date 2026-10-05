"use client";

/**
 * Prompt 40 — create-stocktake dialog (§80).
 * Fields: reference (2–80, unique per business) + optional notes (≤2000).
 * countType is NOT a field — the server pins it to SELECTED (§7/§24).
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
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
  STOCKTAKE_NOTES_MAX,
  STOCKTAKE_REFERENCE_MAX,
  STOCKTAKE_REFERENCE_MIN,
} from "@/lib/inventory/stocktake/types";
import { createStocktake, inventoryKeys } from "./stocktake-api";

export function StocktakeCreateDialog({
  businessId,
  onClose,
  onCreated,
}: {
  businessId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const t = useTranslations("inventory.stocktakes");
  const tErrors = useTranslations("errors");
  const queryClient = useQueryClient();

  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const referenceValid =
    reference.trim().length >= STOCKTAKE_REFERENCE_MIN &&
    reference.trim().length <= STOCKTAKE_REFERENCE_MAX;

  const mutation = useMutation({
    mutationFn: async () =>
      createStocktake(businessId, {
        reference: reference.trim(),
        notes: notes.trim() ? notes.trim() : null,
      }),
    onSuccess: async (row) => {
      toast({ title: t("createdToast") });
      // §120 — targeted list invalidation; the detail is a fresh route.
      await queryClient.invalidateQueries({ queryKey: inventoryKeys.all });
      onCreated(row.id);
    },
    onError: (err) => {
      if (err instanceof ApiClientError && err.status === 409) {
        toast({ title: t("duplicateReference"), variant: "destructive" });
      } else {
        toast({ title: tErrors("generic"), variant: "destructive" });
      }
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("createStocktake")}</DialogTitle>
          <DialogDescription>{t("createStocktakeDesc")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (referenceValid && !mutation.isPending) mutation.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="stocktake-reference">{t("reference")}</Label>
            <Input
              id="stocktake-reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={t("referencePlaceholder")}
              maxLength={STOCKTAKE_REFERENCE_MAX}
              required
              minLength={STOCKTAKE_REFERENCE_MIN}
              dir="auto"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="stocktake-notes">{t("stocktakeNotes")}</Label>
            <Textarea
              id="stocktake-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("notesPlaceholder")}
              maxLength={STOCKTAKE_NOTES_MAX}
              rows={3}
              dir="auto"
            />
            <p className="text-xs text-muted-foreground">
              {notes.length}/{STOCKTAKE_NOTES_MAX}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={!referenceValid || mutation.isPending}>
              {mutation.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {t("createStocktake")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
