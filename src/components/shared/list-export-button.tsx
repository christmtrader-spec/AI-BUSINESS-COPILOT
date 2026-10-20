"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Download, Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { downloadCsv, exportStamp, toCsv } from "@/lib/csv";
import { Button } from "@/components/ui/button";

/**
 * Prompt 52 §F1 — the unified list-export kit.
 *
 * One consistent "Excel/CSV" affordance for EVERY list view: RFC 4180
 * escaping + UTF-8 BOM (Excel renders Persian correctly), formula-injection
 * guard, honest truncation toast, and the same disabled/loading semantics
 * everywhere. Rows come from the view's own `fetchAllPages` walker so the
 * export is complete-or-honest even when the table is paginated.
 */

export type ExportColumn<T> = {
  header: string;
  value: (row: T) => string | number | null | undefined;
};

export function ListExportButton<T>({
  filename,
  columns,
  fetchRows,
  disabled = false,
  className,
  size = "sm",
  label,
}: {
  /** Base filename WITHOUT extension — the stamp + ".csv" are appended. */
  filename: string;
  columns: ExportColumn<T>[];
  /** Complete rows walker (usually fetchAllPages over the view's list API). */
  fetchRows: () => Promise<{ rows: T[]; total: number; truncated: boolean }>;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "default";
  /** Optional label override (defaults to the shared common key). */
  label?: string;
}) {
  const tCommon = useTranslations("common");
  const [pending, setPending] = useState(false);

  async function run() {
    setPending(true);
    try {
      const { rows, total, truncated } = await fetchRows();
      const csv = toCsv(
        columns.map((c) => c.header),
        rows.map((r) => columns.map((c) => c.value(r))),
      );
      downloadCsv(`${filename}-${exportStamp()}.csv`, csv);
      toast({
        title: truncated
          ? tCommon("exportedTruncated", { count: rows.length, total })
          : tCommon("exportedCount", { count: rows.length }),
      });
    } catch {
      toast({ title: tCommon("exportFailed"), variant: "destructive" });
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      className={className}
      onClick={() => void run()}
      disabled={disabled || pending}
    >
      {pending ? (
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        <Download className="size-4" aria-hidden="true" />
      )}
      {label ?? tCommon("exportCsv")}
    </Button>
  );
}
