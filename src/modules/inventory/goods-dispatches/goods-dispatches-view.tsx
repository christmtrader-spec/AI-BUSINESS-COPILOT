"use client";

/**
 * Prompt 44 — goods-dispatch list view.
 * Columns: Reference · Status · Customer · Lines · Dispatched · Created.
 * Filters (server-side): status, search, created-date range, customerId.
 * Pagination default 25, max 100. Rows navigate to the detail deep link
 * #/inventory/goods-dispatches/<id>. NO money columns anywhere (a dispatch
 * records quantity only).
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ChevronRight, PackageOpen, Plus } from "lucide-react";
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
import type { GoodsDispatchListItemDto } from "@/lib/inventory/goods-dispatch/dto";
import type { GoodsDispatchStatus } from "@/lib/inventory/goods-dispatch/types";
import { fetchGoodsDispatches, goodsDispatchKeys } from "./goods-dispatches-api";
import { GoodsDispatchCreateDialog } from "./goods-dispatch-create-dialog";

const STATUS_FILTERS: Array<GoodsDispatchStatus | "ALL"> = [
  "ALL",
  "DRAFT",
  "POSTED",
  "CANCELLED",
];

export function GoodsDispatchesView({ role }: { role: Role }) {
  const t = useTranslations("goodsDispatches");
  const tCommon = useTranslations("common");
  const navigate = useAppStore((s) => s.navigate);
  const businessId = useAppStore((s) => s.activeBusinessId) ?? "";
  const writable = can(role, "data:write");

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<GoodsDispatchStatus | "ALL">("ALL");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);

  const list = useQuery({
    queryKey: goodsDispatchKeys.list(businessId, {
      q: q || undefined,
      status: status === "ALL" ? undefined : status,
      page,
      pageSize: 25,
    }),
    queryFn: () =>
      fetchGoodsDispatches(businessId, {
        q: q || undefined,
        status: status === "ALL" ? undefined : status,
        from: from || undefined,
        to: to || undefined,
        page,
        pageSize: 25,
      }),
  });

  const dateFmt = useMemo(() => new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }), []);

  const statusBadge = (s: GoodsDispatchStatus) => {
    const styles: Record<GoodsDispatchStatus, string> = {
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

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;

  return (
    <div className="space-y-6" data-view="inventory-goods-dispatches">
      <PageHeader
        title={t("title")}
        subtitle={t("listSubtitle")}
        actions={
          <>
            <ListExportButton<GoodsDispatchListItemDto>
              filename="goods-dispatches"
              columns={[
                { header: t("reference"), value: (r) => r.reference },
                { header: t("status"), value: (r) => t(`status_${r.status}`) },
                { header: t("customer"), value: (r) => r.customerNameAtDispatch },
                { header: t("lines"), value: (r) => r.lineCount },
                { header: t("totalDispatched"), value: (r) => r.totalDispatchedQty },
                { header: t("createdAtLabel"), value: (r) => r.createdAt },
              ]}
              fetchRows={() =>
                fetchAllPages<GoodsDispatchListItemDto>((pg, ps) =>
                  fetchGoodsDispatches(businessId, {
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
            <Label htmlFor="goods-dispatch-search">{t("searchLabel")}</Label>
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
            <Label htmlFor="goods-dispatch-status">{t("status")}</Label>
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v as GoodsDispatchStatus | "ALL");
                setPage(1);
              }}
            >
              <SelectTrigger id="goods-dispatch-status" className="w-full">
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
            <Label htmlFor="goods-dispatch-from">{t("fromDate")}</Label>
            <Input
              id="goods-dispatch-from"
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="space-y-1.5 md:w-40">
            <Label htmlFor="goods-dispatch-to">{t("toDate")}</Label>
            <Input
              id="goods-dispatch-to"
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
          icon={PackageOpen}
          title={t("loadFailed")}
          description={tCommon("retry")}
        />
      ) : items.length === 0 && !list.isLoading ? (
        <EmptyState
          icon={PackageOpen}
          title={t("noDispatches")}
          description={t("noDispatchesDesc")}
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
                  sortValue: (r: GoodsDispatchListItemDto) => r.reference,
                  cell: (r: GoodsDispatchListItemDto) => (
                    <span className="font-medium" dir="auto">{r.reference}</span>
                  ),
                },
                {
                  id: "status",
                  header: t("status"),
                  cell: (r: GoodsDispatchListItemDto) => statusBadge(r.status),
                },
                {
                  id: "customer",
                  header: t("customer"),
                  hideBelow: "lg",
                  cell: (r: GoodsDispatchListItemDto) => (
                    <span className="text-sm" dir="auto">
                      {r.customerNameAtDispatch || "—"}
                    </span>
                  ),
                },
                {
                  id: "lines",
                  header: t("lines"),
                  align: "end",
                  hideBelow: "lg",
                  cell: (r: GoodsDispatchListItemDto) => (
                    <span className="tabular-nums" dir="ltr">{r.lineCount}</span>
                  ),
                },
                {
                  id: "dispatched",
                  header: t("totalDispatched"),
                  align: "end",
                  cell: (r: GoodsDispatchListItemDto) => (
                    <span className="tabular-nums" dir="ltr">{r.totalDispatchedQty}</span>
                  ),
                },
                {
                  id: "createdAt",
                  header: t("createdAtLabel"),
                  sortValue: (r: GoodsDispatchListItemDto) => r.createdAt,
                  cell: (r: GoodsDispatchListItemDto) => (
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
              onRowClick={(r) => navigate({ kind: "inventory-goods-dispatch", id: r.id })}
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
                    className="w-full rounded-xl border bg-card p-4 text-start shadow-xs transition-colors hover:bg-muted/40 motion-reduce:transition-none"
                    onClick={() => navigate({ kind: "inventory-goods-dispatch", id: r.id })}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium" dir="auto">{r.reference}</span>
                      {statusBadge(r.status)}
                    </div>
                    <div className="text-muted-foreground mt-2 flex items-center justify-between text-xs">
                      <span dir="auto">{r.customerNameAtDispatch || "—"}</span>
                      <span dir="ltr">
                        {t("totalDispatched")}: {r.totalDispatchedQty}
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
        <GoodsDispatchCreateDialog
          businessId={businessId}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            navigate({ kind: "inventory-goods-dispatch", id });
          }}
        />
      ) : null}
    </div>
  );
}
