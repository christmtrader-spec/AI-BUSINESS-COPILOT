"use client";

/**
 * Aging summary card (§2 row 15 — receivables/payables aging).
 *
 * One card, shared by both balances views (Rule 04). Every figure comes
 * from /api/v1/reports/aging — computed server-side in the business
 * timezone over integer minor units; the UI never derives an overdue state
 * or invents a number (A08/A11). Buckets always render as label + count +
 * amount (never color-only, A-rule on accessible status).
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { AlarmClock, CalendarClock, Download, Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api } from "@/lib/api-client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Ltr } from "@/components/shared/data-table";
import { fmtMoney, txKeys } from "../finance-shared/finance-kit";
import type { BusinessSummary } from "../shell/types";

type AgingBucket = { key: "D0_30" | "D31_60" | "D61_90" | "D90_PLUS"; minor: number; count: number };

type AgingSide = {
  totalMinor: number;
  openCount: number;
  buckets: AgingBucket[];
  topParties: { name: string | null; balanceMinor: number; openCount: number; oldestDays: number }[];
  pastDueMinor?: number;
  pastDueCount?: number;
};

export type AgingData = {
  generatedAt: string;
  timezone: string;
  asOf: string;
  truncated: boolean;
  receivables: AgingSide;
  payables: AgingSide;
};

const BUCKET_LABEL_KEYS = {
  D0_30: "bucket0_30",
  D31_60: "bucket31_60",
  D61_90: "bucket61_90",
  D90_PLUS: "bucket90Plus",
} as const;

/** Amber → red ramp for bucket bars (decorative only — labels carry meaning). */
const BUCKET_BAR_CLASS = [
  "bg-amber-500/70 dark:bg-amber-400/70",
  "bg-amber-500 dark:bg-amber-400",
  "bg-orange-500 dark:bg-orange-400",
  "bg-red-500 dark:bg-red-400",
] as const;

export function AgingCard({
  kind,
  business,
}: {
  kind: "receivables" | "payables";
  business: BusinessSummary;
}) {
  const t = useTranslations("finance.aging");

  const { data, isLoading, error, refetch } = useQuery<AgingData>({
    queryKey: txKeys.aging,
    queryFn: () => api<AgingData>("/api/v1/reports/aging"),
    staleTime: 15_000,
  });

  const side = data ? data[kind] : null;

  // CSV export — the server renders the SAME buildAgingReport() engine the
  // card shows (A11 single source); this button only downloads the file.
  const exportCsv = useMutation({
    mutationFn: async () => {
      const locale = business.locale === "fa" ? "fa" : "en";
      const res = await fetch(
        `/api/v1/reports/aging/export?side=${kind}&locale=${locale}`,
        {
          credentials: "same-origin",
          headers: business.id ? { "x-business-id": business.id } : undefined,
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
      a.download = /filename="([^"]+)"/.exec(dispo)?.[1] ?? `aging-${kind}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => toast({ title: t("exportToast") }),
    onError: (err) =>
      toast({ title: err instanceof Error ? err.message : t("exportFailed"), variant: "destructive" }),
  });

  return (
    <Card data-testid={`aging-card-${kind}`}>
      <CardContent className="pt-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CalendarClock className="text-muted-foreground size-4" aria-hidden="true" />
            <h2 className="text-sm font-semibold">{t("title")}</h2>
            {data ? (
              <span className="text-muted-foreground text-xs tabular-nums" dir="ltr">
                {t("asOf", { asOf: data.asOf })}
              </span>
            ) : null}
          </div>
          {side ? (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => exportCsv.mutate()}
                disabled={exportCsv.isPending}
                data-testid={`aging-export-${kind}`}
                aria-label={`${t("export")}: ${t("title")}`}
                className="min-h-8"
              >
                {exportCsv.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="size-4" aria-hidden="true" />
                )}
                <span className="hidden sm:inline">{exportCsv.isPending ? t("exporting") : t("export")}</span>
              </Button>
              <Badge variant="secondary" className="tabular-nums">
                {t("openItems", { count: side.openCount })}
              </Badge>
            </div>
          ) : null}
        </div>

        {error ? (
          <div className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm">
            {t("loadFailed")}{" "}
            <button className="underline" onClick={() => void refetch()}>
              {t("retry")}
            </button>
          </div>
        ) : isLoading || !side ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : side.openCount === 0 ? (
          <p className="text-muted-foreground text-sm">{t("allSettled")}</p>
        ) : (
          <div className="space-y-5">
            {/* Buckets — label + count + amount + share bar (bar is decorative). */}
            <div className="space-y-2" data-testid={`aging-buckets-${kind}`}>
              {side.buckets.map((b, idx) => {
                const share =
                  side.totalMinor > 0 ? Math.round((b.minor / side.totalMinor) * 100) : 0;
                return (
                  <div key={b.key} className="flex items-center gap-3">
                    <div className="w-24 shrink-0 sm:w-28">
                      <span className="text-sm font-medium">{t(BUCKET_LABEL_KEYS[b.key])}</span>
                      <span className="text-muted-foreground block text-xs tabular-nums">
                        {t("bucketItems", { count: b.count })}
                      </span>
                    </div>
                    <div
                      className="bg-muted h-2 flex-1 overflow-hidden rounded-full"
                      role="presentation"
                    >
                      <div
                        className={`h-full rounded-full ${BUCKET_BAR_CLASS[idx]}`}
                        style={{ width: `${share}%` }}
                      />
                    </div>
                    <Ltr className="w-28 shrink-0 text-end text-sm font-medium tabular-nums sm:w-32">
                      {fmtMoney(business, b.minor)}
                    </Ltr>
                  </div>
                );
              })}
            </div>

            {/* Payables past-due slice — server-derived, never color-only. */}
            {kind === "payables" && side.pastDueCount != null ? (
              <div
                className={
                  side.pastDueCount > 0
                    ? "border-destructive/30 bg-destructive/5 text-destructive inline-flex max-w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm"
                    : "border-border bg-muted/40 text-muted-foreground inline-flex max-w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm"
                }
                data-testid="aging-past-due"
              >
                <AlarmClock className="size-4 shrink-0" aria-hidden="true" />
                <span>
                  {side.pastDueCount > 0
                    ? t("pastDue", {
                        count: side.pastDueCount,
                        amount: fmtMoney(business, side.pastDueMinor ?? 0),
                      })
                    : t("nothingPastDue")}
                </span>
              </div>
            ) : null}

            {/* Top parties with oldest-age badge. */}
            {side.topParties.length > 0 ? (
              <div>
                <p className="mb-2 text-sm font-semibold">{t("topParties")}</p>
                <ul className="space-y-1.5">
                  {side.topParties.slice(0, 5).map((p) => (
                    <li
                      key={p.name ?? "__none__"}
                      className="flex items-center justify-between gap-2 text-sm"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="max-w-40 truncate sm:max-w-56" dir="auto">
                          {p.name ?? t("noParty")}
                        </span>
                        <Badge variant="outline" className="shrink-0 tabular-nums">
                          {t("oldest", { days: p.oldestDays })}
                        </Badge>
                      </span>
                      <Ltr className="shrink-0 font-medium tabular-nums">
                        {fmtMoney(business, p.balanceMinor)}
                      </Ltr>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {data?.truncated ? (
              <p className="text-muted-foreground text-xs">{t("truncated")}</p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
