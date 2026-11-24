"use client";

import { useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CalendarRange } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AdjacentWindowButtons } from "@/components/shared/custom-range-picker";
import {
  JALALI_PRESETS,
  formatJalaliDisplay,
  jalaliPresetWindow,
  toJalali,
  type JalaliPresetKey,
} from "@/lib/jalali";

/**
 * Prompt 52 §F4 — Jalali report-range presets.
 *
 * The SERVER stays Gregorian (report-periods law): this control converts a
 * Jalali preset ("this month / last month / this quarter / …") into
 * INCLUSIVE Gregorian YYYY-MM-DD keys and hands them to the parent, which
 * passes them to the API as from/to. The resolved window is displayed in
 * BOTH calendars (Jalali long-form + Gregorian key) so the user can never
 * be surprised by what range produced the numbers — honest reporting.
 */

export type JalaliRange = { from: string; to: string };

export function JalaliRangePresets({
  value,
  onChange,
  className,
  children,
  timezone,
}: {
  /** Currently applied window (Gregorian keys) or null for rolling presets. */
  value: JalaliRange | null;
  onChange: (range: JalaliRange | null) => void;
  className?: string;
  /** R175 — extra range affordances that join the SAME row (the custom
   *  range picker's trigger renders here; its popover portals out). The
   *  slot keeps the range row ONE visual home — never a second floating
   *  bar competing with the presets. */
  children?: ReactNode;
  /** R176 — the BUSINESS's timezone (the applied-window pager compares
   *  the adjacent window against the business-local today, never the
   *  browser's own zone). */
  timezone: string;
}) {
  const t = useTranslations("reports.jalali");
  const locale = useLocale();

  const labels: Record<JalaliPresetKey, string> = {
    thisMonth: t("thisMonth"),
    lastMonth: t("lastMonth"),
    thisQuarter: t("thisQuarter"),
    lastQuarter: t("lastQuarter"),
    last3Months: t("last3Months"),
    thisYear: t("thisYear"),
    lastYear: t("lastYear"),
  };

  // Cheap (7 items) — computed every render so locale switches relabel
  // immediately and the preset windows stay anchored to "now".
  const presets = JALALI_PRESETS.map((key) => ({
    key,
    label: labels[key],
    window: jalaliPresetWindow(key, new Date()),
  }));

  const shown = value
    ? {
        jalali: `${formatJalaliDisplay(toJalali(new Date(`${value.from}T12:00:00Z`)), { long: true, locale: locale === "fa" ? "fa" : "en" })} — ${formatJalaliDisplay(toJalali(new Date(`${value.to}T12:00:00Z`)), { long: true, locale: locale === "fa" ? "fa" : "en" })}`,
        gregorian: `${value.from} — ${value.to}`,
      }
    : null;

  // R179 — THE PRESSED-KEY DISAMBIGUATION. Two presets can compute the SAME
  // window: last3Months and thisQuarter are byte-identical whenever the
  // current Jalali month is a quarter-end month (months 3/6/9/12 — four
  // months a year; R178's live sample: Azar 1405 ⇒ both = [Mehr 1 → Azar 30]).
  // A window-equality find() alone highlights the array-order winner
  // (thisQuarter is listed first), so the user's press on last3Months reads
  // as "didn't register". The PRESSED key wins: a press records its key in a
  // local ref (presentation state — the WINDOW is the query state and stays
  // in the parent; the highlight is ephemeral UI, so it stays local too and
  // all three consumers inherit the law with zero parent changes). The hint
  // is honored ONLY while its recomputed window still equals the applied
  // value; any other value change (deep link, adjacent pager, custom picker,
  // rolling-days select) invalidates it and the highlight falls back to the
  // deterministic window find() — fresh visits and deep links stay pinned to
  // array order, never to a stale press. The hint is STATE (not a ref) — it
  // drives the render output (the highlight), so it must be render-safe:
  // react-hooks/refs forbids reading refs during render, and the press's
  // setPressedHint batches with the parent's value update into ONE render.
  const [pressedHint, setPressedHint] = useState<JalaliPresetKey | null>(null);
  const pressedWindow = pressedHint
    ? presets.find((p) => p.key === pressedHint)?.window ?? null
    : null;
  const activeKey = value
    ? pressedWindow &&
      pressedWindow.from === value.from &&
      pressedWindow.to === value.to
      ? pressedHint
      : presets.find((p) => p.window.from === value.from && p.window.to === value.to)?.key ?? null
    : null;

  return (
    <div className={className}>
      <div
        className="flex flex-wrap items-center gap-1.5"
        role="group"
        aria-label={t("groupLabel")}
      >
        <CalendarRange className="text-muted-foreground me-1 size-4" aria-hidden="true" />
        {presets.map((p) => (
          <Button
            key={p.key}
            type="button"
            variant={activeKey === p.key ? "secondary" : "outline"}
            size="sm"
            className={`h-8 ${activeKey === p.key ? "border-primary/50 bg-primary/10" : ""}`}
            aria-pressed={activeKey === p.key}
            onClick={() => {
              setPressedHint(p.key);
              onChange({ from: p.window.from, to: p.window.to });
            }}
          >
            {p.label}
          </Button>
        ))}
        {children}
        {value ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground h-8"
            onClick={() => {
              setPressedHint(null); // a stale hint must never bias a later deep link
              onChange(null);
            }}
          >
            {t("clear")}
          </Button>
        ) : null}
      </div>
      {shown ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="text-muted-foreground text-xs tabular-nums" dir="auto">
            <span dir={locale === "fa" ? "rtl" : "ltr"}>{shown.jalali}</span>
            <span className="mx-2">·</span>
            <span dir="ltr">{shown.gregorian}</span>
          </p>
          {/* R176 — the applied-window pager, only for NON-preset windows
              (activeKey is the preset match; a preset's pager is its own
              sibling buttons — one pressed affordance per window). */}
          {value && !activeKey ? (
            <AdjacentWindowButtons value={value} onChange={onChange} timezone={timezone} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
