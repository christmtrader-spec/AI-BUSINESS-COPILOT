"use client";

/**
 * Prompt 40 — stocktake list view (§74/§78/§79/§64).
 * Columns: Reference · Status · Products · Pending · Net variance · Created ·
 * Created by. Filters (server-side): status, reference search, created-date
 * range. Pagination default 25, max 100 (§64/§25). Rows navigate to the
 * detail deep link (§136).
 */
import { useMemo, useState } from "react";
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
import { ListExportButton } from "@/components/shared/list-export-button";
import { fetchAllPages } from "@/lib/csv";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app-store";
import type { StocktakeListItemDto } from "@/lib/inventory/stocktake/dto";
import type { StocktakeStatus } from "@/lib/inventory/stocktake/types";
import { fetchStocktakes, inventoryKeys } from "./stocktake-api";
import { StocktakeCreateDialog } from "./stocktake-create-dialog";

const STATUS_FILTERS: Array<StocktakeStatus | "ALL"> = [
  "ALL",
  "DRAFT",
  "COUNTING",
  "REVIEW",
  "FINALIZED",
  "CANCELLED",
];

export function StocktakesView({ role }: { role: Role }) {
  const t = useTranslations("inventory.stocktakes");
  const tCommon = useTranslations("common");
  const navigate = useAppStore((s) => s.navigate);
  const businessId = useAppStore((s) => s.activeBusinessId) ?? "";
  const writable = can(role, "data:write");

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StocktakeStatus | "ALL">("ALL");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);

  const list = useQuery({
    queryKey: inventoryKeys.stocktakes(businessId, {
      q: q || undefined,
      status: status === "ALL" ? undefined : status,
      page,
      pageSize: 25,
    }),
    queryFn: () =>
      fetchStocktakes(businessId, {
        q: q || undefined,
        status: status === "ALL" ? undefined : status,
        from: from || undefined,
        to: to || undefined,
        page,
        pageSize: 25,
      }),
  });

  const dateFmt = useMemo(() => new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }), []);

  const statusBadge = (s: StocktakeStatus) => {
    const styles: Record<StocktakeStatus, string> = {
      DRAFT: "bg-muted text-muted-foreground border-border",
      COUNTING: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30",
      REVIEW: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30",
      FINALIZED: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
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
    <div className="space-y-6" data-view="inventory-stocktakes">
      <PageHeader
        title={t("stocktakes")}
        subtitle={t("listSubtitle")}
        actions={
          <>
            <ListExportButton<StocktakeListItemDto>
              filename="stocktakes"
              columns={[
                { header: t("reference"), value: (r) => r.reference },
                { header: t("status"), value: (r) => t(`status_${r.status}`) },
                { header: t("products"), value: (r) => r.lineCount },
                { header: t("pending"), value: (r) => r.lineCount - r.countedLineCount },
                { header: t("netVariance"), value: (r) => r.netVarianceUnits },
                { header: t("createdAt"), value: (r) => r.createdAt },
                {
                  header: t("createdBy"),
                  value: (r) => r.createdBy?.name ?? r.createdBy?.email ?? "",
                },
              ]}
              fetchRows={() =>
                fetchAllPages<StocktakeListItemDto>((pg, ps) =>
                  fetchStocktakes(businessId, {
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
                {t("createStocktake")}
              </Button>
            ) : null}
          </>
        }
      />

      {/* §79 — all filters are server-side (§25). */}
      <Card>
        <CardContent className="flex flex-col gap-3 pt-4 md:flex-row md:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="stocktake-search">{t("reference")}</Label>
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
            <Label htmlFor="stocktake-status">{t("status")}</Label>
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v as StocktakeStatus | "ALL");
                setPage(1);
              }}
            >
              <SelectTrigger id="stocktake-status" className="w-full">
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
            <Label htmlFor="stocktake-from">{t("fromDate")}</Label>
            <Input
              id="stocktake-from"
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <div className="space-y-1.5 md:w-40">
            <Label htmlFor="stocktake-to">{t("toDate")}</Label>
            <Input
              id="stocktake-to"
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
          icon={ClipboardList}
          title={t("loadFailed")}
          description={tCommon("retry")}
        />
      ) : items.length === 0 && !list.isLoading ? (
        <EmptyState
          icon={ClipboardList}
          title={t("noStocktakes")}
          description={t("noStocktakesDesc")}
        />
      ) : (
        <>
          {/* Desktop table (§78) */}
          <div className="hidden md:block">
            <DataTable
              columns={[
                {
                  id: "reference",
                  header: t("reference"),
                  sortValue: (r: StocktakeListItemDto) => r.reference,
                  cell: (r: StocktakeListItemDto) => (
                    <span className="font-medium" dir="auto">{r.reference}</span>
                  ),
                },
                {
                  id: "status",
                  header: t("status"),
                  cell: (r: StocktakeListItemDto) => statusBadge(r.status),
                },
                {
                  id: "products",
                  header: t("products"),
                  align: "end",
                  cell: (r: StocktakeListItemDto) => (
                    <span className="tabular-nums" dir="ltr">{r.lineCount}</span>
                  ),
                },
                {
                  id: "pending",
                  header: t("pending"),
                  align: "end",
                  cell: (r: StocktakeListItemDto) => (
                    <span className="tabular-nums" dir="ltr">{r.lineCount - r.countedLineCount}</span>
                  ),
                },
                {
                  id: "net",
                  header: t("netVariance"),
                  align: "end",
                  cell: (r: StocktakeListItemDto) => (
                    <span
                      className={cn(
                        "tabular-nums",
                        r.netVarianceUnits > 0 && "text-emerald-600 dark:text-emerald-400",
                        r.netVarianceUnits < 0 && "text-amber-600 dark:text-amber-400",
                      )}
                      dir="ltr"
                    >
                      {r.netVarianceUnits > 0 ? `+${r.netVarianceUnits}` : r.netVarianceUnits}
                    </span>
                  ),
                },
                {
                  id: "createdAt",
                  header: t("createdAt"),
                  sortValue: (r: StocktakeListItemDto) => r.createdAt,
                  cell: (r: StocktakeListItemDto) => (
                    <span className="text-xs text-muted-foreground" dir="ltr">
                      {dateFmt.format(new Date(r.createdAt))}
                    </span>
                  ),
                },
                {
                  id: "createdBy",
                  header: t("createdBy"),
                  hideBelow: "lg",
                  cell: (r: StocktakeListItemDto) => (
                    <span className="text-xs text-muted-foreground">
                      {r.createdBy?.name ?? r.createdBy?.email ?? "—"}
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
              ariaLabel={t("stocktakes")}
              loading={list.isLoading}
              refreshing={list.isFetching}
              onRowClick={(r) => navigate({ kind: "inventory-stocktake", id: r.id })}
            />
          </div>

          {/* Mobile cards (§134) */}
          <div className="flex flex-col gap-2 md:hidden">
            {list.isLoading
              ? [0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />)
              : items.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="w-full rounded-xl border bg-card p-4 text-start shadow-xs transition-colors hover:bg-muted/40"
                    onClick={() => navigate({ kind: "inventory-stocktake", id: r.id })}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium" dir="auto">{r.reference}</span>
                      {statusBadge(r.status)}
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                      <span dir="ltr">
                        {t("products")}: {r.lineCount} · {t("pending")}: {r.lineCount - r.countedLineCount}
                      </span>
                      <span dir="ltr">
                        {t("netVariance")}:{" "}
                        {r.netVarianceUnits > 0 ? `+${r.netVarianceUnits}` : r.netVarianceUnits}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground" dir="ltr">
                      {dateFmt.format(new Date(r.createdAt))} · {r.createdBy?.name ?? r.createdBy?.email ?? "—"}
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
        <StocktakeCreateDialog
          businessId={businessId}
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false);
            navigate({ kind: "inventory-stocktake", id });
          }}
        />
      ) : null}
    </div>
  );
}
