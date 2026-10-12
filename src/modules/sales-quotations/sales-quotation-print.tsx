"use client";

/**
 * Prompt 47 — printable customer quotation (§16).
 *
 * LAWS:
 *  - the document is unmistakably a SALES QUOTATION / PRICE OFFER — never
 *    labelled a tax invoice, sale, receipt or payment (§16);
 *  - NO tax amounts (the product has no tax engine — no invented tax row);
 *  - internalNotes are structurally absent from the payload (§16);
 *  - no database ids, no audit metadata, no raw technical statuses;
 *  - historical currency + product snapshots render exactly as stored
 *    (§12) — never live master data;
 *  - the app chrome (sidebar, overlays, buttons) is hidden by the print
 *    stylesheet; the browser print dialog is the PDF path (no PDF lib);
 *  - the overlay itself stays tenant-authorized (fetches through the
 *    authenticated /print endpoint) — there is NO public print URL.
 */
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Loader2, Printer, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/shared/primitives";
import { ApiClientError } from "@/lib/api-client";
import {
  fetchSalesQuotationPrint,
  salesQuotationKeys,
  type SalesQuotationPrint,
} from "./sales-quotations-api";

function formatMinor(minor: number): string {
  return minor.toLocaleString("en-US");
}

function dateLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(iso));
}

export function SalesQuotationPrintDialog({
  businessId,
  id,
  onClose,
}: {
  businessId: string;
  id: string;
  onClose: () => void;
}) {
  const t = useTranslations("salesQuotations");
  const tCommon = useTranslations("common");

  const print = useQuery({
    queryKey: salesQuotationKeys.print(businessId, id),
    queryFn: () => fetchSalesQuotationPrint(businessId, id),
    retry: false,
  });

  const data: SalesQuotationPrint | undefined = print.data;
  const notFound = print.error instanceof ApiClientError && print.error.status === 404;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl" data-testid="sales-quotation-print-dialog">
        <DialogHeader className="print:hidden">
          <DialogTitle>{t("printTitle")}</DialogTitle>
        </DialogHeader>

        {print.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground print:hidden">
            <Loader2 className="size-5 animate-spin" aria-hidden />
            <span>{tCommon("loading")}</span>
          </div>
        ) : notFound || !data ? (
          <EmptyState
            icon={X}
            title={t("notFoundTitle")}
            description={t("notFoundDesc")}
          />
        ) : (
          <>
            {/* Toolbar — hidden by the print stylesheet. */}
            <div className="flex items-center justify-end gap-2 print:hidden">
              <Button type="button" variant="outline" size="sm" onClick={() => window.print()}>
                <Printer className="size-4" aria-hidden />
                {t("printAction")}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                <X className="size-4" aria-hidden />
                {tCommon("close")}
              </Button>
            </div>

            {/* The sheet — the ONLY visible subtree when printing. */}
            <article
              className="quotation-print-sheet bg-background mx-auto w-full max-w-2xl rounded-xl border p-6 shadow-xs"
              data-testid="sales-quotation-print-sheet"
            >
              <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
                <div className="flex items-center gap-2.5">
                  <span className="bg-background flex size-10 items-center justify-center rounded-xl border shadow-sm">
                    <img src="/logo.svg" alt="" className="size-5" aria-hidden="true" />
                  </span>
                  <span className="gradient-text text-lg font-semibold">{tCommon("appName")}</span>
                </div>
                <div className="text-end">
                  <h2 className="text-xl font-semibold tracking-tight">{t("printDocTitle")}</h2>
                  <p className="text-muted-foreground text-xs">{t("printDocSubtitle")}</p>
                </div>
              </header>

              <section className="grid grid-cols-2 gap-x-6 gap-y-1 py-4 text-sm">
                <div>
                  <p className="text-muted-foreground text-xs">{t("reference")}</p>
                  <p className="font-medium" dir="auto">{data.reference}</p>
                </div>
                <div className="text-end">
                  <p className="text-muted-foreground text-xs">{t("quotationDate")}</p>
                  <p dir="ltr">{dateLabel(data.quotationDate)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs">{t("customer")}</p>
                  <p className="font-medium" dir="auto">
                    {data.customerNameAtQuotation || t("noCustomer")}
                  </p>
                </div>
                <div className="text-end">
                  <p className="text-muted-foreground text-xs">{t("validUntil")}</p>
                  <p dir="ltr">{dateLabel(data.validUntilDate)}</p>
                </div>
                {data.expectedDeliveryDate ? (
                  <div>
                    <p className="text-muted-foreground text-xs">{t("expectedDelivery")}</p>
                    <p dir="ltr">{dateLabel(data.expectedDeliveryDate)}</p>
                  </div>
                ) : null}
              </section>

              <table className="w-full text-sm">
                <thead>
                  <tr className="border-y text-start text-xs text-muted-foreground">
                    <th className="py-2 text-start font-medium">{t("product")}</th>
                    <th className="py-2 text-end font-medium">{t("qty")}</th>
                    <th className="py-2 text-end font-medium">{t("unitPrice")}</th>
                    <th className="py-2 text-end font-medium">{t("lineTotal")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((line, i) => (
                    <tr key={i} className="border-b align-top">
                      <td className="py-2 pe-2">
                        <span className="font-medium" dir="auto">{line.productNameAtQuotation}</span>
                        {line.skuAtQuotation ? (
                          <span className="text-muted-foreground block text-xs" dir="ltr">{line.skuAtQuotation}</span>
                        ) : null}
                      </td>
                      <td className="py-2 text-end tabular-nums" dir="ltr">{line.qty}</td>
                      <td className="py-2 text-end tabular-nums" dir="ltr">{formatMinor(line.unitPriceMinor)}</td>
                      <td className="py-2 text-end tabular-nums" dir="ltr">{formatMinor(line.lineTotalMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <section className="quotation-print-avoid-break ms-auto mt-4 w-full max-w-64 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("subtotal")}</span>
                  <span className="tabular-nums" dir="ltr">{formatMinor(data.subtotalMinor)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("discount")}</span>
                  <span className="tabular-nums" dir="ltr">-{formatMinor(data.discountMinor)}</span>
                </div>
                <div className="flex justify-between border-t pt-1 font-semibold">
                  <span>{t("total")}</span>
                  <span className="tabular-nums" dir="ltr">{formatMinor(data.totalMinor)}</span>
                </div>
                <p className="text-muted-foreground text-end text-xs" dir="ltr">
                  {data.currencySymbolAtQuotation} · {data.currencyCodeAtQuotation}
                </p>
              </section>

              {data.customerNotes ? (
                <section className="quotation-print-avoid-break mt-4 rounded-lg border p-3 text-sm">
                  <p className="text-muted-foreground text-xs">{t("customerNotes")}</p>
                  <p className="whitespace-pre-wrap" dir="auto">{data.customerNotes}</p>
                </section>
              ) : null}

              <footer className="text-muted-foreground mt-6 space-y-1 border-t pt-3 text-xs">
                <p>{t("printValidityNote", { date: dateLabel(data.validUntilDate) })}</p>
                <p>{t("printNotInvoiceNote")}</p>
                <p>{t("printAcceptanceNote")}</p>
              </footer>
            </article>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
