"use client";

/**
 * Prompt 40 — finalize confirmation dialog (§86).
 * The confirmation EXPLICITLY says inventory quantities will be updated to
 * the physical counted values AND that no sale/expense/payment/customer or
 * supplier balance is created. Requires DialogTitle + DialogDescription.
 * A 409 STOCKTAKE_STALE_COUNT / STOCKTAKE_PRODUCT_INACTIVE response surfaces
 * the localized stale-count message and stays open (§87/§139) — the parent
 * remains in REVIEW.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { ApiClientError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { transitionStocktake, inventoryKeys } from "./stocktake-api";

export type StaleProduct = {
  productId: string;
  productName: string;
  systemQtyAtCount: number;
  currentQty: number;
  kind?: string;
};

export function StocktakeFinalizeDialog({
  businessId,
  stocktakeId,
  onClose,
  onStale,
  onFinalized,
}: {
  businessId: string;
  stocktakeId: string;
  onClose: () => void;
  onStale: (products: StaleProduct[]) => void;
  /** Fires after a successful finalize — lets the parent clear the stale
   * alert (the conflict it described is now resolved, §87). */
  onFinalized?: () => void;
}) {
  const t = useTranslations("inventory.stocktakes");
  const tErrors = useTranslations("errors");
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async () => transitionStocktake(businessId, stocktakeId, "finalize"),
    onSuccess: async () => {
      toast({ title: t("finalizedToast") });
      onFinalized?.();
      // §121 — finalize invalidates stocktake + product + adjustment surfaces
      // (stock quantities and history changed). Targeted — never the whole
      // QueryClient.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: inventoryKeys.all }),
        queryClient.invalidateQueries({ queryKey: ["products"] }),
        queryClient.invalidateQueries({ queryKey: inventoryKeys.adjustments }),
        queryClient.invalidateQueries({ queryKey: ["product"] }),
      ]);
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiClientError && err.status === 409) {
        // §87 — stale/inactive: localized message + recount action; the
        // stocktake stays in REVIEW; nothing is mutated.
        const details = (err.details ?? {}) as { products?: StaleProduct[] };
        onStale(details.products ?? []);
        onClose();
        return;
      }
      if (err instanceof ApiClientError && err.status === 422) {
        toast({ title: t("invalidTransition"), variant: "destructive" });
      } else {
        toast({ title: tErrors("generic"), variant: "destructive" });
      }
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-amber-500" aria-hidden />
            {t("finalizeStocktake")}
          </DialogTitle>
          <DialogDescription>{t("finalizeConfirmDesc")}</DialogDescription>
        </DialogHeader>
        <ul className="space-y-1 rounded-lg border bg-muted/40 p-3 text-sm">
          <li className="flex gap-2">
            <span aria-hidden>✓</span>
            <span>{t("finalizeEffectInventory")}</span>
          </li>
          <li className="flex gap-2 text-muted-foreground">
            <span aria-hidden>—</span>
            <span>{t("finalizeEffectNoFinance")}</span>
          </li>
        </ul>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            type="button"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {t("finalizeStocktake")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
