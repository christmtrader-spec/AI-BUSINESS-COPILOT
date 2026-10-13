"use client";

/**
 * Prompt 48 — supplier-bill list view.
 * Columns: Reference · Status · Purchase order · Supplier · Bill date ·
 * Total · Payable. Filters (server-side): status, search, bill-date range,
 * due-date range, supplierId, purchaseOrderId. Pagination default 25, max
 * 100. Rows navigate to #/supplier-bills/<id>.
 * The payable column shows the LIVE Expense state for POSTED bills only —
 * a draft is never displayed as an active payable (§16).
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
import { FinanceStatusBadge } from "@/modules/finance-shared/finance-kit";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app-store";
import type { SupplierBillListItemDto } from "@/lib/supplier-bills/dto";
import type { SupplierBillStatus } from "@/lib/supplier-bills/types";
import { fetchSupplierBills, supplierBillKeys } from "./supplier-bills-api";
import { SupplierBillCreateDialog } from "./supplier-bill-create-dialog";

const STATUS_FILTERS: Array<SupplierBillStatus | "ALL"> = [
  "ALL",
  "DRAFT",
  "POSTED",
  "CANCELLED",
];

export function SupplierBillsView({ role }: { role: Role }) {
  const t = useTranslations("supplierBills");
  const tCommon = useTranslations("common");
  const navigate = useAppStore((s) => s.navigate);
  const businessId = useAppStore((s) => s.activeBusinessId) ?? "";
  const writable = can(role, "data:write");

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<SupplierBillStatus | "ALL">("ALL");
  const [billFrom, setBillFrom] = useState("");
  const [billTo, setBillTo] = useState("");
  const [dueFrom, setDueFrom] = useState("");
  const [dueTo, setDueTo] = useState("");
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);

  const list = useQuery({
    queryKey: supplierBillKeys.list(businessId, {
      q: q || undefined,
      status: status === "ALL" ? undefined : status,
      page,
      pageSize: 25,
    }),
    queryFn: () =>
      fetchSupplierBills(businessId, {
        q: q || undefined,
        status: status === "ALL" ? undefined : status,
        billDateFrom: billFrom || undefined,
        billDateTo: billTo || undefined,
        dueDateFrom: dueFrom || undefined,
        dueDateTo: dueTo || undefined,
        page,
        pageSize: 25,
      }),
  });

  const dateFmt = useMemo(() => new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }), []);

  const statusBadge = (s: SupplierBillStatus) => {
    const styles: Record<SupplierBillStatus, string> = {
      DRAFT: "bg-muted text-muted-foreground border-border",
      POSTED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
      CANCELLED: "bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30",
    };
    return (
      <Badge variant="outline" className={cn("text-xs font-medium", styles[s])}>
        {t(`status_${s}`)}
      </Badge>
    );
  };

  const payableBadge = (r: SupplierBillListItemDto) => {
    if (!r.payable) {
      return <span className="text-muted-foreground text-xs">—</span>;
    }
    const outstanding = (r.payable.outstandingMinor / 10 ** r.decimalPrecisionAtBill).toFixed(
      r.decimalPrecisionAtBill,
    );
    return (
      <span className="inline-flex items-center gap-1.5" data-testid="sb-payable-badge">
        <FinanceStatusBadge status={r.payable.status} />
        <span className="text-muted-foreground text-xs tabular-nums" dir="ltr">
          {outstanding} {r.currencySymbolAtBill}
        </span>
      </span>
    );
  };

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;

  const fmtMoney = (r: SupplierBillListItemDto) =>
    `${(r.totalMinor / 10 ** r.decimalPrecisionAtBill).toFixed(r.decimalPrecisionAtBill)} ${r.currencySymbolAtBill}`;

  return (
    <div className="space-y-6" data-view="supplier-bills">
      <PageHeader
        title={t("title")}
        subtitle={t("listSubtitle")}
        actions={
          writable ? (
            <Button type="button" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" aria-hidden />
              {t("createAction")}
            </Button>
          ) : null
        }
      />

      {/* All filters are server-side. */}
      <Card>
        <CardContent className="flex flex-col gap-3 pt-4 md:flex-row md:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="sb-search">{t("searchLabel")}</Label>
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
            <Label htmlFor="sb-status">{t("status")}</Label>
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v as SupplierBillStatus | "ALL");
                setPage(1);
              }}
            >
              <SelectTrigger id="sb-status" className="w-full">
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
            <Label htmlFor="sb-from">{t("fromDate")}</Label>
            <Input
              id="sb-from"
              type="date"
              value={billFrom}
              onChange={(e) => {
                setBillFrom(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="space-y-1.5 md:w-40">
            <Label htmlFor="sb-to">{t("toDate")}</Label>
            <Input
              id="sb-to"
              type="date"
              value={billTo}
              onChange={(e) => {
                setBillTo(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="space-y-1.5 md:w-40">
            <Label htmlFor="sb-due-from">{t("dueFrom")}</Label>
            <Input
              id="sb-due-from"
              type="date"
              value={dueFrom}
              onChange={(e) => {
                setDueFrom(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="space-y-1.5 md:w-40">
            <Label htmlFor="sb-due-to">{t("dueTo")}</Label>
            <Input
              id="sb-due-to"
              type="date"
              value={dueTo}
              onChange={(e) => {
                setDueTo(e.target.value);
                setPage(1);
              }}
            />
          </div>
        </CardContent>
      </Card>

      {list.isError && !(list.error instanceof ApiClientError && list.error.status === 404) ? (
        <EmptyState icon={FileText} title={t("loadFailed")} description={tCommon("retry")} />
      ) : items.length === 0 && !list.isLoading ? (
        <EmptyState icon={FileText} title={t("noBills")} description={t("noBillsDesc")} />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block">
            <DataTable
              columns={[
                {
                  id: "reference",
                  header: t("reference"),
                  sortValue: (r: SupplierBillListItemDto) => r.reference,
                  cell: (r: SupplierBillListItemDto) => (
                    <span className="font-medium" dir="auto">{r.reference}</span>
                  ),
                },
                {
                  id: "status",
                  header: t("status"),
                  cell: (r: SupplierBillListItemDto) => statusBadge(r.status),
                },
                {
                  id: "po",
                  header: t("purchaseOrder"),
                  hideBelow: "lg",
                  cell: (r: SupplierBillListItemDto) => (
                    <span className="text-sm" dir="auto">{r.purchaseOrderReferenceAtBill}</span>
                  ),
                },
                {
                  id: "supplier",
                  header: t("supplier"),
                  hideBelow: "lg",
                  cell: (r: SupplierBillListItemDto) => (
                    <span className="text-sm" dir="auto">{r.supplierNameAtBill}</span>
                  ),
                },
                {
                  id: "billDate",
                  header: t("billDate"),
                  hideBelow: "lg",
                  sortValue: (r: SupplierBillListItemDto) => r.billDate,
                  cell: (r: SupplierBillListItemDto) => (
                    <span className="text-xs text-muted-foreground" dir="ltr">
                      {dateFmt.format(new Date(r.billDate))}
                    </span>
                  ),
                },
                {
                  id: "total",
                  header: t("total"),
                  align: "end",
                  sortValue: (r: SupplierBillListItemDto) => r.totalMinor,
                  cell: (r: SupplierBillListItemDto) => (
                    <span className="tabular-nums" dir="ltr">{fmtMoney(r)}</span>
                  ),
                },
                {
                  id: "payable",
                  header: t("payableStatus"),
                  align: "end",
                  cell: (r: SupplierBillListItemDto) => payableBadge(r),
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
              onRowClick={(r) => navigate({ kind: "supplier-bill", id: r.id })}
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
                    onClick={() => navigate({ kind: "supplier-bill", id: r.id })}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium" dir="auto">{r.reference}</span>
                      {statusBadge(r.status)}
                    </div>
                    <div className="text-muted-foreground mt-2 flex items-center justify-between text-xs">
                      <span dir="auto">{r.supplierNameAtBill}</span>
                      <span dir="ltr" className="tabular-nums">{fmtMoney(r)}</span>
                    </div>
                    <div className="mt-1 flex items-center justify-between">
                      <p className="text-muted-foreground text-xs" dir="ltr">
                        {dateFmt.format(new Date(r.billDate))} · {r.purchaseOrderReferenceAtBill}
                      </p>
                      {payableBadge(r)}
                    </div>
                  </button>
                ))}
          </div>

          {total > 25 ? (
            <Pagination page={page} pageSize={25} total={total} onPage={setPage} />
          ) : null}
        </>
      )}

      {createOpen ? (
        <SupplierBillCreateDialog
          businessId={businessId}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            navigate({ kind: "supplier-bill", id });
          }}
        />
      ) : null}
    </div>
  );
}
