"use client";

/**
 * Prompt 47 — sales-quotation list view (§17).
 * Columns: Reference · Status (effective) · Customer · Valid until ·
 * Lines · Total · Converted order · Created. Filters (server-side):
 * status, search, quotation-date range, customerId. Pagination default
 * 25, max 100. Rows navigate to the detail deep link
 * #/sales-quotations/<id>. The badge shows the EFFECTIVE status (a SENT
 * offer past validity renders as EXPIRED — §9); the Total column renders
 * integer minor units in the business-configured currency (display-only).
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ChevronRight, FileText, Plus } from "lucide-react";
import { can, type Role } from "@/lib/rbac";
import { ApiClientError } from "@/lib/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable } from "@/components/shared/data-table";
import { EmptyState, PageHeader } from "@/components/shared/primitives";
import { Pagination, SearchInput } from "@/components/shared/table-kit";
import { ListExportButton } from "@/components/shared/list-export-button";
import { fetchAllPages } from "@/lib/csv";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app-store";
import { fmtMoney } from "../finance-shared/finance-kit";
import type { BusinessSummary } from "../shell/types";
import type { SalesQuotationListItem } from "./sales-quotations-api";
import type { SalesQuotationStatus } from "@/lib/sales-quotations/types";
import { fetchSalesQuotations, salesQuotationKeys } from "./sales-quotations-api";
import { SalesQuotationCreateDialog } from "./sales-quotation-create-dialog";

const STATUS_FILTERS: Array<SalesQuotationStatus | "ALL"> = [
  "ALL",
  "DRAFT",
  "SENT",
  "ACCEPTED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
  "CONVERTED",
];

export function statusBadgeStyles(status: SalesQuotationStatus): string {
  const styles: Record<SalesQuotationStatus, string> = {
    DRAFT: "bg-muted text-muted-foreground border-border",
    SENT: "bg-sky-600/10 text-sky-700 dark:text-sky-300 border-sky-600/30",
    ACCEPTED: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30",
    REJECTED: "bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30",
    EXPIRED: "bg-orange-500/10 text-orange-700 dark:text-orange-300 border-orange-500/30",
    CANCELLED: "bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30",
    CONVERTED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  };
  return styles[status];
}

export function SalesQuotationStatusBadge({
  status,
  label,
}: {
  status: SalesQuotationStatus;
  label: string;
}) {
  return (
    <Badge variant="outline" className={cn("text-xs font-medium", statusBadgeStyles(status))}>
      {label}
    </Badge>
  );
}

export function SalesQuotationsView({ role, business }: { role: Role; business?: BusinessSummary }) {
  const t = useTranslations("salesQuotations");
  const tCommon = useTranslations("common");
  const navigate = useAppStore((s) => s.navigate);
  const businessId = useAppStore((s) => s.activeBusinessId) ?? "";
  const writable = can(role, "data:write");

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<SalesQuotationStatus | "ALL">("ALL");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);

  const list = useQuery({
    queryKey: salesQuotationKeys.list(businessId, {
      q: q || undefined,
      status: status === "ALL" ? undefined : status,
      page,
      pageSize: 25,
    }),
    queryFn: () =>
      fetchSalesQuotations(businessId, {
        q: q || undefined,
        status: status === "ALL" ? undefined : status,
        from: from || undefined,
        to: to || undefined,
        page,
        pageSize: 25,
      }),
  });

  const dateFmt = useMemo(() => new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }), []);

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;

  return (
    <div className="space-y-6" data-view="sales-quotations">
      <PageHeader
        title={t("title")}
        subtitle={t("listSubtitle")}
        actions={
          <>
            <ListExportButton<SalesQuotationListItem>
              filename="sales-quotations"
              columns={[
                { header: t("reference"), value: (r) => r.reference },
                { header: t("status"), value: (r) => t(`status_${r.effectiveStatus}`) },
                { header: t("customer"), value: (r) => r.customerNameAtQuotation },
                { header: t("validUntil"), value: (r) => r.validUntilDate },
                { header: t("lines"), value: (r) => r.lineCount },
                {
                  header: t("total"),
                  value: (r) => (business ? r.totalMinor / 10 ** business.decimalPrecision : r.totalMinor),
                },
                { header: t("convertedOrder"), value: (r) => r.convertedOrderReference },
                { header: t("createdAtLabel"), value: (r) => r.createdAt },
              ]}
              fetchRows={() =>
                fetchAllPages<SalesQuotationListItem>((pg, ps) =>
                  fetchSalesQuotations(businessId, {
                    q: q || undefined,
                    status: status === "ALL" ? undefined : status,
                    from: from || undefined,
                    to: to || undefined,
                    page: pg,
                    pageSize: ps,
                  }),
                )
              }
            />
            {writable ? (
              <Button type="button" onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" aria-hidden />
                {t("createAction")}
              </Button>
            ) : null}
          </>
        }
      />

      {/* All filters are server-side. */}
      <Card>
        <CardContent className="flex flex-col gap-3 pt-4 md:flex-row md:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="sales-quotation-search">{t("searchLabel")}</Label>
            <SearchInput
              value={q}
              onChange={(v) => {
                setQ(v);
                setPage(1);
              }}
              placeholder={t("searchPlaceholder")}
            />
          </div>
          <div className="space-y-1.5 md:w-40">
            <Label htmlFor="sales-quotation-status">{t("status")}</Label>
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v as SalesQuotationStatus | "ALL");
                setPage(1);
              }}
            >
              <SelectTrigger id="sales-quotation-status" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_FILTERS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s === "ALL" ? t("statusAll") : t(`status_${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 md:w-40">
            <Label htmlFor="sales-quotation-from">{t("fromDate")}</Label>
            <Input
              id="sales-quotation-from"
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="space-y-1.5 md:w-40">
            <Label htmlFor="sales-quotation-to">{t("toDate")}</Label>
            <Input
              id="sales-quotation-to"
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPage(1);
              }}
            />
          </div>
        </CardContent>
      </Card>

      {list.isError && !(list.error instanceof ApiClientError && list.error.status === 404) ? (
        <EmptyState
          icon={FileText}
          title={t("loadFailed")}
          description={tCommon("retry")}
        />
      ) : items.length === 0 && !list.isLoading ? (
        <EmptyState
          icon={FileText}
          title={t("noQuotations")}
          description={t("noQuotationsDesc")}
        />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block">
            <DataTable
              columns={[
                {
                  id: "reference",
                  header: t("reference"),
                  sortValue: (r: SalesQuotationListItem) => r.reference,
                  cell: (r: SalesQuotationListItem) => (
                    <span className="font-medium" dir="auto">{r.reference}</span>
                  ),
                },
                {
                  id: "status",
                  header: t("status"),
                  cell: (r: SalesQuotationListItem) => (
                    <SalesQuotationStatusBadge status={r.effectiveStatus} label={t(`status_${r.effectiveStatus}`)} />
                  ),
                },
                {
                  id: "customer",
                  header: t("customer"),
                  hideBelow: "lg",
                  cell: (r: SalesQuotationListItem) => (
                    <span className="text-sm" dir="auto">
                      {r.customerNameAtQuotation || "—"}
                    </span>
                  ),
                },
                {
                  id: "validUntil",
                  header: t("validUntil"),
                  hideBelow: "lg",
                  cell: (r: SalesQuotationListItem) => (
                    <span className="text-xs text-muted-foreground" dir="ltr">
                      {dateFmt.format(new Date(r.validUntilDate))}
                    </span>
                  ),
                },
                {
                  id: "lines",
                  header: t("lines"),
                  align: "end",
                  cell: (r: SalesQuotationListItem) => (
                    <span className="tabular-nums" dir="ltr">{r.lineCount}</span>
                  ),
                },
                {
                  id: "total",
                  header: t("total"),
                  align: "end",
                  cell: (r: SalesQuotationListItem) => (
                    <span className="tabular-nums" dir="ltr">{business ? fmtMoney(business, r.totalMinor) : r.totalMinor.toLocaleString("en-US")}</span>
                  ),
                },
                {
                  id: "converted",
                  header: t("convertedOrder"),
                  hideBelow: "lg",
                  cell: (r: SalesQuotationListItem) =>
                    r.convertedOrderReference ? (
                      <span className="text-xs font-medium text-emerald-700 dark:text-emerald-300" dir="ltr">
                        {r.convertedOrderReference}
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    ),
                },
                {
                  id: "createdAt",
                  header: t("createdAtLabel"),
                  sortValue: (r: SalesQuotationListItem) => r.createdAt,
                  hideBelow: "lg",
                  cell: (r: SalesQuotationListItem) => (
                    <span className="text-xs text-muted-foreground" dir="ltr">
                      {dateFmt.format(new Date(r.createdAt))}
                    </span>
                  ),
                },
                {
                  id: "open",
                  header: "",
                  align: "end",
                  cell: () => <ChevronRight className="size-4 text-muted-foreground" aria-hidden />,
                },
              ]}
              rows={items}
              getRowId={(r) => r.id}
              ariaLabel={t("title")}
              loading={list.isLoading}
              refreshing={list.isFetching}
              onRowClick={(r) => navigate({ kind: "sales-quotation", id: r.id })}
            />
          </div>

          {/* Mobile cards */}
          <div className="flex flex-col gap-2 md:hidden">
            {list.isLoading
              ? [0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />)
              : items.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="w-full rounded-xl border bg-card p-4 text-start shadow-xs transition-colors hover:bg-muted/40"
                    onClick={() => navigate({ kind: "sales-quotation", id: r.id })}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium" dir="auto">{r.reference}</span>
                      <SalesQuotationStatusBadge status={r.effectiveStatus} label={t(`status_${r.effectiveStatus}`)} />
                    </div>
                    <div className="text-muted-foreground mt-2 flex items-center justify-between text-xs">
                      <span dir="auto">{r.customerNameAtQuotation || "—"}</span>
                      <span dir="ltr" className="tabular-nums">
                        {business ? fmtMoney(business, r.totalMinor) : r.totalMinor.toLocaleString("en-US")}
                      </span>
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs" dir="ltr">
                      {t("validUntil")}: {dateFmt.format(new Date(r.validUntilDate))}
                    </p>
                  </button>
                ))}
          </div>

          {total > 25 ? (
            <Pagination page={page} pageSize={25} total={total} onPage={setPage} />
          ) : null}
        </>
      )}

      {createOpen ? (
        <SalesQuotationCreateDialog
          businessId={businessId}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            navigate({ kind: "sales-quotation", id });
          }}
        />
      ) : null}
    </div>
  );
}
