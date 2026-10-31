"use client";

/**
 * Prompt 48 — supplier-bill line picker.
 *
 * Bounded list of the bill's OWN purchase-order lines that still have
 * invoiceable quantity: available = received(POSTED receipts) −
 * returned(POSTED returns) − already billed(POSTED bills). The matching
 * breakdown is shown per line so staff can see exactly why a quantity is
 * (or is not) billable.
 */
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ApiClientError } from "@/lib/api-client";
import { fetchPoBillableLines, type PoBillableLine } from "./supplier-bills-api";

export function SupplierBillLinePicker({
  businessId,
  purchaseOrderId,
  onPick,
  onError,
}: {
  businessId: string;
  purchaseOrderId: string;
  onPick: (line: PoBillableLine) => void;
  onError: (message: string) => void;
}) {
  const t = useTranslations("supplierBills");

  const lines = useQuery({
    queryKey: ["supplier-bills", "po-billable-lines", businessId, purchaseOrderId],
    queryFn: () => fetchPoBillableLines(businessId, purchaseOrderId),
    staleTime: 5_000,
    retry: false,
  });

  if (lines.isLoading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-6 text-sm">
        <Loader2 className="size-4 animate-spin" aria-hidden />
      </div>
    );
  }
  if (lines.isError) {
    const msg =
      lines.error instanceof ApiClientError && lines.error.code === "SUPPLIER_BILL_CORRUPT_HISTORY"
        ? t("corruptHistory")
        : t("noLinesFound");
    return (
      <p className="py-4 text-center text-sm text-destructive" role="alert">
        {msg}
      </p>
    );
  }

  const items = lines.data ?? [];
  if (items.length === 0) {
    return (
      <div className="space-y-2 py-4 text-center">
        <p className="text-muted-foreground text-sm">{t("noLinesFound")}</p>
        <p className="text-muted-foreground text-xs">{t("matchingHint")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="supplier-bill-line-picker">
      <Input
        aria-label={t("addLineSearch")}
        placeholder={t("addLineSearch")}
        onChange={(e) => {
          // Client-side narrowing over a bounded list (≤ PO line cap rows).
          const q = e.target.value.trim().toLowerCase();
          const container = e.currentTarget.closest("[data-picker-list]");
          if (!container) return;
          container.querySelectorAll<HTMLElement>("[data-line-row]").forEach((row) => {
            const text = row.textContent?.toLowerCase() ?? "";
            row.style.display = !q || text.includes(q) ? "" : "none";
          });
        }}
      />
      <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-lg border p-2" data-picker-list role="listbox" aria-label={t("addLineSearch")}>
        {items.map((line) => (
          <button
            key={line.id}
            type="button"
            role="option"
            aria-selected={false}
            data-line-row
            className="w-full rounded-md border px-3 py-2 text-start text-sm transition-colors hover:bg-muted/60 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            onClick={() => onPick(line)}
          >
            <div className="flex items-center justify-between gap-2">
              <span dir="auto" className="min-w-0 truncate font-medium">
                {line.productNameAtOrder}
              </span>
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums" dir="ltr">
                {t("availableQty")}: {line.availableQty}
              </span>
            </div>
            <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs tabular-nums" dir="ltr">
              <span>{t("orderedQty")}: {line.orderedQty}</span>
              <span>{t("receivedQty")}: {line.receivedQty}</span>
              <span>{t("returnedQty")}: {line.returnedQty}</span>
              <span>{t("previouslyBilledQty")}: {line.billedQty}</span>
              {line.skuAtOrder ? <span dir="auto">SKU: {line.skuAtOrder}</span> : null}
            </div>
          </button>
        ))}
      </div>
      <p className="text-muted-foreground text-xs">{t("matchingHint")}</p>
    </div>
  );
}
