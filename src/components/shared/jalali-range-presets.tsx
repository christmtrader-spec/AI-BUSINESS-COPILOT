"use client";

import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CalendarRange } from "lucide-react";
import { Button } from "@/components/ui/button";
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

  const activeKey = value
    ? presets.find((p) => p.window.from === value.from && p.window.to === value.to)?.key ?? null
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
            onClick={() => onChange({ from: p.window.from, to: p.window.to })}
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
            onClick={() => onChange(null)}
          >
            {t("clear")}
          </Button>
        ) : null}
      </div>
      {shown ? (
        <p className="text-muted-foreground mt-1.5 text-xs tabular-nums" dir="auto">
          <span dir={locale === "fa" ? "rtl" : "ltr"}>{shown.jalali}</span>
          <span className="mx-2">·</span>
          <span dir="ltr">{shown.gregorian}</span>
        </p>
      ) : null}
    </div>
  );
}
