"use client";

/**
 * Prompt 47 — sales-quotation line editor (§17).
 *
 * A bounded dialog for qty + the offered unitPriceMinor. The price
 * defaults from the picked product's CURRENT sale price but is PERSISTED
 * as the offered price (§12 — later product price changes never rewrite
 * it). Quantities/prices are exact integers; the live line total is
 * computed with the SAME canonical law as the server (display-only
 * preview — the server total is authoritative).
 */
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Package } from "lucide-react";
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
import {
  computeQuotationLineTotalMinor,
  QUOTATION_QTY_MIN,
  SALES_QUOTATION_QTY_MAX,
  SALES_QUOTATION_PRICE_MAX,
} from "@/lib/sales-quotations/types";
import type { SalesQuotationLineDto } from "@/lib/sales-quotations/dto";

export type SalesQuotationLineEditorValue = {
  qty: number;
  unitPriceMinor: number;
};

export function SalesQuotationLineEditor({
  title,
  description,
  productName,
  unit,
  initial,
  submitting,
  errorText,
  formatTotal,
  onSubmit,
  onClose,
}: {
  title: string;
  description: string;
  productName?: string;
  unit?: string | null;
  initial?: Partial<SalesQuotationLineEditorValue>;
  submitting: boolean;
  errorText: string | null;
  /** r56 — currency-aware formatter for the live line-total preview
   *  (falls back to grouped integers, the historic display). */
  formatTotal?: (minor: number) => string;
  onSubmit: (value: SalesQuotationLineEditorValue) => void;
  onClose: () => void;
}) {
  const t = useTranslations("salesQuotations");
  const tCommon = useTranslations("common");
  const [qtyText, setQtyText] = useState(String(initial?.qty ?? 1));
  const [priceText, setPriceText] = useState(String(initial?.unitPriceMinor ?? 0));

  const qty = Number(qtyText);
  const price = Number(priceText);
  const qtyValid = Number.isSafeInteger(qty) && qty >= QUOTATION_QTY_MIN && qty <= SALES_QUOTATION_QTY_MAX;
  const priceValid = Number.isSafeInteger(price) && price >= 0 && price <= SALES_QUOTATION_PRICE_MAX;
  const lineTotalValid = qtyValid && priceValid;
  let lineTotal: number | null = null;
  if (lineTotalValid) {
    try {
      lineTotal = computeQuotationLineTotalMinor(qty, price);
    } catch {
      lineTotal = null;
    }
  }

  // First letters of the product name for the avatar tile (presentation only).
  const initials = (productName ?? "").trim().split(/\s+/).slice(0, 2).map((w) => w[0] ?? "").join("").toUpperCase();
  const totalText =
    lineTotal !== null ? (formatTotal ? formatTotal(lineTotal) : lineTotal.toLocaleString("en-US")) : null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] gap-0 overflow-y-auto p-6 pb-0 sm:max-w-md" data-testid="sales-quotation-line-editor">
        <DialogHeader className="gap-3 text-start">
          <DialogTitle className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-600 to-teal-600 text-white shadow-sm dark:from-emerald-500 dark:to-teal-400"
            >
              <Package className="size-4.5" />
            </span>
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-4 pb-4">
          {productName ? (
            <div className="bg-card/60 flex items-center gap-3 rounded-xl border p-3">
              <span
                aria-hidden="true"
                className="bg-muted text-muted-foreground grid size-9 shrink-0 place-items-center rounded-lg text-xs font-bold"
              >
                {initials || <Package className="size-4" />}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium" dir="auto">
                  {productName}
                </p>
                {unit ? <p className="text-muted-foreground text-xs">{unit}</p> : null}
              </div>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sq-line-qty">{t("qty")}</Label>
              <Input
                id="sq-line-qty"
                type="number"
                min={QUOTATION_QTY_MIN}
                max={SALES_QUOTATION_QTY_MAX}
                step={1}
                value={qtyText}
                onChange={(e) => setQtyText(e.target.value)}
                inputMode="numeric"
                dir="ltr"
                className="text-center tabular-nums"
                aria-invalid={!qtyValid}
              />
              {!qtyValid ? (
                <p className="text-destructive text-xs" role="alert">{t("invalidQty")}</p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sq-line-price">{t("unitPrice")}</Label>
              <Input
                id="sq-line-price"
                type="number"
                min={0}
                step={1}
                value={priceText}
                onChange={(e) => setPriceText(e.target.value)}
                inputMode="numeric"
                dir="ltr"
                className="text-end tabular-nums"
                aria-invalid={!priceValid}
              />
              {!priceValid ? (
                <p className="text-destructive text-xs" role="alert">{t("invalidPrice")}</p>
              ) : null}
            </div>
          </div>

          {/* Live line total — summary card with the brand gradient */}
          <div className="bg-muted/30 rounded-xl border p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground shrink-0 text-sm">{t("lineTotal")}</span>
              {totalText !== null ? (
                <span
                  className="bg-gradient-to-r from-emerald-600 to-teal-600 bg-clip-text text-lg font-bold tabular-nums text-transparent dark:from-emerald-400 dark:to-teal-300"
                  dir="ltr"
                >
                  {totalText}
                </span>
              ) : (
                <span className="text-destructive text-xs" role="alert">{t("totalOverflow")}</span>
              )}
            </div>
          </div>

          {errorText ? (
            <p className="text-destructive text-sm" role="alert">{errorText}</p>
          ) : null}
        </div>

        <DialogFooter className="sticky bottom-0 -mx-6 border-t bg-background/95 px-6 py-4 backdrop-blur sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            {tCommon("cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => onSubmit({ qty, unitPriceMinor: price })}
            disabled={submitting || !qtyValid || !priceValid || lineTotal === null}
            className="min-w-28"
          >
            {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {tCommon("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Map a domain error to the localized line-editor message (§22). */
export function salesQuotationLineErrorText(
  error: unknown,
  labels: { duplicate: string; lineLimit: string; immutable: string; generic: string },
): string {
  if (error instanceof ApiClientError) {
    if (error.code === "SALES_QUOTATION_DUPLICATE_PRODUCT") return labels.duplicate;
    if (error.code === "SALES_QUOTATION_LINE_LIMIT_REACHED") return labels.lineLimit;
    if (error.code === "SALES_QUOTATION_IMMUTABLE") return labels.immutable;
  }
  return labels.generic;
}
