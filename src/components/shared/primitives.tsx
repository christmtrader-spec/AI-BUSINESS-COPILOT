"use client";

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-10 text-center",
        className,
      )}
      role="status"
    >
      <div className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
        <Icon className="size-6" aria-hidden="true" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold">{title}</p>
        {description ? (
          <p className="text-muted-foreground max-w-sm text-sm">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  titleClassName,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  /** Extra classes for the h1 (e.g. "gradient-shimmer" for heroes).
   *  The signature `gradient-text` is applied by default. */
  titleClassName?: string;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="space-y-1">
        <h1
          className={cn(
            "text-2xl font-semibold tracking-tight gradient-text",
            titleClassName,
          )}
        >
          {title}
        </h1>
        {subtitle ? <p className="text-muted-foreground text-sm">{subtitle}</p> : null}
      </div>
      {actions ? (
        // flex-wrap: many-action headers (e.g. the supplier-bill detail with
        // Back + Export + Edit + Cancel + Post) must wrap on narrow phones —
        // a single unwrappable row overflows the 360px viewport (RTL left-bleed).
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export function Splash({ label }: { label?: string }) {
  return (
    <div className="bg-background flex min-h-svh flex-col items-center justify-center gap-4">
      <div className="bg-primary/10 flex size-14 items-center justify-center rounded-2xl">
        <img src="/logo.svg" alt="" className="size-8" aria-hidden="true" />
      </div>
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <span className="border-primary border-t-primary/25 size-4 animate-spin rounded-full border-2" aria-hidden="true" />
        {label ? <span>{label}</span> : null}
      </div>
    </div>
  );
}
