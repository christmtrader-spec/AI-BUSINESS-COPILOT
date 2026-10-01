"use client";

/**
 * Prompt 35 — leads table (§53/§62/§64).
 *
 * Server-side search + filters + pagination (§62/§63 — never client-only
 * filtering). Row click navigates to the lead detail deep link through the
 * centralized entity helpers (§39/§47); in-row buttons never hijack row
 * navigation (Prompt 34 INTERACTIVE_ROW_SELECTOR law).
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Pencil, Plus, Repeat2, Search, Trash2 } from "lucide-react";
import { DataTable, DataTableToolbar } from "@/components/shared/data-table";
import { Pagination } from "@/components/shared/table-kit";
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
import { LEAD_STATUSES, type LeadDTO, type LeadListResponse } from "@/lib/crm/types";
import { useCrmLeads, useLeadMutations } from "./crm-api";
import { LeadStatusBadge } from "./crm-badges";
import { LeadFormDialog } from "./lead-form-dialog";
import { LeadConvertDialog } from "./lead-convert-dialog";
import { navigateToEntity } from "../entities/entity-route";
import { EntityDeleteDialog } from "../entities/entity-delete-dialog";
import { fmtDate } from "../finance-shared/finance-kit";

const PAGE_SIZE = 25;

/** Closed source label map (no dynamic-key casts at call sites). */
function LeadSourceLabel({ source }: { source: LeadDTO["source"] }) {
  const tSource = useTranslations("crm.lead.source");
  const map: Record<LeadDTO["source"], string> = {
    MANUAL: tSource("MANUAL"),
    REFERRAL: tSource("REFERRAL"),
    WEBSITE: tSource("WEBSITE"),
    SOCIAL: tSource("SOCIAL"),
    PARTNER: tSource("PARTNER"),
    IMPORT: tSource("IMPORT"),
    OTHER: tSource("OTHER"),
  };
  return <>{map[source]}</>;
}

function LeadRowActions({
  row,
  writable,
  onEdit,
  onConvert,
}: {
  row: LeadDTO;
  writable: boolean;
  onEdit: (row: LeadDTO) => void;
  onConvert: (row: LeadDTO) => void;
}) {
  const t = useTranslations("crm.lead");
  const tCommon = useTranslations("common");
  const { remove } = useLeadMutations();
  if (!writable) return null;
  return (
    <div className="flex items-center justify-end gap-1" data-no-row-nav>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label={t("convertAction")}
        title={t("convertAction")}
        disabled={row.status === "CONVERTED" || row.status === "DISQUALIFIED"}
        onClick={(e) => {
          e.stopPropagation();
          onConvert(row);
        }}
      >
        <Repeat2 className="size-4" aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        aria-label={tCommon("edit")}
        onClick={(e) => {
          e.stopPropagation();
          onEdit(row);
        }}
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
        onConfirm={() => {
          remove.mutate(row.id, {
            onSuccess: () => {
              // Toast is handled by the delete dialog contract; nothing else.
            },
          });
        }}
      />
    </div>
  );
}

export function LeadsTable({
  business,
  role,
  customers,
}: {
  business: BusinessSummary;
  role: Role;
  customers: { id: string; name: string }[];
}) {
  const t = useTranslations("crm.lead");
  const tCommon = useTranslations("common");
  const writable = can(role, "data:write");

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<LeadDTO | null>(null);
  const [convertTarget, setConvertTarget] = useState<LeadDTO | null>(null);

  const query = useCrmLeads({ q, status, page, pageSize: PAGE_SIZE });
  const data: LeadListResponse | undefined = query.data;

  const columns = [
    {
      id: "name",
      header: t("colName"),
      cell: (row: LeadDTO) => <span className="font-medium">{row.name}</span>,
      sortValue: (row: LeadDTO) => row.name,
    },
    {
      id: "company",
      header: t("colCompany"),
      cell: (row: LeadDTO) => row.companyName ?? "—",
      hideBelow: "md" as const,
    },
    {
      id: "status",
      header: t("colStatus"),
      cell: (row: LeadDTO) => <LeadStatusBadge status={row.status} />,
    },
    {
      id: "source",
      header: t("colSource"),
      cell: (row: LeadDTO) => <LeadSourceLabel source={row.source} />,
      hideBelow: "md" as const,
    },
    {
      id: "assigned",
      header: t("colAssigned"),
      cell: (row: LeadDTO) => row.assignedTo?.name ?? row.assignedTo?.email ?? "—",
      hideBelow: "lg" as const,
    },
    {
      id: "created",
      header: t("colCreated"),
      cell: (row: LeadDTO) => fmtDate(business, row.createdAt),
      hideBelow: "lg" as const,
    },
    {
      id: "actions",
      header: tCommon("actions"),
      align: "end" as const,
      cell: (row: LeadDTO) => (
        <LeadRowActions
          row={row}
          writable={writable}
          onEdit={(r) => {
            setEditing(r);
            setFormOpen(true);
          }}
          onConvert={(r) => setConvertTarget(r)}
        />
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <DataTableToolbar>
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
        <Select
          value={status ?? "all"}
          onValueChange={(v) => {
            setPage(1);
            setStatus(v === "all" ? null : v);
          }}
        >
          <SelectTrigger className="w-full sm:w-44" aria-label={t("statusFilter")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("allStatuses")}</SelectItem>
            {LEAD_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {t(`status.${s}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {writable ? (
          <Button
            className="sm:ms-auto"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus className="size-4" aria-hidden="true" />
            {t("addLead")}
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
            writable ? (
              <Button
                onClick={() => {
                  setEditing(null);
                  setFormOpen(true);
                }}
              >
                <Plus className="size-4" aria-hidden="true" />
                {t("addLead")}
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
            onRowClick={(row) => navigateToEntity("lead", row.id)}
          />
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            onPage={setPage}
          />
        </>
      ) : null}

      <LeadFormDialog open={formOpen} onOpenChange={setFormOpen} editing={editing} />
      <LeadConvertDialog
        open={convertTarget !== null}
        onOpenChange={(v) => {
          if (!v) setConvertTarget(null);
        }}
        lead={convertTarget}
        customers={customers}
      />
    </div>
  );
}
