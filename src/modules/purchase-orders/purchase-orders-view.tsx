"use client";

/**
 * Prompt 41 — purchase-order list view (§74-§76).
 * Columns: Reference · Status · Supplier · Lines · Total · Ordered · Expected.
 * Filters (server-side §79): status, q (reference/supplier/product snapshot),
 * ordered-date range. Pagination default 25, max 100 (§52). Rows navigate to
 * the detail deep link #/purchase-orders/<id> (§70).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ChevronRight, ClipboardList, Plus } from "lucide-react";
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
import type { PurchaseOrderListItemDto } from "@/lib/purchase-orders/dto";
import type { PurchaseOrderStatus } from "@/lib/purchase-orders/types";
import { fetchPurchaseOrders, purchaseOrderKeys } from "./purchase-orders-api";
import { PurchaseOrderCreateDialog } from "./purchase-order-create-dialog";

const STATUS_FILTERS: Array<PurchaseOrderStatus | "ALL"> = [
  "ALL",
  "DRAFT",
  "SENT",
  "CONFIRMED",
  "CLOSED",
  "CANCELLED",
];

export function PurchaseOrdersView({ role }: { role: Role }) {
  const t = useTranslations("purchaseOrders");
  const tCommon = useTranslations("common");
  const navigate = useAppStore((s) => s.navigate);
  const locale = useAppStore((s) => s.locale);
  const businessId = useAppStore((s) => s.activeBusinessId) ?? "";
  const writable = can(role, "data:write");

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<PurchaseOrderStatus | "ALL">("ALL");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);

  const list = useQuery({
    queryKey: purchaseOrderKeys.list(businessId, {
      q: q || undefined,
      status: status === "ALL" ? undefined : status,
      from: from || undefined,
      to: to || undefined,
      page,
      pageSize: 25,
    }),
    queryFn: () =>
      fetchPurchaseOrders(businessId, {
        q: q || undefined,
        status: status === "ALL" ? undefined : status,
        from: from || undefined,
        to: to || undefined,
        page,
        pageSize: 25,
      }),
  });

  const dateFmt = new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : "en-US", {
    dateStyle: "medium",
  });

  const moneyFmt = (minor: number, symbol: string, precision: number) =>
    // §91/§23 — display uses the ORDER's currency snapshot; integer minor
    // units rendered exactly, never re-interpreted with live precision.
    new Intl.NumberFormat(locale === "fa" ? "fa-IR" : "en-US", {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    }).format(minor / 10 ** precision) + ` ${symbol}`;

  const statusBadge = (s: PurchaseOrderStatus) => {
    const styles: Record<PurchaseOrderStatus, string> = {
      DRAFT: "bg-muted text-muted-foreground border-border",
      SENT: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30",
      CONFIRMED: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30",
      CLOSED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
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
    <div className="space-y-6" data-view="purchase-orders">
      <PageHeader
        title={t("title")}
        subtitle={t("listSubtitle")}
        actions={
          writable ? (
            <Button type="button" onClick={() => setCreateOpen(true)} data-testid="po-create">
              <Plus className="size-4" aria-hidden />
              {t("createAction")}
            </Button>
          ) : null
        }
      />

      {/* §79 — all filters are server-side (§52). */}
      <Card>
        <CardContent className="flex flex-col gap-3 pt-4 md:flex-row md:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="po-search">{t("searchLabel")}</Label>
            <SearchInput
              value={q}
              onChange={(v) => {
                setQ(v);
                setPage(1);
              }}
              placeholder={t("searchPlaceholder")}
            />
          </div>
          <div className="space-y-1.5 md:w-44">
            <Label htmlFor="po-status">{t("status")}</Label>
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v as PurchaseOrderStatus | "ALL");
                setPage(1);
              }}
            >
              <SelectTrigger id="po-status" className="w-full">
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
            <Label htmlFor="po-from">{t("fromDate")}</Label>
            <Input
              id="po-from"
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="space-y-1.5 md:w-40">
            <Label htmlFor="po-to">{t("toDate")}</Label>
            <Input
              id="po-to"
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
        <EmptyState icon={ClipboardList} title={t("loadFailed")} description={tCommon("retry")} />
      ) : items.length === 0 && !list.isLoading ? (
        <EmptyState
          icon={ClipboardList}
          title={t("noOrders")}
          description={t("noOrdersDesc")}
          action={
            writable ? (
              <Button type="button" onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" aria-hidden />
                {t("createAction")}
              </Button>
            ) : null
          }
        />
      ) : (
        <>
          {/* Desktop table (§74) */}
          <div className="hidden md:block">
            <DataTable
              columns={[
                {
                  id: "reference",
                  header: t("reference"),
                  sortValue: (r: PurchaseOrderListItemDto) => r.reference,
                  cell: (r: PurchaseOrderListItemDto) => (
                    <span className="font-medium" dir="auto">{r.reference}</span>
                  ),
                },
                {
                  id: "status",
                  header: t("status"),
                  cell: (r: PurchaseOrderListItemDto) => statusBadge(r.status),
                },
                {
                  id: "supplier",
                  header: t("supplier"),
                  cell: (r: PurchaseOrderListItemDto) => (
                    <span className="max-w-48 truncate text-sm" dir="auto">
                      {r.supplierNameAtOrder}
                    </span>
                  ),
                },
                {
                  id: "lines",
                  header: t("lines"),
                  align: "end",
                  cell: (r: PurchaseOrderListItemDto) => (
                    <span className="tabular-nums" dir="ltr">{r.lineCount}</span>
                  ),
                },
                {
                  id: "total",
                  header: t("total"),
                  align: "end",
                  cell: (r: PurchaseOrderListItemDto) => (
                    <span className="tabular-nums" dir="ltr">
                      {moneyFmt(r.totalMinor, r.currencySymbolAtOrder, r.decimalPrecisionAtOrder)}
                    </span>
                  ),
                },
                {
                  id: "orderedAt",
                  header: t("orderedAt"),
                  sortValue: (r: PurchaseOrderListItemDto) => r.orderedAt,
                  cell: (r: PurchaseOrderListItemDto) => (
                    <span className="text-xs text-muted-foreground" dir="ltr">
                      {dateFmt.format(new Date(r.orderedAt))}
                    </span>
                  ),
                },
                {
                  id: "expected",
                  header: t("expectedDate"),
                  hideBelow: "lg",
                  cell: (r: PurchaseOrderListItemDto) => (
                    <span className="text-xs text-muted-foreground" dir="ltr">
                      {r.expectedDate ? dateFmt.format(new Date(r.expectedDate)) : "—"}
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
              onRowClick={(r) => navigate({ kind: "purchase-order", id: r.id })}
            />
          </div>

          {/* Mobile cards (§74) */}
          <div className="flex flex-col gap-2 md:hidden">
            {list.isLoading
              ? [0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />)
              : items.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="w-full rounded-xl border bg-card p-4 text-start shadow-xs transition-colors hover:bg-muted/40"
                    onClick={() => navigate({ kind: "purchase-order", id: r.id })}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium" dir="auto">{r.reference}</span>
                      {statusBadge(r.status)}
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground" dir="auto">
                      {r.supplierNameAtOrder}
                    </p>
                    <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                      <span dir="ltr">
                        {t("lines")}: {r.lineCount} · {t("totalQty")}: {r.totalQty}
                      </span>
                      <span className="tabular-nums" dir="ltr">
                        {moneyFmt(r.totalMinor, r.currencySymbolAtOrder, r.decimalPrecisionAtOrder)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground" dir="ltr">
                      {dateFmt.format(new Date(r.orderedAt))}
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
        <PurchaseOrderCreateDialog
          businessId={businessId}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            navigate({ kind: "purchase-order", id });
          }}
        />
      ) : null}
    </div>
  );
}
