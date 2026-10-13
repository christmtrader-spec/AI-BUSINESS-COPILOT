"use client";

/**
 * Prompt 48 — supplier-bill line dialog (add or edit).
 *
 * Shows the agreed PO unit price next to the entered invoice price and a
 * LIVE computed variance + line total (integer display only — the server
 * recomputes authoritatively). Qty must be a whole number ≥ 1; the price
 * is integer minor units ≥ 0.
 */
import { useMemo, useState } from "react";
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
import type { PoBillableLine } from "./supplier-bills-api";
import type { SupplierBillDetailDto } from "@/lib/supplier-bills/dto";

export type SupplierBillLineDialogResult = {
  billedQty: number;
  unitPriceMinor: number;
};

export function SupplierBillLineDialog({
  businessId,
  billId,
  line,
  existingLine,
  onClose,
  onSaved,
}: {
  businessId: string;
  billId: string;
  /** The picked PO line (add flow) — carries the PO price + availability. */
  line?: PoBillableLine;
  /** The existing bill line (edit flow). */
  existingLine?: {
    id: string;
    productNameAtBill: string;
    billedQty: number;
    unitPriceMinor: number;
    purchaseOrderUnitPriceMinor: number;
  };
  onClose: () => void;
  onSaved: (detail: SupplierBillDetailDto) => void;
}) {
  const t = useTranslations("supplierBills");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const decimalPrecision = 2;

  const displayName = existingLine?.productNameAtBill ?? line?.productNameAtOrder ?? "";
  const poUnitPrice = existingLine?.purchaseOrderUnitPriceMinor ?? line?.unitPriceMinor ?? 0;
  const [qty, setQty] = useState(String(existingLine?.billedQty ?? line?.availableQty ?? 1));
  const [price, setPrice] = useState(String(existingLine?.unitPriceMinor ?? poUnitPrice));
  const [submitting, setSubmitting] = useState(false);
  const [domainError, setDomainError] = useState<string | null>(null);

  const qtyNum = Number.parseInt(qty, 10);
  const priceNum = Number.parseInt(price, 10);
  const validQty = Number.isInteger(qtyNum) && qtyNum >= 1 && qtyNum <= 1_000_000;
  const validPrice = Number.isInteger(priceNum) && priceNum >= 0 && priceNum <= 1_000_000_000;

  const computed = useMemo(() => {
    if (!validQty || !validPrice) return null;
    const lineTotal = qtyNum * priceNum; // display-only; server recomputes exactly
    if (!Number.isSafeInteger(lineTotal)) return null;
    return { lineTotal, variance: priceNum - poUnitPrice };
  }, [validQty, validPrice, qtyNum, priceNum, poUnitPrice]);

  async function submit() {
    if (submitting || !validQty || !validPrice) return;
    setSubmitting(true);
    setDomainError(null);
    try {
      const { addSupplierBillLine, updateSupplierBillLine } = await import("./supplier-bills-api");
      const detail = existingLine
        ? await updateSupplierBillLine(businessId, billId, existingLine.id, {
            billedQty: qtyNum,
            unitPriceMinor: priceNum,
          })
        : await addSupplierBillLine(businessId, billId, {
            purchaseOrderLineId: (line as PoBillableLine).id,
            billedQty: qtyNum,
            unitPriceMinor: priceNum,
          });
      onSaved(detail);
    } catch (error) {
      if (error instanceof ApiClientError) {
        const code = error.code;
        if (code === "SUPPLIER_BILL_QUANTITY_EXCEEDS_AVAILABLE") {
          const available =
            (error.details as { availableQty?: number } | undefined)?.availableQty ?? 0;
          setDomainError(t("qtyExceedsAvailable", { available }));
        } else if (code === "SUPPLIER_BILL_QUANTITY_EXCEEDS_RECEIVED") {
          const received =
            (error.details as { availableQty?: number } | undefined)?.availableQty ?? 0;
          setDomainError(t("qtyExceedsReceived", { received }));
        } else if (code === "SUPPLIER_BILL_RETURNED_QUANTITY") {
          const returned = (error.details as { availableQty?: number } | undefined)?.availableQty ?? 0;
          setDomainError(t("returnedQuantity", { returned }));
        } else if (code === "SUPPLIER_BILL_DUPLICATE_PO_LINE") {
          setDomainError(t("duplicatePoLine"));
        } else if (code === "SUPPLIER_BILL_LINE_LIMIT_REACHED") {
          setDomainError(t("lineLimit"));
        } else if (code === "SUPPLIER_BILL_PRICE_OVERFLOW" || code === "SUPPLIER_BILL_TOTAL_OVERFLOW") {
          setDomainError(t("totalOverflow"));
        } else if (code === "SUPPLIER_BILL_CORRUPT_HISTORY") {
          setDomainError(t("corruptHistory"));
        } else if (code === "SUPPLIER_BILL_IMMUTABLE") {
          setDomainError(t("immutable"));
        } else {
          setDomainError(tErrors("generic"));
        }
      } else {
        setDomainError(tErrors("generic"));
      }
    } finally {
      setSubmitting(false);
    }
  }

  const fmt = (minor: number) => (minor / 10 ** decimalPrecision).toFixed(decimalPrecision);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md" data-testid="supplier-bill-line-dialog">
        <DialogHeader>
          <DialogTitle>{existingLine ? t("editLineTitle") : t("addLineTitle")}</DialogTitle>
          <DialogDescription>
            {existingLine
              ? t("editLineDesc", { product: displayName })
              : t("addLineDesc", { product: displayName })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {line && !existingLine ? (
            <div className="rounded-lg border bg-muted/30 p-3 text-xs">
              <div className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums" dir="ltr">
                <span>{t("orderedQty")}: {line.orderedQty}</span>
                <span>{t("receivedQty")}: {line.receivedQty}</span>
                <span>{t("returnedQty")}: {line.returnedQty}</span>
                <span>{t("previouslyBilledQty")}: {line.billedQty}</span>
                <span className="font-medium">{t("availableQty")}: {line.availableQty}</span>
              </div>
              <p className="text-muted-foreground mt-1">{t("matchingHint")}</p>
            </div>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="sb-line-qty">{t("billedQty")}</Label>
              <Input
                id="sb-line-qty"
                type="number"
                min={1}
                max={1_000_000}
                step={1}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                inputMode="numeric"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sb-line-price">{t("unitPrice")}</Label>
              <Input
                id="sb-line-price"
                type="number"
                min={0}
                step={1}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                inputMode="numeric"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 rounded-lg border p-3 text-sm">
            <div>
              <p className="text-muted-foreground text-xs">{t("poUnitPrice")}</p>
              <p className="tabular-nums" dir="ltr">{fmt(poUnitPrice)}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">{t("priceVariance")}</p>
              <p
                className={
                  computed && computed.variance !== 0
                    ? "font-medium text-amber-600 dark:text-amber-400 tabular-nums"
                    : "tabular-nums"
                }
                dir="ltr"
                data-testid="sb-price-variance"
              >
                {computed ? `${computed.variance > 0 ? "+" : ""}${fmt(computed.variance)}` : "—"}
              </p>
            </div>
            <div className="col-span-2 border-t pt-2">
              <p className="text-muted-foreground text-xs">{t("lineTotal")}</p>
              <p className="font-medium tabular-nums" dir="ltr">
                {computed ? fmt(computed.lineTotal) : "—"}
              </p>
            </div>
          </div>

          {!validQty && qty !== "" ? (
            <p className="text-sm text-destructive" role="alert">{t("invalidQty")}</p>
          ) : null}
          {!validPrice && price !== "" ? (
            <p className="text-sm text-destructive" role="alert">{t("invalidPrice")}</p>
          ) : null}
          {domainError ? (
            <p className="text-sm text-destructive" role="alert">{domainError}</p>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            {tCommon("cancel")}
          </Button>
          <Button type="button" onClick={submit} disabled={!validQty || !validPrice || submitting}>
            {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {t("saveLine")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
