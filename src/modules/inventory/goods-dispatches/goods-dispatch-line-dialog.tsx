"use client";

/**
 * Prompt 44 — goods-dispatch line dialog (qty + reason).
 *
 * Shows CURRENT stock, an integer input for "Dispatched quantity"
 * (server STILL revalidates — the advisory bound here is UX, never an
 * authority), and the closed reason selector. No price is shown. When
 * editing an existing line, the advisory max adds the line's own qty
 * back to the current stock allowance.
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
import {
  GOODS_DISPATCH_REASON_CODES,
  type GoodsDispatchReasonCode,
} from "@/lib/inventory/goods-dispatch/types";

/** A picker row over the current product stock. */
export type DispatchableProduct = {
  id: string;
  name: string;
  sku: string | null;
  unit: string | null;
  stockQty: number;
};

export type GoodsDispatchLineDialogValue = {
  qty: number;
  reasonCode: GoodsDispatchReasonCode;
};

export function GoodsDispatchLineDialog({
  product,
  initialQty,
  initialReason,
  title,
  submitLabel,
  cancelLabel,
  qtyLabel,
  stockLabel,
  reasonLabel,
  invalidQtyMessage,
  insufficientMessage,
  onSubmit,
  onClose,
}: {
  product: DispatchableProduct;
  /** When editing an existing line, its current quantity (advisory max adds it back). */
  initialQty?: number;
  initialReason?: string;
  title: string;
  submitLabel: string;
  cancelLabel: string;
  qtyLabel: string;
  stockLabel: string;
  reasonLabel: string;
  invalidQtyMessage: string;
  insufficientMessage: string;
  onSubmit: (value: GoodsDispatchLineDialogValue) => void;
  onClose: () => void;
}) {
  const t = useTranslations("goodsDispatches");
  const [raw, setRaw] = useState(initialQty !== undefined ? String(initialQty) : "");
  const [reason, setReason] = useState<GoodsDispatchReasonCode>(
    (initialReason as GoodsDispatchReasonCode | undefined) ?? "SALE",
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Advisory max is the CURRENT stock. When editing a draft line, its own
  // quantity is added back to the allowance. Only POST is authoritative.
  const maxQty = initialQty !== undefined ? product.stockQty + initialQty : product.stockQty;

  function submit() {
    if (submitting) return;
    setError(null);
    const value = raw.trim();
    if (!/^\d+$/.test(value)) {
      setError(invalidQtyMessage); // rejects 1.5 / NaN / Infinity / negative
      return;
    }
    const qty = Number(value);
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > 1_000_000) {
      setError(invalidQtyMessage);
      return;
    }
    if (qty > maxQty) {
      setError(insufficientMessage);
      return;
    }
    setSubmitting(true);
    onSubmit({ qty, reasonCode: reason });
    setSubmitting(false);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="goods-dispatch-line-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription dir="auto">{product.name}</DialogDescription>
        </DialogHeader>

        <div className="text-muted-foreground grid grid-cols-2 gap-2 rounded-lg border p-3 text-center text-sm">
          <div>
            <p className="text-xs">{stockLabel}</p>
            <p className="font-medium tabular-nums" dir="ltr">{product.stockQty}</p>
          </div>
          <div>
            <p className="text-xs">{t("estimatedStockImpact")}</p>
            <p className="text-amber-600 font-medium tabular-nums dark:text-amber-400" dir="ltr">
              −{raw ? (Number(raw) || 0) : 0}
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="gds-line-qty">{qtyLabel}</Label>
          <Input
            id="gds-line-qty"
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
          <Label htmlFor="gds-line-reason">{reasonLabel}</Label>
          <Select value={reason} onValueChange={(v) => setReason(v as GoodsDispatchReasonCode)}>
            <SelectTrigger id="gds-line-reason" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GOODS_DISPATCH_REASON_CODES.map((code) => (
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
