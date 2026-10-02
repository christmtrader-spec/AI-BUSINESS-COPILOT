"use client";

/**
 * Prompt 35 — Lead detail view (§41).
 *
 * Sections: header (status badge + actions) → summary metrics (open
 * opportunities, total opportunities, conversion state) → contact card →
 * related opportunities (bounded ≤10, server-bounded). Delete is CRM-only
 * soft delete — a converted lead's customer is NEVER touched (§68).
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { CalendarClock, CheckCircle2, Pencil, Repeat2, Target, Trash2, TrendingUp, UserRound } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import type { Role } from "@/lib/rbac";
import { can } from "@/lib/rbac";
import { useAppStore } from "@/store/app-store";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fmtCount, fmtDate } from "../finance-shared/finance-kit";
import type { BusinessSummary } from "../shell/types";
import { invalidateEntityDetail } from "./entity-api";
import { EntityHeader, EntityBreadcrumb, EntityTypeBadge } from "./entity-header";
import { EntityMetricCard } from "./entity-metric-card";
import { EntityDeleteDialog } from "./entity-delete-dialog";
import { RelatedRecordList } from "./related-record-list";
import { navigateToEntity, navigateToEntityList } from "./entity-route";
import { LeadFormDialog } from "../crm/lead-form-dialog";
import { LeadConvertDialog } from "../crm/lead-convert-dialog";
import { LeadStatusDialog } from "../crm/lead-status-dialog";
import { LeadStatusBadge } from "../crm/crm-badges";
import { invalidateCrmAfterMutation } from "../crm/crm-api";
import { CrmTimelineCard, CrmActiveTasksCard } from "../crm/crm-timeline";
import type { LeadDetail } from "@/lib/crm";

export function LeadDetailView({
  data,
  business,
  uiLocale,
  role,
}: {
  data: LeadDetail;
  business: BusinessSummary;
  uiLocale: string;
  role: Role;
}) {
  const t = useTranslations("crm.lead.detail");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const queryClient = useQueryClient();
  const businessId = useAppStore((s) => s.activeBusinessId);
  const navigate = useAppStore((s) => s.navigate);

  const writable = can(role, "data:write");
  const [editOpen, setEditOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);

  const invalidate = () => {
    invalidateCrmAfterMutation(queryClient, businessId, { customers: true });
    invalidateEntityDetail(queryClient, businessId, "lead", data.id);
  };

  const deleteMutation = useMutation({
    mutationFn: async () => api(`/api/v1/crm/leads/${encodeURIComponent(data.id)}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: t("deletedToast") });
      invalidateCrmAfterMutation(queryClient, businessId, { customers: true });
      navigateToEntityList("lead");
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  const convertible = data.status !== "CONVERTED" && data.status !== "DISQUALIFIED";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <EntityBreadcrumb listLabel={t("backTarget")} title={data.name} />
        <EntityHeader
          icon={UserRound}
          avatarInitials={data.name.slice(0, 2).toUpperCase()}
          title={data.name}
          subtitle={data.companyName ?? data.phone ?? data.email ?? null}
          badge={<LeadStatusBadge status={data.status} />}
          backLabel={t("backTo")}
          onBack={() => navigateToEntityList("lead")}
          actions={
            writable ? (
              <>
                {convertible ? (
                  <Button variant="outline" size="sm" onClick={() => setConvertOpen(true)}>
                    <Repeat2 className="size-4" aria-hidden="true" />
                    {t("convert")}
                  </Button>
                ) : null}
                {convertible ? (
                  <Button variant="outline" size="sm" onClick={() => setStatusOpen(true)}>
                    <CalendarClock className="size-4" aria-hidden="true" />
                    {t("changeStatus")}
                  </Button>
                ) : null}
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

      {/* Summary metrics (§41) — status + open opportunities + conversion state */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <EntityMetricCard
          label={t("statusLabel")}
          value={tStatusText(data.status)}
          icon={Target}
        />
        <EntityMetricCard
          label={t("openOpportunities")}
          value={fmtCount(uiLocale, data.openOpportunityCount)}
          icon={TrendingUp}
        />
        <EntityMetricCard
          label={t("totalOpportunities")}
          value={fmtCount(uiLocale, data.opportunityCount)}
          icon={Target}
        />
        <EntityMetricCard
          label={t("conversion")}
          value={data.status === "CONVERTED" ? t("convertedYes") : t("convertedNo")}
          icon={CheckCircle2}
          tone={data.status === "CONVERTED" ? "positive" : "default"}
          hint={data.convertedAt ? fmtDate(business, data.convertedAt) : undefined}
        />
      </div>

      {/* Contact card */}
      <Card>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
          <div className="flex flex-col gap-3">
            <InfoRow label={t("company")} value={data.companyName} />
            <InfoRow label={t("phone")} value={data.phone} ltr />
            <InfoRow label={t("email")} value={data.email} ltr />
          </div>
          <div className="flex flex-col gap-3">
            <InfoRow label={t("sourceLabel")} value={tSourceText(data.source)} />
            <InfoRow label={t("sourceDetail")} value={data.sourceDetail} />
            <InfoRow
              label={t("assignedTo")}
              value={data.assignedTo ? (data.assignedTo.name ?? data.assignedTo.email) : null}
            />
            <InfoRow label={t("note")} value={data.note} />
          </div>
        </CardContent>
      </Card>

      {/* Converted → link to the resulting customer (§41) */}
      {data.customer ? (
        <RelatedRecordList
          title={t("customerTitle")}
          entity="customer"
          emptyText=""
          onOpen={navigateToEntity}
          items={[
            {
              id: data.customer.id,
              icon: CheckCircle2,
              primary: data.customer.name,
              secondary: data.customer.phone ?? data.customer.email ?? undefined,
              badge: <EntityTypeBadge label={t("convertedYes")} />,
            },
          ]}
        />
      ) : null}

      {/* Related opportunities (§41 — server-bounded ≤10) */}
      <RelatedRecordList
        title={t("opportunitiesTitle")}
        entity="opportunity"
        emptyText={t("noOpportunities")}
        onOpen={navigateToEntity}
        items={data.recentOpportunities.map((o) => ({
          id: o.id,
          icon: TrendingUp,
          primary: o.title,
          secondary: o.expectedCloseDate ? fmtDate(business, o.expectedCloseDate) : undefined,
          trailing: `${o.probabilityPct}%`,
        }))}
      />

      {/* Prompt 36 (§38/§50) — Timeline + Tasks sections. Historical context
          is preserved after conversion (§105): existing lead activities stay
          attached to the lead. Financially non-interfering (§102). */}
      <CrmTimelineCard
        contextType="LEAD"
        contextId={data.id}
        contextTitle={data.name}
        business={business}
        writable={writable}
      />
      <CrmActiveTasksCard
        contextType="LEAD"
        contextId={data.id}
        business={business}
        writable={writable}
      />

      <LeadFormDialog open={editOpen} onOpenChange={setEditOpen} editing={data} />
      <LeadConvertDialog
        open={convertOpen}
        onOpenChange={setConvertOpen}
        lead={data}
        customers={[]}
        onConverted={(customerId) =>
          navigate({ kind: "entity", entity: "customer", id: customerId })
        }
      />
      <LeadStatusDialog
        open={statusOpen}
        onOpenChange={setStatusOpen}
        lead={data}
        onSaved={invalidate}
      />

      <p className="sr-only">{tCommon("appName")}</p>
    </div>
  );

  function tStatusText(status: LeadDetail["status"]): string {
    const map: Record<LeadDetail["status"], string> = {
      NEW: t("status.NEW"),
      CONTACTED: t("status.CONTACTED"),
      QUALIFIED: t("status.QUALIFIED"),
      DISQUALIFIED: t("status.DISQUALIFIED"),
      CONVERTED: t("status.CONVERTED"),
    };
    return map[status];
  }

  function tSourceText(source: LeadDetail["source"]): string {
    const map: Record<LeadDetail["source"], string> = {
      MANUAL: t("source.MANUAL"),
      REFERRAL: t("source.REFERRAL"),
      WEBSITE: t("source.WEBSITE"),
      SOCIAL: t("source.SOCIAL"),
      PARTNER: t("source.PARTNER"),
      IMPORT: t("source.IMPORT"),
      OTHER: t("source.OTHER"),
    };
    return map[source];
  }
}

function InfoRow({
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
