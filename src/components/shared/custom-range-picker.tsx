"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CalendarPlus, CalendarRange, ChevronLeft, ChevronRight, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  MAX_REPORT_RANGE_DAYS,
  addLocalDays,
  daysBetweenInclusive,
  localDateKeyOf,
  parseLocalDateKey,
} from "@/lib/report-periods";
import { JALALI_PRESETS, formatJalaliDisplay, jalaliPresetWindow, toJalali } from "@/lib/jalali";
import { cn } from "@/lib/utils";

/**
 * R175 — Reports CUSTOM DATE RANGE (the server's own grammar reaches the UI).
 *
 * Prompt 52 §F4 gave /api/v1/reports/summary (and /reports/export) an
 * explicit `?from=&to=` window — but the UI could only REACH it through the
 * seven fixed Jalali presets; no human could ask for "Oct 1 → Nov 15".
 * This picker closes that affordance gap with ZERO API changes: it writes
 * through the parent's ONE applied-range state (the SAME jalaliRange the
 * presets write), so the summary query, the CSV export, the both-calendar
 * display line and the deep-link grammar all keep riding unchanged paths.
 *
 * LAWS (mirrored from lib/report-periods — the client HINTS, the server
 * stays the authority and 422 INVALID_REPORT_RANGE surfaces in the banner):
 *  - strict Gregorian YYYY-MM-DD keys (parseLocalDateKey — real calendar
 *    dates only, 2000..2100);
 *  - from <= to, span <= MAX_REPORT_RANGE_DAYS (366) — checked on the RAW
 *    keys exactly like resolveCustomRange (clamping never rescues an
 *    over-wide span);
 *  - from may not lie in the future (L4); a future `to` is clamped to the
 *    business-local today BEFORE applying, so what the UI sends is what
 *    the server would have resolved (L3: the timezone input is the
 *    BUSINESS's — the browser's own zone is never consulted);
 *  - the applied window is displayed in BOTH calendars by the presets
 *    row's shown-line (honest reporting — this picker only adds entry).
 */

export type CustomRangeValue = { from: string; to: string };

type DraftError = "invalid" | "order" | "future" | "span" | null;

/** shadcn Input classes on the native date inputs, with the family's
 *  focus-visible ring family (ring + offset + motion-reduce escape). */
const DATE_INPUT_CLASS =
  "border-input bg-transparent placeholder:text-muted-foreground flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none";

function localeDigits(locale: string, n: number): string {
  return new Intl.NumberFormat(locale === "fa" ? "fa-IR" : "en-US").format(n);
}

export function CustomRangePicker({
  value,
  onChange,
  timezone,
  className,
}: {
  /** Currently applied window (Gregorian keys) or null for rolling presets. */
  value: CustomRangeValue | null;
  /** Writes through the parent's ONE range state — the presets share it. */
  onChange: (range: CustomRangeValue | null) => void;
  /** The business timezone (L3 — the browser's own zone is never an input). */
  timezone: string;
  className?: string;
}) {
  const t = useTranslations("reports.customRange");
  const locale = useLocale();
  const [open, setOpen] = useState(false);

  // Draft inputs — the APPLIED range stays the parent's state; an abandoned
  // draft dies with the popover, never leaking into the applied window.
  const [fromDraft, setFromDraft] = useState("");
  const [toDraft, setToDraft] = useState("");

  const now = new Date();
  const todayKey = localDateKeyOf(now, timezone);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      // Prefill the APPLIED window when one exists (edit-in-place), else a
      // sensible last-30-days draft — both anchored in the business zone.
      const from = value?.from ?? addLocalDays(todayKey, -29);
      const to = value?.to ?? todayKey;
      setFromDraft(from);
      setToDraft(to);
    }
  };

  const fromKey = parseLocalDateKey(fromDraft);
  const toKey = parseLocalDateKey(toDraft);

  // Validation mirrors resolveCustomRange's exact order: parse → order →
  // span (on the RAW keys) → future-from → clamp-future-to.
  let draftError: DraftError = null;
  if (fromDraft !== "" || toDraft !== "") {
    if (!fromKey || !toKey) draftError = "invalid";
    else if (fromKey > toKey) draftError = "order";
    else if (daysBetweenInclusive(fromKey, toKey) > MAX_REPORT_RANGE_DAYS) draftError = "span";
    else if (fromKey > todayKey) draftError = "future";
  }
  const canApply = draftError === null && fromKey !== null && toKey !== null;
  const spanDays = fromKey && toKey ? daysBetweenInclusive(fromKey, toKey) : null;
  const clampedTo = toKey !== null && toKey > todayKey ? todayKey : toKey;

  // Nudge law — shift the DRAFT to the ADJACENT window of the same inclusive
  // span (no overlap, no gaps): previous = [from − N, from − 1], next =
  // [to + 1, to + N] where N = daysBetweenInclusive(from, to). The nudge
  // edits the draft only — validation, the hint and the future-to clamp all
  // run over the shifted draft, so the user reviews before applying (the
  // server stays the authority; what the UI sends is what it would resolve).
  const nudgeDraft = (direction: "prev" | "next") => {
    if (!fromKey || !toKey) return;
    const span = daysBetweenInclusive(fromKey, toKey);
    if (direction === "prev") {
      setFromDraft(addLocalDays(fromKey, -span));
      setToDraft(addLocalDays(fromKey, -1));
    } else {
      setFromDraft(addLocalDays(toKey, 1));
      setToDraft(addLocalDays(toKey, span));
    }
  };

  const apply = () => {
    if (!canApply || fromKey === null || clampedTo === null) return;
    onChange({ from: fromKey, to: clampedTo });
    setOpen(false);
  };

  // Pressed exactly when a NON-preset window is applied (a deep link or an
  // earlier custom pick) — preset windows press their own preset button in
  // the row instead (one pressed affordance per window, never two).
  const matchesPreset = value
    ? JALALI_PRESETS.some((k) => {
        const w = jalaliPresetWindow(k, now);
        return w.from === value.from && w.to === value.to;
      })
    : false;
  const customActive = value !== null && !matchesPreset;

  const jalaliOf = (key: string) =>
    formatJalaliDisplay(toJalali(new Date(`${key}T12:00:00Z`)), {
      long: true,
      locale: locale === "fa" ? "fa" : "en",
    });

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={customActive ? "secondary" : "outline"}
          size="sm"
          aria-pressed={customActive}
          aria-label={customActive && value ? `${t("trigger")}: ${value.from} → ${value.to}` : t("trigger")}
          title={t("trigger")}
          data-testid="custom-range-trigger"
          className={cn(
            "h-8 gap-1.5",
            customActive && "border-primary/50 bg-primary/10",
            className,
          )}
        >
          <CalendarPlus className="size-3.5" aria-hidden="true" />
          {t("trigger")}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 p-4"
        role="dialog"
        aria-label={t("popoverLabel")}
        data-testid="custom-range-popover"
      >
        <p className="flex items-center gap-2 text-sm font-medium">
          <CalendarRange className="text-muted-foreground size-4" aria-hidden="true" />
          {t("popoverLabel")}
        </p>
        <div className="mt-3 grid gap-3">
          <div className="grid gap-1.5">
            <label htmlFor="custom-range-from" className="text-muted-foreground text-xs font-medium">
              {t("from")}
            </label>
            <input
              id="custom-range-from"
              type="date"
              value={fromDraft}
              onChange={(e) => setFromDraft(e.target.value)}
              className={DATE_INPUT_CLASS}
              dir="ltr"
              data-testid="custom-range-from"
            />
            {fromKey ? (
              <p className="text-muted-foreground text-[11px] tabular-nums" dir="auto">
                {jalaliOf(fromKey)}
              </p>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <label htmlFor="custom-range-to" className="text-muted-foreground text-xs font-medium">
              {t("to")}
            </label>
            <input
              id="custom-range-to"
              type="date"
              value={toDraft}
              min={fromKey ?? undefined}
              onChange={(e) => setToDraft(e.target.value)}
              className={DATE_INPUT_CLASS}
              dir="ltr"
              data-testid="custom-range-to"
            />
            {toKey ? (
              <p className="text-muted-foreground text-[11px] tabular-nums" dir="auto">
                {jalaliOf(toKey)}
              </p>
            ) : null}
          </div>
        </div>
        {/* R175 — the window nudge: page the draft through time one
            same-length window at a time (prev/next are adjacency moves,
            never overlapping re-draws). dir=rtl mirrors the row by DOM
            order — the icons keep their own directional meaning. */}
        <div className="mt-3 flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-muted-foreground focus-visible:ring-offset-1 h-8 gap-1"
            onClick={() => nudgeDraft("prev")}
            disabled={!canApply}
            title={t("prevWindow")}
            aria-label={t("prevWindow")}
            data-testid="custom-range-prev"
          >
            <ChevronLeft className="size-3.5" aria-hidden="true" />
            <span className="text-xs">{t("prevWindow")}</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-muted-foreground focus-visible:ring-offset-1 h-8 gap-1"
            onClick={() => nudgeDraft("next")}
            disabled={!canApply}
            title={t("nextWindow")}
            aria-label={t("nextWindow")}
            data-testid="custom-range-next"
          >
            <span className="text-xs">{t("nextWindow")}</span>
            <ChevronRight className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
        <p
          role="status"
          className={cn(
            "mt-3 min-h-4 text-xs",
            draftError ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
          )}
          data-testid="custom-range-hint"
        >
          {draftError === "invalid"
            ? t("invalid")
            : draftError === "order"
              ? t("order")
              : draftError === "span"
                ? t("span", { max: localeDigits(locale, MAX_REPORT_RANGE_DAYS) })
                : draftError === "future"
                  ? t("future")
                  : spanDays !== null
                    ? t("hintDays", { count: localeDigits(locale, spanDays) })
                    : ""}
        </p>
        <div className="mt-3 flex items-center justify-end gap-2 border-t pt-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground focus-visible:ring-offset-1 h-8 gap-1.5"
            onClick={() => {
              setFromDraft("");
              setToDraft("");
            }}
            data-testid="custom-range-reset"
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            {t("reset")}
          </Button>
          <Button
            type="button"
            size="sm"
            className="focus-visible:ring-offset-1 h-8"
            onClick={apply}
            disabled={!canApply}
            data-testid="custom-range-apply"
          >
            {t("apply")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
