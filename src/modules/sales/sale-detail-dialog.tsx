"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Banknote, Trash2 } from "lucide-react";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/hooks/use-toast";
import { FinanceStatusBadge, fmtDate, fmtMoney, useInvalidateFinance } from "../finance-shared/finance-kit";
import { PaymentFormDialog, type PaymentTarget } from "../payments/payment-form-dialog";
import type { BusinessSummary } from "../shell/types";

type SaleDetail = {
  sale: {
    id: string;
    number: number;
    customerName: string | null;
    issueDate: string;
    subtotalMinor: number;
    discountMinor: number;
    totalMinor: number;
    paidMinor: number;
    status: string;
    balanceMinor: number;
    note: string | null;
  };
  items: {
    id: string;
    name: string;
    unit: string | null;
    qty: number;
    unitPriceMinor: number;
    lineTotalMinor: number;
  }[];
  payments: {
    id: string;
    amountMinor: number;
    method: string;
    note: string | null;
    paidAt: string;
    actorName: string | null;
  }[];
};

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
  const [payOpen, setPayOpen] = useState(false);

  const { data, isLoading, error, refetch } = useQuery<SaleDetail>({
    queryKey: ["sales", "detail", saleId],
    queryFn: () => api(`/api/v1/sales/${saleId}`),
    enabled: saleId !== null,
  });

  const deletePaymentMutation = useMutation({
    mutationFn: async (paymentId: string) =>
      api(`/api/v1/payments/${paymentId}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: t("paymentDeletedToast") });
      invalidate();
      void refetch();
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
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="bg-muted/50 h-10 animate-pulse rounded-md" />
              ))}
            </div>
          ) : error || !data ? (
            <div className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm">
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
                </DialogTitle>
                <DialogDescription dir="auto">
                  {data.sale.customerName ?? t("walkIn")} · {fmtDate(business, data.sale.issueDate)}
                </DialogDescription>
              </DialogHeader>

              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead>{t("colItem")}</TableHead>
                      <TableHead className="text-end">{t("colQty")}</TableHead>
                      <TableHead className="text-end">{t("colUnitPrice")}</TableHead>
                      <TableHead className="text-end">{t("colLineTotal")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.items.map((i) => (
                      <TableRow key={i.id}>
                        <TableCell dir="auto">
                          <span className="font-medium">{i.name}</span>
                          {i.unit ? (
                            <span className="text-muted-foreground ms-1 text-xs">({i.unit})</span>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-end tabular-nums" dir="ltr">{i.qty}</TableCell>
                        <TableCell className="text-end tabular-nums" dir="ltr">
                          {fmtMoney(business, i.unitPriceMinor)}
                        </TableCell>
                        <TableCell className="text-end font-medium tabular-nums" dir="ltr">
                          {fmtMoney(business, i.lineTotalMinor)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="space-y-1 text-sm tabular-nums" dir="ltr">
                <div className="text-muted-foreground flex justify-between">
                  <span>{t("subtotal")}</span>
                  <span>{fmtMoney(business, data.sale.subtotalMinor)}</span>
                </div>
                {data.sale.discountMinor > 0 ? (
                  <div className="text-muted-foreground flex justify-between">
                    <span>{t("discount")}</span>
                    <span>−{fmtMoney(business, data.sale.discountMinor)}</span>
                  </div>
                ) : null}
                <div className="flex justify-between text-base font-semibold">
                  <span>{t("total")}</span>
                  <span>{fmtMoney(business, data.sale.totalMinor)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">{t("paid")}</span>
                  <span className="text-emerald-700 dark:text-emerald-400">
                    {fmtMoney(business, data.sale.paidMinor)}
                  </span>
                </div>
                <div className="flex justify-between font-medium">
                  <span>{t("balance")}</span>
                  <span
                    className={
                      data.sale.balanceMinor > 0
                        ? "text-amber-700 dark:text-amber-400"
                        : "text-emerald-700 dark:text-emerald-400"
                    }
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
    </>
  );
}
