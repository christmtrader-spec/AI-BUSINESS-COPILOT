"use client";

/**
 * R135 — THE 14-DAY AI-USAGE SPARKLINE (⌘K quick dialog).
 *
 * Server truth only: the bars render `useUsageSeries` (the SAME COMMITTED
 * UsageEvents the meter counts) — this component never computes, inflates
 * or interpolates a number (§52: informational, never authorizing).
 *
 * Honesty laws:
 * - an ALL-ZERO window renders the empty-state text, never a fake flat
 *   line — silence and "no usage" must look different;
 * - heights normalize to the window's own max (a 1-request day in a
 *   1-request window is a FULL bar, honestly);
 * - zero days keep a 2px floor line — the day exists (zero-fill law of
 *   src/lib/billing/usage-series.ts), it just has no usage;
 * - today's bar carries the strong hue; past days the 70% twin — the eye
 *   finds "now" without a legend.
 *
 * A11y law: ONE composed `role="img"` label (total + busiest day) — a
 * screen reader gets the summary, not fourteen tab stops; pointer users
 * get per-bar `title` tooltips. `dir="ltr"` keeps the time axis flowing
 * left→right even in FA (time axes don't mirror; the LABELS localize).
 *
 * Motion law: opacity-only transitions, `motion-reduce` still (the app's
 * one motion family — R132's panel law).
 */

import { useLocale, useTranslations } from "next-intl";
import { useUsageSeries } from "@/hooks/use-billing";
import { toPersianDigits } from "@/lib/jalali";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Bot } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

/** Locale-aware short day label (e.g. "Oct 28" / «۲۸ آبان»). */
function dayLabel(iso: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : locale, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${iso}T12:00:00.000Z`));
  } catch {
    return iso.slice(5);
  }
}

export function UsageSeriesSpark({ open }: { open: boolean }) {
  const t = useTranslations("billing.usage");
  const locale = useLocale();
  const navigate = useAppStore((s) => s.navigate);
  const fa = locale === "fa";
  const loc = (n: number | string) => (fa ? toPersianDigits(String(n)) : String(n));
  const seriesQ = useUsageSeries(open);

  if (seriesQ.isLoading) {
    return (
      <div className="space-y-1.5" aria-busy="true">
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (seriesQ.isError || !seriesQ.data) {
    return (
      <p className="text-muted-foreground py-1 text-xs" role="status">
        {t("seriesUnavailable")}
      </p>
    );
  }

  const { series } = seriesQ.data;
  const total = series.reduce((acc, d) => acc + d.requests, 0);
  const max = Math.max(...series.map((d) => d.requests));
  const todayKey = series.length ? series[series.length - 1].date : "";
  const busiest = series.reduce<{ date: string; requests: number } | null>(
    (best, d) => (d.requests > 0 && (!best || d.requests > best.requests) ? { date: d.date, requests: d.requests } : best),
    null,
  );

  if (total === 0) {
    return (
      <div className="space-y-1.5" data-testid="usage-series-empty">
        <p className="text-muted-foreground text-xs font-medium">{t("seriesTitle")}</p>
        <div className="border-border/70 rounded-md border border-dashed px-3 py-3">
          <p className="text-muted-foreground/80 text-xs leading-relaxed">{t("seriesEmpty")}</p>
          {/* R136 — the empty state is an INVITATION, not a dead end: one
              click lands the copilot where the first request comes from.
              A real button (the a11y law) — not a fake link. */}
          <Button
            variant="outline"
            size="sm"
            className="mt-2 h-7 gap-1.5 text-xs"
            onClick={() => navigate({ kind: "module", module: "copilot" })}
            data-testid="usage-series-ask"
          >
            <Bot className="size-3.5" aria-hidden="true" />
            {t("seriesAskCta")}
          </Button>
        </div>
      </div>
    );
  }

  // ONE composed screen-reader summary — the numbers the bars encode.
  const ariaSummary = [
    `${t("seriesTitle")} — ${t("seriesTotal", { count: loc(total) })}`,
    busiest ? t("seriesBusiest", { date: dayLabel(busiest.date, locale), count: loc(busiest.requests) }) : null,
  ]
    .filter(Boolean)
    .join(". ");

  return (
    <div className="space-y-1.5" data-testid="usage-series-spark">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <p className="text-muted-foreground text-xs font-medium">{t("seriesTitle")}</p>
        <p className="text-muted-foreground text-xs tabular-nums">
          {t("seriesTotal", { count: loc(total) })}
        </p>
      </div>
      <div
        role="img"
        aria-label={ariaSummary}
        className="border-border/70 flex h-10 items-end gap-[2px] border-b"
        dir="ltr"
      >
        {series.map((d) => {
          const isToday = d.date === todayKey;
          const h = d.requests === 0 ? 2 : Math.max(12, Math.round((d.requests / max) * 100));
          const label = `${dayLabel(d.date, locale)}${isToday ? ` · ${t("seriesToday")}` : ""}: ${loc(d.requests)}`;
          return (
            <div
              key={d.date}
              title={label}
              style={{ height: `${h}%` }}
              data-testid={`usage-series-bar-${d.date}`}
              data-today={isToday || undefined}
              data-zero={d.requests === 0 || undefined}
              className={[
                "min-w-[3px] flex-1 rounded-t-[2px]",
                // Hue law: today strong, past days the 70% twin, zero days
                // the muted floor — no legend needed, "now" is findable.
                d.requests === 0
                  ? "bg-muted-foreground/25"
                  : isToday
                    ? "bg-primary"
                    : "bg-primary/70",
                "transition-opacity duration-200 hover:opacity-80 motion-reduce:transition-none",
              ].join(" ")}
            />
          );
        })}
      </div>
      {/* R136 — the axis anchors: first and last day micro-labels under the
          baseline. Time axes don't mirror (the dir="ltr" law above), but the
          LABELS localize — Persian calendar names ride the same formatter. */}
      <div className="text-muted-foreground/70 flex justify-between text-[10px] leading-none" dir="ltr">
        <span>{dayLabel(series[0].date, locale)}</span>
        <span className="flex items-center gap-1">
          <span aria-hidden="true" className="bg-primary size-1.5 rounded-full" />
          {dayLabel(todayKey, locale)}
        </span>
      </div>
    </div>
  );
}
