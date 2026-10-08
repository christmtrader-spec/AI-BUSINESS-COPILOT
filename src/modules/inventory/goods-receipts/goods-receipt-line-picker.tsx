"use client";

/**
 * Prompt 42 — goods-receipt LINE picker (§110/§111).
 *
 * NOT a product picker: the list shows ONLY PurchaseOrderLines with
 * remainingQty > 0 for the receipt's own confirmed PO. Display is the PO
 * LINE snapshot (product name/SKU/unit) + ordered/received/remaining —
 * NO price anywhere (§111).
 */
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { GoodsReceiptDetailDto, GoodsReceiptLineDto } from "@/lib/inventory/goods-receipt/dto";
import type { PoReceivableLine } from "./goods-receipts-api";

export function GoodsReceiptLinePicker({
  lines,
  existingLines,
  onPick,
  onClose,
}: {
  lines: PoReceivableLine[];
  existingLines: GoodsReceiptDetailDto["lines"];
  onPick: (line: PoReceivableLine) => void;
  onClose: () => void;
}) {
  const t = useTranslations("goodsReceipts");
  const [q, setQ] = useState("");

  const existing = useMemo(
    () => new Set(existingLines.map((l) => l.purchaseOrderLineId)),
    [existingLines],
  );
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return lines;
    return lines.filter(
      (l) =>
        l.productNameAtOrder.toLowerCase().includes(needle) ||
        (l.skuAtOrder ?? "").toLowerCase().includes(needle),
    );
  }, [lines, q]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg" data-testid="goods-receipt-line-picker">
        <DialogHeader>
          <DialogTitle>{t("addLineTitle")}</DialogTitle>
          <DialogDescription>{t("addLineSearch")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="gr-line-search">{t("searchLabel")}</Label>
            <Input
              id="gr-line-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoComplete="off"
            />
          </div>

          <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-lg border p-2" role="listbox" aria-label={t("addLineTitle")}>
            {filtered.length === 0 ? (
              <p className="text-muted-foreground py-6 text-center text-sm">{t("noLinesFound")}</p>
            ) : (
              filtered.map((line) => {
                const alreadyOnReceipt = existing.has(line.id);
                return (
                  <button
                    key={line.id}
                    type="button"
                    role="option"
                    aria-selected={false}
                    aria-disabled={alreadyOnReceipt}
                    disabled={alreadyOnReceipt}
                    className="flex w-full flex-col gap-1 rounded-md px-2 py-2 text-start text-sm transition-colors enabled:hover:bg-muted/60 disabled:opacity-45"
                    onClick={() => !alreadyOnReceipt && onPick(line)}
                  >
                    <span dir="auto" className="min-w-0 truncate font-medium">
                      {line.productNameAtOrder}
                      {line.skuAtOrder ? (
                        <span className="text-muted-foreground font-normal"> · {line.skuAtOrder}</span>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground flex items-center gap-3 text-xs tabular-nums" dir="ltr">
                      <span>{t("ordered")}: {line.orderedQty}</span>
                      <span>{t("received")}: {line.receivedQty}</span>
                      <span className="font-medium">{t("remaining")}: {line.remainingQty}</span>
                      {alreadyOnReceipt ? <span className="text-xs">· {t("duplicateLine")}</span> : null}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
