"use client";

/**
 * Prompt 34 — Expense detail page (§29).
 * Header + amount summary + supplier link + read-only note + payments.
 * Edit/Delete reuse the EXISTING endpoints via the extracted shared dialog.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  CalendarDays,
  CreditCard,
  Pencil,
  ReceiptText,
  Trash2,
  Truck,
  Wallet,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { can, type Role } from "@/lib/rbac";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FinanceStatusBadge, fmtDate, fmtMoney } from "../finance-shared/finance-kit";
import type { BusinessSummary } from "../shell/types";
import { invalidateEntityDetail } from "./entity-api";
import { EntityHeader, EntityBreadcrumb, EntityTypeBadge } from "./entity-header";
import { EntityMetricCard } from "./entity-metric-card";
import { EntityDeleteDialog } from "./entity-delete-dialog";
import { RelatedRecordList } from "./related-record-list";
import { navigateToEntity, navigateToEntityList } from "./entity-route";
import { ExpenseFormDialog } from "../expenses/expense-form-dialog";
import { InfoRow } from "./customer-detail-view";
import type { ExpenseDetail } from "@/lib/entities";

export function ExpenseDetailView({
  data,
  business,
  role,
}: {
  data: ExpenseDetail;
  business: BusinessSummary;
  role: Role;
}) {
  const t = useTranslations("entityDetail");
  const tCommon = useTranslations("common");
  const tSearch = useTranslations("search");
  const tErrors = useTranslations("errors");
  const queryClient = useQueryClient();
  const businessId = useAppStore((s) => s.activeBusinessId);

  const writable = can(role, "data:write");
  const e = data.expense;
  const [editOpen, setEditOpen] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: async () => api(`/api/v1/expenses/${e.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: t("deletedToast", { type: t("expense") }) });
      for (const key of [["expenses"], ["audit"]] as const) {
        void queryClient.invalidateQueries({ queryKey: [...key] });
      }
      invalidateEntityDetail(queryClient, businessId, "expense", e.id);
      navigateToEntityList("expense");
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <EntityBreadcrumb listLabel={t("expenses")} title={e.category} />
        <EntityHeader
          icon={ReceiptText}
          title={e.category}
          subtitle={fmtDate(business, e.spentAt)}
          badge={<FinanceStatusBadge status={e.status} />}
          backLabel={t("backTo", { list: t("expenses") })}
          onBack={() => navigateToEntityList("expense")}
          actions={
            writable ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                  <Pencil className="size-4" aria-hidden="true" />
                  {tCommon("edit")}
                </Button>
                <EntityDeleteDialog
                  triggerLabel={tCommon("delete")}
                  triggerIcon={Trash2}
                  title={t("deleteTitle", { type: t("expense") })}
                  description={t("deleteDesc")}
                  confirmLabel={tCommon("delete")}
                  cancelLabel={tCommon("cancel")}
                  pending={deleteMutation.isPending}
                  onConfirm={() => deleteMutation.mutate()}
                />
              </>
            ) : null
          }
        />
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <CalendarDays className="size-3.5" aria-hidden="true" />
          {fmtDate(business, e.spentAt)}
        </p>
      </div>

      {/* Amount summary (§29) */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <EntityMetricCard label={t("amount")} value={fmtMoney(business, e.amountMinor)} icon={Wallet} />
        <EntityMetricCard
          label={t("paid")}
          value={fmtMoney(business, e.paidMinor)}
          tone="positive"
        />
        <EntityMetricCard
          label={t("balance")}
          value={fmtMoney(business, e.balanceMinor)}
          tone={e.balanceMinor > 0 ? "warning" : "positive"}
        />
      </div>

      {/* Supplier + note (§29) — supplier clickable when present */}
      <Card>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
          <div className="flex flex-col gap-0.5">
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {t("supplier")}
            </p>
            {e.supplierId ? (
              <Button
                variant="link"
                size="sm"
                className="h-auto w-fit px-0 text-base"
                onClick={() => navigateToEntity("supplier", e.supplierId as string)}
              >
                <Truck className="size-4" aria-hidden="true" />
                <span dir="auto">{e.supplierName ?? t("unknownSupplier")}</span>
              </Button>
            ) : (
              <p className="text-muted-foreground text-sm">{t("noSupplier")}</p>
            )}
          </div>
          <InfoRow label={t("note")} value={e.note} />
        </CardContent>
      </Card>

      {/* Payments (§29): rows open the payment detail */}
      <RelatedRecordList
        title={t("payments")}
        entity="payment"
        emptyText={t("noPayments")}
        onOpen={navigateToEntity}
        items={data.payments.map((p) => ({
          id: p.id,
          icon: CreditCard,
          primary: tSearch(`method.${p.method}`),
          secondary: p.actorName ? t("recordedBy", { name: p.actorName }) : p.note,
          trailing: fmtMoney(business, p.amountMinor),
          trailingMuted: fmtDate(business, p.paidAt),
        }))}
      />

      <ExpenseFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        editing={{
          id: e.id,
          category: e.category,
          amountMinor: e.amountMinor,
          note: e.note,
        }}
        business={business}
      />
    </div>
  );
}
