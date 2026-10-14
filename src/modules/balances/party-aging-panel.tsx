"use client";

/**
 * Prompt 49 (§17) — READ-ONLY aging overview panel for Customer 360 /
 * Supplier 360. Every figure arrives server-computed (canonical aging
 * engine, business timezone, integer minor units) — this component only
 * renders and navigates. The payables variant separates the past-due slice
 * (stated dueDate law) from the age buckets; the receivables variant shows
 * invoice AGE only and never claims an overdue state (§9).
 */

import { useTranslations } from "next-intl";
import { AlarmClock, CalendarClock, ChevronRight, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Ltr } from "@/components/shared/data-table";
import { useAppStore } from "@/store/app-store";
import { fmtCount, fmtMoney } from "../finance-shared/finance-kit";
import type { BusinessSummary } from "../shell/types";
import type { PartyAgingSummary } from "@/lib/entities";

const BUCKET_LABEL_KEYS = {
  D0_30: "bucket0_30",
  D31_60: "bucket31_60",
  D61_90: "bucket61_90",
  D90_PLUS: "bucket90Plus",
} as const;

const BUCKET_BAR_CLASS = [
  "bg-amber-500/70 dark:bg-amber-400/70",
  "bg-amber-500 dark:bg-amber-400",
  "bg-orange-500 dark:bg-orange-400",
  "bg-red-500 dark:bg-red-400",
] as const;

export function PartyAgingPanel({
  side,
  partyId,
  summary,
  business,
  uiLocale,
}: {
  side: "receivables" | "payables";
  partyId: string;
  summary: PartyAgingSummary | undefined;
  business: BusinessSummary;
  uiLocale: string;
}) {
  const t = useTranslations("finance.agingDetails");
  const tAging = useTranslations("finance.aging");
  const navigate = useAppStore((s) => s.navigate);

  const openDetails = (filter: { bucket?: string; pastDue?: boolean } = {}) => {
    navigate({
      kind: "aging-details",
      side,
      partyId,
      bucket: (filter.bucket as "D0_30" | "D31_60" | "D61_90" | "D90_PLUS" | undefined) ?? null,
      pastDue: filter.pastDue ?? false,
    });
  };

  return (
    <Card data-testid={`party-aging-panel-${side}`}>
      <CardContent className="space-y-4 pt-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CalendarClock className="text-muted-foreground size-4" aria-hidden="true" />
            <h2 className="text-sm font-semibold">{t("panelTitle")}</h2>
            {summary ? (
              <span className="text-muted-foreground text-xs tabular-nums" dir="ltr">
                {t("asOf", { asOf: summary.asOf })}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-8"
              onClick={() => openDetails()}
              data-testid={`party-aging-open-${side}`}
            >
              {t("openDetails")}
              <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-8"
              onClick={() =>
                navigate({
                  kind: "statements",
                  statementType: side === "receivables" ? "customer" : "supplier",
                  id: partyId,
                })
              }
            >
              <FileText className="size-4" aria-hidden="true" />
              {t("viewStatement")}
            </Button>
          </div>
        </div>

        {!summary || summary.openItemCount === 0 ? (
          <p className="text-muted-foreground text-sm">{t("panelEmpty")}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <span className="font-medium tabular-nums">
                {t("totalOutstanding")}:{" "}
                <Ltr className="text-amber-700 dark:text-amber-400">
                  {fmtMoney(business, summary.totalOutstandingMinor)}
                </Ltr>
              </span>
              <span className="text-muted-foreground tabular-nums">
                {t("openItems", { count: summary.openItemCount })}
              </span>
              <Badge variant="outline" className="tabular-nums">
                {tAging("oldest", { days: summary.oldestDays })}
              </Badge>
              {side === "payables" && summary.pastDueCount != null && summary.pastDueCount > 0 ? (
                <Badge
                  variant="destructive"
                  className="cursor-pointer tabular-nums"
                  onClick={() => openDetails({ pastDue: true })}
                >
                  <AlarmClock className="me-1 size-3" aria-hidden="true" />
                  {t("pastDueSummary", {
                    count: summary.pastDueCount,
                    amount: fmtMoney(business, summary.pastDueMinor ?? 0),
                  })}
                </Badge>
              ) : null}
            </div>

            {/* Four canonical buckets — label + count + amount (§17). */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid={`party-aging-buckets-${side}`}>
              {summary.buckets.map((b, idx) => {
                const share =
                  summary.totalOutstandingMinor > 0
                    ? Math.round((b.minor / summary.totalOutstandingMinor) * 100)
                    : 0;
                return (
                  <button
                    key={b.key}
                    type="button"
                    className="rounded-lg border p-3 text-start transition-colors hover:bg-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    onClick={() => openDetails({ bucket: b.key })}
                    aria-label={`${t(BUCKET_LABEL_KEYS[b.key])} — ${t("openDetailsHint")}`}
                  >
                    <span className="block text-xs font-medium">{t(BUCKET_LABEL_KEYS[b.key])}</span>
                    <Ltr className="mt-1 block text-sm font-semibold tabular-nums">
                      {fmtMoney(business, b.minor)}
                    </Ltr>
                    <span className="text-muted-foreground mt-0.5 flex items-center justify-between gap-1 text-xs tabular-nums">
                      {fmtCount(uiLocale, b.count)}
                      <span
                        className={`inline-block h-1.5 w-12 rounded-full ${BUCKET_BAR_CLASS[idx]}`}
                        role="presentation"
                        style={{ opacity: share > 0 ? 1 : 0.25 }}
                      />
                    </span>
                  </button>
                );
              })}
            </div>

            {summary.truncated ? (
              <p className="text-muted-foreground text-xs">{tAging("truncated")}</p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
