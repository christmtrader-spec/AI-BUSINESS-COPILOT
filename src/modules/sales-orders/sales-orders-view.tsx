"use client";

/**
 * Prompt 45 — sales-order list view (§74).
 * Columns: Reference · Status · Customer · Lines · Ordered/Dispatched ·
 * Total · Invoice · Created. Filters (server-side): status, search,
 * created-date range, customerId. Pagination default 25, max 100. Rows
 * navigate to the detail deep link #/sales-orders/<id>.
 * The Total column renders with the ORDER'S currency snapshot from the
 * detail DTO when needed — list rows carry the business-configured minor
 * units (display-only formatting).
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
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app-store";
import type { SalesOrderListItem } from "./sales-orders-api";
import type { SalesOrderStatus } from "@/lib/sales-orders/types";
import { fetchSalesOrders, salesOrderKeys } from "./sales-orders-api";
import { SalesOrderCreateDialog } from "./sales-order-create-dialog";

const STATUS_FILTERS: Array<SalesOrderStatus | "ALL"> = [
  "ALL",
  "DRAFT",
  "CONFIRMED",
  "COMPLETED",
  "CANCELLED",
];

export function SalesOrdersView({ role }: { role: Role }) {
  const t = useTranslations("salesOrders");
  const tCommon = useTranslations("common");
  const navigate = useAppStore((s) => s.navigate);
  const businessId = useAppStore((s) => s.activeBusinessId) ?? "";
  const writable = can(role, "data:write");

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<SalesOrderStatus | "ALL">("ALL");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);

  const list = useQuery({
    queryKey: salesOrderKeys.list(businessId, {
      q: q || undefined,
      status: status === "ALL" ? undefined : status,
      page,
      pageSize: 25,
    }),
    queryFn: () =>
      fetchSalesOrders(businessId, {
        q: q || undefined,
        status: status === "ALL" ? undefined : status,
        from: from || undefined,
        to: to || undefined,
        page,
        pageSize: 25,
      }),
  });

  const dateFmt = useMemo(() => new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }), []);

  const statusBadge = (s: SalesOrderStatus) => {
    const styles: Record<SalesOrderStatus, string> = {
      DRAFT: "bg-muted text-muted-foreground border-border",
      CONFIRMED: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30",
      COMPLETED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
      CANCELLED: "bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30",
    };
    return (
      <Badge variant="outline" className={cn("text-xs font-medium", styles[s])}>
        {t(`status_${s}`)}
      </Badge>
    );
  };

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;

  return (
    <div className="space-y-6" data-view="sales-orders">
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
            <Label htmlFor="sales-order-search">{t("searchLabel")}</Label>
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
            <Label htmlFor="sales-order-status">{t("status")}</Label>
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v as SalesOrderStatus | "ALL");
                setPage(1);
              }}
            >
              <SelectTrigger id="sales-order-status" className="w-full">
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
            <Label htmlFor="sales-order-from">{t("fromDate")}</Label>
            <Input
              id="sales-order-from"
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="space-y-1.5 md:w-40">
            <Label htmlFor="sales-order-to">{t("toDate")}</Label>
            <Input
              id="sales-order-to"
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
          title={t("noOrders")}
          description={t("noOrdersDesc")}
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
                  sortValue: (r: SalesOrderListItem) => r.reference,
                  cell: (r: SalesOrderListItem) => (
                    <span className="font-medium" dir="auto">{r.reference}</span>
                  ),
                },
                {
                  id: "status",
                  header: t("status"),
                  cell: (r: SalesOrderListItem) => statusBadge(r.status),
                },
                {
                  id: "customer",
                  header: t("customer"),
                  hideBelow: "lg",
                  cell: (r: SalesOrderListItem) => (
                    <span className="text-sm" dir="auto">
                      {r.customerNameAtOrder || "—"}
                    </span>
                  ),
                },
                {
                  id: "fulfillment",
                  header: t("dispatchedLabel"),
                  align: "end",
                  cell: (r: SalesOrderListItem) => (
                    <span className="tabular-nums" dir="ltr" aria-label={t("progressLabel", { dispatched: r.dispatchedQty, ordered: r.totalQty })}>
                      {r.dispatchedQty}/{r.totalQty}
                    </span>
                  ),
                },
                {
                  id: "total",
                  header: t("total"),
                  align: "end",
                  hideBelow: "lg",
                  cell: (r: SalesOrderListItem) => (
                    <span className="tabular-nums" dir="ltr">{r.totalMinor.toLocaleString("en-US")}</span>
                  ),
                },
                {
                  id: "invoice",
                  header: t("linkedInvoice"),
                  hideBelow: "lg",
                  cell: (r: SalesOrderListItem) =>
                    r.invoiceNumber ? (
                      <span className="text-xs font-medium" dir="ltr">
                        {`INV-${String(r.invoiceNumber).padStart(4, "0")}`}
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    ),
                },
                {
                  id: "createdAt",
                  header: t("createdAtLabel"),
                  sortValue: (r: SalesOrderListItem) => r.createdAt,
                  hideBelow: "lg",
                  cell: (r: SalesOrderListItem) => (
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
              onRowClick={(r) => navigate({ kind: "sales-order", id: r.id })}
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
                    onClick={() => navigate({ kind: "sales-order", id: r.id })}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium" dir="auto">{r.reference}</span>
                      {statusBadge(r.status)}
                    </div>
                    <div className="text-muted-foreground mt-2 flex items-center justify-between text-xs">
                      <span dir="auto">{r.customerNameAtOrder || "—"}</span>
                      <span dir="ltr">
                        {t("dispatchedLabel")}: {r.dispatchedQty}/{r.totalQty}
                      </span>
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs" dir="ltr">
                      {dateFmt.format(new Date(r.createdAt))}
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
        <SalesOrderCreateDialog
          businessId={businessId}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            navigate({ kind: "sales-order", id });
          }}
        />
      ) : null}
    </div>
  );
}
