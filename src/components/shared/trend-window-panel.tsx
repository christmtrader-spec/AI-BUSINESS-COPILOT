"use client";

import { useId, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronDown, GitCompareArrows } from "lucide-react";
import { toPersianDigits } from "@/lib/jalali";
import { fmtCount } from "@/modules/finance-shared/finance-kit";
import { trendDeltaCls } from "@/components/shared/trend-chip";

/**
 * R132 — THE WINDOW COMPARISON PANEL.
 *
 * The TrendChip says "what"; this panel says "how much, side by side".
 * One shared component for the dashboard perf card and the Reports KPI
 * strip — the visual language cannot drift between surfaces (the same
 * ONE-component law as TrendChip itself).
 *
 * Data law: EVERY number comes from the summary the surface ALREADY
 * fetched (the additive `trend` block + the current kpis) — zero new
 * requests, zero client-side recomputation of server truth. The delta
 * badges reuse TrendChip's exact hue law (riseIsGood per METRIC; pct is
 * null on a ≤0 baseline and renders as the honest "—", never a fabricated
 * percentage; prev=0 & cur≠0 renders "New").
 *
 * Bar law: within a row both bars normalize against max(|cur|, |prev|) of
 * THAT metric — bars are proportions of the row's own scale, never
 * cross-metric. Negative net cash renders a |value|-width ROSE bar with a
 * signed LTR label (honesty over prettiness). The bar track is dir="ltr"
 * in both locales (same time-axis law as the perf chart, W19).
 *
 * a11y law: the trigger is a real button (aria-expanded + aria-controls),
 * the panel is a labelled region, Escape collapses, focus-visible ring on
 * the trigger — the keyboard reaches everything the pointer does.
 */

export type TrendWindowBlock = {
  revenuePrevMinor: number;
  expensesPrevMinor: number;
  collectedPrevMinor: number;
  netCashPrevMinor: number;
  revenueChangePct: number | null;
  expensesChangePct: number | null;
  collectedChangePct: number | null;
  netCashChangePct: number | null;
  salesCountPrev: number;
  expensesCountPrev: number;
  previousRange: { from: string; to: string };
};

export function TrendWindowPanel({
  trend,
  kpis,
  range,
  fmt,
}: {
  trend: TrendWindowBlock;
  kpis: {
    revenueMinor: number;
    expensesMinor: number;
    collectedMinor: number;
    netCashMinor: number;
    salesCount: number;
    expensesCount: number;
  };
  range: { from: string; to: string };
  /** Money formatter bound to the business (fmtMoney(business, minor)). */
  fmt: (minor: number) => string;
}) {
  const t = useTranslations("trend");
  const uiLocale = useLocale();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const fa = uiLocale === "fa";
  const loc = (n: number | string) => (fa ? toPersianDigits(String(n)) : String(n));
  const rangeLabel = (r: { from: string; to: string }) =>
    loc(`${r.from.slice(5)} → ${r.to.slice(5)}`);

  const rows = [
    {
      key: "revenue",
      label: t("metricRevenue"),
      cur: kpis.revenueMinor,
      prev: trend.revenuePrevMinor,
      pct: trend.revenueChangePct,
      riseIsGood: true,
    },
    {
      key: "collected",
      label: t("metricCollected"),
      cur: kpis.collectedMinor,
      prev: trend.collectedPrevMinor,
      pct: trend.collectedChangePct,
      riseIsGood: true,
    },
    {
      key: "expenses",
      label: t("metricExpenses"),
      cur: kpis.expensesMinor,
      prev: trend.expensesPrevMinor,
      pct: trend.expensesChangePct,
      riseIsGood: false,
    },
    {
      key: "netCash",
      label: t("metricNetCash"),
      cur: kpis.netCashMinor,
      prev: trend.netCashPrevMinor,
      pct: trend.netCashChangePct,
      riseIsGood: true,
    },
  ] as const;

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        aria-expanded={open}
        aria-controls={panelId}
        className="text-muted-foreground hover:text-foreground hover:border-foreground/30 inline-flex h-7 items-center gap-1.5 rounded-full border border-border/70 bg-background/60 px-2.5 text-xs font-medium transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
      >
        <GitCompareArrows className="size-3.5" aria-hidden="true" />
        {t("compareTrigger")}
        <ChevronDown
          className={`size-3.5 transition-transform duration-200 motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {/* Grid-rows height animation (0fr → 1fr): layout-safe in both
          directions, disabled under motion-reduce. */}
      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div
            id={panelId}
            role="region"
            aria-label={t("panelLabel")}
            className="bg-card/60 mt-3 rounded-xl border p-4"
          >
            {/* Window header: current ← → previous, exact date keys */}
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-medium" dir="ltr">
              <span className="text-foreground/80">{rangeLabel(range)}</span>
              <span aria-hidden="true" className="border-foreground/30 border-x h-3" />
              <span>{rangeLabel(trend.previousRange)}</span>
              <span className="ms-auto">{t("currentVsPrevious")}</span>
            </div>

            <div className="mt-3 space-y-3.5">
              {rows.map((row) => {
                const max = Math.max(Math.abs(row.cur), Math.abs(row.prev));
                const curW = max > 0 ? (Math.abs(row.cur) / max) * 100 : 0;
                const prevW = max > 0 ? (Math.abs(row.prev) / max) * 100 : 0;
                // R132 bar-hue law: each row rides the METRIC's identity —
                // the same emerald/teal/rose family the KPI tones and the
                // delta badges already speak (one visual language). Net cash
                // is sign-tinted (honesty over prettiness); the previous bar
                // is the same hue at twin opacity (never a second color).
                const HUES = {
                  revenue: { cur: "bg-emerald-500/70 dark:bg-emerald-400/60", prev: "bg-emerald-500/30 dark:bg-emerald-400/25" },
                  collected: { cur: "bg-teal-500/70 dark:bg-teal-400/60", prev: "bg-teal-500/30 dark:bg-teal-400/25" },
                  expenses: { cur: "bg-rose-500/70 dark:bg-rose-400/60", prev: "bg-rose-500/30 dark:bg-rose-400/25" },
                } as const;
                const signTone = (a: number, b: string, c: string) => (a >= 0 ? b : c);
                const curTone =
                  row.key === "netCash"
                    ? signTone(row.cur, "bg-emerald-500/70 dark:bg-emerald-400/60", "bg-rose-500/70 dark:bg-rose-400/60")
                    : HUES[row.key].cur;
                const prevTone =
                  row.key === "netCash"
                    ? signTone(row.prev, "bg-emerald-500/30 dark:bg-emerald-400/25", "bg-rose-500/30 dark:bg-rose-400/25")
                    : HUES[row.key].prev;
                return (
                  <div key={row.key}>
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-semibold">{row.label}</p>
                      <span
                        className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums ${trendDeltaCls(row.pct, row.riseIsGood)}`}
                        aria-label={row.pct === null && row.prev !== 0 ? t("noBaseline") : undefined}
                      >
                        {row.pct === null
                          ? row.prev === 0 && row.cur !== 0
                            ? t("new")
                            : "—"
                          : row.pct === 0
                            ? "0%"
                            : `${loc(fmtCount(uiLocale, Math.abs(row.pct)))}%`}
                      </span>
                    </div>
                    <div className="mt-1.5 space-y-1" dir="ltr">
                      {/* Current bar */}
                      <div className="flex items-center gap-2">
                        <div className="bg-muted/50 h-2.5 min-w-0 flex-1 overflow-hidden rounded-full">
                          <div
                            className={`h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none ${curTone}`}
                            style={{ width: `${curW}%` }}
                          />
                        </div>
                        <span
                          className="w-20 shrink-0 text-end text-xs font-semibold tabular-nums"
                          title={t("currentWindow")}
                        >
                          {fmt(row.cur)}
                        </span>
                      </div>
                      {/* Previous bar (faded twin) */}
                      <div className="flex items-center gap-2">
                        <div className="bg-muted/30 h-2.5 min-w-0 flex-1 overflow-hidden rounded-full">
                          <div
                            className={`h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none ${prevTone}`}
                            style={{ width: `${prevW}%` }}
                          />
                        </div>
                        <span
                          className="text-muted-foreground w-20 shrink-0 text-end text-xs tabular-nums"
                          title={t("previousWindow")}
                        >
                          {fmt(row.prev)}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Counts strip: activity volume, not money — compact chips */}
            <div className="border-border/60 mt-4 flex flex-wrap gap-2 border-t pt-3">
              <span className="bg-muted/50 text-muted-foreground inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium tabular-nums">
                {t("salesCountChip", { cur: loc(fmtCount(uiLocale, kpis.salesCount)), prev: loc(fmtCount(uiLocale, trend.salesCountPrev)) })}
              </span>
              <span className="bg-muted/50 text-muted-foreground inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium tabular-nums">
                {t("expensesCountChip", { cur: loc(fmtCount(uiLocale, kpis.expensesCount)), prev: loc(fmtCount(uiLocale, trend.expensesCountPrev)) })}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
