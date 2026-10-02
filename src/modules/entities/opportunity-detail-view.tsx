"use client";

/**
 * Prompt 35 — Opportunity detail view (§42/§43/§70/§135/§138).
 *
 * Summary cards: Stage / Probability / Expected value / Weighted value —
 * the money labels are ALWAYS "Expected"/"Weighted" forecast language
 * (never revenue, §135). Actions: Edit · Move stage · Delete · and ONLY
 * for a WON opportunity with a linked customer: "New invoice" reusing the
 * EXISTING SaleFormDialog (§70/§138 — one invoice flow, explicit user
 * action, no automatic Sale on WON, §33).
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  CalendarClock,
  Handshake,
  Pencil,
  Percent,
  ReceiptText,
  ShoppingCart,
  Trash2,
  TrendingUp,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import type { Role } from "@/lib/rbac";
import { can } from "@/lib/rbac";
import { useAppStore } from "@/store/app-store";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fmtDate, fmtMoney } from "../finance-shared/finance-kit";
import type { BusinessSummary } from "../shell/types";
import { invalidateEntityDetail } from "./entity-api";
import { EntityHeader, EntityBreadcrumb, EntityTypeBadge } from "./entity-header";
import { EntityMetricCard } from "./entity-metric-card";
import { EntityDeleteDialog } from "./entity-delete-dialog";
import { RelatedRecordList } from "./related-record-list";
import { navigateToEntity, navigateToEntityList } from "./entity-route";
import { OpportunityFormDialog } from "../crm/opportunity-form-dialog";
import { OpportunityStageDialog } from "../crm/opportunity-stage-dialog";
import { StageBadge } from "../crm/crm-badges";
import { invalidateCrmAfterMutation } from "../crm/crm-api";
import { CrmTimelineCard, CrmActiveTasksCard } from "../crm/crm-timeline";
import { SaleFormDialog } from "../sales/sale-form-dialog";
import type { OpportunityDetail } from "@/lib/crm";

export function OpportunityDetailView({
  data,
  business,
  uiLocale,
  role,
}: {
  data: OpportunityDetail;
  business: BusinessSummary;
  uiLocale: string;
  role: Role;
}) {
  const t = useTranslations("crm.opportunity.detail");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const queryClient = useQueryClient();
  const businessId = useAppStore((s) => s.activeBusinessId);
  const navigate = useAppStore((s) => s.navigate);

  const writable = can(role, "data:write");
  const [editOpen, setEditOpen] = useState(false);
  const [stageOpen, setStageOpen] = useState(false);
  const [invoiceOpen, setInvoiceOpen] = useState(false);

  const invalidate = () => {
    invalidateCrmAfterMutation(queryClient, businessId, { customers: true });
    invalidateEntityDetail(queryClient, businessId, "opportunity", data.id);
  };

  const deleteMutation = useMutation({
    mutationFn: async () =>
      api(`/api/v1/crm/opportunities/${encodeURIComponent(data.id)}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: t("deletedToast") });
      invalidateCrmAfterMutation(queryClient, businessId, { customers: true });
      navigateToEntityList("opportunity");
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  const wonWithCustomer = data.stage === "WON" && data.customer !== null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <EntityBreadcrumb listLabel={t("backTarget")} title={data.title} />
        <EntityHeader
          icon={TrendingUp}
          title={data.title}
          subtitle={data.customer?.name ?? data.lead?.name ?? null}
          badge={<StageBadge stage={data.stage} />}
          backLabel={t("backTo")}
          onBack={() => navigateToEntityList("opportunity")}
          actions={
            writable ? (
              <>
                {wonWithCustomer ? (
                  <Button variant="outline" size="sm" onClick={() => setInvoiceOpen(true)}>
                    <ShoppingCart className="size-4" aria-hidden="true" />
                    {t("newInvoice")}
                  </Button>
                ) : null}
                <Button variant="outline" size="sm" onClick={() => setStageOpen(true)}>
                  <CalendarClock className="size-4" aria-hidden="true" />
                  {t("moveStage")}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                  <Pencil className="size-4" aria-hidden="true" />
                  {tCommon("edit")}
                </Button>
                <EntityDeleteDialog
                  triggerLabel={tCommon("delete")}
                  triggerIcon={Trash2}
                  title={t("deleteTitle")}
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

      {/* §42 — Stage/Probability/Expected/Weighted. FORECAST language only. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <EntityMetricCard
          label={t("stageLabel")}
          value={stageText(data.stage)}
          icon={Handshake}
        />
        <EntityMetricCard
          label={t("probability")}
          value={`${data.probabilityPct}%`}
          icon={Percent}
        />
        <EntityMetricCard
          label={t("expectedValue")}
          value={fmtMoney(business, data.expectedValueMinor)}
          hint={t("forecastNote")}
          icon={TrendingUp}
        />
        <EntityMetricCard
          label={t("weightedValue")}
          value={fmtMoney(business, data.weightedValueMinor)}
          hint={t("weightedNote")}
          icon={TrendingUp}
        />
      </div>

      {/* Detail card */}
      <Card>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
          <div className="flex flex-col gap-3">
            <InfoRow
              label={t("customer")}
              value={data.customer?.name ?? null}
              link={
                data.customer
                  ? () => navigateToEntity("customer", data.customer!.id)
                  : undefined
              }
            />
            <InfoRow
              label={t("lead")}
              value={data.lead?.name ?? null}
              link={data.lead ? () => navigateToEntity("lead", data.lead!.id) : undefined}
            />
            <InfoRow
              label={t("expectedClose")}
              value={data.expectedCloseDate ? fmtDate(business, data.expectedCloseDate) : null}
            />
            <InfoRow
              label={t("assignedTo")}
              value={
                data.assignedTo
                  ? (data.assignedTo.name ?? data.assignedTo.email)
                  : null
              }
            />
          </div>
          <div className="flex flex-col gap-3">
            <InfoRow label={t("description")} value={data.description} />
            {data.stage === "LOST" ? (
              <InfoRow label={t("lostReason")} value={data.lostReason} />
            ) : null}
            {data.wonAt ? (
              <InfoRow label={t("wonAt")} value={fmtDate(business, data.wonAt)} />
            ) : null}
            {data.lostAt ? (
              <InfoRow label={t("lostAt")} value={fmtDate(business, data.lostAt)} />
            ) : null}
            <InfoRow label={t("currency")} value={data.currencyCode} ltr />
          </div>
        </CardContent>
      </Card>

      {/* §138 — invoice creation via the ONE existing dialog; targeted
          invalidations after successful sale creation. */}
      {wonWithCustomer && data.customer ? (
        <RelatedRecordList
          title={t("invoiceCtaTitle")}
          entity="customer"
          emptyText=""
          onOpen={navigateToEntity}
          items={[
            {
              id: data.customer.id,
              icon: ReceiptText,
              primary: data.customer.name,
              secondary: undefined,
              badge: <EntityTypeBadge label={t("wonBadge")} />,
            },
          ]}
        />
      ) : null}

      {/* Prompt 36 (§39/§51) — Timeline + Tasks. Winning the opportunity
          creates NO automatic activity/task/notification (§106). */}
      <CrmTimelineCard
        contextType="OPPORTUNITY"
        contextId={data.id}
        contextTitle={data.title}
        business={business}
        writable={writable}
      />
      <CrmActiveTasksCard
        contextType="OPPORTUNITY"
        contextId={data.id}
        business={business}
        writable={writable}
      />

      <OpportunityFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        editing={data}
        business={business}
        customers={
          data.customer
            ? [{ id: data.customer.id, name: data.customer.name }]
            : []
        }
        leads={data.lead ? [{ id: data.lead.id, name: data.lead.name }] : []}
      />
      <OpportunityStageDialog
        open={stageOpen}
        onOpenChange={setStageOpen}
        opportunity={data}
        onSaved={invalidate}
      />

      {wonWithCustomer && data.customer ? (
        <SaleFormDialogLazy
          open={invoiceOpen}
          onOpenChange={setInvoiceOpen}
          business={business}
          customerId={data.customer.id}
          customerName={data.customer.name}
          onCreated={invalidate}
        />
      ) : null}

    </div>
  );

  function stageText(stage: OpportunityDetail["stage"]): string {
    const map: Record<OpportunityDetail["stage"], string> = {
      DISCOVERY: t("stage.DISCOVERY"),
      QUALIFIED: t("stage.QUALIFIED"),
      PROPOSAL: t("stage.PROPOSAL"),
      NEGOTIATION: t("stage.NEGOTIATION"),
      WON: t("stage.WON"),
      LOST: t("stage.LOST"),
    };
    return map[stage];
  }
}

function SaleFormDialogLazy({
  open,
  onOpenChange,
  business,
  customerId,
  customerName,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  business: BusinessSummary;
  customerId: string;
  customerName: string;
  onCreated: () => void;
}) {
  return (
    <SaleFormDialog
      open={open}
      onOpenChange={onOpenChange}
      business={business}
      presetCustomer={{ id: customerId, name: customerName }}
      onCreated={onCreated}
    />
  );
}

function InfoRow({
  label,
  value,
  link,
  ltr,
}: {
  label: string;
  value: string | null;
  link?: () => void;
  ltr?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</p>
      {value ? (
        link ? (
          <button
            type="button"
            onClick={link}
            className="text-start text-sm break-words underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {value}
          </button>
        ) : (
          <p className="text-sm break-words" dir={ltr ? "ltr" : "auto"}>
            {value}
          </p>
        )
      ) : (
        <p className="text-muted-foreground text-sm">—</p>
      )}
    </div>
  );
}
