"use client";

/**
 * Settings → Subscription — Prompt 20 (§51/§96/§94/§95).
 *
 * MINIMAL, READ-ONLY-SUMMARY billing UI:
 * - current plan + status + period + trial state
 * - feature/limit summary with live usage bars (over-limit state, §89)
 * - internal plan switch (clearly labeled "no payment" — §82/§83)
 * - cancel (cancelAtPeriodEnd semantics, §44) + reactivate (§45)
 * - subscription event history (§20)
 *
 * There is deliberately NO checkout, NO payment form, NO card field.
 * Everything shown comes from the server; nothing here authorizes access.
 */
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  BadgeCheck,
  CalendarClock,
  CircleAlert,
  CreditCard,
  History,
  Info,
  Loader2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { ApiClientError } from "@/lib/api-client";
import { asRole, can } from "@/lib/rbac";
import { cn } from "@/lib/utils";
import { formatMinor } from "@/lib/payments/pricing";
import type { BusinessSummary } from "../shell/types";
import {
  useCancelSubscription,
  useChangePlan,
  useCreateCheckout,
  useEntitlements,
  usePlanCatalog,
  useReactivateSubscription,
  useSubscription,
  useSubscriptionEvents,
  useUsage,
  type UsageMetricPayload,
} from "@/hooks/use-billing";
import { CheckoutDialog } from "./checkout-dialog";
import { PaymentsHistoryCard } from "./payments-history-card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { PageHeader, EmptyState } from "@/components/shared/primitives";

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

function StatusBadge({ status }: { status: string }) {
  const t = useTranslations("billing");
  const tone =
    status === "ACTIVE"
      ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
      : status === "TRIALING"
        ? "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-400"
        : status === "CANCELED"
          ? "border-orange-500/30 bg-orange-500/15 text-orange-700 dark:text-orange-400"
          : status === "PAST_DUE" || status === "PAUSED"
            ? "border-yellow-500/30 bg-yellow-500/15 text-yellow-700 dark:text-yellow-400"
            : "text-muted-foreground border-border bg-muted"; // EXPIRED
  return (
    <Badge variant="outline" className={cn("font-medium", tone)} data-testid="billing-status">
      {t(`status_${status}` as "status_ACTIVE")}
    </Badge>
  );
}

function usagePercent(used: number, limit: number | null): number | null {
  if (limit === null || limit <= 0) return null;
  return Math.min(100, Math.round((used / limit) * 100));
}

/**
 * Prompt 21 §52/§53/§54 — AI usage card content for ONE metric.
 * Levels come from the SERVER (single source: src/lib/billing/usage.ts);
 * this component never hard-codes thresholds (§53).
 */
function UsageMetricRow({
  metric,
  m,
  periodEnd,
  locale,
}: {
  metric: string;
  m: UsageMetricPayload;
  periodEnd: string | null;
  locale: string;
}) {
  const tUsage = useTranslations("billing.usage");
  const pct = m.percentageUsed;
  const tone =
    m.level === "reached"
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : m.level === "critical"
        ? "border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-400"
        : m.level === "warning"
          ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
          : null;
  const barTone =
    m.level === "reached"
      ? "[&>div]:bg-destructive"
      : m.level === "critical"
        ? "[&>div]:bg-orange-500"
        : m.level === "warning"
          ? "[&>div]:bg-amber-500"
          : "";
  const badge =
    m.level === "reached"
      ? tUsage("reachedBadge")
      : m.level === "critical"
        ? tUsage("criticalBadge")
        : m.level === "warning"
          ? tUsage("warningBadge")
          : null;
  return (
    <div className="space-y-1.5" data-testid={`usage-${metric}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="flex items-center gap-2">
          {tUsage(`metric_${metric}` as "metric_AI_REQUESTS")}
          {badge ? (
            <Badge variant="outline" className={cn("font-medium", tone)}>
              {badge}
            </Badge>
          ) : null}
        </span>
        {m.limit === null ? (
          <span className="text-muted-foreground font-medium">
            {tUsage("usedOnly", { used: m.used })} · {tUsage("unlimitedMetric")}
          </span>
        ) : (
          <span className="text-muted-foreground font-medium">
            {tUsage("usedOf", { used: m.used, limit: m.limit })} ·{" "}
            <span>
              {m.remaining === 0
                ? tUsage("remainingNone")
                : tUsage("remaining", { count: m.remaining ?? 0 })}
            </span>
          </span>
        )}
      </div>
      {pct !== null ? (
        <Progress
          value={pct}
          aria-label={tUsage(`metric_${metric}` as "metric_AI_REQUESTS")}
          className={cn("h-1.5", barTone)}
        />
      ) : null}
      {m.level === "reached" ? (
        <p className="text-destructive flex items-start gap-1.5 text-xs">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {periodEnd
            ? tUsage("reachedNotice", { date: formatDate(periodEnd, locale) })
            : tUsage("reachedNoticeNoDate")}
        </p>
      ) : null}
    </div>
  );
}

export function SubscriptionView({ business, role }: { business: BusinessSummary; role: string }) {
  const t = useTranslations("billing");
  const tCommon = useTranslations("common");
  const uiLocale = useLocale();
  const r = asRole(role);
  const canManage = can(r, "settings:manage");

  const [planDialogOpen, setPlanDialogOpen] = useState(false);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  // Prompt 22 — sandbox checkout session currently open in the dialog.
  const [checkout, setCheckout] = useState<{ id: string; planName: string } | null>(null);

  const subscriptionQ = useSubscription();
  const entitlementsQ = useEntitlements();
  const catalogQ = usePlanCatalog();
  const eventsQ = useSubscriptionEvents();
  const usageQ = useUsage();

  const changePlan = useChangePlan();
  const cancelSub = useCancelSubscription();
  const reactivate = useReactivateSubscription();
  const createCheckout = useCreateCheckout();

  const sub = subscriptionQ.data?.subscription;
  const entitlements = entitlementsQ.data?.entitlements ?? [];
  const usage = entitlementsQ.data?.usage ?? null;

  const onSwitch = (planCode: string, planName: string) => {
    changePlan.mutate(
      { planCode },
      {
        onSuccess: (res) => {
          setPlanDialogOpen(false);
          if (res.changed) toast({ title: t("planChangedToast", { plan: planName }) });
        },
        onError: (error) => {
          if (error instanceof ApiClientError) {
            toast({
              title: error.code === "INVALID_PLAN" ? t("featureUnavailable") : t("loadError"),
              description: error.message,
              variant: "destructive",
            });
          }
        },
      },
    );
  };

  const onCancel = () => {
    cancelSub.mutate(undefined, {
      onSuccess: () => {
        setCancelDialogOpen(false);
        toast({ title: t("canceledToast") });
      },
      onError: (error) => {
        setCancelDialogOpen(false);
        toast({
          title: t("reactivateFailed"),
          description: error.message,
          variant: "destructive",
        });
      },
    });
  };

  const onReactivate = () => {
    reactivate.mutate(undefined, {
      onSuccess: () => toast({ title: t("reactivatedToast") }),
      onError: (error) =>
        toast({
          title: t("reactivateFailed"),
          description: error.message,
          variant: "destructive",
        }),
    });
  };

  // Prompt 22 — start a sandbox checkout for a PAID plan. The browser sends
  // only the plan + period; the amount comes back from the server.
  const startCheckout = async (
    planCode: string,
    planName: string,
    billingPeriod: "MONTHLY" | "YEARLY",
  ) => {
    try {
      const res = await createCheckout.mutateAsync({ planCode, billingPeriod });
      setPlanDialogOpen(false);
      setCheckout({ id: res.checkoutSession.id, planName });
    } catch (error) {
      toast({
        title: t("checkout.createFailed"),
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    }
  };

  // ---- loading / error states ----------------------------------------------
  if (subscriptionQ.isLoading) {
    return (
      <div className="space-y-4">
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <Card>
          <CardContent className="space-y-3 p-6">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-4 w-48" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (subscriptionQ.isError || !sub) {
    return (
      <div className="space-y-4">
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <EmptyState
          icon={CircleAlert}
          title={t("loadError")}
          description={
            subscriptionQ.error instanceof Error ? subscriptionQ.error.message : undefined
          }
        />
      </div>
    );
  }

  const isCanceledActive = sub.status === "CANCELED" && sub.cancelAtPeriodEnd;
  const onFallback = sub.effectivePlanCode !== sub.plan.code;
  const locale = uiLocale;

  return (
    <div className="space-y-4" data-testid="billing-view">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {/* ---- Current plan ---------------------------------------------------- */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <CreditCard className="text-muted-foreground size-4" aria-hidden="true" />
                {t("currentPlan")}
              </CardTitle>
              <CardDescription className="mt-1">{business.name}</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant="secondary"
                className="font-semibold"
                data-testid="billing-plan-code"
              >
                {sub.plan.name}
              </Badge>
              <StatusBadge status={sub.status} />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          {onFallback ? (
            <div
              className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
              role="status"
            >
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{t("fallbackNotice")}</span>
            </div>
          ) : null}
          {isCanceledActive && sub.currentPeriodEnd ? (
            <div
              className="flex items-start gap-2 rounded-md border border-orange-500/30 bg-orange-500/10 px-3 py-2 text-sm text-orange-700 dark:text-orange-400"
              role="status"
            >
              <CalendarClock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{t("canceledNotice", { date: formatDate(sub.currentPeriodEnd, locale) })}</span>
            </div>
          ) : null}

          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div className="flex items-center justify-between gap-4 sm:justify-start">
              <dt className="text-muted-foreground">{t("period")}</dt>
              <dd className="font-medium">
                {sub.currentPeriodEnd
                  ? `${formatDate(sub.currentPeriodStart, locale)} → ${formatDate(
                      sub.currentPeriodEnd,
                      locale,
                    )}`
                  : "—"}
              </dd>
            </div>
            {sub.inTrial && sub.trialEnd ? (
              <div className="flex items-center justify-between gap-4 sm:justify-start">
                <dt className="text-muted-foreground">{t("trialEnds")}</dt>
                <dd className="font-medium">{formatDate(sub.trialEnd, locale)}</dd>
              </div>
            ) : null}
          </dl>

          {canManage ? (
            <div className="flex flex-wrap gap-2 pt-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPlanDialogOpen(true)}
                data-testid="billing-switch"
              >
                {t("changePlan")}
              </Button>
              {isCanceledActive ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onReactivate}
                  disabled={reactivate.isPending}
                  data-testid="billing-reactivate"
                >
                  {reactivate.isPending ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : null}
                  {t("reactivate")}
                </Button>
              ) : sub.status === "ACTIVE" || sub.status === "TRIALING" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setCancelDialogOpen(true)}
                  data-testid="billing-cancel"
                >
                  {t("cancelSub")}
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="text-muted-foreground flex items-center gap-1.5 pt-2 text-xs">
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              {t("ownerOnly")}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ---- AI usage (Prompt 21 §52/§53/§54) -------------------------------- */}
      <Card data-testid="usage-card">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="text-muted-foreground size-4" aria-hidden="true" />
            {t("usage.title")}
          </CardTitle>
          <CardDescription>{t("usage.subtitle")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {usageQ.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-3/4" />
            </div>
          ) : usageQ.isError || !usageQ.data ? (
            <p className="text-muted-foreground text-sm">{t("usage.unavailable")}</p>
          ) : (
            <>
              <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                <span>
                  {t("usage.currentPeriod")}:{" "}
                  {formatDate(usageQ.data.period.start, locale)}
                  {usageQ.data.period.end
                    ? ` → ${formatDate(usageQ.data.period.end, locale)}`
                    : ""}
                </span>
              </div>
              <UsageMetricRow
                metric="AI_REQUESTS"
                m={usageQ.data.metrics.AI_REQUESTS}
                periodEnd={usageQ.data.period.end}
                locale={locale}
              />
              <UsageMetricRow
                metric="AI_MESSAGES"
                m={usageQ.data.metrics.AI_MESSAGES}
                periodEnd={usageQ.data.period.end}
                locale={locale}
              />
              {/* AI_TOKENS is recorded-when-reported (§14) — shown only when
                  real provider data exists; never displayed as a quota. */}
              {usageQ.data.metrics.AI_TOKENS.used > 0 ? (
                <UsageMetricRow
                  metric="AI_TOKENS"
                  m={usageQ.data.metrics.AI_TOKENS}
                  periodEnd={usageQ.data.period.end}
                  locale={locale}
                />
              ) : null}
              {canManage &&
              (usageQ.data.metrics.AI_REQUESTS.level === "reached" ||
                usageQ.data.metrics.AI_MESSAGES.level === "reached") ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPlanDialogOpen(true)}
                  data-testid="usage-switch-plan"
                >
                  {t("usage.reachedAction")}
                </Button>
              ) : null}
              <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {t("usage.serverAuthoritative")}
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* ---- Entitlements ------------------------------------------------------ */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("entitlementsTitle")}</CardTitle>
          <CardDescription>{t("usageBar")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {entitlementsQ.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-2/3" />
            </div>
          ) : (
            entitlements.map((e) => {
              const u = usage?.[e.code];
              const pct = u ? usagePercent(u.used, u.limit) : null;
              const over = u !== undefined && u.limit !== null && u.used > u.limit;
              const at = u !== undefined && u.limit !== null && u.used === u.limit;
              return (
                <div key={e.code} data-testid={`entitlement-${e.code}`} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <span className="flex items-center gap-2">
                      {t(`entitlement.${e.code}` as "entitlement.CUSTOMERS_MAX")}
                      {over ? (
                        <Badge
                          variant="outline"
                          className="border-destructive/40 bg-destructive/10 text-destructive"
                        >
                          {t("overLimit")}
                        </Badge>
                      ) : at ? (
                        <Badge
                          variant="outline"
                          className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                        >
                          {t("atLimit")}
                        </Badge>
                      ) : null}
                    </span>
                    {e.type === "BOOLEAN" ? (
                      e.value === true ? (
                        <Badge
                          variant="outline"
                          className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                        >
                          <BadgeCheck className="size-3.5" aria-hidden="true" />
                          {t("included")}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground">
                          {t("notIncluded")}
                        </Badge>
                      )
                    ) : (
                      <span className="text-muted-foreground font-medium">
                        {e.value === null
                          ? t("unlimited")
                          : u
                            ? t("limitOf", { used: u.used, limit: e.value as number })
                            : t("limitOf", { used: 0, limit: e.value as number })}
                      </span>
                    )}
                  </div>
                  {pct !== null ? (
                    <Progress
                      value={pct}
                      aria-label={t(`entitlement.${e.code}` as "entitlement.CUSTOMERS_MAX")}
                      className={cn("h-1.5", over && "[&>div]:bg-destructive")}
                    />
                  ) : null}
                </div>
              );
            })
          )}
          <Separator />
          <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {t("noPaymentBadge")}
          </p>
        </CardContent>
      </Card>

      {/* ---- History ----------------------------------------------------------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="text-muted-foreground size-4" aria-hidden="true" />
            {t("historyTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {eventsQ.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </div>
          ) : !eventsQ.data || eventsQ.data.items.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("historyEmpty")}</p>
          ) : (
            <ol className="space-y-3">
              {eventsQ.data.items.map((ev) => (
                <li key={ev.id} className="flex items-start gap-3 text-sm">
                  <span
                    className="bg-primary/10 text-primary mt-1 size-2 shrink-0 rounded-full"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {t(`event_${ev.type}` as "event_CREATED")}
                      {ev.fromPlanCode && ev.toPlanCode && ev.fromPlanCode !== ev.toPlanCode ? (
                        <span className="text-muted-foreground font-normal">
                          {" "}
                          · {ev.fromPlanCode} → {ev.toPlanCode}
                        </span>
                      ) : null}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {formatDate(ev.createdAt, locale)}
                      {ev.actor?.name ? ` · ${ev.actor.name}` : ""}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      {/* ---- Plan dialog (Prompt 22: prices + payment path + internal switch) -- */}
      <AlertDialog open={planDialogOpen} onOpenChange={setPlanDialogOpen}>
        <AlertDialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("changePlanTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("changePlanDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2" data-testid="billing-plan-options">
            {(catalogQ.data?.plans ?? [])
              .filter((p) => p.selfService)
              .map((p) => {
                const isCurrent = p.code === sub.plan.code;
                const priceLine = p.pricing
                  ? {
                      monthly: formatMinor(p.pricing.monthlyMinor, p.pricing.currency, uiLocale),
                      yearly: formatMinor(p.pricing.yearlyMinor, p.pricing.currency, uiLocale),
                    }
                  : null;
                return (
                  <div
                    key={p.code}
                    data-testid={`plan-option-${p.code}`}
                    className={cn(
                      "w-full rounded-lg border p-3 text-start transition-colors",
                      isCurrent
                        ? "border-primary/40 bg-primary/5"
                        : "hover:bg-accent/50",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold">{p.name}</span>
                      {isCurrent ? (
                        <Badge variant="secondary">{t("currentPlan")}</Badge>
                      ) : priceLine ? (
                        <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                          <span className="font-semibold text-foreground">
                            {t("checkout.perMonth", { amount: priceLine.monthly })}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {t("checkout.perYear", { amount: priceLine.yearly })} (
                            {t("checkout.yearlySaving")})
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs font-medium">
                          {t("checkout.free")}
                        </span>
                      )}
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs">{p.description}</p>
                    {!isCurrent && canManage ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {priceLine ? (
                          <>
                            <Button
                              size="sm"
                              onClick={() => startCheckout(p.code, p.name, "MONTHLY")}
                              disabled={createCheckout.isPending}
                              data-testid={`checkout-monthly-${p.code}`}
                            >
                              {createCheckout.isPending ? (
                                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                              ) : null}
                              {t("checkout.payWithPlan")} · {t("checkout.periodMonthly")}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => startCheckout(p.code, p.name, "YEARLY")}
                              disabled={createCheckout.isPending}
                              data-testid={`checkout-yearly-${p.code}`}
                            >
                              {t("checkout.periodYearly")}
                            </Button>
                          </>
                        ) : null}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-muted-foreground"
                          onClick={() => onSwitch(p.code, p.name)}
                          disabled={changePlan.isPending}
                          data-testid={`switch-internal-${p.code}`}
                        >
                          {t("changePlan")}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
          </div>
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <Info className="size-3.5 shrink-0" aria-hidden="true" />
            {t("priceNote")}
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={changePlan.isPending || createCheckout.isPending}>
              {tCommon("cancel")}
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ---- Prompt 22: sandbox checkout + payment history ---------------------- */}
      <CheckoutDialog
        checkoutId={checkout?.id ?? null}
        planName={checkout?.planName ?? ""}
        onClose={() => setCheckout(null)}
      />
      <PaymentsHistoryCard businessId={business.id} />

      {/* ---- Cancel confirmation ------------------------------------------------ */}
      <AlertDialog open={cancelDialogOpen} onOpenChange={setCancelDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("cancelTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("cancelDesc", { date: formatDate(sub.currentPeriodEnd, locale) })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelSub.isPending}>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                onCancel();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="billing-cancel-confirm"
            >
              {cancelSub.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : null}
              {t("cancelConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
