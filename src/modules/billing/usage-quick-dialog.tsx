"use client";

/**
 * R133 — THE ⌘K USAGE QUICK DIALOG ("AI usage" from the command palette).
 *
 * The palette is a discovery layer that never executes mutations (§1) —
 * this dialog is READ-ONLY inspection: the same server truth the
 * Settings → Subscription usage card renders, one keystroke away.
 *
 * Laws carried over VERBATIM from the subscription view (one honesty
 * family, zero drift):
 * - levels come from the SERVER (src/lib/billing/usage.ts §53) — this
 *   component never hard-codes a threshold;
 * - unlimited plans render "Unlimited" + NO percentage — never a fake
 *   giant number (§64);
 * - AI_TOKENS is recorded-when-reported (§14) — shown only when real
 *   provider data exists, never displayed as a quota (§52);
 * - no money is ever computed here (§62/§104).
 *
 * Fetch law: the useUsage query is enabled ONLY while the dialog is open —
 * opening the palette must never fire a billing request; closing cancels
 * nothing (TanStack caches 15s, §67).
 */

import { useLocale, useTranslations } from "next-intl";
import { Gauge, Info, RefreshCcw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useUsage, type UsageMetricPayload } from "@/hooks/use-billing";
import { cn } from "@/lib/utils";

/** Same medium-datetime convention as the subscription view. */
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

/** ONE row — the exact level-tone law of the subscription view's card. */
function QuickMetricRow({ metric, m, periodEnd }: { metric: string; m: UsageMetricPayload; periodEnd: string | null }) {
  const t = useTranslations("billing.usage");
  const pct = m.percentageUsed;
  const badgeTone =
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
      ? t("reachedBadge")
      : m.level === "critical"
        ? t("criticalBadge")
        : m.level === "warning"
          ? t("warningBadge")
          : null;
  return (
    <div className="space-y-1.5" data-testid={`usage-quick-${metric}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-sm">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium">{t(`metric_${metric}` as "metric_AI_REQUESTS")}</span>
          {badge ? (
            <Badge variant="outline" className={cn("font-medium", badgeTone)}>
              {badge}
            </Badge>
          ) : null}
        </span>
        {m.limit === null ? (
          <span className="text-muted-foreground text-xs font-medium tabular-nums">
            {t("usedOnly", { used: m.used })} · {t("unlimitedMetric")}
          </span>
        ) : (
          <span className="text-muted-foreground text-xs font-medium tabular-nums">
            {t("usedOf", { used: m.used, limit: m.limit })}
            {m.remaining !== null
              ? m.remaining === 0
                ? ` · ${t("remainingNone")}`
                : ` · ${t("remaining", { count: m.remaining })}`
              : null}
          </span>
        )}
      </div>
      {pct !== null ? (
        <Progress
          value={pct}
          aria-label={t(`metric_${metric}` as "metric_AI_REQUESTS")}
          className={cn(
            "h-1.5",
            barTone,
            // R134 — the fill eases in like every other bar in the app
            // (the trend panel's motion law: one duration family, never a
            // snap-in), and stands perfectly still under motion-reduce.
            "[&>div]:transition-transform [&>div]:duration-500 [&>div]:ease-out motion-reduce:[&>div]:transition-none",
          )}
        />
      ) : null}
      {m.level === "reached" ? (
        <p className="text-destructive flex items-start gap-1.5 text-xs">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {periodEnd ? t("reachedNotice", { date: formatDate(periodEnd, "en") }) : t("reachedNoticeNoDate")}
        </p>
      ) : null}
    </div>
  );
}

export function UsageQuickDialog({
  open,
  onOpenChange,
  onOpenSubscription,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Deep link to the full Settings → Subscription view. */
  onOpenSubscription: () => void;
}) {
  const t = useTranslations("billing.usage");
  const tCommon = useTranslations("common");
  const uiLocale = useLocale();
  // Fetch ONLY while open (opening the palette must never fire a request).
  const usageQ = useUsage(open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="usage-quick-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Gauge className="text-primary size-4" aria-hidden="true" />
            {/* Gradient on the words only — the icon keeps its own color. */}
            <span className="gradient-warm">{t("title")}</span>
          </DialogTitle>
          <DialogDescription>{t("subtitle")}</DialogDescription>
        </DialogHeader>

        {usageQ.isLoading ? (
          <div className="space-y-4 py-1" aria-busy="true">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : usageQ.isError || !usageQ.data ? (
          <div className="text-muted-foreground flex flex-col items-start gap-2 py-1 text-sm">
            <span>{t("unavailable")}</span>
            <Button size="sm" variant="outline" onClick={() => void usageQ.refetch()}>
              <RefreshCcw className="size-3.5" aria-hidden="true" />
              {tCommon("retry")}
            </Button>
          </div>
        ) : (
          <div className="space-y-4 py-1">
            {/* Plan + period strip */}
            <div
              className="bg-muted/40 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs"
              data-testid="usage-quick-plan"
            >
              <Badge variant="secondary" className="font-semibold uppercase">
                {usageQ.data.planCode}
              </Badge>
              <span className="text-muted-foreground tabular-nums">
                {t("currentPeriod")}: {formatDate(usageQ.data.period.start, uiLocale)}
                {usageQ.data.period.end ? ` → ${formatDate(usageQ.data.period.end, uiLocale)}` : ""}
              </span>
            </div>

            <QuickMetricRow metric="AI_REQUESTS" m={usageQ.data.metrics.AI_REQUESTS} periodEnd={usageQ.data.period.end} />
            <QuickMetricRow metric="AI_MESSAGES" m={usageQ.data.metrics.AI_MESSAGES} periodEnd={usageQ.data.period.end} />
            {/* AI_TOKENS — recorded-when-reported (§14): only when real
                provider data exists; never displayed as a quota. */}
            {usageQ.data.metrics.AI_TOKENS.used > 0 ? (
              <QuickMetricRow metric="AI_TOKENS" m={usageQ.data.metrics.AI_TOKENS} periodEnd={usageQ.data.period.end} />
            ) : null}

            <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {t("serverAuthoritative")}
            </p>
          </div>
        )}

        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onOpenSubscription} data-testid="usage-quick-open-subscription">
            {t("quickOpenSubscription")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
