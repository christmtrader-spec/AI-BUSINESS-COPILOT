"use client";

/**
 * Prompt 34 — shared related-record list (§78).
 * Rows are real buttons (keyboard reachable, 44px min height), each with
 * icon + primary + secondary + trailing status/value. `onOpen` receives
 * the item id; navigation itself goes through the centralized entity
 * helpers (§34 — no arbitrary cross-module links).
 */

import type { LucideIcon } from "lucide-react";
import type { EntityType } from "@/lib/entity-routes";
import { cn } from "@/lib/utils";

export type RelatedRecordItem = {
  id: string;
  icon: LucideIcon;
  primary: string;
  secondary?: string | null;
  /** Trailing status/value chip text (already localized/formatted). */
  trailing?: string | null;
  /** Optional badge node (e.g. localized status) next to the trailing text. */
  badge?: React.ReactNode;
  /** Optional softer trailing text (e.g. date). */
  trailingMuted?: string | null;
};

export function RelatedRecordList({
  title,
  entity,
  items,
  emptyText,
  onOpen,
  className,
}: {
  title: string;
  /**
   * Closed entity type every row opens (the list is per-relation).
   * `null` renders STATIC rows (history entries that open nothing — §31:
   * never render non-interactive content as clickable).
   */
  entity: EntityType | null;
  items: RelatedRecordItem[];
  emptyText: string;
  /** (entity, id) — the caller maps to the centralized navigation helper. */
  onOpen: (entity: EntityType, id: string) => void;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={cn("bg-card overflow-hidden rounded-xl border", className)}
    >
      <h2 className="text-muted-foreground border-b px-4 py-2.5 text-sm font-medium">
        {title}
      </h2>
      {items.length === 0 ? (
        <p className="text-muted-foreground px-4 py-6 text-center text-sm">{emptyText}</p>
      ) : (
        <ul className="divide-y">
          {items.map((item) => {
            const Icon = item.icon;
            const rowInner = (
              <>
                <span className="bg-muted/60 flex size-8 shrink-0 items-center justify-center rounded-md">
                  <Icon className="text-muted-foreground size-4" aria-hidden="true" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium" dir="auto">
                    {item.primary}
                  </span>
                  {item.secondary ? (
                    <span className="text-muted-foreground truncate text-xs" dir="auto">
                      {item.secondary}
                    </span>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {item.badge}
                  {item.trailing ? (
                    <span className="text-sm font-medium tabular-nums" dir="ltr">
                      {item.trailing}
                    </span>
                  ) : null}
                  {item.trailingMuted ? (
                    <span className="text-muted-foreground text-xs">
                      {item.trailingMuted}
                    </span>
                  ) : null}
                </span>
              </>
            );
            const rowClass =
              "flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-start";
            return (
              <li key={`${entity ?? "static"}-${item.id}`}>
                {entity === null ? (
                  <div className={rowClass}>{rowInner}</div>
                ) : (
                  <button
                    type="button"
                    onClick={() => onOpen(entity, item.id)}
                    className={cn(
                      rowClass,
                      "hover:bg-accent focus-visible:bg-accent cursor-pointer outline-none",
                    )}
                  >
                    {rowInner}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
