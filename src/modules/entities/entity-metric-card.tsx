"use client";

/**
 * Prompt 34 — shared metric card (§77). Token-based colors only
 * (positive/warning tones map to existing semantic tokens); values are
 * pre-formatted by the caller with the business money utilities (§43).
 */

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function EntityMetricCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  /** Pre-formatted display value (money/count/date). */
  value: string;
  hint?: string;
  icon?: LucideIcon;
  tone?: "default" | "positive" | "warning";
}) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-700 dark:text-emerald-400"
      : tone === "warning"
        ? "text-amber-700 dark:text-amber-400"
        : "";
  return (
    <div className="rounded-lg border p-4">
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium tracking-wide uppercase">
        {Icon ? <Icon className="size-3.5" aria-hidden="true" /> : null}
        {label}
      </p>
      <p className={cn("mt-1 truncate text-xl font-semibold tabular-nums", toneClass)} dir="ltr">
        {value}
      </p>
      {hint ? <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p> : null}
    </div>
  );
}
