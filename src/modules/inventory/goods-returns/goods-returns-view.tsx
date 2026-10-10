"use client";

/**
 * Prompt 43 — goods-return list view (§89).
 * Columns: Reference · Status · Source receipt · Supplier · Lines ·
 * Returned · Created. Filters (server-side): status, search, created-date
 * range, goodsReceiptId. Pagination default 25, max 100 (§72).
 * Rows navigate to the detail deep link #/inventory/goods-returns/<id>.
 * NO money columns anywhere (§7 — a return records quantity only).
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ChevronRight, PackageMinus, Plus } from "lucide-react";
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
import type { GoodsReturnListItemDto } from "@/lib/inventory/goods-return/dto";
import type { GoodsReturnStatus } from "@/lib/inventory/goods-return/types";
import { fetchGoodsReturns, goodsReturnKeys } from "./goods-returns-api";
import { GoodsReturnCreateDialog } from "./goods-return-create-dialog";

const STATUS_FILTERS: Array<GoodsReturnStatus | "ALL"> = [
  "ALL",
  "DRAFT",
  "POSTED",
  "CANCELLED",
];

export function GoodsReturnsView({ role }: { role: Role }) {
  const t = useTranslations("goodsReturns");
  const tCommon = useTranslations("common");
  const navigate = useAppStore((s) => s.navigate);
  const businessId = useAppStore((s) => s.activeBusinessId) ?? "";
  const writable = can(role, "data:write");

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<GoodsReturnStatus | "ALL">("ALL");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);

  const list = useQuery({
    queryKey: goodsReturnKeys.list(businessId, {
      q: q || undefined,
      status: status === "ALL" ? undefined : status,
      page,
      pageSize: 25,
    }),
    queryFn: () =>
      fetchGoodsReturns(businessId, {
        q: q || undefined,
        status: status === "ALL" ? undefined : status,
        from: from || undefined,
        to: to || undefined,
        page,
        pageSize: 25,
      }),
  });

  const dateFmt = useMemo(() => new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }), []);

  const statusBadge = (s: GoodsReturnStatus) => {
    const styles: Record<GoodsReturnStatus, string> = {
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
    <div className="space-y-6" data-view="inventory-goods-returns">
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

      {/* §72 — all filters are server-side. */}
      <Card>
        <CardContent className="flex flex-col gap-3 pt-4 md:flex-row md:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="goods-return-search">{t("searchLabel")}</Label>
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
            <Label htmlFor="goods-return-status">{t("status")}</Label>
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v as GoodsReturnStatus | "ALL");
                setPage(1);
              }}
            >
              <SelectTrigger id="goods-return-status" className="w-full">
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
            <Label htmlFor="goods-return-from">{t("fromDate")}</Label>
            <Input
              id="goods-return-from"
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="space-y-1.5 md:w-40">
            <Label htmlFor="goods-return-to">{t("toDate")}</Label>
            <Input
              id="goods-return-to"
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
          icon={PackageMinus}
          title={t("loadFailed")}
          description={tCommon("retry")}
        />
      ) : items.length === 0 && !list.isLoading ? (
        <EmptyState
          icon={PackageMinus}
          title={t("noReturns")}
          description={t("noReturnsDesc")}
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
                  sortValue: (r: GoodsReturnListItemDto) => r.reference,
                  cell: (r: GoodsReturnListItemDto) => (
                    <span className="font-medium" dir="auto">{r.reference}</span>
                  ),
                },
                {
                  id: "status",
                  header: t("status"),
                  cell: (r: GoodsReturnListItemDto) => statusBadge(r.status),
                },
                {
                  id: "receipt",
                  header: t("sourceReceipt"),
                  hideBelow: "lg",
                  cell: (r: GoodsReturnListItemDto) => (
                    <span className="text-sm" dir="auto">{r.goodsReceiptReferenceAtReturn}</span>
                  ),
                },
                {
                  id: "supplier",
                  header: t("supplier"),
                  hideBelow: "lg",
                  cell: (r: GoodsReturnListItemDto) => (
                    <span className="text-sm" dir="auto">{r.supplierNameAtReturn}</span>
                  ),
                },
                {
                  id: "lines",
                  header: t("lines"),
                  align: "end",
                  cell: (r: GoodsReturnListItemDto) => (
                    <span className="tabular-nums" dir="ltr">{r.lineCount}</span>
                  ),
                },
                {
                  id: "returned",
                  header: t("totalReturned"),
                  align: "end",
                  cell: (r: GoodsReturnListItemDto) => (
                    <span className="tabular-nums" dir="ltr">{r.totalReturnedQty}</span>
                  ),
                },
                {
                  id: "createdAt",
                  header: t("createdAtLabel"),
                  sortValue: (r: GoodsReturnListItemDto) => r.createdAt,
                  cell: (r: GoodsReturnListItemDto) => (
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
              onRowClick={(r) => navigate({ kind: "inventory-goods-return", id: r.id })}
            />
          </div>

          {/* Mobile cards (§146) */}
          <div className="flex flex-col gap-2 md:hidden">
            {list.isLoading
              ? [0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />)
              : items.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="w-full rounded-xl border bg-card p-4 text-start shadow-xs transition-colors hover:bg-muted/40"
                    onClick={() => navigate({ kind: "inventory-goods-return", id: r.id })}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium" dir="auto">{r.reference}</span>
                      {statusBadge(r.status)}
                    </div>
                    <div className="text-muted-foreground mt-2 flex items-center justify-between text-xs">
                      <span dir="auto">{r.supplierNameAtReturn}</span>
                      <span dir="ltr">
                        {t("totalReturned")}: {r.totalReturnedQty}
                      </span>
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs" dir="ltr">
                      {dateFmt.format(new Date(r.createdAt))} · {r.goodsReceiptReferenceAtReturn}
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
        <GoodsReturnCreateDialog
          businessId={businessId}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            navigate({ kind: "inventory-goods-return", id });
          }}
        />
      ) : null}
    </div>
  );
}
