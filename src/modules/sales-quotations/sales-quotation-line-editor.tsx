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

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md" data-testid="sales-quotation-line-editor">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {productName ? (
            <p className="text-sm font-medium" dir="auto">
              {productName}
              {unit ? <span className="text-muted-foreground font-normal"> · {unit}</span> : null}
            </p>
          ) : null}

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
              aria-invalid={!priceValid}
            />
            {!priceValid ? (
              <p className="text-destructive text-xs" role="alert">{t("invalidPrice")}</p>
            ) : null}
          </div>

          {lineTotal !== null ? (
            <p className="text-muted-foreground text-sm" dir="ltr">
              {t("lineTotal")}: {lineTotal.toLocaleString("en-US")}
            </p>
          ) : (
            <p className="text-destructive text-xs" role="alert">{t("totalOverflow")}</p>
          )}

          {errorText ? (
            <p className="text-destructive text-sm" role="alert">{errorText}</p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            {tCommon("cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => onSubmit({ qty, unitPriceMinor: price })}
            disabled={submitting || !qtyValid || !priceValid || lineTotal === null}
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
