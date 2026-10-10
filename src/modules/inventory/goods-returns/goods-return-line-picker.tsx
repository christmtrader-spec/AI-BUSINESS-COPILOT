"use client";

/**
 * Prompt 43 — goods-return LINE picker (§93).
 *
 * NOT a product picker: the list shows ONLY GoodsReceiptLines of the
 * source receipt with returnableQty > 0. Display is the RECEIPT LINE
 * snapshot (product name/SKU/unit) + received/returned/returnable —
 * NO price anywhere (§93). Lines already on the draft return are disabled.
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
import type { GoodsReturnDetailDto } from "@/lib/inventory/goods-return/dto";
import type { ReturnableReceiptLine } from "./goods-return-line-dialog";

export function GoodsReturnLinePicker({
  lines,
  existingLines,
  onPick,
  onClose,
}: {
  lines: ReturnableReceiptLine[];
  existingLines: GoodsReturnDetailDto["lines"];
  onPick: (line: ReturnableReceiptLine) => void;
  onClose: () => void;
}) {
  const t = useTranslations("goodsReturns");
  const [q, setQ] = useState("");

  const existing = useMemo(
    () => new Set(existingLines.map((l) => l.goodsReceiptLineId)),
    [existingLines],
  );
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return lines;
    return lines.filter(
      (l) =>
        l.productNameAtReceipt.toLowerCase().includes(needle) ||
        (l.skuAtReceipt ?? "").toLowerCase().includes(needle),
    );
  }, [lines, q]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg" data-testid="goods-return-line-picker">
        <DialogHeader>
          <DialogTitle>{t("addLineTitle")}</DialogTitle>
          <DialogDescription>{t("addLineSearch")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="grt-line-search">{t("searchLabel")}</Label>
            <Input
              id="grt-line-search"
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
                const alreadyOnReturn = existing.has(line.id);
                return (
                  <button
                    key={line.id}
                    type="button"
                    role="option"
                    aria-selected={false}
                    aria-disabled={alreadyOnReturn}
                    disabled={alreadyOnReturn}
                    className="flex w-full flex-col gap-1 rounded-md px-2 py-2 text-start text-sm transition-colors enabled:hover:bg-muted/60 disabled:opacity-45"
                    onClick={() => !alreadyOnReturn && onPick(line)}
                  >
                    <span dir="auto" className="min-w-0 truncate font-medium">
                      {line.productNameAtReceipt}
                      {line.skuAtReceipt ? (
                        <span className="text-muted-foreground font-normal"> · {line.skuAtReceipt}</span>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground flex items-center gap-3 text-xs tabular-nums" dir="ltr">
                      <span>{t("receivedQty")}: {line.receivedQty}</span>
                      <span>{t("returnedQty")}: {line.returnedQty}</span>
                      <span className="font-medium">{t("returnableQty")}: {line.returnableQty}</span>
                      {alreadyOnReturn ? <span className="text-xs">· {t("duplicateLine")}</span> : null}
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
