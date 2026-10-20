"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Prompt 52 §F7 — first-visit onboarding tour.
 *
 * A lightweight, dependency-free spotlight: a positioned cutout highlights
 * real UI anchors (`data-tour` attributes) with a short explanation card.
 * Design laws:
 *  - Runs ONCE per browser (localStorage flag), only on the dashboard and
 *    only on desktop viewports (≥1024px) where the sidebar anchors exist —
 *    a tour pointing at invisible UI would be dishonest.
 *  - Skippable at every step (Skip button + Escape). Completion and skip
 *    both persist the flag.
 *  - RTL-safe (logical properties; the card flips with the highlight box).
 */

const TOUR_FLAG = "abc-tour-v1";

type TourStep = {
  anchor: string;
  titleKey: string;
  descKey: string;
};

const STEPS: TourStep[] = [
  { anchor: "quick-actions", titleKey: "quickActionsTitle", descKey: "quickActionsDesc" },
  { anchor: "module:sales", titleKey: "salesTitle", descKey: "salesDesc" },
  { anchor: "module:products", titleKey: "productsTitle", descKey: "productsDesc" },
  { anchor: "module:payments", titleKey: "paymentsTitle", descKey: "paymentsDesc" },
  { anchor: "module:reports", titleKey: "reportsTitle", descKey: "reportsDesc" },
  { anchor: "module:copilot", titleKey: "copilotTitle", descKey: "copilotDesc" },
  { anchor: "settings:business", titleKey: "settingsTitle", descKey: "settingsDesc" },
];

type Rect = { top: number; left: number; width: number; height: number };

function rectOf(anchor: string): Rect | null {
  const el = document.querySelector<HTMLElement>(`[data-tour="${CSS.escape(anchor)}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export function OnboardingTour({ enabled }: { enabled: boolean }) {
  const t = useTranslations("tour");
  const [active, setActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);

  // Steps that currently have a visible anchor (skips hidden/absent UI).
  const steps = useMemo(
    () => (active ? STEPS.filter((s) => rectOf(s.anchor) !== null) : []),
    [active],
  );

  const finish = useCallback(() => {
    setActive(false);
    setStepIndex(0);
    try {
      window.localStorage.setItem(TOUR_FLAG, new Date().toISOString());
    } catch {
      // Storage can be disabled — the tour simply runs again next visit.
    }
  }, []);

  // Arm once per browser on the dashboard, desktop only, after first paint.
  useEffect(() => {
    if (!enabled) return;
    if (window.innerWidth < 1024) return;
    let done = false;
    try {
      done = window.localStorage.getItem(TOUR_FLAG) !== null;
    } catch {
      done = false;
    }
    if (done) return;
    const timer = window.setTimeout(() => {
      if (rectOf("quick-actions") !== null) {
        setActive(true);
      }
    }, 900);
    return () => window.clearTimeout(timer);
  }, [enabled]);

  // Track the highlighted anchor (resize/scroll/RTL switches).
  useEffect(() => {
    if (!active || steps.length === 0) return; // render gate already hides the overlay
    const step = steps[Math.min(stepIndex, steps.length - 1)];
    const update = () => setRect(rectOf(step.anchor));
    // Defer the first measurement one frame — keeps the effect free of a
    // synchronous setState (no cascading render) while still positioning
    // before the browser paints.
    const raf = window.requestAnimationFrame(update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [active, steps, stepIndex]);

  // Escape dismisses; arrows navigate.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const forward = document.documentElement.dir !== "rtl" ? e.key === "ArrowRight" : e.key === "ArrowLeft";
        setStepIndex((i) => {
          const next = forward ? i + 1 : i - 1;
          if (next >= steps.length) {
            finish();
            return i;
          }
          return Math.max(0, next);
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, steps.length, finish]);

  if (!active || steps.length === 0 || rect === null) return null;

  const step = steps[Math.min(stepIndex, steps.length - 1)];
  const isLast = stepIndex === steps.length - 1;
  const PAD = 8;
  const CARD_OFFSET = 16;

  // Card placement: prefer below the highlight, flip above when clipped,
  // clamp horizontally into the viewport.
  const cardWidth = 320;
  const cardHeightEstimate = 180;
  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;
  const placeBelow = rect.top + rect.height + CARD_OFFSET + cardHeightEstimate < viewportH;
  const cardTop = placeBelow
    ? rect.top + rect.height + CARD_OFFSET
    : Math.max(12, rect.top - CARD_OFFSET - cardHeightEstimate);
  const cardLeft = Math.min(
    Math.max(12, rect.left + rect.width / 2 - cardWidth / 2),
    Math.max(12, viewportW - cardWidth - 12),
  );

  return (
    <div
      className="fixed inset-0 z-[80]"
      role="dialog"
      aria-modal="true"
      aria-label={t("ariaLabel")}
      data-view="onboarding-tour"
    >
      {/* Spotlight cutout: a transparent hole over the anchor via the
          box-shadow spread trick (no canvas, no measurement math beyond
          the anchor rect). Click-through stays blocked by the overlay. */}
      <div
        className="absolute rounded-xl transition-all duration-200"
        style={{
          top: rect.top - PAD,
          left: rect.left - PAD,
          width: rect.width + PAD * 2,
          height: rect.height + PAD * 2,
          boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
          pointerEvents: "none",
        }}
      />
      <button
        type="button"
        aria-label={t("skip")}
        className="absolute inset-0 cursor-default"
        onClick={finish}
      />
      <div
        className="bg-card absolute rounded-xl border p-4 shadow-xl"
        style={{
          top: cardTop,
          left: cardLeft,
          width: cardWidth,
          position: "absolute",
        }}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold" dir="auto">
            {t(step.titleKey as "salesTitle")}
          </p>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground size-7 shrink-0"
            onClick={finish}
            aria-label={t("skip")}
          >
            <X className="size-4" />
          </Button>
        </div>
        <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed" dir="auto">
          {t(step.descKey as "salesDesc")}
        </p>
        <div className="mt-4 flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs tabular-nums" dir="ltr">
            {t("stepOf", { current: stepIndex + 1, total: steps.length })}
          </span>
          <div className="flex items-center gap-2">
            {stepIndex > 0 ? (
              <Button variant="outline" size="sm" className="h-8" onClick={() => setStepIndex((i) => i - 1)}>
                {t("back")}
              </Button>
            ) : null}
            <Button
              size="sm"
              className={cn("h-8 min-w-20", isLast ? "" : "bg-gradient-to-r from-emerald-600 to-teal-600 text-white hover:from-emerald-700 hover:to-teal-700")}
              onClick={() => (isLast ? finish() : setStepIndex((i) => i + 1))}
            >
              {isLast ? t("done") : t("next")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
