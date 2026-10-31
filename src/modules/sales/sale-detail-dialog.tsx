"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Banknote, Printer, Trash2 } from "lucide-react";
import { api, ApiClientError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import { DataTable, Ltr } from "@/components/shared/data-table";
import { toJalali, formatJalaliDisplay } from "@/lib/jalali";
import { FinanceStatusBadge, fmtDate, fmtMoney, useInvalidateFinance } from "../finance-shared/finance-kit";
import { PaymentFormDialog, type PaymentTarget } from "../payments/payment-form-dialog";
import { invalidateEntityDetail } from "@/modules/entities/entity-api";
import { useAppStore } from "@/store/app-store";
import type { BusinessSummary } from "../shell/types";

/** One invoice line item — also the row type of the detail-dialog table. */
export type SaleItemRow = {
  id: string;
  name: string;
  unit: string | null;
  qty: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
};

type SaleDetail = {
  sale: {
    id: string;
    number: number;
    customerName: string | null;
    issueDate: string;
    subtotalMinor: number;
    discountMinor: number;
    taxRateBp?: number;
    taxMinor?: number;
    totalMinor: number;
    paidMinor: number;
    status: string;
    balanceMinor: number;
    note: string | null;
  };
  items: SaleItemRow[];
  payments: {
    id: string;
    amountMinor: number;
    method: string;
    note: string | null;
    paidAt: string;
    actorName: string | null;
  }[];
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Basis points -> compact "10%" label for the printed document. */
function vatPercentLabel(rateBp: number): string {
  const value = rateBp / 100;
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
  return `${formatted}%`;
}

/**
 * Official document serial — deterministic and honest: issue year + the
 * per-business invoice number. This identifies the DOCUMENT (e.g. for
 * bookkeeping references); it deliberately does NOT claim any government
 * registration (no tax-authority codes are fabricated).
 */
function invoiceSerial(issueDate: string, number: number): string {
  const year = new Date(issueDate).getUTCFullYear();
  return `${year}-INV-${String(number).padStart(4, "0")}`;
}

/** Jalali display line for fa invoices (official Iranian date form). */
function jalaliDateLine(issueDate: string): string {
  const d = new Date(issueDate);
  if (Number.isNaN(d.getTime())) return "";
  return formatJalaliDisplay(toJalali(d), { long: true, locale: "fa" });
}

/**
 * Labels + serial context shared by the preview and the print window —
 * ONE source of truth: the preview iframe renders byte-identical HTML to
 * what gets printed.
 */
type InvoiceLabels = {
  invoice: string;
  date: string;
  serial: string;
  customer: string;
  walkIn: string;
  item: string;
  qty: string;
  unitPrice: string;
  lineTotal: string;
  subtotal: string;
  discount: string;
  vat: string;
  total: string;
  paid: string;
  balance: string;
  payments: string;
  noPayments: string;
  footer: string;
};

/**
 * Build the self-contained, print-friendly invoice document. Purely
 * client-side narration of server data — every number comes from the
 * fetched SaleDetail (A08/A11). Persian (fa) invoices additionally show
 * the official Jalali issue date next to the Gregorian one. The SAME html
 * is rendered in the in-app preview iframe and handed to the print window
 * — what you review is exactly what prints.
 */
function buildInvoiceHtml(
  data: SaleDetail,
  business: BusinessSummary,
  labels: InvoiceLabels,
): string {
  const fmt = (minor: number) => fmtMoney(business, minor);
  const numberLabel = `INV-${String(data.sale.number).padStart(4, "0")}`;
  const serial = invoiceSerial(data.sale.issueDate, data.sale.number);
  const rtl = business.locale === "fa";
  const esc = escapeHtml;

  const itemRows = data.items
    .map(
      (i) => `
      <tr>
        <td>${esc(i.name)}${i.unit ? ` <small>(${esc(i.unit)})</small>` : ""}</td>
        <td class="num">${i.qty}</td>
        <td class="num">${fmt(i.unitPriceMinor)}</td>
        <td class="num">${fmt(i.lineTotalMinor)}</td>
      </tr>`,
    )
    .join("");

  const paymentRows =
    data.payments.length === 0
      ? `<p class="muted">${esc(labels.noPayments)}</p>`
      : `<ul>${data.payments
          .map(
            (p) =>
              `<li>${fmt(p.amountMinor)} — ${esc(p.method)} · ${esc(fmtDate(business, p.paidAt))}</li>`,
          )
          .join("")}</ul>`;

  const html = `<!doctype html>
<html dir="${rtl ? "rtl" : "ltr"}" lang="${business.locale}">
<head>
<meta charset="utf-8" />
<title>${esc(numberLabel)} — ${esc(business.name)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Tahoma, sans-serif; margin: 40px auto; max-width: 720px; color: #171717; }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #171717; padding-bottom: 16px; margin-bottom: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .inv-number { font-family: ui-monospace, monospace; font-size: 18px; letter-spacing: 0.02em; }
  .muted { color: #666; }
  small { color: #666; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th, td { border-bottom: 1px solid #e5e5e5; padding: 8px 6px; text-align: ${rtl ? "right" : "left"}; font-size: 14px; }
  th { background: #fafafa; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #555; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .totals { margin-inline-start: auto; max-width: 320px; }
  .totals div { display: flex; justify-content: space-between; padding: 4px 0; font-size: 14px; }
  .totals .grand { font-weight: 700; font-size: 16px; border-top: 2px solid #171717; margin-top: 6px; padding-top: 8px; }
  .totals .balance-due { color: #b45309; font-weight: 600; }
  ul { list-style: none; padding: 0; font-size: 14px; }
  li { padding: 6px 0; border-bottom: 1px dashed #e5e5e5; font-variant-numeric: tabular-nums; }
  footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid #e5e5e5; color: #888; font-size: 12px; text-align: center; }
  @media print { body { margin: 12mm; } }
</style>
</head>
<body>
  <header>
    <div>
      <h1>${esc(business.name)}</h1>
      <span class="muted">${esc(labels.invoice)} <span class="inv-number">${esc(numberLabel)}</span></span>
    </div>
    <div class="muted" style="text-align:${rtl ? "left" : "right"}">
      ${esc(labels.date)}<br /><strong>${esc(fmtDate(business, data.sale.issueDate))}</strong>${
        rtl ? `<br /><span>${esc(jalaliDateLine(data.sale.issueDate))}</span>` : ""
      }<br /><small>${esc(labels.serial)}: <span class="inv-number">${esc(serial)}</span></small>
    </div>
  </header>
  <p><strong>${esc(labels.customer)}:</strong> ${esc(data.sale.customerName ?? labels.walkIn)}</p>
  <table>
    <thead>
      <tr>
        <th>${esc(labels.item)}</th>
        <th class="num">${esc(labels.qty)}</th>
        <th class="num">${esc(labels.unitPrice)}</th>
        <th class="num">${esc(labels.lineTotal)}</th>
      </tr>
    </thead>
    <tbody>${itemRows}
    </tbody>
  </table>
  <div class="totals">
    <div><span class="muted">${esc(labels.subtotal)}</span><span>${fmt(data.sale.subtotalMinor)}</span></div>
    ${data.sale.discountMinor > 0 ? `<div><span class="muted">${esc(labels.discount)}</span><span>−${fmt(data.sale.discountMinor)}</span></div>` : ""}
    ${(data.sale.taxMinor ?? 0) > 0 ? `<div><span class="muted">${esc(labels.vat)} (${vatPercentLabel(data.sale.taxRateBp ?? 0)})</span><span>${fmt(data.sale.taxMinor ?? 0)}</span></div>` : ""}
    <div class="grand"><span>${esc(labels.total)}</span><span>${fmt(data.sale.totalMinor)}</span></div>
    <div><span class="muted">${esc(labels.paid)}</span><span>${fmt(data.sale.paidMinor)}</span></div>
    <div class="balance-due"><span>${esc(labels.balance)}</span><span>${fmt(data.sale.balanceMinor)}</span></div>
  </div>
  ${data.sale.note ? `<p class="muted">${esc(data.sale.note)}</p>` : ""}
  <h3 style="font-size:14px; margin-top:24px;">${esc(labels.payments)}</h3>
  ${paymentRows}
  <footer>${esc(labels.footer)}</footer>
</body>
</html>`;

  return html;
}

/** Open the OS print dialog with the EXACT document shown in the preview. */
function printInvoiceHtml(html: string): void {
  const win = window.open("", "_blank", "width=820,height=920");
  if (!win) return;
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  // Give the new document a tick to lay out before printing.
  setTimeout(() => win.print(), 250);
}

/** Invoice detail: line items, totals, payment history + record payment. */
export function SaleDetailDialog({
  saleId,
  onOpenChange,
  business,
  canPay,
}: {
  saleId: string | null;
  onOpenChange: (v: boolean) => void;
  business: BusinessSummary;
  canPay: boolean;
}) {
  const t = useTranslations("finance.saleDetail");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const tPay = useTranslations("finance.paymentForm");
  const invalidate = useInvalidateFinance();
  const queryClient = useQueryClient();
  const [payOpen, setPayOpen] = useState(false);
  const [printPreviewOpen, setPrintPreviewOpen] = useState(false);

  const { data, isLoading, error, refetch } = useQuery<SaleDetail>({
    queryKey: ["sales", "detail", saleId],
    queryFn: () => api(`/api/v1/sales/${saleId}`),
    enabled: saleId !== null,
  });

  const deletePaymentMutation = useMutation({
    mutationFn: async (paymentId: string) =>
      api(`/api/v1/payments/${paymentId}`, { method: "DELETE" }),
    onSuccess: (_data, paymentId) => {
      toast({ title: t("paymentDeletedToast") });
      invalidate();
      void refetch();
      // Prompt 34 §37 — the reversed payment's detail (if cached/open)
      // must converge or vanish; the sale detail refetches above.
      invalidateEntityDetail(
        queryClient,
        useAppStore.getState().activeBusinessId,
        "payment",
        paymentId,
      );
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  const open = saleId !== null;
  const s = data?.sale;

  /** Shared label pack for BOTH the preview iframe and the print window. */
  const invoiceLabels: InvoiceLabels | null =
    data != null
      ? {
          invoice: t("printInvoiceLabel"),
          date: t("printDateLabel"),
          serial: t("printSerialLabel"),
          customer: t("printCustomerLabel"),
          walkIn: t("walkIn"),
          item: t("colItem"),
          qty: t("colQty"),
          unitPrice: t("colUnitPrice"),
          lineTotal: t("colLineTotal"),
          subtotal: t("subtotal"),
          discount: t("discount"),
          vat: t("vatLabel"),
          total: t("total"),
          paid: t("paid"),
          balance: t("balance"),
          payments: t("payments"),
          noPayments: t("noPayments"),
          footer: t("printFooter"),
        }
      : null;
  const invoiceHtml =
    data != null && invoiceLabels != null ? buildInvoiceHtml(data, business, invoiceLabels) : "";
  const presetTarget: PaymentTarget | null =
    s != null
      ? {
          kind: "sale",
          id: s.id,
          number: s.number,
          customerName: s.customerName,
          balanceMinor: s.balanceMinor,
        }
      : null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
          {isLoading ? (
            <div className="space-y-2 py-8" aria-busy="true">
              {/* a11y — Radix requires a DialogTitle even while loading */}
              <DialogTitle className="sr-only">{t("printInvoiceLabel")}</DialogTitle>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="bg-muted/50 h-10 animate-pulse rounded-md" />
              ))}
            </div>
          ) : error || !data ? (
            <div className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm">
              <DialogTitle className="sr-only">{t("printInvoiceLabel")}</DialogTitle>
              {tErrors("loadFailed")}{" "}
              <button className="underline" onClick={() => void refetch()}>
                {tCommon("retry")}
              </button>
            </div>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-base tracking-tight" dir="ltr">
                    {`INV-${String(data.sale.number).padStart(4, "0")}`}
                  </span>
                  <FinanceStatusBadge status={data.sale.status} />
                  <Button
                    variant="outline"
                    size="sm"
                    className="ms-auto h-8"
                    onClick={() => setPrintPreviewOpen(true)}
                  >
                    <Printer className="size-4" aria-hidden="true" />
                    {t("print")}
                  </Button>
                </DialogTitle>
                <DialogDescription dir="auto">
                  {data.sale.customerName ?? t("walkIn")} · {fmtDate(business, data.sale.issueDate)}
                </DialogDescription>
              </DialogHeader>

              <DataTable<SaleItemRow>
                ariaLabel={t("printInvoiceLabel")}
                columns={[
                  {
                    id: "item",
                    header: t("colItem"),
                    cell: (i) => (
                      <div className="min-w-0" dir="auto">
                        <span className="font-medium">{i.name}</span>
                        {i.unit ? (
                          <span className="text-muted-foreground ms-1 text-xs">({i.unit})</span>
                        ) : null}
                      </div>
                    ),
                  },
                  {
                    id: "qty",
                    header: t("colQty"),
                    align: "end",
                    cell: (i) => <Ltr>{i.qty}</Ltr>,
                  },
                  {
                    id: "unitPrice",
                    header: t("colUnitPrice"),
                    align: "end",
                    cell: (i) => <Ltr>{fmtMoney(business, i.unitPriceMinor)}</Ltr>,
                  },
                  {
                    id: "lineTotal",
                    header: t("colLineTotal"),
                    align: "end",
                    cell: (i) => (
                      <Ltr className="font-medium">{fmtMoney(business, i.lineTotalMinor)}</Ltr>
                    ),
                  },
                ]}
                rows={data.items}
                getRowId={(i) => i.id}
                loading={isLoading}
                skeletonRows={4}
              />

              <div className="bg-muted/30 ms-auto w-full max-w-sm space-y-2.5 rounded-xl border p-4 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground shrink-0">{t("subtotal")}</span>
                  <span className="font-medium tabular-nums" dir="ltr">
                    {fmtMoney(business, data.sale.subtotalMinor)}
                  </span>
                </div>
                {data.sale.discountMinor > 0 ? (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground shrink-0">{t("discount")}</span>
                    <span className="tabular-nums" dir="ltr">
                      −{fmtMoney(business, data.sale.discountMinor)}
                    </span>
                  </div>
                ) : null}
                {(data.sale.taxMinor ?? 0) > 0 ? (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground shrink-0">
                      {t("vatLabel")} ({vatPercentLabel(data.sale.taxRateBp ?? 0)})
                    </span>
                    <span className="tabular-nums" dir="ltr">
                      {fmtMoney(business, data.sale.taxMinor ?? 0)}
                    </span>
                  </div>
                ) : null}
                <Separator />
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold">{t("total")}</span>
                  <span
                    className="bg-gradient-to-r from-emerald-600 to-teal-600 bg-clip-text text-base font-bold tabular-nums text-transparent dark:from-emerald-400 dark:to-teal-300"
                    dir="ltr"
                  >
                    {fmtMoney(business, data.sale.totalMinor)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground shrink-0">{t("paid")}</span>
                  <span className="tabular-nums text-emerald-700 dark:text-emerald-400" dir="ltr">
                    {fmtMoney(business, data.sale.paidMinor)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 font-medium">
                  <span className="shrink-0">{t("balance")}</span>
                  <span
                    className={
                      data.sale.balanceMinor > 0
                        ? "tabular-nums text-amber-700 dark:text-amber-400"
                        : "tabular-nums text-emerald-700 dark:text-emerald-400"
                    }
                    dir="ltr"
                  >
                    {fmtMoney(business, data.sale.balanceMinor)}
                  </span>
                </div>
              </div>

              {data.sale.note ? (
                <p className="text-muted-foreground rounded-md bg-muted/50 px-3 py-2 text-sm" dir="auto">
                  {data.sale.note}
                </p>
              ) : null}

              <Separator />

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold">{t("payments")}</p>
                  {canPay && data.sale.balanceMinor > 0 ? (
                    <Button size="sm" variant="secondary" className="h-8" onClick={() => setPayOpen(true)}>
                      <Banknote className="size-4" aria-hidden="true" />
                      {t("recordPayment")}
                    </Button>
                  ) : null}
                </div>
                {data.payments.length === 0 ? (
                  <p className="text-muted-foreground text-sm">{t("noPayments")}</p>
                ) : (
                  <ul className="divide-y rounded-md border">
                    {data.payments.map((p) => (
                      <li key={p.id} className="flex items-center justify-between gap-2 px-3 py-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium tabular-nums" dir="ltr">
                            {fmtMoney(business, p.amountMinor)} · {tPay(`methods.${p.method}`)}
                          </p>
                          <p className="text-muted-foreground truncate text-xs">
                            {fmtDate(business, p.paidAt)}
                            {p.actorName ? ` · ${p.actorName}` : ""}
                            {p.note ? ` · ${p.note}` : ""}
                          </p>
                        </div>
                        {canPay ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:text-destructive size-8 shrink-0"
                            onClick={() => deletePaymentMutation.mutate(p.id)}
                            aria-label={tCommon("delete")}
                            title={tCommon("delete")}
                            disabled={deletePaymentMutation.isPending}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <PaymentFormDialog
        open={payOpen}
        onOpenChange={setPayOpen}
        business={business}
        presetTarget={presetTarget}
      />

      {/*
        Print PREVIEW — final review before issuance (R61-2). The iframe is
        fully sandboxed (no scripts) and renders byte-identical HTML to what
        the print window receives, so what is reviewed is what prints.
      */}
      <Dialog open={printPreviewOpen} onOpenChange={setPrintPreviewOpen}>
        <DialogContent className="flex h-[85svh] max-w-3xl flex-col gap-3 overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Printer className="size-4" aria-hidden="true" />
              {t("printPreviewTitle")}
              {s ? (
                <span className="font-mono text-xs text-muted-foreground" dir="ltr">
                  {invoiceSerial(s.issueDate, s.number)}
                </span>
              ) : null}
            </DialogTitle>
            <DialogDescription>{t("printPreviewDesc")}</DialogDescription>
          </DialogHeader>
          {invoiceHtml ? (
            <iframe
              title={t("printPreviewTitle")}
              srcDoc={invoiceHtml}
              sandbox=""
              className="min-h-0 w-full flex-1 rounded-lg border bg-white"
            />
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setPrintPreviewOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button
              size="sm"
              disabled={!invoiceHtml}
              onClick={() => printInvoiceHtml(invoiceHtml)}
            >
              <Printer className="size-4" aria-hidden="true" />
              {t("printNow")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
