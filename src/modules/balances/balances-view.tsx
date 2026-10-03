"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Banknote, HandCoins } from "lucide-react";
import { can, asRole, type Role } from "@/lib/rbac";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState, PageHeader } from "@/components/shared/primitives";
import { DataTable, DataTableToolbar, Ltr } from "@/components/shared/data-table";
import { Pagination, SearchInput } from "@/components/shared/table-kit";
import {
  FinanceStatusBadge,
  StatCard,
  fmtDate,
  fmtMoney,
  txKeys,
} from "../finance-shared/finance-kit";
import { PaymentFormDialog, type PaymentTarget } from "../payments/payment-form-dialog";
import { fetchBalancesData, type BalancesData, type BalanceItem } from "./balances-data";
import { AgingCard } from "./aging-card";
import type { BusinessSummary } from "../shell/types";

/**
 * Shared outstanding-balances view for receivables (who owes us) and
 * payables (whom we owe) — Rule 04. Sums are computed server-side from
 * integer minor units; the UI never invents numbers.
 */
export function BalancesView({
  kind,
  business,
  role,
}: {
  kind: "receivables" | "payables";
  business: BusinessSummary;
  role: Role;
}) {
  const t = useTranslations(kind === "receivables" ? "finance.receivables" : "finance.payables");
  const tCommon = useTranslations("common");
  const canPay = can(asRole(role), "finance:manage");

  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [payTarget, setPayTarget] = useState<PaymentTarget | null>(null);

  const { data, isLoading, isFetching, error, refetch } = useQuery<BalancesData>({
    queryKey: kind === "receivables" ? txKeys.receivables : txKeys.payables,
    // Shared fetch+transform — the shell prefetcher uses the same function,
    // so a warmed cache entry always has this exact shape.
    queryFn: () => fetchBalancesData(kind),
  });

  // Client-side filter over the (capped) open items list + local pagination.
  const filtered = (data?.items ?? []).filter((i) => {
    if (!q) return true;
    const hay = `${i.label1} ${i.label2 ?? ""}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });
  const pageSize = 10;
  const pageItems = filtered.slice((page - 1) * pageSize, page * pageSize);

  function toTarget(i: BalanceItem): PaymentTarget {
    if (kind === "receivables") {
      return {
        kind: "sale",
        id: i.id,
        number: Number(i.label1.replace(/^INV-/, "")) || 0,
        customerName: i.label2,
        balanceMinor: i.balanceMinor,
      };
    }
    return {
      kind: "expense",
      id: i.id,
      category: i.label1,
      supplierName: i.label2,
      balanceMinor: i.balanceMinor,
    };
  }

  return (
    <div className="space-y-6" data-view={`module:${kind}`}>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label={t("statOutstanding")}
          value={fmtMoney(business, data?.totalOutstandingMinor ?? 0)}
          tone="warning"
        />
        <StatCard label={t("statOpenCount")} value={String(data?.openCount ?? 0)} />
        <StatCard
          label={t("statTopParty")}
          value={data?.byParty[0]?.name ?? "—"}
          hint={data?.byParty[0] ? fmtMoney(business, data.byParty[0].balanceMinor) : undefined}
        />
      </div>

      <AgingCard kind={kind} business={business} />

      {data && data.byParty.length > 1 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="mb-3 text-sm font-semibold">{t("byParty")}</p>
            <div className="flex flex-wrap gap-2">
              {data.byParty.map((p) => (
                <Badge key={p.name} variant="secondary" className="gap-1.5 px-3 py-1.5" dir="auto">
                  <span className="max-w-40 truncate font-medium">{p.name}</span>
                  <span className="tabular-nums opacity-70" dir="ltr">
                    {fmtMoney(business, p.balanceMinor)}
                  </span>
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="pt-6">
          {error ? (
            <div className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm">
              {t("loadFailed")}{" "}
              <button className="underline" onClick={() => void refetch()}>
                {tCommon("retry")}
              </button>
            </div>
          ) : (
            <>
              <DataTableToolbar>
                <SearchInput
                  value={q}
                  onChange={(v) => {
                    setQ(v);
                    setPage(1);
                  }}
                  placeholder={t("searchPlaceholder")}
                />
              </DataTableToolbar>

              <DataTable<BalanceItem>
                ariaLabel={t("title")}
                sortLocale={business.locale}
                refreshing={isFetching && !isLoading}
                columns={[
                  {
                    id: "ref",
                    header: t("colRef"),
                    cell: (i) => <Ltr className="font-medium">{i.label1}</Ltr>,
                  },
                  {
                    id: "party",
                    header: t("colParty"),
                    cell: (i) =>
                      i.label2 ? (
                        <div className="max-w-36 truncate">{i.label2}</div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      ),
                  },
                  {
                    id: "date",
                    header: t("colDate"),
                    hideBelow: "sm",
                    sortValue: (i) => i.date,
                    defaultSortDir: "desc",
                    cell: (i) => (
                      <span className="text-muted-foreground text-sm tabular-nums whitespace-nowrap">
                        {fmtDate(business, i.date)}
                      </span>
                    ),
                  },
                  ...(kind === "payables"
                    ? [
                        {
                          id: "due",
                          header: t("colDue"),
                          hideBelow: "md" as const,
                          sortValue: (i: BalanceItem) => i.dueDate ?? "",
                          cell: (i: BalanceItem) =>
                            i.dueDate ? (
                              <span className="flex flex-wrap items-center gap-1.5 whitespace-nowrap">
                                <span className="text-muted-foreground text-sm tabular-nums">
                                  {fmtDate(business, i.dueDate)}
                                </span>
                                {i.pastDue ? (
                                  <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
                                    {t("overdueBadge")}
                                  </Badge>
                                ) : null}
                              </span>
                            ) : (
                              <span className="text-muted-foreground text-sm">—</span>
                            ),
                        },
                      ]
                    : []),
                  {
                    id: "amount",
                    header: t("colAmount"),
                    align: "end",
                    hideBelow: "md",
                    cell: (i) => <Ltr>{fmtMoney(business, i.amountMinor)}</Ltr>,
                  },
                  {
                    id: "balance",
                    header: t("colBalance"),
                    align: "end",
                    sortValue: (i) => i.balanceMinor,
                    cell: (i) => (
                      <Ltr className="font-medium text-amber-700 dark:text-amber-400">
                        {fmtMoney(business, i.balanceMinor)}
                      </Ltr>
                    ),
                  },
                  {
                    id: "status",
                    header: t("colStatus"),
                    cell: (i) => <FinanceStatusBadge status={i.status} />,
                  },
                  ...(canPay
                    ? [
                        {
                          id: "actions",
                          header: tCommon("actions"),
                          align: "end" as const,
                          cell: (i: BalanceItem) => (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-8"
                              onClick={() => setPayTarget(toTarget(i))}
                            >
                              <Banknote className="size-4" aria-hidden="true" />
                              {t("pay")}
                            </Button>
                          ),
                        },
                      ]
                    : []),
                ]}
                rows={pageItems}
                getRowId={(i) => i.id}
                loading={isLoading}
                skeletonRows={5}
                empty={
                  (data?.items ?? []).length === 0 ? (
                    <EmptyState
                      icon={HandCoins}
                      title={t("allSettled")}
                      description={t("allSettledDesc")}
                    />
                  ) : (
                    <EmptyState
                      icon={HandCoins}
                      title={tCommon("search")}
                      description={t("searchPlaceholder")}
                    />
                  )
                }
              />
              <Pagination
                page={page}
                pageSize={pageSize}
                total={filtered.length}
                onPage={setPage}
                labels={{
                  prev: tCommon("previous"),
                  next: tCommon("next")
                }}
              />
            </>
          )}
        </CardContent>
      </Card>

      <PaymentFormDialog
        open={payTarget != null}
        onOpenChange={(v) => setPayTarget(v ? payTarget : null)}
        business={business}
        presetTarget={payTarget}
      />
    </div>
  );
}
