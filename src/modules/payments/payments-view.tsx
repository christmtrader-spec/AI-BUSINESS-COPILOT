"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ArrowDownToLine, Plus, Trash2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { can, asRole, type Role } from "@/lib/rbac";
import { useAppStore } from "@/store/app-store";
import { useQuickIntent } from "@/hooks/use-quick-intent";
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
import { Badge } from "@/components/ui/badge";
import { EmptyState, PageHeader } from "@/components/shared/primitives";
import { DataTable, DataTableToolbar, Ltr } from "@/components/shared/data-table";
import { ListExportButton } from "@/components/shared/list-export-button";
import { Pagination, SearchInput } from "@/components/shared/table-kit";
import { fetchAllPages } from "@/lib/csv";
import { fmtDate, fmtMoney, txKeys, useInvalidateFinance } from "../finance-shared/finance-kit";
import { PaymentFormDialog } from "./payment-form-dialog";
import { navigateToEntity } from "@/modules/entities/entity-route";
import { invalidateEntityDetail } from "@/modules/entities/entity-api";
import type { BusinessSummary } from "../shell/types";

type PaymentRow = {
  id: string;
  direction: "IN" | "OUT";
  saleId: string | null;
  saleNumber: number | null;
  customerName: string | null;
  expenseId: string | null;
  expenseCategory: string | null;
  supplierName: string | null;
  amountMinor: number;
  method: string;
  note: string | null;
  paidAt: string;
  actorName: string | null;
};

type PaymentsPage = { items: PaymentRow[]; total: number; page: number; pageSize: number };

const DIRECTIONS = ["ALL", "IN", "OUT"] as const;

/** Payments module — unified money-in/money-out ledger. */
export function PaymentsView({
  business,
  role,
}: {
  business: BusinessSummary;
  role: Role;
}) {
  const t = useTranslations("finance.payments");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const invalidate = useInvalidateFinance();
  const queryClient = useQueryClient();
  const businessId = useAppStore((s) => s.activeBusinessId);

  const canPay = can(asRole(role), "finance:manage");

  const [page, setPage] = useState(1);
  const [direction, setDirection] = useState<(typeof DIRECTIONS)[number]>("ALL");
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  // Prompt 52 §F2 — dashboard quick action: open the record-payment dialog on arrival.
  useQuickIntent("new-payment", () => setFormOpen(true));

  const dirQs = direction === "ALL" ? "" : `&direction=${direction}`;
  const qQs = search ? `&q=${encodeURIComponent(search)}` : "";
  const { data, isLoading, isFetching, error, refetch } = useQuery<PaymentsPage>({
    queryKey: [...txKeys.payments, page, direction, search],
    queryFn: () => api(`/api/v1/payments?page=${page}&pageSize=15${dirQs}${qQs}`),
  });

  const deleteMutation = useMutation({
    mutationFn: async (row: PaymentRow) => api(`/api/v1/payments/${row.id}`, { method: "DELETE" }),
    onSuccess: (_data, row) => {
      toast({ title: t("deletedToast") });
      invalidate();
      // Prompt 34 §37 — targeted: reversed payment + its related document.
      invalidateEntityDetail(queryClient, businessId, "payment", row.id);
      if (row.saleId) invalidateEntityDetail(queryClient, businessId, "sale", row.saleId);
      if (row.expenseId) invalidateEntityDetail(queryClient, businessId, "expense", row.expenseId);
    },
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : tErrors("generic"),
        variant: "destructive",
      });
    },
  });

  const items = data?.items ?? [];
  const tPay = useTranslations("finance.paymentForm");

  function partyLabel(p: PaymentRow): string {
    if (p.direction === "IN") {
      return `${t("invoiceShort")} ${p.saleNumber != null ? `INV-${String(p.saleNumber).padStart(4, "0")}` : "—"}${p.customerName ? ` · ${p.customerName}` : ""}`;
    }
    return `${p.expenseCategory ?? "—"}${p.supplierName ? ` · ${p.supplierName}` : ""}`;
  }

  return (
    <div className="space-y-6" data-view="module:payments">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <>
            <ListExportButton<PaymentRow>
              filename="payments"
              columns={[
                { header: t("colDate"), value: (p) => p.paidAt },
                { header: t("colDirection"), value: (p) => p.direction },
                {
                  header: t("colTarget"),
                  value: (p) =>
                    p.direction === "IN"
                      ? `INV-${String(p.saleNumber ?? 0).padStart(4, "0")}${p.customerName ? ` · ${p.customerName}` : ""}`
                      : `${p.expenseCategory ?? ""}${p.supplierName ? ` · ${p.supplierName}` : ""}`,
                },
                { header: t("colAmount"), value: (p) => p.amountMinor / 10 ** business.decimalPrecision },
                { header: t("colMethod"), value: (p) => tPay(`methods.${p.method}`) },
                { header: t("colNote"), value: (p) => p.note ?? "" },
                { header: t("colBy"), value: (p) => p.actorName ?? "" },
              ]}
              fetchRows={() =>
                fetchAllPages<PaymentRow>((pg, ps) =>
                  api(`/api/v1/payments?page=${pg}&pageSize=${ps}${dirQs}${qQs}`),
                )
              }
            />
            {canPay ? (
              <Button onClick={() => setFormOpen(true)} size="sm">
                <Plus className="size-4" aria-hidden="true" />
                {t("recordPayment")}
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

      <Card>
        <CardContent className="pt-6">
          <DataTableToolbar>
            <SearchInput
              value={search}
              onChange={(v) => {
                setSearch(v);
                setPage(1);
              }}
              placeholder={t("searchPlaceholder")}
            />
            <Select
              value={direction}
              onValueChange={(v) => {
                setDirection(v as (typeof DIRECTIONS)[number]);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-full sm:w-48" aria-label={t("directionFilter")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIRECTIONS.map((d) => (
                  <SelectItem key={d} value={d}>
                    {d === "ALL" ? t("allDirections") : t(`dir_${d}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </DataTableToolbar>

          <DataTable<PaymentRow>
            ariaLabel={t("title")}
            sortLocale={business.locale}
            refreshing={isFetching && !isLoading}
            onRowClick={(row) => navigateToEntity("payment", row.id)}
            columns={[
              {
                id: "date",
                header: t("colDate"),
                sortValue: (p) => p.paidAt,
                defaultSortDir: "desc",
                cell: (p) => (
                  <span className="text-muted-foreground text-sm tabular-nums whitespace-nowrap">
                    {fmtDate(business, p.paidAt)}
                  </span>
                ),
              },
              {
                id: "direction",
                header: t("colDirection"),
                cell: (p) => (
                  <Badge
                    variant="outline"
                    className={
                      p.direction === "IN"
                        ? "border-emerald-300/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                        : "border-rose-300/60 bg-rose-500/10 text-rose-700 dark:text-rose-400"
                    }
                  >
                    {p.direction === "IN" ? t("dir_IN") : t("dir_OUT")}
                  </Badge>
                ),
              },
              {
                id: "target",
                header: t("colTarget"),
                cell: (p) => (
                  <div className="text-sm">
                    <div className="max-w-44 truncate">{partyLabel(p)}</div>
                    {p.note ? (
                      <p className="text-muted-foreground max-w-44 truncate text-xs">
                        {p.note}
                      </p>
                    ) : null}
                  </div>
                ),
              },
              {
                id: "method",
                header: t("colMethod"),
                hideBelow: "md",
                cell: (p) => (
                  <span className="text-muted-foreground text-sm">
                    {tPay(`methods.${p.method}`)}
                  </span>
                ),
              },
              {
                id: "amount",
                header: t("colAmount"),
                align: "end",
                sortValue: (p) => p.amountMinor,
                cell: (p) => (
                  <Ltr
                    className={
                      p.direction === "IN"
                        ? "font-medium text-emerald-700 dark:text-emerald-400"
                        : "font-medium text-rose-700 dark:text-rose-400"
                    }
                  >
                    {p.direction === "IN" ? "+" : "−"}
                    {fmtMoney(business, p.amountMinor)}
                  </Ltr>
                ),
              },
              ...(canPay
                ? [
                    {
                      id: "actions",
                      header: tCommon("actions"),
                      align: "end" as const,
                      cell: (p: PaymentRow) => (
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
                                onClick={() => deleteMutation.mutate(p)}
                              >
                                {tCommon("delete")}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      ),
                    },
                  ]
                : []),
            ]}
            rows={items}
            getRowId={(p) => p.id}
            loading={isLoading}
            skeletonRows={6}
            empty={
              direction === "ALL" && !search ? (
                <EmptyState
                  icon={ArrowDownToLine}
                  title={t("empty")}
                  description={t("emptyDesc")}
                  action={
                    canPay ? (
                      <Button size="sm" variant="outline" onClick={() => setFormOpen(true)}>
                        <Plus className="size-4" aria-hidden="true" />
                        {t("recordPayment")}
                      </Button>
                    ) : null
                  }
                />
              ) : (
                <EmptyState icon={ArrowDownToLine} title={t("emptyFiltered")} />
              )
            }
          />
          <Pagination
            page={page}
            pageSize={15}
            total={data?.total ?? 0}
            onPage={setPage}
            labels={{
              prev: tCommon("previous"),
              next: tCommon("next")
            }}
          />
        </CardContent>
      </Card>

      <PaymentFormDialog open={formOpen} onOpenChange={setFormOpen} business={business} />
    </div>
  );
}
