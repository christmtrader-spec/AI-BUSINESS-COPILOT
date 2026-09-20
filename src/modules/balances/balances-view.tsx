"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Banknote, HandCoins } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { EmptyState, PageHeader } from "@/components/shared/primitives";
import { Pagination, SearchInput } from "@/components/shared/table-kit";
import {
  FinanceStatusBadge,
  StatCard,
  fmtDate,
  fmtMoney,
  txKeys,
} from "../finance-shared/finance-kit";
import { PaymentFormDialog, type PaymentTarget } from "../payments/payment-form-dialog";
import {
  fetchBalancesData,
  type BalancesData,
  type BalanceItem,
} from "./balances-data";
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

  const { data, isLoading, error, refetch } = useQuery<BalancesData>({
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
          <div className="mb-4">
            <SearchInput
              value={q}
              onChange={(v) => {
                setQ(v);
                setPage(1);
              }}
              placeholder={t("searchPlaceholder")}
            />
          </div>

          {isLoading ? (
            <div className="space-y-2" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="bg-muted/50 h-12 animate-pulse rounded-md" />
              ))}
            </div>
          ) : error ? (
            <div className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm">
              {t("loadFailed")}{" "}
              <button className="underline" onClick={() => void refetch()}>
                {tCommon("retry")}
              </button>
            </div>
          ) : (data?.items ?? []).length === 0 ? (
            <EmptyState icon={HandCoins} title={t("allSettled")} description={t("allSettledDesc")} />
          ) : pageItems.length === 0 ? (
            <EmptyState icon={HandCoins} title={tCommon("search")} description={t("searchPlaceholder")} />
          ) : (
            <>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead>{t("colRef")}</TableHead>
                      <TableHead>{t("colParty")}</TableHead>
                      <TableHead className="hidden sm:table-cell">{t("colDate")}</TableHead>
                      <TableHead className="hidden text-end md:table-cell">{t("colAmount")}</TableHead>
                      <TableHead className="text-end">{t("colBalance")}</TableHead>
                      <TableHead>{t("colStatus")}</TableHead>
                      {canPay ? (
                        <TableHead className="text-end">{tCommon("actions")}</TableHead>
                      ) : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageItems.map((i) => (
                      <TableRow key={i.id} className="hover:bg-muted/40">
                        <TableCell className="font-medium" dir="ltr">
                          {i.label1}
                        </TableCell>
                        <TableCell className="max-w-36 truncate" dir="auto">
                          {i.label2 ?? <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-muted-foreground hidden whitespace-nowrap text-sm sm:table-cell">
                          {fmtDate(business, i.date)}
                        </TableCell>
                        <TableCell className="hidden text-end tabular-nums md:table-cell" dir="ltr">
                          {fmtMoney(business, i.amountMinor)}
                        </TableCell>
                        <TableCell
                          className="text-end font-medium text-amber-700 tabular-nums dark:text-amber-400"
                          dir="ltr"
                        >
                          {fmtMoney(business, i.balanceMinor)}
                        </TableCell>
                        <TableCell>
                          <FinanceStatusBadge status={i.status} />
                        </TableCell>
                        {canPay ? (
                          <TableCell className="text-end">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-8"
                              onClick={() => setPayTarget(toTarget(i))}
                            >
                              <Banknote className="size-4" aria-hidden="true" />
                              {t("pay")}
                            </Button>
                          </TableCell>
                        ) : null}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
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
