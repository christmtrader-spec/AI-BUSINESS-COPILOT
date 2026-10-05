"use client";

/**
 * Prompt 40 — count dialog (§84).
 * Shows product (read-only), SYSTEM quantity (server snapshot, read-only),
 * the counted quantity (the ONLY editable field), and a live VARIANCE
 * preview (read-only). Only countedQty is submitted (§16/§30).
 * Recount = counting an already-counted line (§32).
 */
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { ApiClientError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { COUNTED_QTY_MAX } from "@/lib/inventory/stocktake/types";
import { countStocktakeLine, inventoryKeys } from "./stocktake-api";
import { cn } from "@/lib/utils";

export type CountTarget = {
  lineId: string;
  productName: string;
  /** Server snapshot recorded on the line (may be the 0 placeholder for
   * uncounted lines or the last count for recounts). */
  systemQtyAtCount: number;
  /** Current Product.stockQty at page load — the PREVIEW basis (§15/§30).
   * The server re-reads stockQty at save; its snapshot is authoritative. */
  currentStockQty: number | null;
  countedQty: number | null;
  stocktakeId: string;
  stocktakeStatus: "DRAFT" | "COUNTING" | "REVIEW" | "FINALIZED" | "CANCELLED";
};

export function StocktakeCountDialog({
  businessId,
  target,
  onClose,
}: {
  businessId: string;
  target: CountTarget;
  onClose: () => void;
}) {
  const t = useTranslations("inventory.stocktakes");
  const tErrors = useTranslations("errors");
  const queryClient = useQueryClient();
  const [qtyText, setQtyText] = useState(
    target.countedQty != null ? String(target.countedQty) : "",
  );
  // NOTE: the parent keys this dialog by line id, so per-line state
  // re-initializes through remount — no state-sync effect needed.

  const parsed = useMemo(() => {
    if (!/^-?\d+$/.test(qtyText.trim())) return null;
    const n = Number.parseInt(qtyText.trim(), 10);
    return Number.isSafeInteger(n) ? n : null;
  }, [qtyText]);
  const valid = parsed != null && parsed >= 0 && parsed <= COUNTED_QTY_MAX;
  // §15/§30 — preview against the freshest known CURRENT stock; the value
  // the server snapshots at save time is authoritative and may differ if
  // stock moved after page load (stale-count protection handles that, §40).
  const previewSystemQty = target.currentStockQty ?? target.systemQtyAtCount;
  const variance = valid && parsed != null ? parsed - previewSystemQty : null;
  const isRecount = target.countedQty != null;

  const mutation = useMutation({
    mutationFn: async () =>
      countStocktakeLine(businessId, target.stocktakeId, target.lineId, parsed as number),
    onSuccess: async () => {
      toast({ title: isRecount ? t("recountedToast") : t("countedToast") });
      // §120/§124 — refresh the stocktake detail (summary + lines refetch).
      await queryClient.invalidateQueries({
        queryKey: inventoryKeys.stocktake(businessId, target.stocktakeId),
      });
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiClientError && err.status === 422) {
        toast({ title: t("productNotCountable"), variant: "destructive" });
      } else {
        toast({ title: tErrors("generic"), variant: "destructive" });
      }
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isRecount ? t("recount") : t("countProduct")}</DialogTitle>
          <DialogDescription>{t("countDialogDesc", { product: target.productName })}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !mutation.isPending) mutation.mutate();
          }}
        >
          <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("product")}</span>
              <span className="font-medium" dir="auto">{target.productName}</span>
            </div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-muted-foreground">{t("systemQuantity")}</span>
              <span className="font-medium tabular-nums" dir="ltr">{previewSystemQty}</span>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="stocktake-counted-qty">{t("countedQuantity")}</Label>
            <Input
              id="stocktake-counted-qty"
              inputMode="numeric"
              pattern="-?\d*"
              value={qtyText}
              onChange={(e) => setQtyText(e.target.value)}
              placeholder="0"
              dir="ltr"
              required
              autoFocus
              aria-describedby="stocktake-count-hint"
            />
            <p id="stocktake-count-hint" className="text-xs text-muted-foreground">
              {t("countedQuantityHint", { max: COUNTED_QTY_MAX })}
            </p>
          </div>
          <div className="rounded-lg border p-3 text-sm" aria-live="polite">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{t("variancePreview")}</span>
              {variance == null ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <span
                  dir="ltr"
                  className={cn(
                    "font-medium tabular-nums",
                    variance > 0 && "text-emerald-600 dark:text-emerald-400",
                    variance < 0 && "text-amber-600 dark:text-amber-400",
                  )}
                >
                  {variance > 0 ? `+${variance}` : `${variance}`}
                </span>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={!valid || mutation.isPending}>
              {mutation.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {isRecount ? t("recount") : t("saveCount")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
