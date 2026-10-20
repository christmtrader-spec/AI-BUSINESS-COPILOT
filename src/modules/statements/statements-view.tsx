"use client";

/**
 * Prompt 39 — Party Statement view (§63–§75/§140–§151/§215/§216).
 *
 * ONE view for both statement kinds (§63). The server computes opening /
 * increase / decrease / running balance / closing (§24/§44) — this view
 * ONLY renders. Labels are movement vocabulary (Increase/Decrease), never
 * Debit/Credit (§263) and never P&L (§65/§113).
 *
 * STATES (§140): loading · error · not found · empty period · data ·
 * exporting — no blank screen anywhere.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { ApiClientError } from "@/lib/api-client";
import { useAppStore } from "@/store/app-store";
import { JalaliRangePresets } from "@/components/shared/jalali-range-presets";
import type { BusinessSummary } from "../shell/types";
import { navigateToEntity } from "../entities/entity-route";
import { EntityHeader, EntityTypeBadge } from "../entities/entity-header";
import { StatCard, fmtDateTime, fmtMoney } from "../finance-shared/finance-kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  STATEMENT_PRESETS,
  presetRange,
  type StatementPreset,
} from "@/lib/statements/formatting";
import type { StatementTypeToken } from "@/lib/statements/types";
import { fetchStatementPage, statementApiPath, statementKeysFor, type StatementPage } from "./statements-api";

const PAGE_LIMIT = 50;

export function StatementsView({
  business,
  role,
  statementType,
  partyId,
}: {
  business: BusinessSummary;
  role: string;
  statementType: StatementTypeToken;
  partyId: string;
}) {
  void role; // data:read-only view — every role may view statements (§50)
  const t = useTranslations("statements");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const activeBusinessId = useAppStoreActiveId();
  const timeZone = business.timezone || "UTC";

  // ---- applied range + draft inputs (§74/§75) ----------------------------
  const [range, setRange] = useState(() => presetRange("thisMonth", timeZone));
  const [fromInput, setFromInput] = useState(range.from);
  const [toInput, setToInput] = useState(range.to);
  const rangeInvalid = fromInput > toInput;

  // ---- cursor stack (Prev/Next pages; server-generated opaque cursor) ----
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const pageIndex = cursors.length - 1;
  const hasPrev = cursors.length > 1;

  const entityType = statementType === "customer" ? ("customer" as const) : ("supplier" as const);

  // ---- query (§157/§159 — key carries type + business + party + range) ---
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<StatementPage>({
    queryKey: statementKeysFor(statementType, business.id, partyId, range.from, range.to, cursor, locale),
    queryFn: () => fetchStatementPage(statementType, partyId, { from: range.from, to: range.to, cursor, locale }),
    staleTime: 15_000,
    retry: (failureCount, err) =>
      err instanceof ApiClientError && err.status >= 500 && err.status < 600 ? failureCount < 2 : false,
  });

  const notFound = isError && error instanceof ApiClientError && error.status === 404;
  const partyName = data?.party.name ?? null;
  const rows = data?.rows ?? [];
  const summary = data?.summary ?? null;

  // ---- range mutations ----------------------------------------------------
  const applyRange = (from: string, to: string) => {
    if (from > to) return; // §74 — never apply an invalid range
    setRange({ from, to });
    setFromInput(from);
    setToInput(to);
    setCursors([null]); // §48 — a fresh range needs a fresh cursor
  };

  const applyPreset = (preset: StatementPreset) => {
    const next = presetRange(preset, timeZone);
    applyRange(next.from, next.to);
  };

  // ---- CSV export (§76/§142) ----------------------------------------------
  const exportMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `${statementApiPath(statementType, partyId)}/export?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&locale=${locale}`,
        {
          credentials: "same-origin",
          headers: activeBusinessId ? { "x-business-id": activeBusinessId } : undefined,
        },
      );
      if (!res.ok) {
        let message = t("exportFailed");
        try {
          const body = (await res.json()) as { error?: { code?: string } } | null;
          if (body?.error?.code === "RATE_LIMITED") message = t("exportRateLimited");
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
        /filename="([^"]+)"/.exec(dispo)?.[1] ??
        `${statementType}-statement-${range.from}_${range.to}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => toast({ title: t("exportToast") }),
    onError: (err) =>
      toast({ title: err instanceof Error ? err.message : t("exportFailed"), variant: "destructive" }),
  });

  const eventLabel = (eventType: string): string => {
    switch (eventType) {
      case "SALE":
        return t("sale");
      case "PAYMENT_RECEIVED":
        return t("paymentReceived");
      case "BILL":
        return t("bill");
      case "PAYMENT_MADE":
        return t("paymentMade");
      default:
        return eventType;
    }
  };

  /**
   * Prompt 49 (§13) — authorized source-document navigation. The target is
   * resolved from the row's SERVER-provided sourceType + sourceId (never
   * from client text); unsupported source types keep the row read-only —
   * no fake routes are invented.
   */
  const sourceTargetOf = (sourceType: string): "sale" | "expense" | "payment" | null => {
    switch (sourceType) {
      case "SALE":
        return "sale";
      case "BILL":
        return "expense";
      case "PAYMENT_IN":
      case "PAYMENT_OUT":
        return "payment";
      default:
        return null;
    }
  };
  const openSource = (sourceType: string, sourceId: string) => {
    const entity = sourceTargetOf(sourceType);
    if (entity) navigateToEntity(entity, sourceId);
  };

  const increasesLabel = statementType === "customer" ? t("increasesCustomer") : t("increasesSupplier");
  const decreasesLabel = statementType === "customer" ? t("decreasesCustomer") : t("decreasesSupplier");
  const headingLabel = statementType === "customer" ? t("customerStatement") : t("supplierStatement");
  const backLabel = statementType === "customer" ? t("backToCustomer") : t("backToSupplier");

  // §47 — pagination footer numbers (first/last row of the current page).
  const shown = useMemo(() => {
    const first = rows.length ? pageIndex * PAGE_LIMIT + 1 : 0;
    const last = pageIndex * PAGE_LIMIT + rows.length;
    return { first, last };
  }, [rows.length, pageIndex]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <EntityHeader
          icon={FileText}
          avatarInitials={partyName ? partyName.slice(0, 2).toUpperCase() : undefined}
          title={partyName ?? headingLabel}
          subtitle={`${t("statementPeriod")}: ${range.from} – ${range.to} · ${t("timezoneLabel")}: ${timeZone}`}
          badge={<EntityTypeBadge label={headingLabel} />}
          backLabel={backLabel}
          onBack={() => navigateToEntity(entityType, partyId)}
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => exportMutation.mutate()}
              disabled={exportMutation.isPending || notFound}
            >
              <Download className="size-4" aria-hidden="true" />
              {exportMutation.isPending ? t("exporting") : t("export")}
            </Button>
          }
        />
      </div>

      {/* Date range (§74/§75) — native date inputs + presets in the business calendar */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-6">
          <div className="flex flex-wrap gap-2">
            {STATEMENT_PRESETS.map((preset) => (
              <Button
                key={preset}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => applyPreset(preset)}
              >
                {t(preset)}
              </Button>
            ))}
          </div>
          {/* Prompt 52 §F4 — Jalali calendar presets (resolve to Gregorian
              keys; the server statement API is unchanged). */}
          <JalaliRangePresets
            value={{ from: range.from, to: range.to }}
            onChange={(r) => {
              if (r) applyRange(r.from, r.to);
            }}
          />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="st-from">{t("from")}</Label>
            <Input
              id="st-from"
              type="date"
              value={fromInput}
              onChange={(e) => setFromInput(e.target.value)}
              className="w-40"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="st-to">{t("to")}</Label>
            <Input
              id="st-to"
              type="date"
              value={toInput}
              onChange={(e) => setToInput(e.target.value)}
              className="w-40"
            />
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => applyRange(fromInput, toInput)}
            disabled={rangeInvalid}
          >
            {t("apply")}
          </Button>
          {rangeInvalid ? (
            <p className="text-destructive w-full text-sm" role="alert">
              {t("invalidDateRange")}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* Error / not-found states (§140/§141) */}
      {isError && !notFound ? (
        <div className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-sm">
          {t("loadFailed")}{" "}
          <button className="underline" onClick={() => void refetch()}>
            {tCommon("retry")}
          </button>
        </div>
      ) : null}
      {notFound ? (
        <div className="text-muted-foreground rounded-lg border border-dashed p-6 text-sm">
          {t("notFound")}
        </div>
      ) : null}

      {/* Loading skeleton (§140) */}
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

      {/* Data + empty period (§72 — the period is empty; never "no history") */}
      {summary ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label={t("openingBalance")} value={fmtMoney(business, summary.openingBalanceMinor)} />
            <StatCard label={increasesLabel} value={fmtMoney(business, summary.periodIncreaseMinor)} />
            <StatCard label={decreasesLabel} value={fmtMoney(business, summary.periodDecreaseMinor)} />
            <StatCard
              label={t("closingBalance")}
              value={fmtMoney(business, summary.closingBalanceMinor)}
              tone={summary.closingBalanceMinor > 0 ? "warning" : "positive"}
            />
          </div>

          {rows.length === 0 ? (
            <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-sm">
              {t("noTransactionsInPeriod")}
            </p>
          ) : (
            <>
              {/* Desktop table (§66/§149) */}
              <div className="hidden md:block" aria-busy={isFetching}>
                <Table>
                  <caption className="sr-only">{headingLabel}</caption>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">{t("transactionDate")}</TableHead>
                      <TableHead scope="col">{t("reference")}</TableHead>
                      <TableHead scope="col">{t("description")}</TableHead>
                      <TableHead scope="col" className="text-end">
                        {t("increase")}
                      </TableHead>
                      <TableHead scope="col" className="text-end">
                        {t("decrease")}
                      </TableHead>
                      <TableHead scope="col" className="text-end">
                        {t("balance")}
                      </TableHead>
                      <TableHead scope="col" className="text-end">
                        <span className="sr-only">{t("openSourceDocument")}</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="whitespace-nowrap text-sm">
                          {fmtDateTime(business, row.occurredAt)}
                        </TableCell>
                        <TableCell className="max-w-40 truncate font-mono text-xs" dir="auto">
                          {row.reference ?? "—"}
                        </TableCell>
                        <TableCell className="max-w-56">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="shrink-0 text-[11px] font-medium">
                              {eventLabel(row.eventType)}
                            </Badge>
                            <span className="text-sm" dir="auto">
                              {row.description ?? "—"}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-end">
                          {row.increaseMinor !== 0 ? (
                            <span className="inline-flex items-center justify-end gap-1 text-emerald-700 tabular-nums dark:text-emerald-400">
                              <ArrowUpRight className="size-3.5" aria-hidden="true" />
                              <span className="sr-only">{t("increase")}: </span>
                              <span dir="ltr">{fmtMoney(business, row.increaseMinor)}</span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-end">
                          {row.decreaseMinor !== 0 ? (
                            <span className="inline-flex items-center justify-end gap-1 text-rose-700 tabular-nums dark:text-rose-400">
                              <ArrowDownRight className="size-3.5" aria-hidden="true" />
                              <span className="sr-only">{t("decrease")}: </span>
                              <span dir="ltr">{fmtMoney(business, row.decreaseMinor)}</span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-end font-medium tabular-nums">
                          <span dir="ltr">{fmtMoney(business, row.balanceAfterMinor)}</span>
                        </TableCell>
                        <TableCell className="text-end">
                          {sourceTargetOf(row.sourceType) ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8"
                              onClick={() => openSource(row.sourceType, row.sourceId)}
                              aria-label={`${t("openSourceDocument")}: ${row.reference ?? ""}`}
                            >
                              <ExternalLink className="size-4" aria-hidden="true" />
                              <span className="sr-only">{t("openSourceDocument")}</span>
                            </Button>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile card rows (§148): date · reference · movement · balance */}
              <div className="flex flex-col gap-2 md:hidden">
                {rows.map((row) => (
                  <Card key={row.id}>
                    <CardContent className="space-y-2 px-4 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">{fmtDateTime(business, row.occurredAt)}</span>
                        <Badge variant="outline" className="text-[11px] font-medium">
                          {eventLabel(row.eventType)}
                        </Badge>
                      </div>
                      {row.reference ? (
                        <p className="text-muted-foreground truncate font-mono text-xs" dir="auto">
                          {row.reference}
                        </p>
                      ) : null}
                      {row.description ? (
                        <p className="text-muted-foreground text-xs" dir="auto">
                          {row.description}
                        </p>
                      ) : null}
                      <div className="flex items-center justify-between gap-2 border-t pt-2">
                        <span className="text-sm tabular-nums">
                          {row.increaseMinor !== 0 ? (
                            <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                              <ArrowUpRight className="size-3.5" aria-hidden="true" />
                              <span className="sr-only">{t("increase")}: </span>
                              <span dir="ltr">{fmtMoney(business, row.increaseMinor)}</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-rose-700 dark:text-rose-400">
                              <ArrowDownRight className="size-3.5" aria-hidden="true" />
                              <span className="sr-only">{t("decrease")}: </span>
                              <span dir="ltr">{fmtMoney(business, row.decreaseMinor)}</span>
                            </span>
                          )}
                        </span>
                        <span className="flex items-center gap-2">
                          <span className="text-sm font-medium tabular-nums">
                            <span className="text-muted-foreground sr-only">{t("balance")}: </span>
                            <span dir="ltr">{fmtMoney(business, row.balanceAfterMinor)}</span>
                          </span>
                          {sourceTargetOf(row.sourceType) ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-8"
                              onClick={() => openSource(row.sourceType, row.sourceId)}
                            >
                              <ExternalLink className="size-4" aria-hidden="true" />
                              <span className="sr-only">{t("openSourceDocument")}</span>
                            </Button>
                          ) : null}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </>
          )}

          {/* Pagination footer (§47 — server cursor; totals are page-independent) */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-muted-foreground text-sm">
              {rows.length
                ? `${t("shownRange", { first: shown.first, last: shown.last, total: summary.eventCount })} · `
                : ""}
              {t("eventsCount", { count: summary.eventCount })}
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
      ) : null}
    </div>
  );
}

/** Business id of the active membership — used only for the export fetch header. */
function useAppStoreActiveId(): string | null {
  return useAppStore((s) => s.activeBusinessId);
}
