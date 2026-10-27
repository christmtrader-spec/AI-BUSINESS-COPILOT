"use client";

/**
 * Prompt 34 — Customer 360 detail page (§25).
 * Header + contact + summary metrics + related invoices/payments. All
 * money flows through the business money utilities (§43); related rows
 * navigate via the centralized entity helpers (§34).
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  CreditCard,
  FileText,
  HandCoins,
  PackageOpen,
  Pencil,
  ReceiptText,
  ShoppingCart,
  Trash2,
  TrendingUp,
  UserRound,
  Wallet,
  FileSignature,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import type { Role } from "@/lib/rbac";
import { can } from "@/lib/rbac";
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
import { StageBadge } from "../crm/crm-badges";
import { invalidateCrmAfterMutation } from "../crm/crm-api";
import { CrmTimelineCard } from "../crm/crm-timeline";
import { PartyFormDialog } from "../parties/party-form-dialog";
import { SaleFormDialog } from "../sales/sale-form-dialog";
import { PartyAgingPanel } from "../balances/party-aging-panel";
import type { CustomerDetail } from "@/lib/entities";

export function CustomerDetailView({
  data,
  business,
  uiLocale,
  role,
}: {
  data: CustomerDetail;
  business: BusinessSummary;
  uiLocale: string;
  role: Role;
}) {
  const t = useTranslations("entityDetail");
  const tGd = useTranslations("goodsDispatches");
  const tSo = useTranslations("salesOrders");
  const tSq = useTranslations("salesQuotations");
  const tCommon = useTranslations("common");
  const tStatements = useTranslations("statements");
  const tSearch = useTranslations("search");
  const tErrors = useTranslations("errors");
  const queryClient = useQueryClient();
  const businessId = useAppStore((s) => s.activeBusinessId);
  const navigate = useAppStore((s) => s.navigate);

  const writable = can(role, "data:write");
  const c = data.customer;
  const [editOpen, setEditOpen] = useState(false);
  const [newInvoiceOpen, setNewInvoiceOpen] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: async () => api(`/api/v1/customers/${c.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: t("deletedToast", { type: t("customer") }) });
      void queryClient.invalidateQueries({ queryKey: ["parties", "customer"] });
      void queryClient.invalidateQueries({ queryKey: ["audit"] });
      invalidateEntityDetail(queryClient, businessId, "customer", c.id);
      navigateToEntityList("customer");
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  const subtitle =
    c.phone ?? c.email ?? t("noContact");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <EntityBreadcrumb listLabel={t("customers")} title={c.name} />
        <EntityHeader
          icon={ReceiptText}
          avatarInitials={c.name.slice(0, 2).toUpperCase()}
          title={c.name}
          subtitle={subtitle}
          badge={<EntityTypeBadge label={t("customer")} />}
          backLabel={t("backTo", { list: t("customers") })}
          onBack={() => navigateToEntityList("customer")}
          actions={
            <>
              {/* Prompt 39 (§54/§144) — Statement CTA: read-only (data:read),
                  available to every role, placed with the financial actions. */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigate({ kind: "statements", statementType: "customer", id: c.id })}
              >
                <FileText className="size-4" aria-hidden="true" />
                {tStatements("statement")}
              </Button>
              {writable ? (
                <>
                  <Button variant="outline" size="sm" onClick={() => setNewInvoiceOpen(true)}>
                    <ShoppingCart className="size-4" aria-hidden="true" />
                    {t("newInvoice")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                    <Pencil className="size-4" aria-hidden="true" />
                    {tCommon("edit")}
                  </Button>
                  <EntityDeleteDialog
                    triggerLabel={tCommon("delete")}
                    triggerIcon={Trash2}
                    title={t("deleteTitle", { type: t("customer") })}
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

      {/* Financial summary (§25) — server-authoritative integer aggregates */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <EntityMetricCard
          label={t("totalSales")}
          value={fmtMoney(business, data.summary.totalSalesMinor)}
          icon={TrendingUp}
        />
        <EntityMetricCard
          label={t("paid")}
          value={fmtMoney(business, data.summary.paidSalesMinor)}
          icon={Wallet}
          tone="positive"
        />
        <EntityMetricCard
          label={t("receivable")}
          value={fmtMoney(business, data.summary.receivableMinor)}
          icon={HandCoins}
          tone={data.summary.receivableMinor > 0 ? "warning" : "positive"}
        />
        <EntityMetricCard
          label={t("invoices")}
          value={fmtCount(uiLocale, data.summary.invoiceCount)}
          hint={t("openInvoices", { count: data.summary.openInvoiceCount })}
          icon={ReceiptText}
        />
      </div>

      {/* Prompt 49 (§17) — READ-ONLY receivables-aging overview for this
          exact customer: canonical engine data, bucket drill-down + the
          party-scoped detailed view + the statement. SalesOrders and
          Quotations can NEVER appear here (§8). */}
      <PartyAgingPanel
        side="receivables"
        partyId={c.id}
        summary={data.receivablesAging}
        business={business}
        uiLocale={uiLocale}
      />

      {/* Contact card */}
      <Card>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
          <div className="flex flex-col gap-3">
            <InfoRow label={t("phone")} value={c.phone} ltr />
            <InfoRow label={t("email")} value={c.email} ltr />
          </div>
          <div className="flex flex-col gap-3">
            <InfoRow label={t("address")} value={c.address} />
            <InfoRow label={t("note")} value={c.note} />
          </div>
        </CardContent>
      </Card>

      {/* Related records (§34) */}
      <RelatedRecordList
        title={t("recentSales")}
        entity="sale"
        emptyText={t("noRecentSales")}
        onOpen={navigateToEntity}
        items={data.recentSales.map((s) => ({
          id: s.id,
          icon: ShoppingCart,
          primary: `INV-${String(s.number).padStart(4, "0")}`,
          // R90 — a draft has no issue day yet: honest absence, no fake date.
          secondary: s.issueDate ? fmtDate(business, s.issueDate) : t("draftNoIssueDate"),
          trailing: fmtMoney(business, s.totalMinor),
          badge: <FinanceStatusBadge status={s.status} />,
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

      {/* Prompt 44 — bounded goods-dispatch history (≤10). Inventory
          events, never financial rows; rows deep-link to the dispatch
          document (#/inventory/goods-dispatches/<id>). */}
      <RelatedRecordList
        title={tGd("customerHistory")}
        entity={null}
        emptyText={tGd("noCustomerHistory")}
        onOpen={() => {}}
        onOpenRow={(id) => navigate({ kind: "inventory-goods-dispatch", id })}
        items={(data.recentGoodsDispatches ?? []).map((d) => ({
          id: d.id,
          icon: PackageOpen,
          primary: d.reference,
          secondary: d.customerNameAtDispatch || undefined,
          trailing: `${tGd("totalDispatched")}: ${d.totalDispatchedQty}`,
          trailingMuted: d.postedAt
            ? fmtDate(business, d.postedAt)
            : tGd(`status_${d.status}`),
        }))}
      />

      {/* Prompt 45 (§71) — bounded sales-order history (≤10). Commercial
          commitments — NOT financial rows; rows deep-link to the order
          document (#/sales-orders/<id>). Quantity facts use the canonical
          POSTED-only fulfillment aggregate. */}
      <RelatedRecordList
        title={tSo("orderHistory")}
        entity={null}
        emptyText={tSo("noOrderHistory")}
        onOpen={() => {}}
        onOpenRow={(id) => navigate({ kind: "sales-order", id })}
        items={(data.recentSalesOrders ?? []).map((o) => ({
          id: o.id,
          icon: ShoppingCart,
          primary: o.reference,
          secondary: tSo(`status_${o.status}`),
          trailing: tSo("progressLabel", {
            dispatched: o.dispatchedQty,
            ordered: o.orderedQty,
          }),
          trailingMuted:
            typeof o.invoiceNumber === "number"
              ? `INV-${String(o.invoiceNumber).padStart(4, "0")}`
              : null,
        }))}
      />

      {/* Prompt 47 (§19) — bounded quotation history (≤10). Commercial
          OFFERS — not orders, not invoices, not stock events (§1/§19):
          a SENT offer is not a confirmed order and an ACCEPTED offer is
          not yet a converted SalesOrder. Converted rows carry the exact
          originating order reference. Rows deep-link to the quotation
          document (#/sales-quotations/<id>). */}
      <RelatedRecordList
        title={tSq("quotationHistory")}
        entity={null}
        emptyText={tSq("noQuotationHistory")}
        onOpen={() => {}}
        onOpenRow={(id) => navigate({ kind: "sales-quotation", id })}
        items={(data.recentSalesQuotations ?? []).map((qt) => ({
          id: qt.id,
          icon: FileSignature,
          primary: qt.reference,
          secondary: tSq(`status_${qt.effectiveStatus}`),
          trailing: fmtMoney(business, qt.totalMinor),
          trailingMuted: qt.convertedOrderReference ?? undefined,
        }))}
      />

      {/* Prompt 35 (§44/§45) — CRM PIPELINE section: visually SEPARATE from
          the financial summary above (different heading, forecast labels).
          Clicking an opportunity opens its exact detail (§44). */}
      <section aria-label={t("crmSection")} className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold tracking-wide uppercase">{t("crmSection")}</h2>
          <span className="text-muted-foreground text-xs">
            {t("crmOpenCount", { count: data.crm.openOpportunityCount })}
          </span>
        </div>
        {data.crm.recentOpportunities.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
            {t("crmEmpty")}
          </p>
        ) : (
          <RelatedRecordList
            title={t("crmSection")}
            entity="opportunity"
            emptyText={t("crmEmpty")}
            onOpen={navigateToEntity}
            items={data.crm.recentOpportunities.map((o) => ({
              id: o.id,
              icon: TrendingUp,
              primary: o.title,
              secondary: o.expectedCloseDate ? fmtDate(business, o.expectedCloseDate) : undefined,
              trailing: fmtMoney(business, o.expectedValueMinor),
              trailingMuted: `${o.probabilityPct}%`,
              badge: <StageBadge stage={o.stage} />,
            }))}
          />
        )}
        {data.crm.leadOrigin ? (
          <RelatedRecordList
            title={t("crmLeadOrigin")}
            entity="lead"
            emptyText=""
            onOpen={navigateToEntity}
            items={[
              {
                id: data.crm.leadOrigin.id,
                icon: UserRound,
                primary: data.crm.leadOrigin.name,
                secondary: data.crm.leadOrigin.convertedAt
                  ? fmtDate(business, data.crm.leadOrigin.convertedAt)
                  : undefined,
              },
            ]}
          />
        ) : null}
      </section>

      {/* Prompt 36 (§49/§129) — CRM TIMELINE below the CRM pipeline section:
          activities + active tasks for this customer, with Add activity /
          Create task CTAs. Financial cards above stay untouched (§49). */}
      <CrmTimelineCard
        contextType="CUSTOMER"
        contextId={c.id}
        contextTitle={c.name}
        business={business}
        writable={writable}
      />

      <PartyFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        kind="customer"
        editing={c}
      />

      {/* New invoice — REUSES the shared SaleFormDialog (§75, one flow)
          with this customer pre-selected; success refreshes the 360. */}
      <SaleFormDialog
        open={newInvoiceOpen}
        onOpenChange={setNewInvoiceOpen}
        business={business}
        presetCustomer={{ id: c.id, name: c.name }}
        onCreated={() => {
          invalidateEntityDetail(queryClient, businessId, "customer", c.id);
          invalidateCrmAfterMutation(queryClient, businessId);
        }}
      />
    </div>
  );
}

export function InfoRow({
  label,
  value,
  ltr,
}: {
  label: string;
  value: string | null;
  ltr?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</p>
      {value ? (
        <p className="text-sm break-words" dir={ltr ? "ltr" : "auto"}>
          {value}
        </p>
      ) : (
        <p className="text-muted-foreground text-sm">—</p>
      )}
    </div>
  );
}
