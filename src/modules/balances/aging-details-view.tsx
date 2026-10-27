"use client";

/**
 * Prompt 49 (§16) — DETAILED AGING view: the open documents behind the
 * aggregate receivables/payables aging, filterable by bucket / party /
 * past-due with signed-cursor pagination and a complete CSV export.
 *
 * RENDER-ONLY LAW: every figure (age, bucket, outstanding, past-due) is
 * computed SERVER-side by the canonical aging engine — this component never
 * derives a number, never invents a due date, and never calls a customer
 * invoice "overdue" (receivables carry invoice AGE only, §5/§9).
 *
 * Navigation (§11/§13): party → Customer/Supplier 360; source document →
 * the authorized Sale/Expense detail; statement → the party statement.
 * Unassigned parties get NO fabricated destination (§6).
 *
 * STATES: loading · error · party-not-found · empty · data · page-truncated
 * · summary-truncated · exporting — no blank screen anywhere (§140 parity).
 */

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  AlarmClock,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  Receipt,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { AGING_BUCKET_KEYS, type AgingBucketKey } from "@/lib/aging";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/shared/primitives";
import { Ltr } from "@/components/shared/data-table";
import { StatCard, fmtDate, fmtMoney } from "../finance-shared/finance-kit";
// R93 — the presentation twin of the R89 board: ONE pure grouping function
// (client-safe by construction — the module has zero imports), so the table
// sub-groups can never disagree with the party board's order.
import { groupAgingItemsByParty } from "@/lib/aging-groups";
import { navigateToEntity } from "../entities/entity-route";
import { EntityHeader } from "../entities/entity-header";
import { useAppStore } from "@/store/app-store";
import type { BusinessSummary } from "../shell/types";

type AgingDetailItemDto = {
  sourceType: "SALE" | "EXPENSE";
  sourceId: string;
  reference: string;
  partyId: string | null;
  partyName: string | null;
  documentDate: string;
  anchorDate: string;
  dueDate: string | null;
  totalMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  ageDays: number;
  bucket: AgingBucketKey;
  pastDue: boolean;
  supplierBillReference: string | null;
};

type AgingDetailResponse = {
  party: { id: string; name: string } | null;
  summary: {
    asOf: string;
    timezone: string;
    totalOutstandingMinor: number;
    openItemCount: number;
    buckets: { key: AgingBucketKey; minor: number; count: number }[];
    pastDueMinor: number | null;
    pastDueCount: number | null;
    filteredTotalOutstandingMinor: number;
    filteredOpenItemCount: number;
    truncated: boolean;
  };
  items: AgingDetailItemDto[];
  nextCursor: string | null;
  pageTruncated: boolean;
};

const BUCKET_LABEL_KEYS = {
  D0_30: "bucket0_30",
  D31_60: "bucket31_60",
  D61_90: "bucket61_90",
  D90_PLUS: "bucket90Plus",
} as const;

export function AgingDetailsView({
  side,
  business,
  role,
  partyId,
  bucket,
  pastDue,
}: {
  side: "receivables" | "payables";
  business: BusinessSummary;
  role: string;
  partyId: string | null;
  bucket: AgingBucketKey | null;
  pastDue: boolean;
}) {
  void role; // data:read-only view — every role may inspect aging (§7)
  const t = useTranslations("finance.agingDetails");
  const tCommon = useTranslations("common");
  const navigate = useAppStore((s) => s.navigate);
  const activeBusinessId = useAppStore((s) => s.activeBusinessId);

  // Cursor stack (Prev/Next) — the server-generated signed cursor; any
  // filter change resets the stack (§18).
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const hasPrev = cursors.length > 1;

  const params = new URLSearchParams({ side });
  if (partyId) params.set("partyId", partyId);
  if (bucket) params.set("bucket", bucket);
  if (pastDue) params.set("pastDue", "true");
  if (cursor) params.set("cursor", cursor);
  const queryString = params.toString();

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<AgingDetailResponse>({
    queryKey: ["aging-details", business.id, side, partyId ?? null, bucket ?? null, pastDue, cursor],
    queryFn: () =>
      api<AgingDetailResponse>(`/api/v1/reports/aging/items?${queryString}`),
    staleTime: 15_000,
    retry: (failureCount, err) =>
      err instanceof ApiClientError && err.status >= 500 && err.status < 600 ? failureCount < 2 : false,
  });

  const notFound = isError && error instanceof ApiClientError && error.status === 404;
  const items = data?.items ?? [];
  // R93 — per-party sub-grouping of THIS page (presentation-only: it never
  // enters the hash and never touches the export). Disabled when a single
  // party is already filtered (grouping one party is noise).
  const partyGroups = partyId ? null : groupAgingItemsByParty(items);
  const summary = data?.summary ?? null;

  // ---- CSV export (§14) — complete scope or a controlled rejection --------
  const exportMutation = useMutation({
    mutationFn: async () => {
      const exportParams = new URLSearchParams({ side });
      if (partyId) exportParams.set("partyId", partyId);
      if (bucket) exportParams.set("bucket", bucket);
      if (pastDue) exportParams.set("pastDue", "true");
      exportParams.set("locale", business.locale === "fa" ? "fa" : "en");
      const res = await fetch(`/api/v1/reports/aging/items/export?${exportParams.toString()}`, {
        credentials: "same-origin",
        headers: activeBusinessId ? { "x-business-id": activeBusinessId } : undefined,
      });
      if (!res.ok) {
        let message = t("exportFailed");
        try {
          const body = (await res.json()) as {
            error?: { code?: string; details?: { cap?: number } };
          } | null;
          if (body?.error?.code === "RATE_LIMITED") message = t("exportRateLimited");
          if (body?.error?.code === "AGING_EXPORT_TOO_LARGE") {
            message = t("exportTooLarge", { cap: body.error.details?.cap ?? 0 });
          }
        } catch {
          /* non-JSON error body — keep the generic message */
        }
        throw new Error(message);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const dispo = res.headers.get("content-disposition") ?? "";
      a.download =
        /filename="([^"]+)"/.exec(dispo)?.[1] ?? `aging-${side}-detail.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => toast({ title: t("exportToast") }),
    onError: (err) =>
      toast({ title: err instanceof Error ? err.message : t("exportFailed"), variant: "destructive" }),
  });

  const partyName = data?.party?.name ?? null;
  const heading = partyName
    ? t("partyTitle", { party: partyName, side: t(side === "receivables" ? "side_receivables" : "side_payables") })
    : side === "receivables"
      ? t("receivablesTitle")
      : t("payablesTitle");

  const navigateToAging = (next: {
    side?: "receivables" | "payables";
    partyId?: string | null;
    bucket?: AgingBucketKey | null;
    pastDue?: boolean;
  }) => {
    navigate({
      kind: "aging-details",
      side: next.side ?? side,
      partyId: next.partyId !== undefined ? next.partyId : partyId,
      bucket: next.bucket !== undefined ? next.bucket : bucket,
      pastDue: next.pastDue !== undefined ? next.pastDue : pastDue,
    });
  };

  // §11/§13 — authorized source-document navigation only.
  const openSource = (item: AgingDetailItemDto) => {
    if (item.sourceType === "SALE") navigateToEntity("sale", item.sourceId);
    else navigateToEntity("expense", item.sourceId);
  };

  const openStatement = () => {
    if (!partyId) return;
    navigate({
      kind: "statements",
      statementType: side === "receivables" ? "customer" : "supplier",
      id: partyId,
    });
  };

  const dueLabel = (item: AgingDetailItemDto) => {
    if (side !== "payables") return null;
    if (!item.dueDate) return <span className="text-muted-foreground text-xs">{t("noDueDate")}</span>;
    // Due TODAY is not past due (§9) — the dueDate is stored as the
    // UTC-midnoon instant of its calendar day, so the ISO date part IS the
    // business-local day key; comparing it with the server asOf day is exact.
    if (summary && item.dueDate.slice(0, 10) === summary.asOf) {
      return <span className="text-xs tabular-nums">{t("dueToday")}</span>;
    }
    if (item.pastDue) {
      return (
        <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
          {t("pastDueBadge")}
        </Badge>
      );
    }
    return <span className="text-muted-foreground text-xs">{t("notPastDue")}</span>;
  };

  // R93 — ONE row renderer shared by the flat and the grouped table paths
  // (identical DOM either way — grouping only inserts party header rows).
  const renderRow = (item: AgingDetailItemDto) => (
                      <TableRow key={`${item.sourceType}:${item.sourceId}`}>
                        <TableCell className="font-mono text-xs" dir="auto">
                          <Ltr>{item.reference}</Ltr>
                          {item.supplierBillReference ? (
                            <span className="text-muted-foreground block text-[10px]" dir="auto">
                              {item.supplierBillReference}
                            </span>
                          ) : null}
                        </TableCell>
                        {!partyId ? (
                          <TableCell>
                            {item.partyId ? (
                              <button
                                type="button"
                                className="max-w-40 truncate text-sm underline-offset-2 hover:underline"
                                onClick={() =>
                                  navigateToEntity(
                                    item.sourceType === "SALE" ? "customer" : "supplier",
                                    item.partyId!,
                                  )
                                }
                                title={item.partyName ?? undefined}
                              >
                                {item.partyName}
                              </button>
                            ) : (
                              <span className="text-muted-foreground text-sm">{t("unassignedParty")}</span>
                            )}
                          </TableCell>
                        ) : null}
                        <TableCell className="whitespace-nowrap text-sm">
                          {fmtDate(business, item.documentDate)}
                        </TableCell>
                        {side === "payables" ? (
                          <TableCell className="whitespace-nowrap">
                            {item.dueDate ? (
                              <span className="text-muted-foreground text-sm tabular-nums">
                                {fmtDate(business, item.dueDate)}
                              </span>
                            ) : null}
                            <span className="block">{dueLabel(item)}</span>
                          </TableCell>
                        ) : null}
                        <TableCell className="whitespace-nowrap text-sm tabular-nums">
                          {side === "receivables" ? (
                            <span title={t("invoiceAge")}>
                              {t("invoiceAgeDays", { days: item.ageDays })}
                            </span>
                          ) : (
                            t("invoiceAgeDays", { days: item.ageDays })
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[11px] font-medium">
                            {t(BUCKET_LABEL_KEYS[item.bucket])}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-end tabular-nums">
                          <Ltr>{fmtMoney(business, item.totalMinor)}</Ltr>
                        </TableCell>
                        <TableCell className="text-end tabular-nums">
                          <Ltr>{fmtMoney(business, item.paidMinor)}</Ltr>
                        </TableCell>
                        <TableCell className="text-end font-medium tabular-nums">
                          <Ltr className="text-amber-700 dark:text-amber-400">
                            {fmtMoney(business, item.outstandingMinor)}
                          </Ltr>
                        </TableCell>
                        <TableCell className="text-end">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-8"
                            onClick={() => openSource(item)}
                            aria-label={`${t("viewSource")}: ${item.reference}`}
                          >
                            <ExternalLink className="size-4" aria-hidden="true" />
                            <span className="sr-only">{t("viewSource")}</span>
                          </Button>
                        </TableCell>
                      </TableRow>
  );

  return (
    <div className="flex flex-col gap-6" data-view="aging-details">
      <EntityHeader
        icon={CalendarClock}
        title={heading}
        subtitle={t("subtitle")}
        backLabel={side === "receivables" ? t("backToReceivables") : t("backToPayables")}
        onBack={() => navigate({ kind: "module", module: side })}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {partyId ? (
              <Button type="button" variant="outline" size="sm" onClick={openStatement} disabled={notFound}>
                <FileText className="size-4" aria-hidden="true" />
                {t("viewStatement")}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => exportMutation.mutate()}
              disabled={exportMutation.isPending || notFound}
              data-testid={`aging-detail-export-${side}`}
            >
              {exportMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Download className="size-4" aria-hidden="true" />
              )}
              {exportMutation.isPending ? t("exporting") : t("export")}
            </Button>
          </div>
        }
      />

      {/* Error / not-found states */}
      {isError && !notFound ? (
        <div className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-sm">
          {t("loadFailed")}{" "}
          <button className="underline" onClick={() => void refetch()}>
            {tCommon("retry")}
          </button>
        </div>
      ) : null}
      {notFound ? <EmptyState icon={CalendarClock} title={t("notFound")} /> : null}

      {/* Loading skeleton */}
      {isLoading && !data ? (
        <div className="space-y-4" aria-busy="true">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-20 rounded-lg" />
            ))}
          </div>
          <Skeleton className="h-64 rounded-xl" />
        </div>
      ) : null}

      {summary ? (
        <>
          {/* Summary (§7.3) — full scope + filtered total + past-due slice */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              label={t("totalOutstanding")}
              value={fmtMoney(business, summary.totalOutstandingMinor)}
              tone={summary.totalOutstandingMinor > 0 ? "warning" : "positive"}
            />
            <StatCard label={t("openItems", { count: summary.openItemCount })} value=" " hint={summary.asOf} />
            {bucket ? (
              <StatCard
                label={t("filteredTotal")}
                value={fmtMoney(business, summary.filteredTotalOutstandingMinor)}
                hint={t("filteredItems", { count: summary.filteredOpenItemCount })}
              />
            ) : (
              <StatCard
                label={t("bucket0_30")}
                value={fmtMoney(business, summary.buckets[0]?.minor ?? 0)}
                hint={String(summary.buckets[0]?.count ?? 0)}
              />
            )}
            {side === "payables" && summary.pastDueCount != null ? (
              <StatCard
                label={t("pastDueSummary", {
                  count: summary.pastDueCount,
                  amount: fmtMoney(business, summary.pastDueMinor ?? 0),
                })}
                value={fmtMoney(business, summary.pastDueMinor ?? 0)}
              />
            ) : (
              <StatCard
                label={t("bucket90Plus")}
                value={fmtMoney(business, summary.buckets[3]?.minor ?? 0)}
                hint={String(summary.buckets[3]?.count ?? 0)}
              />
            )}
          </div>

          {/* Bucket filter chips (§16 B/E) — label + count, never color-only */}
          <div className="flex flex-wrap items-center gap-2" data-testid={`aging-detail-buckets-${side}`}>
            <Button
              type="button"
              variant={bucket === null && !pastDue ? "default" : "outline"}
              size="sm"
              className="min-h-8"
              onClick={() => navigateToAging({ bucket: null, pastDue: false })}
            >
              {t("allBuckets")}
            </Button>
            {AGING_BUCKET_KEYS.map((key) => {
              const b = summary.buckets.find((x) => x.key === key);
              return (
                <Button
                  key={key}
                  type="button"
                  variant={bucket === key ? "default" : "outline"}
                  size="sm"
                  className="min-h-8"
                  onClick={() => navigateToAging({ bucket: key })}
                >
                  {t(BUCKET_LABEL_KEYS[key])}
                  <span className="tabular-nums opacity-70">· {b?.count ?? 0}</span>
                </Button>
              );
            })}
            {side === "payables" ? (
              <Button
                type="button"
                variant={pastDue ? "default" : "outline"}
                size="sm"
                className="min-h-8"
                onClick={() => navigateToAging({ pastDue: !pastDue, bucket: null })}
                data-testid="aging-detail-pastdue-toggle"
              >
                <AlarmClock className="size-4" aria-hidden="true" />
                {t("pastDueOnly")}
              </Button>
            ) : null}
          </div>

          {summary.truncated ? (
            <p className="text-muted-foreground text-xs">
              {t("summaryTruncated", { cap: 5000 })}
            </p>
          ) : null}

          {items.length === 0 && !isFetching ? (
            <EmptyState icon={Receipt} title={t("empty")} description={t("subtitle")} />
          ) : (
            <>
              {/* R93 — the honest page-scope note: the sub-groups fold THIS
                  page only (bounded scan law); the party board is the
                  cross-page authority. */}
              {partyGroups && partyGroups.length > 1 ? (
                <p className="text-muted-foreground text-xs" data-testid="aging-detail-group-scope">
                  {t("groupsPageScope")}
                </p>
              ) : null}
              {/* Desktop table */}
              <div className="hidden md:block" aria-busy={isFetching}>
                <Table>
                  <caption className="sr-only">{heading}</caption>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">{t("colDocument")}</TableHead>
                      {!partyId ? <TableHead scope="col">{t("colParty")}</TableHead> : null}
                      <TableHead scope="col">{t("colDate")}</TableHead>
                      {side === "payables" ? <TableHead scope="col">{t("colDueDate")}</TableHead> : null}
                      <TableHead scope="col">{t("colAge")}</TableHead>
                      <TableHead scope="col">{t("colBucket")}</TableHead>
                      <TableHead scope="col" className="text-end">{t("colTotal")}</TableHead>
                      <TableHead scope="col" className="text-end">{t("colPaid")}</TableHead>
                      <TableHead scope="col" className="text-end">{t("colOutstanding")}</TableHead>
                      <TableHead scope="col" className="text-end">{t("colSource")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {partyGroups
                      ? partyGroups.flatMap((group) => [
                          <TableRow key={`group:${group.partyId ?? "unassigned"}`} className="bg-muted/50">
                            <TableCell colSpan={side === "payables" ? 10 : 9} className="py-1.5">
                              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
                                <span className="font-medium" dir="auto">
                                  {group.partyName ?? t("unassignedParty")}
                                </span>
                                <span className="text-muted-foreground tabular-nums">
                                  {t("groupSummary", {
                                    count: group.count,
                                    total: fmtMoney(business, group.outstandingMinor),
                                    days: group.oldestDays,
                                  })}
                                </span>
                              </div>
                            </TableCell>
                          </TableRow>,
                          ...group.items.map(renderRow),
                        ])
                      : items.map(renderRow)}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile cards */}
              <div className="flex flex-col gap-2 md:hidden">
                {items.map((item) => (
                  <Card key={`${item.sourceType}:${item.sourceId}`}>
                    <CardContent className="space-y-2 px-4 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-sm" dir="auto">
                          {item.reference}
                        </span>
                        <Badge variant="outline" className="text-[11px] font-medium">
                          {t(BUCKET_LABEL_KEYS[item.bucket])}
                        </Badge>
                      </div>
                      <div className="flex items-center justify-between gap-2 text-sm">
                        <span className="text-muted-foreground truncate" dir="auto">
                          {item.partyName ?? t("unassignedParty")}
                        </span>
                        <span className="text-muted-foreground whitespace-nowrap tabular-nums">
                          {fmtDate(business, item.documentDate)}
                        </span>
                      </div>
                      {side === "payables" ? (
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="text-muted-foreground">
                            {item.dueDate ? fmtDate(business, item.dueDate) : t("noDueDate")}
                          </span>
                          {item.pastDue ? (
                            <Badge variant="destructive" className="px-1.5 py-0 text-[10px]">
                              {t("pastDueBadge")}
                            </Badge>
                          ) : item.dueDate ? (
                            <span className="text-muted-foreground">{dueLabel(item)}</span>
                          ) : null}
                        </div>
                      ) : null}
                      <div className="flex items-center justify-between gap-2 border-t pt-2">
                        <span className="text-sm tabular-nums">
                          <span className="text-muted-foreground">{t("colOutstanding")}: </span>
                          <Ltr className="font-medium text-amber-700 dark:text-amber-400">
                            {fmtMoney(business, item.outstandingMinor)}
                          </Ltr>
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8"
                          onClick={() => openSource(item)}
                        >
                          <ExternalLink className="size-4" aria-hidden="true" />
                          {t("viewSource")}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {data?.pageTruncated ? (
                <p className="text-muted-foreground text-xs">{t("pageTruncated")}</p>
              ) : null}

              {/* Signed-cursor pagination (§7.1) */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-muted-foreground text-sm tabular-nums">
                  {t("filteredItems", { count: summary.filteredOpenItemCount })}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!hasPrev || isFetching}
                    onClick={() => setCursors(cursors.slice(0, -1))}
                  >
                    <ChevronLeft className="size-4 rtl:-scale-x-100" aria-hidden="true" />
                    {t("pagePrev")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!data?.nextCursor || isFetching}
                    onClick={() => {
                      if (data?.nextCursor) setCursors([...cursors, data.nextCursor]);
                    }}
                  >
                    {t("pageNext")}
                    <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden="true" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

/** Fetch one detailed-aging page (server-computed ages/buckets; client renders). */
async function fetchAgingDetail(url: string): Promise<AgingDetailResponse> {
  const res = await fetch(url, { credentials: "same-origin" });
  const body = (await res.json().catch(() => null)) as
    | { ok: true; data: AgingDetailResponse }
    | { ok: false; error: { code?: string; message?: string } }
    | null;
  if (!res.ok || !body || body.ok === false) {
    const code = body && body.ok === false ? body.error?.code : undefined;
    const message = body && body.ok === false ? body.error?.message : undefined;
  throw new ApiClientError(code ?? "AGING_DETAIL_FAILED", message ?? "Request failed", res.status);
  }
  return body.data;
}
