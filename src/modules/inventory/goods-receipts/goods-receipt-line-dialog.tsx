"use client";

/**
 * Prompt 42 — goods-receipt line quantity dialog (§112).
 *
 * Shows Ordered / Already received / Remaining, then an integer input for
 * "Received now" bounded by max=remaining (server STILL revalidates — the
 * bound here is UX, never an authority §66). No price is shown (§112).
 */
import { useState } from "react";
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
import type { PoReceivableLine } from "./goods-receipts-api";

export type GoodsReceiptLineDialogValue = {
  receivedQty: number;
};

export function GoodsReceiptLineDialog({
  line,
  initialQty,
  title,
  submitLabel,
  cancelLabel,
  qtyLabel,
  orderedLabel,
  receivedLabel,
  remainingLabel,
  invalidQtyMessage,
  exceedsMessage,
  onSubmit,
  onClose,
}: {
  line: PoReceivableLine;
  /** When editing an existing line, its current quantity (excluded from the max). */
  initialQty?: number;
  title: string;
  submitLabel: string;
  cancelLabel: string;
  qtyLabel: string;
  orderedLabel: string;
  receivedLabel: string;
  remainingLabel: string;
  invalidQtyMessage: string;
  exceedsMessage: string;
  onSubmit: (value: GoodsReceiptLineDialogValue) => void;
  onClose: () => void;
}) {
  const [raw, setRaw] = useState(initialQty !== undefined ? String(initialQty) : "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // §112 — max is the CURRENT remaining quantity. When editing a draft
  // line, its own quantity is added back to the allowance.
  const maxQty =
    initialQty !== undefined ? line.remainingQty + initialQty : line.remainingQty;

  function submit() {
    if (submitting) return;
    setError(null);
    const value = raw.trim();
    if (!/^\d+$/.test(value)) {
      setError(invalidQtyMessage); // rejects 1.5 / NaN / Infinity / negative (§18)
      return;
    }
    const qty = Number(value);
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > 1_000_000) {
      setError(invalidQtyMessage);
      return;
    }
    if (qty > maxQty) {
      setError(exceedsMessage);
      return;
    }
    setSubmitting(true);
    onSubmit({ receivedQty: qty });
    setSubmitting(false);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="goods-receipt-line-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription dir="auto">{line.productNameAtOrder}</DialogDescription>
        </DialogHeader>

        <div className="text-muted-foreground grid grid-cols-3 gap-2 rounded-lg border p-3 text-center text-sm">
          <div>
            <p className="text-xs">{orderedLabel}</p>
            <p className="font-medium tabular-nums" dir="ltr">{line.orderedQty}</p>
          </div>
          <div>
            <p className="text-xs">{receivedLabel}</p>
            <p className="font-medium tabular-nums" dir="ltr">{line.receivedQty}</p>
          </div>
          <div>
            <p className="text-xs">{remainingLabel}</p>
            <p className="text-emerald-600 font-medium tabular-nums dark:text-emerald-400" dir="ltr">
              {maxQty}
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="gr-line-qty">{qtyLabel}</Label>
          <Input
            id="gr-line-qty"
            inputMode="numeric"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={`1–${maxQty}`}
            autoFocus
          />
          {error ? (
            <p className="text-destructive text-sm" role="alert">{error}</p>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            {cancelLabel}
          </Button>
          <Button type="button" onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
