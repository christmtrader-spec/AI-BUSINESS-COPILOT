"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Eye, Plus, ShoppingCart, Trash2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { can, asRole, type Role } from "@/lib/rbac";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  const invalidate = useInvalidateFinance();

  const writable = can(asRole(role), "data:write");
  const canPay = can(asRole(role), "finance:manage");

  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("ALL");
  const [formOpen, setFormOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const statusQs = status === "ALL" ? "" : `&status=${status}`;
  const { data, isLoading, error, refetch } = useQuery<SalesPage>({
    queryKey: [...txKeys.sales, q, page, status],
    queryFn: () =>
      api(`/api/v1/sales?q=${encodeURIComponent(q)}&page=${page}&pageSize=10${statusQs}`),
  });

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

      <Card>
        <CardContent className="pt-6">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
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
          </div>

          {isLoading ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="bg-muted/50 h-12 animate-pulse rounded-md" />
              ))}
            </div>
          ) : items.length === 0 && !q && status === "ALL" ? (
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
          ) : items.length === 0 ? (
            <EmptyState icon={ShoppingCart} title={tCommon("search")} description={t("searchPlaceholder")} />
          ) : (
            <>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead>{t("colInvoice")}</TableHead>
                      <TableHead>{t("colCustomer")}</TableHead>
                      <TableHead className="hidden sm:table-cell">{t("colDate")}</TableHead>
                      <TableHead className="text-end">{t("colTotal")}</TableHead>
                      <TableHead className="hidden text-end md:table-cell">{t("colBalance")}</TableHead>
                      <TableHead>{t("colStatus")}</TableHead>
                      <TableHead className="text-end">{tCommon("actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((s) => (
                      <TableRow key={s.id} className="hover:bg-muted/40">
                        <TableCell>
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
                        </TableCell>
                        <TableCell className="max-w-36 truncate" dir="auto">
                          {s.customerName ?? <span className="text-muted-foreground">{t("walkIn")}</span>}
                        </TableCell>
                        <TableCell className="text-muted-foreground hidden whitespace-nowrap text-sm sm:table-cell">
                          {fmtDate(business, s.issueDate)}
                        </TableCell>
                        <TableCell className="text-end font-medium tabular-nums" dir="ltr">
                          {fmtMoney(business, s.totalMinor)}
                        </TableCell>
                        <TableCell
                          className={`hidden text-end tabular-nums md:table-cell ${
                            s.balanceMinor > 0 ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"
                          }`}
                          dir="ltr"
                        >
                          {fmtMoney(business, s.balanceMinor)}
                        </TableCell>
                        <TableCell>
                          <FinanceStatusBadge status={s.status} />
                        </TableCell>
                        <TableCell className="text-end">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              onClick={() => setDetailId(s.id)}
                              aria-label={t("view")}
                            >
                              <Eye className="size-4" />
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
                                    <Trash2 className="size-4" />
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
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <Pagination
                page={page}
                pageSize={10}
                total={data?.total ?? 0}
                onPage={setPage}
                labels={{
                  prev: tCommon("previous"),
                  next: tCommon("next"),
                  of: business.locale === "fa" ? "از" : "of",
                }}
              />
            </>
          )}
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
