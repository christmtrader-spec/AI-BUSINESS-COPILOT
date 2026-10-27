"use client";

import { useLocale, useTranslations } from "next-intl";
import { TrendingDown, TrendingUp } from "lucide-react";
import { toPersianDigits } from "@/lib/jalali";
import { fmtCount } from "@/modules/finance-shared/finance-kit";

/**
 * R116 — the ONE trend chip, shared by the dashboard and the Reports KPI
 * strip (R115's inline dashboard chip extracted so the visual language
 * cannot drift between surfaces).
 *
 * Honesty law (L8, server-enforced): the server sends the RAW previous-window
 * total and a pctChange that is null on a ≤0 baseline. The chip derives its
 * state from those RAW inputs — it never invents a percentage:
 *   no previousRange            → nothing to say (hidden — pre-R115 cache);
 *   prev=0 & cur=0              → hidden (both windows silent);
 *   prev=0 & cur≠0              → muted "New" (no baseline exists);
 *   pct=null with prev≠0        → muted "—" (negative baseline, aria-label'd);
 *   otherwise                   → arrow + locale-digit %, hue follows the
 *                                 METRIC's meaning (`riseIsGood`: a rise is
 *                                 good for revenue/collected/net cash, bad
 *                                 for expenses — the arrow never lies alone).
 */
export function TrendChip({
  pct,
  prev,
  cur,
  riseIsGood,
  previousRange,
}: {
  pct: number | null;
  prev: number;
  cur: number;
  riseIsGood: boolean;
  previousRange?: { from: string; to: string } | null;
}) {
  const t = useTranslations("trend");
  const uiLocale = useLocale();
  if (!previousRange) return null;
  if (prev === 0 && cur === 0) return null;
  const rangeLabel = `${previousRange.from.slice(5)} → ${previousRange.to.slice(5)}`;
  const vsTitle = t("vsPrev", { range: uiLocale === "fa" ? toPersianDigits(rangeLabel) : rangeLabel });
  if (pct === null) {
    if (prev === 0) {
      return (
        <span
          className="inline-flex shrink-0 items-center rounded-full border border-border/60 bg-muted/50 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-muted-foreground"
          title={vsTitle}
        >
          {t("new")}
        </span>
      );
    }
    return (
      <span
        className="inline-flex shrink-0 items-center rounded-full border border-border/60 bg-muted/50 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-muted-foreground"
        title={vsTitle}
        aria-label={t("noBaseline")}
      >
        —
      </span>
    );
  }
  const rise = pct > 0;
  const good = pct === 0 ? null : rise === riseIsGood;
  const hueCls =
    good === null
      ? "border-border/60 bg-muted/50 text-muted-foreground"
      : good
        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
        : "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums ${hueCls}`}
      title={vsTitle}
    >
      {rise ? (
        <TrendingUp className="size-3" aria-hidden="true" />
      ) : (
        <TrendingDown className="size-3" aria-hidden="true" />
      )}
      {pct === 0 ? "0%" : `${fmtCount(uiLocale, Math.abs(pct))}%`}
    </span>
  );
}
