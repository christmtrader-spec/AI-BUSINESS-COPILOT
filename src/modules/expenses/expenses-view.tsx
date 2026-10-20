"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { Banknote, CalendarDays, Download, Pencil, Plus, Trash2, Wallet, X } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { downloadCsv, exportStamp, fetchAllPages, toCsv } from "@/lib/csv";
import { can, asRole, type Role } from "@/lib/rbac";
import { useAppStore } from "@/store/app-store";
import { useQuickIntent } from "@/hooks/use-quick-intent";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { PaymentFormDialog, type PaymentTarget } from "../payments/payment-form-dialog";
import { ExpenseFormDialog } from "./expense-form-dialog";
import { navigateToEntity } from "@/modules/entities/entity-route";
import { invalidateEntityDetail } from "@/modules/entities/entity-api";import type { BusinessSummary } from "../shell/types";

type ExpenseRow = {
  id: string;
  supplierName: string | null;
  category: string;
  amountMinor: number;
  paidMinor: number;
  status: string;
  balanceMinor: number;
  spentAt: string;
  dueDate: string | null;
  reference: string | null;
  note: string | null;
};

type ExpensesPage = { items: ExpenseRow[]; total: number; page: number; pageSize: number };

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

/** Expenses module — record costs, track paid/balance, pay suppliers. */
export function ExpensesView({
  business,
  role,
}: {
  business: BusinessSummary;
  role: Role;
}) {
  const t = useTranslations("finance.expenses");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const uiLocale = useLocale();
  const invalidate = useInvalidateFinance();
  const view = useAppStore((s) => s.view);
  const navigate = useAppStore((s) => s.navigate);
  const queryClient = useQueryClient();
  const businessId = useAppStore((s) => s.activeBusinessId);

  const writable = can(asRole(role), "data:write");
  const canPay = can(asRole(role), "finance:manage");

  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("ALL");
  const [dialogOpen, setDialogOpen] = useState(false);
  // Prompt 52 §F2 — dashboard quick action: open the create dialog on arrival.
  useQuickIntent("new-expense", () => setDialogOpen(true));
  const [editing, setEditing] = useState<ExpenseRow | null>(null);
  const [payTarget, setPayTarget] = useState<PaymentTarget | null>(null);

  // Month drill-down deep link (#/expenses?month=YYYY-MM, "Open in Expenses"
  // from the reports month dialog) — same bucket as the MoM table.
  const month =
    view.kind === "module" && view.module === "expenses" && view.param && MONTH_RE.test(view.param)
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
  const { data, isLoading, isFetching, error, refetch } = useQuery<ExpensesPage>({
    queryKey: [...txKeys.expenses, q, page, status, month],
    queryFn: () =>
      api(`/api/v1/expenses?q=${encodeURIComponent(q)}&page=${page}&pageSize=10${statusQs}${monthQs}`),
  });

  const monthLabel = useMemo(
    () => (month ? fmtMonthLabel(month, uiLocale) : null),
    [month, uiLocale],
  );

  function openCreate() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(e: ExpenseRow) {
    setEditing(e);
    setDialogOpen(true);
  }

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => api(`/api/v1/expenses/${id}`, { method: "DELETE" }),
    onSuccess: (_data, id) => {
      toast({ title: t("deletedToast") });
      invalidate();
      // Prompt 34 §37 — cached detail must not resurrect a deleted expense.
      invalidateEntityDetail(queryClient, businessId, "expense", id);
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  const items = data?.items ?? [];

  // Export expenses as CSV — mirrors the ACTIVE filters (search/status/month)
  // so the file matches the visible list; fetchAllPages walks the server's
  // 100-row page cap and reports truncation honestly (r23).
  const exportMutation = useMutation({
    mutationFn: async () => {
      const { rows, total: grand, truncated } = await fetchAllPages<ExpenseRow>((pg, pageSize) =>
        api<ExpensesPage>(
          `/api/v1/expenses?q=${encodeURIComponent(q)}&page=${pg}&pageSize=${pageSize}${statusQs}${monthQs}`,
        ),
      );
      const csv = toCsv(
        [t("colDate"), t("colCategory"), t("colSupplier"), t("colDue"), t("colAmount"), t("colPaid"), t("colBalance"), t("colStatus"), t("reference"), t("colNote")],
        rows.map((e) => [
          fmtDate(business, e.spentAt),
          e.category,
          e.supplierName ?? "—",
          e.dueDate ? fmtDate(business, e.dueDate) : "",
          fmtMoney(business, e.amountMinor),
          fmtMoney(business, e.paidMinor),
          fmtMoney(business, e.balanceMinor),
          e.status,
          e.reference ?? "",
          e.note ?? "",
        ]),
      );
      downloadCsv(`expenses-${exportStamp()}.csv`, csv);
      return { exported: rows.length, total: grand, truncated };
    },
    onSuccess: ({ exported, total: grand, truncated }) =>
      toast({
        title: truncated
          ? tCommon("exportedTruncated", { count: exported, total: grand })
          : tCommon("exportedCount", { count: exported }),
      }),
    onError: () => toast({ title: tCommon("exportFailed"), variant: "destructive" }),
  });

  return (
    <div className="space-y-6" data-view="module:expenses">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={exportMutation.isPending}
              onClick={() => exportMutation.mutate()}
            >
              <Download className="size-4" aria-hidden="true" />
              {exportMutation.isPending ? tCommon("exportingCsv") : tCommon("exportCsv")}
            </Button>
            {writable ? (
              <Button onClick={openCreate} size="sm">
                <Plus className="size-4" aria-hidden="true" />
                {t("addExpense")}
              </Button>
            ) : null}
          </>
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
          data-testid="expenses-month-chip"
        >
          <CalendarDays className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">
            {t("monthFiltered", { month: monthLabel ?? month })}
          </span>
          <button
            type="button"
            onClick={() => navigate({ kind: "module", module: "expenses" })}
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

          <DataTable<ExpenseRow>
            ariaLabel={t("title")}
            sortLocale={business.locale}
            refreshing={isFetching && !isLoading}
            columns={[
              {
                id: "category",
                header: t("colCategory"),
                cell: (e) => (
                  <div>
                    <span className="font-medium">{e.category}</span>
                    {e.reference ? (
                      <p className="text-muted-foreground max-w-40 truncate text-xs">
                        <Ltr>{e.reference}</Ltr>
                      </p>
                    ) : null}
                    {e.note ? (
                      <p className="text-muted-foreground max-w-40 truncate text-xs">
                        {e.note}
                      </p>
                    ) : null}
                  </div>
                ),
              },
              {
                id: "supplier",
                header: t("colSupplier"),
                hideBelow: "md",
                cell: (e) =>
                  e.supplierName ? (
                    <div className="max-w-36 truncate text-sm">{e.supplierName}</div>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  ),
              },
              {
                id: "date",
                header: t("colDate"),
                hideBelow: "sm",
                sortValue: (e) => e.spentAt,
                defaultSortDir: "desc",
                cell: (e) => (
                  <span className="text-muted-foreground text-sm tabular-nums whitespace-nowrap">
                    {fmtDate(business, e.spentAt)}
                  </span>
                ),
              },
              {
                id: "due",
                header: t("colDue"),
                hideBelow: "md",
                sortValue: (e) => e.dueDate ?? "",
                cell: (e) =>
                  e.dueDate ? (
                    <span className="text-sm tabular-nums whitespace-nowrap">
                      {fmtDate(business, e.dueDate)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground text-sm">—</span>
                  ),
              },
              {
                id: "amount",
                header: t("colAmount"),
                align: "end",
                sortValue: (e) => e.amountMinor,
                cell: (e) => (
                  <Ltr className="font-medium">{fmtMoney(business, e.amountMinor)}</Ltr>
                ),
              },
              {
                id: "balance",
                header: t("colBalance"),
                align: "end",
                hideBelow: "md",
                cell: (e) => (
                  <Ltr
                    className={
                      e.balanceMinor > 0
                        ? "text-amber-700 dark:text-amber-400"
                        : "text-emerald-700 dark:text-emerald-400"
                    }
                  >
                    {fmtMoney(business, e.balanceMinor)}
                  </Ltr>
                ),
              },
              {
                id: "status",
                header: t("colStatus"),
                cell: (e) => <FinanceStatusBadge status={e.status} />,
              },
              ...(writable || canPay
                ? [
                    {
                      id: "actions",
                      header: tCommon("actions"),
                      align: "end" as const,
                      cell: (e: ExpenseRow) => (
                        <div className="flex items-center justify-end gap-1">
                          {canPay && e.balanceMinor > 0 ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              onClick={() =>
                                setPayTarget({
                                  kind: "expense",
                                  id: e.id,
                                  category: e.category,
                                  supplierName: e.supplierName,
                                  balanceMinor: e.balanceMinor,
                                })
                              }
                              aria-label={t("pay")}
                            >
                              <Banknote className="size-4" aria-hidden="true" />
                            </Button>
                          ) : null}
                          {writable ? (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8"
                                onClick={() => openEdit(e)}
                                aria-label={tCommon("edit")}
                              >
                                <Pencil className="size-4" aria-hidden="true" />
                              </Button>
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
                                    <AlertDialogDescription>
                                      {t("deleteDesc")}
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
                                    <AlertDialogAction
                                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                      onClick={() => deleteMutation.mutate(e.id)}
                                    >
                                      {tCommon("delete")}
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            </>
                          ) : null}
                        </div>
                      ),
                    },
                  ]
                : []),
            ]}
            rows={items}
            getRowId={(e) => e.id}
            loading={isLoading}
            skeletonRows={5}
            onRowClick={(e) => navigateToEntity("expense", e.id)}
            empty={
              !q && status === "ALL" && !month ? (
                <EmptyState
                  icon={Wallet}
                  title={t("empty")}
                  description={t("emptyDesc")}
                  action={
                    writable ? (
                      <Button size="sm" variant="outline" onClick={openCreate}>
                        <Plus className="size-4" aria-hidden="true" />
                        {t("addExpense")}
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
                      onClick={() => navigate({ kind: "module", module: "expenses" })}
                    >
                      {t("monthFilterClear")}
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={Wallet}
                  title={tCommon("search")}
                  description={t("searchPlaceholder")}
                />
              )
            }
          />
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
        </CardContent>
      </Card>

      <ExpenseFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        business={business}
      />

      <PaymentFormDialog
        open={payTarget != null}
        onOpenChange={(v) => setPayTarget(v ? payTarget : null)}
        business={business}
        presetTarget={payTarget}
      />
    </div>
  );
}
