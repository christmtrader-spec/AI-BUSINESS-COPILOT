"use client";

/**
 * Prompt 35 — opportunities table (§53/§62/§64).
 *
 * Server-side filters + pagination. Expected value is FORECAST-labeled
 * (§12/§135). Row click → #/opportunities/<id> via the centralized helpers.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { DataTable, DataTableToolbar } from "@/components/shared/data-table";
import { Pagination } from "@/components/shared/table-kit";
import { ListExportButton } from "@/components/shared/list-export-button";
import { fetchAllPages } from "@/lib/csv";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/primitives";
import type { BusinessSummary } from "../shell/types";
import type { Role } from "@/lib/rbac";
import { can } from "@/lib/rbac";
import { OPPORTUNITY_STAGES, type OpportunityDTO, type OpportunityListResponse } from "@/lib/crm/types";
import { useCrmOpportunities, useOpportunityMutations } from "./crm-api";
import { StageBadge } from "./crm-badges";
import { OpportunityFormDialog } from "./opportunity-form-dialog";
import { OpportunityStageDialog } from "./opportunity-stage-dialog";
import { navigateToEntity } from "../entities/entity-route";
import { EntityDeleteDialog } from "../entities/entity-delete-dialog";
import { fmtDate, fmtMoney } from "../finance-shared/finance-kit";

const PAGE_SIZE = 25;

function StageLabel({ stage }: { stage: OpportunityDTO["stage"] }) {
  const tStage = useTranslations("crm.opportunity.stage");
  const map: Record<OpportunityDTO["stage"], string> = {
    DISCOVERY: tStage("DISCOVERY"),
    QUALIFIED: tStage("QUALIFIED"),
    PROPOSAL: tStage("PROPOSAL"),
    NEGOTIATION: tStage("NEGOTIATION"),
    WON: tStage("WON"),
    LOST: tStage("LOST"),
  };
  return <>{map[stage]}</>;
}

export function OpportunitiesTable({
  business,
  role,
  customers,
  leads,
  customerIdFilter,
}: {
  business: BusinessSummary;
  role: Role;
  customers: { id: string; name: string }[];
  leads: { id: string; name: string }[];
  /** Fixed customer filter (Customer 360 reuse, §44). */
  customerIdFilter?: string | null;
}) {
  const t = useTranslations("crm.opportunity");
  const tStage = useTranslations("crm.opportunity.stage");
  const tCommon = useTranslations("common");
  const writable = can(role, "data:write");

  const [q, setQ] = useState("");
  const [stage, setStage] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<OpportunityDTO | null>(null);
  const [stageTarget, setStageTarget] = useState<OpportunityDTO | null>(null);
  const { remove } = useOpportunityMutations();

  const query = useCrmOpportunities({ q, stage, customerId: customerIdFilter ?? null, page, pageSize: PAGE_SIZE });
  const data: OpportunityListResponse | undefined = query.data;

  const columns = [
    {
      id: "title",
      header: t("colTitle"),
      cell: (row: OpportunityDTO) => <span className="font-medium">{row.title}</span>,
      sortValue: (row: OpportunityDTO) => row.title,
    },
    {
      id: "customer",
      header: t("colCustomer"),
      cell: (row: OpportunityDTO) => row.customer?.name ?? row.lead?.name ?? "—",
    },
    {
      id: "stage",
      header: t("colStage"),
      cell: (row: OpportunityDTO) => <StageBadge stage={row.stage} />,
    },
    {
      id: "probability",
      header: t("colProbability"),
      align: "end" as const,
      cell: (row: OpportunityDTO) => (
        <span dir="ltr" className="tabular-nums">
          {row.probabilityPct}%
        </span>
      ),
      hideBelow: "md" as const,
    },
    {
      id: "value",
      header: t("colExpectedValue"),
      align: "end" as const,
      cell: (row: OpportunityDTO) => fmtMoney(business, row.expectedValueMinor),
    },
    {
      id: "close",
      header: t("colExpectedClose"),
      cell: (row: OpportunityDTO) =>
        row.expectedCloseDate ? fmtDate(business, row.expectedCloseDate) : "—",
      hideBelow: "lg" as const,
    },
    {
      id: "assigned",
      header: t("colAssigned"),
      cell: (row: OpportunityDTO) => row.assignedTo?.name ?? row.assignedTo?.email ?? "—",
      hideBelow: "lg" as const,
    },
    {
      id: "actions",
      header: tCommon("actions"),
      align: "end" as const,
      cell: (row: OpportunityDTO) =>
        writable ? (
          <div className="flex items-center justify-end gap-1" data-no-row-nav>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={(e) => {
                e.stopPropagation();
                setStageTarget(row);
              }}
              aria-label={t("moveStage")}
              title={t("moveStage")}
            >
              <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 9l-3 3 3 3M9 5l3-3 3 3M9 19l3 3 3-3M19 9l3 3-3 3M2 12h20M12 2v20" />
              </svg>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={(e) => {
                e.stopPropagation();
                setEditing(row);
                setFormOpen(true);
              }}
              aria-label={tCommon("edit")}
            >
              <Pencil className="size-4" aria-hidden="true" />
            </Button>
            <EntityDeleteDialog
              triggerLabel={tCommon("delete")}
              triggerIcon={Trash2}
              title={t("deleteTitle")}
              description={t("deleteDesc")}
              confirmLabel={tCommon("delete")}
              cancelLabel={tCommon("cancel")}
              pending={remove.isPending}
              onConfirm={() => remove.mutate(row.id)}
            />
          </div>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <DataTableToolbar>
        <ListExportButton<OpportunityDTO>
          filename="crm-opportunities"
          columns={[
            { header: t("colTitle"), value: (row) => row.title },
            {
              header: t("colCustomer"),
              value: (row) => row.customer?.name ?? row.lead?.name ?? "",
            },
            { header: t("colStage"), value: (row) => tStage(row.stage) },
            { header: t("colProbability"), value: (row) => row.probabilityPct },
            {
              header: t("colExpectedValue"),
              value: (row) => row.expectedValueMinor / 10 ** business.decimalPrecision,
            },
            { header: t("colExpectedClose"), value: (row) => row.expectedCloseDate },
            {
              header: t("colAssigned"),
              value: (row) => row.assignedTo?.name ?? row.assignedTo?.email ?? "",
            },
          ]}
          fetchRows={() =>
            fetchAllPages<OpportunityDTO>((pg, ps) => {
              const search = new URLSearchParams({ page: String(pg), pageSize: String(ps) });
              if (q) search.set("q", q);
              if (stage) search.set("stage", stage);
              if (customerIdFilter) search.set("customerId", customerIdFilter);
              return api<OpportunityListResponse>(`/api/v1/crm/opportunities?${search.toString()}`);
            })
          }
        />
        <div className="relative w-full sm:max-w-xs">
          <Search
            className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2"
            aria-hidden="true"
          />
          <Input
            value={q}
            onChange={(e) => {
              setPage(1);
              setQ(e.target.value);
            }}
            placeholder={t("searchPlaceholder")}
            className="ps-8"
            maxLength={64}
            type="search"
            aria-label={t("searchPlaceholder")}
          />
        </div>
        {!customerIdFilter ? (
          <Select
            value={stage ?? "all"}
            onValueChange={(v) => {
              setPage(1);
              setStage(v === "all" ? null : v);
            }}
          >
            <SelectTrigger className="w-full sm:w-44" aria-label={t("stageFilter")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("allStages")}</SelectItem>
              {OPPORTUNITY_STAGES.map((s) => (
                <SelectItem key={s} value={s}>
                  <StageLabel stage={s} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {writable && !customerIdFilter ? (
          <Button
            className="sm:ms-auto"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus className="size-4" aria-hidden="true" />
            {t("addOpportunity")}
          </Button>
        ) : null}
      </DataTableToolbar>

      {query.isPending ? (
        <DataTable
          columns={columns}
          rows={[]}
          getRowId={(r) => r.id}
          loading
          skeletonRows={5}
          ariaLabel={t("title")}
        />
      ) : query.isError ? (
        <EmptyState icon={Search} title={t("emptyTitle")} />
      ) : (data?.items.length ?? 0) === 0 ? (
        <EmptyState
          icon={Search}
          title={t("emptyTitle")}
          description={t("emptyDesc")}
          action={
            writable && !customerIdFilter ? (
              <Button
                onClick={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
              >
                <Plus className="size-4" aria-hidden="true" />
                {t("addOpportunity")}
              </Button>
            ) : undefined
          }
        />
      ) : data ? (
        <>
          <DataTable
            columns={columns}
            rows={data.items}
            getRowId={(r) => r.id}
            ariaLabel={t("title")}
            refreshing={query.isFetching}
            onRowClick={(row) => navigateToEntity("opportunity", row.id)}
          />
          {data.total > data.pageSize && !customerIdFilter ? (
            <Pagination
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              onPage={setPage}
            />
          ) : null}
        </>
      ) : null}

      <OpportunityFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        editing={editing}
        business={business}
        customers={customers}
        leads={leads}
      />
      <OpportunityStageDialog
        open={stageTarget !== null}
        onOpenChange={(v) => {
          if (!v) setStageTarget(null);
        }}
        opportunity={stageTarget}
      />
    </div>
  );
}
