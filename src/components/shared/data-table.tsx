"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Column-definition-driven DataTable (r17).
 *
 * Alignment law: the SAME `align` value from a single ColumnDef is applied to
 * BOTH the <th> and the <td> — headers can never drift away from their cells,
 * in LTR or RTL. Alignment uses logical utilities (text-start / text-center /
 * text-end) that mirror automatically in RTL.
 *
 * Bidi law: never set `dir` on the td/th itself (that would re-resolve
 * text-start/text-end against the element's own direction and desync it from
 * the header). LTR islands (phone numbers, emails, invoice ids, …) are inline
 * <span dir="ltr"> inside the cell — the span isolates glyph ORDER while the
 * td keeps full control of ALIGNMENT.
 */

export type ColumnAlign = "start" | "center" | "end";

export type SortDir = "asc" | "desc";

export type ColumnDef<T> = {
  /** Stable unique column id (also the sorting key). */
  id: string;
  /** Column title (already localized by the caller). */
  header: React.ReactNode;
  /** Cell renderer for a row. */
  cell: (row: T, index: number) => React.ReactNode;
  /** Logical alignment, applied identically to th + td. Default "start". */
  align?: ColumnAlign;
  /** Extra classes applied to BOTH th and td (e.g. "w-44"). */
  className?: string;
  /** th-only extras (rare). */
  thClassName?: string;
  /** td-only extras (e.g. truncation on the cell only). */
  tdClassName?: string;
  /** Responsive hiding — mirrors the old `hidden md:table-cell` pattern. */
  hideBelow?: "sm" | "md" | "lg";
  /** Provide to make the column client-sortable (current page). */
  sortValue?: (row: T) => string | number;
  /** Direction applied on the first click of an unsorted column. */
  defaultSortDir?: SortDir;
};

type SortState = { id: string; dir: SortDir } | null;

const ALIGN: Record<ColumnAlign, string> = {
  start: "text-start",
  center: "text-center",
  end: "text-end",
};

const HIDE: Record<NonNullable<ColumnDef<unknown>["hideBelow"]>, string> = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
};

const SKELETON_WIDTHS = [
  "w-28",
  "w-20",
  "w-24",
  "w-16",
  "w-32",
  "w-14",
  "w-24",
  "w-20",
];

/**
 * Prompt 34 §31 — elements that OWN their click semantics inside a row.
 * Clicking (or keyboard-activating) any of them never triggers the row's
 * navigation handler.
 */
const INTERACTIVE_ROW_SELECTOR =
  "button, a, input, select, textarea, label, [role='button'], [data-no-row-nav]";

function columnClasses<T>(col: ColumnDef<T>, side: "th" | "td"): string {
  return cn(
    ALIGN[col.align ?? "start"],
    col.hideBelow ? HIDE[col.hideBelow] : undefined,
    col.className,
    side === "th" ? col.thClassName : col.tdClassName,
  );
}

/** Inline LTR island — keeps phone numbers / emails / ids readable in RTL
 *  without stealing alignment control from the cell. */
export function Ltr({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span dir="ltr" className={cn("tabular-nums", className)}>
      {children}
    </span>
  );
}

/** Toolbar row: filters on the start side, meta/actions on the end side. */
export function DataTableToolbar({
  children,
  end,
  className,
}: {
  children: React.ReactNode;
  end?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
        {children}
      </div>
      {end ? <div className="flex shrink-0 items-center gap-2">{end}</div> : null}
    </div>
  );
}

export function DataTable<T>({
  columns,
  rows,
  getRowId,
  loading = false,
  skeletonRows = 4,
  empty,
  ariaLabel,
  sortLocale,
  maxHeightClass,
  stickyHeader = false,
  refreshing = false,
  onRowClick,
  rowClassName,
  className,
  containerClassName,
}: {
  columns: ColumnDef<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  loading?: boolean;
  skeletonRows?: number;
  /** Rendered inside a full-width colSpan row when `rows` is empty. */
  empty?: React.ReactNode;
  /** Accessible table label (sr-only caption). */
  ariaLabel?: string;
  /** BCP-47 locale used for string sorting (fa collation orders پ/چ/ژ correctly). */
  sortLocale?: string;
  /** e.g. "max-h-[32rem]" — enables a scrollable body. */
  maxHeightClass?: string;
  /** Sticky thead (implies a scrollable body). */
  stickyHeader?: boolean;
  /** True while a background refetch is in flight — subtle dim, no flash. */
  refreshing?: boolean;
  onRowClick?: (row: T) => void;
  /** Optional per-row extra classes (e.g. highlight the current month row). */
  rowClassName?: (row: T) => string;
  className?: string;
  containerClassName?: string;
}) {
  const t = useTranslations("common");
  const [sort, setSort] = React.useState<SortState>(null);

  const sortedRows = React.useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.id === sort.id);
    if (!col?.sortValue) return rows;
    const val = col.sortValue;
    return [...rows].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      let cmp: number;
      if (typeof va === "number" && typeof vb === "number") {
        cmp = va - vb;
      } else {
        cmp = String(va).localeCompare(String(vb), sortLocale, {
          sensitivity: "base",
          numeric: true,
        });
      }
      return sort.dir === "asc" ? cmp : -cmp;
    });
  }, [rows, columns, sort, sortLocale]);

  function toggleSort(col: ColumnDef<T>) {
    if (!col.sortValue) return;
    setSort((prev) => {
      if (prev?.id !== col.id) {
        return { id: col.id, dir: col.defaultSortDir ?? "asc" };
      }
      if (prev.dir === "asc") return { id: col.id, dir: "desc" };
      return null; // third click clears
    });
  }

  return (
    <div
      data-slot="data-table"
      className={cn(
        "relative w-full overflow-x-auto rounded-xl border bg-card shadow-xs",
        (maxHeightClass || stickyHeader) && "overflow-y-auto",
        maxHeightClass,
        containerClassName,
      )}
    >
      <Table className={className}>
        {ariaLabel ? <caption className="sr-only">{ariaLabel}</caption> : null}
        <TableHeader
          className={cn(
            "bg-muted/60",
            stickyHeader &&
              "[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-muted/95 [&_th]:backdrop-blur-sm",
          )}
        >
          <TableRow className="hover:bg-transparent border-b-border/70">
            {columns.map((col) => {
              const isActive = sort?.id === col.id;
              const sortable = Boolean(col.sortValue);
              return (
                <TableHead
                  key={col.id}
                  className={columnClasses(col, "th")}
                  aria-sort={
                    sortable
                      ? isActive
                        ? sort.dir === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                      : undefined
                  }
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(col)}
                      title={t("sortBy", {
                        column: typeof col.header === "string" ? col.header : col.id,
                      })}
                      className="group hover:text-foreground focus-visible:ring-ring -mx-1 inline-flex h-7 items-center gap-1 rounded px-1 transition-colors focus-visible:ring-2 focus-visible:outline-none"
                    >
                      {col.header}
                      {isActive ? (
                        sort.dir === "asc" ? (
                          <ArrowUp className="size-3.5" aria-hidden="true" />
                        ) : (
                          <ArrowDown className="size-3.5" aria-hidden="true" />
                        )
                      ) : (
                        <ArrowUpDown
                          className="size-3.5 opacity-40 transition-opacity group-hover:opacity-100"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  ) : (
                    col.header
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody
          className={cn(
            "transition-opacity",
            refreshing && "opacity-60 pointer-events-none",
          )}
        >
          {loading
            ? Array.from({ length: skeletonRows }).map((_, r) => (
                <TableRow key={`skeleton-${r}`} className="hover:bg-transparent">
                  {columns.map((col, ci) => (
                    <TableCell key={col.id} className={columnClasses(col, "td")}>
                      <Skeleton
                        className={cn(
                          "h-3.5",
                          SKELETON_WIDTHS[(r * 3 + ci) % SKELETON_WIDTHS.length],
                        )}
                      />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            : sortedRows.map((row, index) => (
                <TableRow
                  key={getRowId(row)}
                  onClick={
                    onRowClick
                      ? (event) => {
                          // Prompt 34 §31 — action buttons/links/inputs inside
                          // a row keep their own semantics; a click on them
                          // must NEVER trigger row navigation.
                          const target = event.target as HTMLElement | null;
                          if (target?.closest(INTERACTIVE_ROW_SELECTOR)) return;
                          onRowClick(row);
                        }
                      : undefined
                  }
                  onKeyDown={
                    onRowClick
                      ? (event) => {
                          // §31/§46 — keyboard activation parity for rows.
                          if (event.key !== "Enter" && event.key !== " ") return;
                          const target = event.target as HTMLElement | null;
                          if (target?.closest(INTERACTIVE_ROW_SELECTOR)) return;
                          event.preventDefault();
                          onRowClick(row);
                        }
                      : undefined
                  }
                  tabIndex={onRowClick ? 0 : undefined}
                  className={cn(
                    onRowClick && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    rowClassName?.(row),
                  )}
                >
                  {columns.map((col) => (
                    <TableCell key={col.id} className={columnClasses(col, "td")}>
                      {col.cell(row, index)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
          {!loading && sortedRows.length === 0 && empty ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columns.length} className="p-0">
                {empty}
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  );
}
