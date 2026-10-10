"use client";

/**
 * Prompt 43 — goods-return line dialog (§93/§94).
 *
 * Shows Received / Already returned / Returnable, an integer input for
 * "Return quantity" bounded by max=returnable (server STILL revalidates —
 * the bound here is UX, never an authority §94), and the closed §23
 * reason selector. No price is shown (§93). No free product picker: only
 * lines of the source receipt with returnableQty > 0 are offered (§93).
 */
import { useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GOODS_RETURN_REASON_CODES, type GoodsReturnReasonCode } from "@/lib/inventory/goods-return/types";

/** §93 — a picker row over the source receipt's OWN lines (no product picker). */
export type ReturnableReceiptLine = {
  id: string;
  productId: string;
  productNameAtReceipt: string;
  skuAtReceipt: string | null;
  unitAtReceipt: string | null;
  receivedQty: number;
  returnedQty: number;
  returnableQty: number;
};

export type GoodsReturnLineDialogValue = {
  returnedQty: number;
  reasonCode: GoodsReturnReasonCode;
};

export function GoodsReturnLineDialog({
  line,
  initialQty,
  initialReason,
  title,
  submitLabel,
  cancelLabel,
  qtyLabel,
  receivedLabel,
  returnedLabel,
  returnableLabel,
  reasonLabel,
  invalidQtyMessage,
  exceedsMessage,
  onSubmit,
  onClose,
}: {
  line: ReturnableReceiptLine;
  /** When editing an existing line, its current quantity (excluded from the max). */
  initialQty?: number;
  initialReason?: string;
  title: string;
  submitLabel: string;
  cancelLabel: string;
  qtyLabel: string;
  receivedLabel: string;
  returnedLabel: string;
  returnableLabel: string;
  reasonLabel: string;
  invalidQtyMessage: string;
  exceedsMessage: string;
  onSubmit: (value: GoodsReturnLineDialogValue) => void;
  onClose: () => void;
}) {
  const t = useTranslations("goodsReturns");
  const [raw, setRaw] = useState(initialQty !== undefined ? String(initialQty) : "");
  const [reason, setReason] = useState<GoodsReturnReasonCode>(
    (initialReason as GoodsReturnReasonCode | undefined) ?? "DAMAGED",
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // §94 — max is the CURRENT returnable quantity. When editing a draft
  // line, its own quantity is added back to the allowance.
  const maxQty =
    initialQty !== undefined ? line.returnableQty + initialQty : line.returnableQty;

  function submit() {
    if (submitting) return;
    setError(null);
    const value = raw.trim();
    if (!/^\d+$/.test(value)) {
      setError(invalidQtyMessage); // rejects 1.5 / NaN / Infinity / negative (§32)
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
    onSubmit({ returnedQty: qty, reasonCode: reason });
    setSubmitting(false);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="goods-return-line-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription dir="auto">{line.productNameAtReceipt}</DialogDescription>
        </DialogHeader>

        <div className="text-muted-foreground grid grid-cols-3 gap-2 rounded-lg border p-3 text-center text-sm">
          <div>
            <p className="text-xs">{receivedLabel}</p>
            <p className="font-medium tabular-nums" dir="ltr">{line.receivedQty}</p>
          </div>
          <div>
            <p className="text-xs">{returnedLabel}</p>
            <p className="font-medium tabular-nums" dir="ltr">{line.returnedQty}</p>
          </div>
          <div>
            <p className="text-xs">{returnableLabel}</p>
            <p className="text-emerald-600 font-medium tabular-nums dark:text-emerald-400" dir="ltr">
              {maxQty}
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="grt-line-qty">{qtyLabel}</Label>
          <Input
            id="grt-line-qty"
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

        <div className="space-y-1.5">
          <Label htmlFor="grt-line-reason">{reasonLabel}</Label>
          <Select value={reason} onValueChange={(v) => setReason(v as GoodsReturnReasonCode)}>
            <SelectTrigger id="grt-line-reason" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GOODS_RETURN_REASON_CODES.map((code) => (
                <SelectItem key={code} value={code}>
                  {t(`reason_${code}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
