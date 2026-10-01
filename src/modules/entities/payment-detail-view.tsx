"use client";

/**
 * Prompt 34 — Payment detail page (§30).
 * Payment fields + the single related document (sale OR expense).
 * Reversal is surfaced ONLY for finance:manage holders and reuses the
 * EXISTING DELETE endpoint + confirm pattern — never a second flow (§30).
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  ArrowDownLeft,
  ArrowUpRight,
  CreditCard,
  ReceiptText,
  RotateCcw,
  ShoppingCart,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { can, type Role } from "@/lib/rbac";
import { useAppStore } from "@/store/app-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FinanceStatusBadge, fmtDate, fmtMoney } from "../finance-shared/finance-kit";
import type { BusinessSummary } from "../shell/types";
import { invalidateEntityDetail } from "./entity-api";
import { EntityHeader, EntityBreadcrumb, EntityTypeBadge } from "./entity-header";
import { EntityMetricCard } from "./entity-metric-card";
import { EntityDeleteDialog } from "./entity-delete-dialog";
import { navigateToEntity, navigateToEntityList } from "./entity-route";
import { InfoRow } from "./customer-detail-view";
import type { PaymentDetail } from "@/lib/entities";

export function PaymentDetailView({
  data,
  business,
  role,
}: {
  data: PaymentDetail;
  business: BusinessSummary;
  role: Role;
}) {
  const t = useTranslations("entityDetail");
  const tCommon = useTranslations("common");
  const tSearch = useTranslations("search");
  const tErrors = useTranslations("errors");
  const queryClient = useQueryClient();
  const businessId = useAppStore((s) => s.activeBusinessId);

  const canReverse = can(role, "finance:manage");
  const p = data.payment;

  const reverseMutation = useMutation({
    mutationFn: async () => api(`/api/v1/payments/${p.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: t("reversedToast") });
      // §37 — targeted: this payment + its related document + the lists.
      for (const key of [["payments"], ["sales"], ["expenses"], ["receivables"], ["payables"], ["audit"]] as const) {
        void queryClient.invalidateQueries({ queryKey: [...key] });
      }
      invalidateEntityDetail(queryClient, businessId, "payment", p.id);
      if (data.related.sale) {
        invalidateEntityDetail(queryClient, businessId, "sale", data.related.sale.id);
        if (data.related.sale.customerId) {
          invalidateEntityDetail(queryClient, businessId, "customer", data.related.sale.customerId);
        }
      }
      if (data.related.expense) {
        invalidateEntityDetail(queryClient, businessId, "expense", data.related.expense.id);
        if (data.related.expense.supplierId) {
          invalidateEntityDetail(queryClient, businessId, "supplier", data.related.expense.supplierId);
        }
      }
      navigateToEntityList("payment");
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  const directionBadge =
    p.direction === "IN" ? (
      <Badge variant="outline" className="border-emerald-300/60 bg-emerald-500/10 font-medium text-emerald-700 dark:text-emerald-400">
        <ArrowDownLeft className="size-3.5 rtl:-scale-x-100" aria-hidden="true" />
        {tSearch("direction.IN")}
      </Badge>
    ) : (
      <Badge variant="outline" className="border-rose-300/60 bg-rose-500/10 font-medium text-rose-700 dark:text-rose-400">
        <ArrowUpRight className="size-3.5 rtl:-scale-x-100" aria-hidden="true" />
        {tSearch("direction.OUT")}
      </Badge>
    );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <EntityBreadcrumb listLabel={t("payments")} title={fmtMoney(business, p.amountMinor)} />
        <EntityHeader
          icon={CreditCard}
          title={fmtMoney(business, p.amountMinor)}
          subtitle={tSearch(`method.${p.method}`)}
          badge={
            <>
              {directionBadge}
              <EntityTypeBadge label={t("payment")} />
            </>
          }
          backLabel={t("backTo", { list: t("payments") })}
          onBack={() => navigateToEntityList("payment")}
          actions={
            canReverse ? (
              <EntityDeleteDialog
                triggerLabel={t("reverse")}
                triggerIcon={RotateCcw}
                title={t("reverseTitle")}
                description={t("reverseDesc")}
                confirmLabel={t("reverseConfirm")}
                cancelLabel={tCommon("cancel")}
                pending={reverseMutation.isPending}
                onConfirm={() => reverseMutation.mutate()}
              />
            ) : null
          }
        />
        <p className="text-muted-foreground text-xs">{fmtDate(business, p.paidAt)}</p>
      </div>

      {/* Payment fields (§30) */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <EntityMetricCard label={t("amount")} value={fmtMoney(business, p.amountMinor)} />
        <EntityMetricCard label={t("method")} value={tSearch(`method.${p.method}`)} />
        <EntityMetricCard
          label={t("direction")}
          value={tSearch(`direction.${p.direction}`)}
        />
      </div>

      <Card>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
          <InfoRow label={t("date")} value={fmtDate(business, p.paidAt)} />
          <InfoRow label={t("note")} value={p.note} />
        </CardContent>
      </Card>

      {/* Related document — sale OR expense (§30/§34), never both */}
      {data.related.sale ? (
        <Card>
          <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                {t("relatedSale")}
              </p>
              <p className="flex items-center gap-2 truncate font-mono text-sm font-semibold" dir="ltr">
                <ShoppingCart className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
                {data.related.sale.formattedInvoiceNumber}
              </p>
              <p className="text-muted-foreground truncate text-sm" dir="auto">
                {data.related.sale.customerName ?? t("walkIn")}
              </p>
              <div className="flex items-center gap-2">
                <FinanceStatusBadge status={data.related.sale.status} />
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigateToEntity("sale", data.related.sale!.id)}
            >
              <ReceiptText className="size-4" aria-hidden="true" />
              {t("openSale")}
            </Button>
          </CardContent>
        </Card>
      ) : data.related.expense ? (
        <Card>
          <CardContent className="flex flex-col gap-3 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                {t("relatedExpense")}
              </p>
              <p className="truncate text-sm font-semibold" dir="auto">
                <ReceiptText className="text-muted-foreground me-1.5 inline size-4" aria-hidden="true" />
                {data.related.expense.category}
              </p>
              <p className="text-muted-foreground truncate text-sm" dir="auto">
                {data.related.expense.supplierName ?? t("noSupplier")}
              </p>
              <FinanceStatusBadge status={data.related.expense.status} />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigateToEntity("expense", data.related.expense!.id)}
            >
              <ReceiptText className="size-4" aria-hidden="true" />
              {t("openExpense")}
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
