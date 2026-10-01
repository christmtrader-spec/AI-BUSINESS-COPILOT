"use client";

/**
 * Prompt 34 — Supplier 360 detail page (§26).
 * Header + contact + payable summary + related expenses/payments.
 * Payable NEVER includes platform subscription balances (§14/§69).
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  ArrowUpRight,
  CreditCard,
  Pencil,
  ReceiptText,
  Trash2,
  Truck,
  TrendingDown,
  Wallet,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { can, type Role } from "@/lib/rbac";
import { useAppStore } from "@/store/app-store";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FinanceStatusBadge, fmtCount, fmtDate, fmtMoney } from "../finance-shared/finance-kit";
import type { BusinessSummary } from "../shell/types";
import { invalidateEntityDetail } from "./entity-api";
import { EntityHeader, EntityBreadcrumb, EntityTypeBadge } from "./entity-header";
import { EntityMetricCard } from "./entity-metric-card";
import { EntityDeleteDialog } from "./entity-delete-dialog";
import { RelatedRecordList } from "./related-record-list";
import { navigateToEntity, navigateToEntityList } from "./entity-route";
import { PartyFormDialog } from "../parties/party-form-dialog";
import { ExpenseFormDialog } from "../expenses/expense-form-dialog";
import { InfoRow } from "./customer-detail-view";
import type { SupplierDetail } from "@/lib/entities";

export function SupplierDetailView({
  data,
  business,
  uiLocale,
  role,
}: {
  data: SupplierDetail;
  business: BusinessSummary;
  uiLocale: string;
  role: Role;
}) {
  const t = useTranslations("entityDetail");
  const tCommon = useTranslations("common");
  const tSearch = useTranslations("search");
  const tErrors = useTranslations("errors");
  const queryClient = useQueryClient();
  const businessId = useAppStore((s) => s.activeBusinessId);

  const writable = can(role, "data:write");
  const s = data.supplier;
  const [editOpen, setEditOpen] = useState(false);
  const [newExpenseOpen, setNewExpenseOpen] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: async () => api(`/api/v1/suppliers/${s.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: t("deletedToast", { type: t("supplier") }) });
      void queryClient.invalidateQueries({ queryKey: ["parties", "supplier"] });
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
      invalidateEntityDetail(queryClient, businessId, "supplier", s.id);
      navigateToEntityList("supplier");
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  const subtitle = s.phone ?? s.email ?? t("noContact");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <EntityBreadcrumb listLabel={t("suppliers")} title={s.name} />
        <EntityHeader
          icon={Truck}
          avatarInitials={s.name.slice(0, 2).toUpperCase()}
          title={s.name}
          subtitle={subtitle}
          badge={<EntityTypeBadge label={t("supplier")} />}
          backLabel={t("backTo", { list: t("suppliers") })}
          onBack={() => navigateToEntityList("supplier")}
          actions={
            writable ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setNewExpenseOpen(true)}>
                  <Wallet className="size-4" aria-hidden="true" />
                  {t("newExpense")}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                  <Pencil className="size-4" aria-hidden="true" />
                  {tCommon("edit")}
                </Button>
                <EntityDeleteDialog
                  triggerLabel={tCommon("delete")}
                  triggerIcon={Trash2}
                  title={t("deleteTitle", { type: t("supplier") })}
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
      </div>

      {/* Payable summary (§26) — server-authoritative integer aggregates */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <EntityMetricCard
          label={t("totalExpenses")}
          value={fmtMoney(business, data.summary.totalExpensesMinor)}
          icon={TrendingDown}
        />
        <EntityMetricCard
          label={t("paid")}
          value={fmtMoney(business, data.summary.paidExpensesMinor)}
          icon={Wallet}
          tone="positive"
        />
        <EntityMetricCard
          label={t("payable")}
          value={fmtMoney(business, data.summary.payableMinor)}
          icon={ArrowUpRight}
          tone={data.summary.payableMinor > 0 ? "warning" : "positive"}
        />
        <EntityMetricCard
          label={t("expensesCount")}
          value={fmtCount(uiLocale, data.summary.expenseCount)}
          hint={t("openExpenses", { count: data.summary.openExpenseCount })}
          icon={ReceiptText}
        />
      </div>

      {/* Contact card */}
      <Card>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
          <div className="flex flex-col gap-3">
            <InfoRow label={t("phone")} value={s.phone} ltr />
            <InfoRow label={t("email")} value={s.email} ltr />
          </div>
          <div className="flex flex-col gap-3">
            <InfoRow label={t("address")} value={s.address} />
            <InfoRow label={t("note")} value={s.note} />
          </div>
        </CardContent>
      </Card>

      {/* Related records (§34) */}
      <RelatedRecordList
        title={t("recentExpenses")}
        entity="expense"
        emptyText={t("noRecentExpenses")}
        onOpen={navigateToEntity}
        items={data.recentExpenses.map((e) => ({
          id: e.id,
          icon: ReceiptText,
          primary: e.category,
          secondary: fmtDate(business, e.spentAt),
          trailing: fmtMoney(business, e.amountMinor),
          badge: <FinanceStatusBadge status={e.status} />,
        }))}
      />
      <RelatedRecordList
        title={t("recentPayments")}
        entity="payment"
        emptyText={t("noRecentPayments")}
        onOpen={navigateToEntity}
        items={data.recentPayments.map((p) => ({
          id: p.id,
          icon: CreditCard,
          primary: tSearch(`method.${p.method}`),
          secondary: p.note,
          trailing: fmtMoney(business, p.amountMinor),
          trailingMuted: fmtDate(business, p.paidAt),
        }))}
      />

      <PartyFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        kind="supplier"
        editing={s}
      />

      {/* New expense — REUSES the shared ExpenseFormDialog (§75, one flow)
          with this supplier pre-selected; success refreshes the 360. */}
      <ExpenseFormDialog
        open={newExpenseOpen}
        onOpenChange={setNewExpenseOpen}
        editing={null}
        business={business}
        presetSupplier={{ id: s.id, name: s.name }}
        onSaved={() => invalidateEntityDetail(queryClient, businessId, "supplier", s.id)}
      />
    </div>
  );
}
