"use client";

/**
 * Platform overview (§18/§88) — title/value/status per card, honest
 * denominators, no net profit/valuation/unverified revenue. Monetary AI
 * cost values render ONLY when the server included them (role-gated §90).
 */
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { platformQueries } from "./platform-api";
import { formatCount, StatusBadge } from "./kit";

export function OverviewView() {
  const t = useTranslations("platform");
  const tSub = useTranslations("platform.subscriptionStatus");
  const { data, isLoading, isError } = useQuery({
    queryKey: ["platform", "overview"],
    queryFn: platformQueries.overview,
    refetchOnWindowFocus: false,
  });

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
    );
  }
  if (isError || !data) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {t("errors.PLATFORM_INVALID_OPERATION")}
      </p>
    );
  }

  const cards: Array<{ title: string; value: string; status?: { key: string; label: string } | null }> = [
    { title: t("overview.users"), value: formatCount(data.users) },
    { title: t("overview.businesses"), value: formatCount(data.businesses) },
    { title: t("overview.activeOperators"), value: formatCount(data.activeOperators) },
    { title: t("overview.trialing"), value: formatCount(data.subscriptions.trialing) },
    { title: t("overview.activeSubs"), value: formatCount(data.subscriptions.active), status: null },
    { title: t("overview.canceledSubs"), value: formatCount(data.subscriptions.canceled) },
    { title: t("overview.expiredSubs"), value: formatCount(data.subscriptions.expired) },
    { title: t("overview.pausedSubs"), value: formatCount(data.subscriptions.paused) },
    { title: t("overview.pendingCheckouts"), value: formatCount(data.payments.pendingCheckouts) },
    {
      title: t("overview.reconciliationRequired"),
      value: formatCount(data.payments.reconciliationRequired),
      status:
        data.payments.reconciliationRequired > 0
          ? { key: "RECONCILIATION_REQUIRED", label: tSub("RECONCILIATION_REQUIRED") }
          : null,
    },
    { title: t("overview.aiRequests"), value: formatCount(data.ai.requestsWindow) },
    {
      title: t("overview.aiCoverage"),
      value:
        data.ai.costCoverageBps == null
          ? t("overview.noData")
          : `${(data.ai.costCoverageBps / 100).toFixed(1)}%`,
    },
  ];

  return (
    <div className="space-y-6">
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label={t("overview.title")}>
        {cards.map((c) => (
          <Card key={c.title}>
            <CardHeader className="pb-1">
              <CardTitle className="text-muted-foreground text-xs font-medium">{c.title}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              <p className="text-2xl font-semibold tabular-nums">{c.value}</p>
              {c.status ? <StatusBadge status={c.status.key} label={c.status.label} /> : null}
            </CardContent>
          </Card>
        ))}
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("overview.byPlan")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {Object.entries(data.subscriptions.byPlan).length === 0 ? (
              <p className="text-muted-foreground text-sm">{t("overview.noData")}</p>
            ) : (
              Object.entries(data.subscriptions.byPlan).map(([plan, n]) => (
                <div key={plan} className="flex items-center justify-between text-sm">
                  <span className="font-mono">{plan}</span>
                  <span className="tabular-nums">{formatCount(n)}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("overview.aiCostCard")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span>{t("overview.aiKnown")}</span>
              <span className="tabular-nums">{formatCount(data.ai.knownRecords)}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span>{t("overview.aiUnknown")}</span>
              <span className="tabular-nums">{formatCount(data.ai.unknownRecords)}</span>
            </div>
            {data.ai.knownCostNanoMinorByCurrency ? (
              <>
                <Separator />
                {Object.entries(data.ai.knownCostNanoMinorByCurrency).length === 0 ? (
                  <p className="text-muted-foreground text-xs">{t("overview.noData")}</p>
                ) : (
                  Object.entries(data.ai.knownCostNanoMinorByCurrency).map(([cur, nano]) => (
                    <div key={cur} className="flex items-center justify-between text-sm" dir="ltr">
                      <span className="font-mono">{cur}</span>
                      <span className="tabular-nums">{nano} nm</span>
                    </div>
                  ))
                )}
              </>
            ) : (
              <p className="text-muted-foreground text-xs">{t("overview.costRestricted")}</p>
            )}
            <Separator />
            <div className="flex items-center justify-between text-sm">
              <span>{t("overview.aiAnomalies")}</span>
              <span className="tabular-nums">{formatCount(data.ai.openAnomalies)}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("overview.trustCard")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span>{t("overview.trustVerdict")}</span>
              <StatusBadge status={data.trust.verdict === "READY" ? "READY" : "NOT_CONFIGURED"} label={t(`trust.${data.trust.verdict}` as Parameters<typeof t>[0])} />
            </div>
            <Separator />
            {data.trust.readinessBlockers.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t("trust.noBlockers")}</p>
            ) : (
              <ul className="space-y-1">
                {data.trust.readinessBlockers.map((b) => (
                  <li key={b.key} className="flex items-center justify-between text-sm">
                    <span>{t(`trustKeys.${b.key}` as Parameters<typeof t>[0])}</span>
                    <StatusBadge status={b.status} label={t(`trust.${b.status}` as Parameters<typeof t>[0])} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
