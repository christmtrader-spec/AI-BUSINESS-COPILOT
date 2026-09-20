"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { CalendarDays, Eye, Plus, ShoppingCart, Trash2, X } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { can, asRole, type Role } from "@/lib/rbac";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState, PageHeader } from "@/components/shared/primitives";
import { DataTable, DataTableToolbar, Ltr } from "@/components/shared/data-table";
import { Pagination, SearchInput } from "@/components/shared/table-kit";
import {
  FinanceStatusBadge,
  fmtDate,
  fmtMoney,
  txKeys,
  useInvalidateFinance,
} from "../finance-shared/finance-kit";
import { SaleFormDialog } from "./sale-form-dialog";
import { SaleDetailDialog } from "./sale-detail-dialog";
import type { BusinessSummary } from "../shell/types";

type SaleRow = {
  id: string;
  number: number;
  customerName: string | null;
  issueDate: string;
  totalMinor: number;
  paidMinor: number;
  status: string;
  balanceMinor: number;
  note: string | null;
};

type SalesPage = { items: SaleRow[]; total: number; page: number; pageSize: number };

const STATUS_FILTERS = ["ALL", "UNPAID", "PARTIAL", "PAID"] as const;

const MONTH_RE = /^\d{4}-\d{2}$/;

/** Localized short month label for a YYYY-MM key ("Sep 2026" / "شهریور ۱۴۰۵"). */
function fmtMonthLabel(key: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : "en-GB", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${key}-01T00:00:00Z`));
  } catch {
    return key;
  }
}

/** Sales module — invoice list, totals strip, create + detail + delete. */
export function SalesView({
  business,
  role,
}: {
  business: BusinessSummary;
  role: Role;
}) {
  const t = useTranslations("finance.sales");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const uiLocale = useLocale();
  const invalidate = useInvalidateFinance();
  const view = useAppStore((s) => s.view);
  const navigate = useAppStore((s) => s.navigate);

  const writable = can(asRole(role), "data:write");
  const canPay = can(asRole(role), "finance:manage");

  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("ALL");
  const [formOpen, setFormOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  // Month drill-down deep link (#/sales?month=YYYY-MM, "Open in Sales" from
  // the reports month dialog). The param lives in the URL — shareable and
  // back/forward safe; the ✕ on the chip clears it.
  const month =
    view.kind === "module" && view.module === "sales" && view.param && MONTH_RE.test(view.param)
      ? view.param
      : null;

  // Render-time reset (React docs "adjusting state when a prop changes"):
  // a new month deep link/page param flips back to page 1 without an effect.
  const [pageKey, setPageKey] = useState(month ?? "");
  if ((month ?? "") !== pageKey) {
    setPageKey(month ?? "");
    setPage(1);
  }

  const statusQs = status === "ALL" ? "" : `&status=${status}`;
  const monthQs = month ? `&month=${month}` : "";
  const { data, isLoading, error, refetch } = useQuery<SalesPage>({
    queryKey: [...txKeys.sales, q, page, status, month],
    queryFn: () =>
      api(`/api/v1/sales?q=${encodeURIComponent(q)}&page=${page}&pageSize=10${statusQs}${monthQs}`),
  });

  const monthLabel = useMemo(
    () => (month ? fmtMonthLabel(month, uiLocale) : null),
    [month, uiLocale],
  );

  // Small aggregate strip over the first page is not a total — the honest
  // totals come from the dedicated receivables view; here we show the
  // loaded page count only (no invented numbers).
  const items = data?.items ?? [];

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => api(`/api/v1/sales/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: t("deletedToast") });
      invalidate();
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  // Three empty-state variants, rendered inside the DataTable's colSpan row
  // (only when a page has no rows and no skeleton is up):
  // 1. no data & no filters at all → create CTA;
  // 2. month deep-link with zero rows → clear-filter CTA;
  // 3. otherwise (search/status filtered) → search hint.
  const emptyState =
    !q && status === "ALL" && !month ? (
      <EmptyState
        icon={ShoppingCart}
        title={t("empty")}
        description={t("emptyDesc")}
        action={
          writable ? (
            <Button size="sm" variant="outline" onClick={() => setFormOpen(true)}>
              <Plus className="size-4" aria-hidden="true" />
              {t("newInvoice")}
            </Button>
          ) : null
        }
      />
    ) : month ? (
      <EmptyState
        icon={CalendarDays}
        title={t("monthEmptyTitle")}
        description={t("monthEmptyDesc", { month: monthLabel ?? month })}
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate({ kind: "module", module: "sales" })}
          >
            {t("monthFilterClear")}
          </Button>
        }
      />
    ) : (
      <EmptyState icon={ShoppingCart} title={tCommon("search")} description={t("searchPlaceholder")} />
    );

  return (
    <div className="space-y-6" data-view="module:sales">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          writable ? (
            <Button onClick={() => setFormOpen(true)} size="sm">
              <Plus className="size-4" aria-hidden="true" />
              {t("newInvoice")}
            </Button>
          ) : null
        }
      />

      {error ? (
        <div className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm">
          {tErrors("loadFailed")}{" "}
          <button className="underline" onClick={() => void refetch()}>
            {tCommon("retry")}
          </button>
        </div>
      ) : null}

      {month ? (
        <div
          className="border-amber-500/30 bg-amber-500/5 text-amber-800 dark:text-amber-300 inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium"
          data-testid="sales-month-chip"
        >
          <CalendarDays className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">
            {t("monthFiltered", { month: monthLabel ?? month })}
          </span>
          <button
            type="button"
            onClick={() => navigate({ kind: "module", module: "sales" })}
            aria-label={t("monthFilterClear")}
            title={t("monthFilterClear")}
            className="hover:bg-amber-500/15 -me-1 rounded-full p-0.5 transition-colors"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <Card>
        <CardContent className="pt-6">
          <DataTableToolbar>
            <SearchInput
              value={q}
              onChange={(v) => {
                setQ(v);
                setPage(1);
              }}
              placeholder={t("searchPlaceholder")}
            />
            <Select
              value={status}
              onValueChange={(v) => {
                setStatus(v as (typeof STATUS_FILTERS)[number]);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label={t("statusFilter")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_FILTERS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s === "ALL" ? t("allStatuses") : t(`status_${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </DataTableToolbar>

          <DataTable<SaleRow>
            ariaLabel={t("title")}
            sortLocale={business.locale}
            columns={[
              {
                id: "invoice",
                header: t("colInvoice"),
                sortValue: (s) => s.number,
                cell: (s) => (
                  <div className="min-w-0">
                    <button
                      className="hover:text-primary font-mono text-[13px] font-semibold tracking-tight hover:underline"
                      dir="ltr"
                      onClick={() => setDetailId(s.id)}
                    >
                      {`INV-${String(s.number).padStart(4, "0")}`}
                    </button>
                    {s.note ? (
                      <p className="text-muted-foreground max-w-40 truncate text-xs" dir="auto">
                        {s.note}
                      </p>
                    ) : null}
                  </div>
                ),
              },
              {
                id: "customer",
                header: t("colCustomer"),
                cell: (s) => (
                  <div className="max-w-36 truncate" dir="auto">
                    {s.customerName ?? (
                      <span className="text-muted-foreground">{t("walkIn")}</span>
                    )}
                  </div>
                ),
              },
              {
                id: "date",
                header: t("colDate"),
                hideBelow: "sm",
                sortValue: (s) => s.issueDate,
                defaultSortDir: "desc",
                cell: (s) => (
                  <span className="text-muted-foreground text-sm whitespace-nowrap">
                    {fmtDate(business, s.issueDate)}
                  </span>
                ),
              },
              {
                id: "total",
                header: t("colTotal"),
                align: "end",
                sortValue: (s) => s.totalMinor,
                cell: (s) => <Ltr className="font-medium">{fmtMoney(business, s.totalMinor)}</Ltr>,
              },
              {
                id: "balance",
                header: t("colBalance"),
                align: "end",
                hideBelow: "md",
                cell: (s) => (
                  <Ltr
                    className={
                      s.balanceMinor > 0
                        ? "text-amber-700 dark:text-amber-400"
                        : "text-emerald-700 dark:text-emerald-400"
                    }
                  >
                    {fmtMoney(business, s.balanceMinor)}
                  </Ltr>
                ),
              },
              {
                id: "status",
                header: t("colStatus"),
                cell: (s) => <FinanceStatusBadge status={s.status} />,
              },
              {
                id: "actions",
                header: tCommon("actions"),
                align: "end",
                cell: (s) => (
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      onClick={() => setDetailId(s.id)}
                      aria-label={t("view")}
                    >
                      <Eye className="size-4" aria-hidden="true" />
                    </Button>
                    {writable ? (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:text-destructive size-8"
                            aria-label={tCommon("delete")}
                          >
                            <Trash2 className="size-4" aria-hidden="true" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
                            <AlertDialogDescription>{t("deleteDesc")}</AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              onClick={() => deleteMutation.mutate(s.id)}
                            >
                              {tCommon("delete")}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    ) : null}
                  </div>
                ),
              },
            ]}
            rows={items}
            getRowId={(s) => s.id}
            loading={isLoading}
            skeletonRows={5}
            empty={emptyState}
          />
          {items.length > 0 ? (
            <Pagination
              page={page}
              pageSize={10}
              total={data?.total ?? 0}
              onPage={setPage}
              labels={{
                prev: tCommon("previous"),
                next: tCommon("next")
              }}
            />
          ) : null}
        </CardContent>
      </Card>

      <SaleFormDialog open={formOpen} onOpenChange={setFormOpen} business={business} />
      <SaleDetailDialog
        saleId={detailId}
        onOpenChange={(v) => setDetailId(v ? detailId : null)}
        business={business}
        canPay={canPay}
      />
    </div>
  );
}
