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
  ClipboardList,
  CreditCard,
  FileText,
  PackageCheck,
  PackageMinus,
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
import { Badge } from "@/components/ui/badge";
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
  const tStatements = useTranslations("statements");
  const tSearch = useTranslations("search");
  const tErrors = useTranslations("errors");
  const tPo = useTranslations("purchaseOrders");
  const tGr = useTranslations("goodsReceipts");
  const tRt = useTranslations("goodsReturns");
  const queryClient = useQueryClient();
  const businessId = useAppStore((s) => s.activeBusinessId);
  const navigate = useAppStore((s) => s.navigate);

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
            <>
              {/* Prompt 39 (§55/§145) — Statement CTA: read-only (data:read),
                  available to every role. */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate({ kind: "statements", statementType: "supplier", id: s.id })}
              >
                <FileText className="size-4" aria-hidden="true" />
                {tStatements("statement")}
              </Button>
              {writable ? (
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
              ) : null}
            </>
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

      {/* Prompt 41 (§65/§154) — bounded purchase-order history (≤10). Orders
          are NOT entity-router records; navigation uses the dedicated deep
          link #/purchase-orders/<id>. Read-only (§201); the totals shown are
          procurement document totals — never payables (§150/§151). */}
      <RelatedRecordList
        title={tPo("purchaseOrderHistory")}
        entity={null}
        emptyText={tPo("noPurchaseOrderHistory")}
        onOpen={() => undefined}
        items={data.recentPurchaseOrders.map((po) => ({
          id: po.id,
          icon: ClipboardList,
          primary: po.reference,
          secondary: `${fmtDate(business, po.orderedAt)} · ${tPo("totalQty")}: ${po.totalQty}`,
          trailing: `${(po.totalMinor / 10 ** po.decimalPrecisionAtOrder).toString()} ${po.currencySymbolAtOrder}`,
          badge: (
            <Badge variant="outline" className="text-xs">
              {po.status === "DRAFT" ? tPo("status_DRAFT")
                : po.status === "SENT" ? tPo("status_SENT")
                : po.status === "CONFIRMED" ? tPo("status_CONFIRMED")
                : po.status === "CLOSED" ? tPo("status_CLOSED")
                : tPo("status_CANCELLED")}
            </Badge>
          ),
        }))}
        onOpenRow={(id) => navigate({ kind: "purchase-order", id })}
      />

      {/* Prompt 42 (§121) — bounded goods-receipt history (≤10). Snapshot
          supplier identity; NO financial statement contamination — these
          rows are physical receiving evidence, never payables. */}
      {data.recentGoodsReceipts && data.recentGoodsReceipts.length > 0 ? (
        <RelatedRecordList
          title={tGr("supplierHistory")}
          entity={null}
          emptyText={tGr("noSupplierHistory")}
          onOpen={() => undefined}
          items={data.recentGoodsReceipts.map((gr) => ({
            id: gr.id,
            icon: PackageCheck,
            primary: gr.reference,
            secondary: gr.postedAt
              ? `${tGr("postedAtLabel")}: ${fmtDate(business, gr.postedAt)}`
              : tGr(`status_${gr.status}`),
            trailing: `${tGr("receivedTotal")}: ${gr.totalReceivedQty}`,
          }))}
          onOpenRow={(id) => navigate({ kind: "inventory-goods-receipt", id })}
        />
      ) : null}

      {/* Prompt 43 (§100) — bounded goods-return history (≤10). Snapshot
          identity (supplierNameAtReturn); NO financial statement
          contamination — returns are never payables and never mutate the
          statement or aging views. */}
      {data.recentGoodsReturns && data.recentGoodsReturns.length > 0 ? (
        <RelatedRecordList
          title={tRt("supplierHistory")}
          entity={null}
          emptyText={tRt("noSupplierHistory")}
          onOpen={() => undefined}
          items={data.recentGoodsReturns.map((ret) => ({
            id: ret.id,
            icon: PackageMinus,
            primary: ret.reference,
            secondary: ret.postedAt
              ? `${tRt("postedAtLabel")}: ${fmtDate(business, ret.postedAt)}`
              : tRt(`status_${ret.status}`),
            trailing: `${tRt("totalReturned")}: ${ret.totalReturnedQty}`,
          }))}
          onOpenRow={(id) => navigate({ kind: "inventory-goods-return", id })}
        />
      ) : null}

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
