"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  ChevronDown,
  Download,
  FileSpreadsheet,
  FileText,
  Loader2,
} from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { downloadCsv, exportStamp, toCsv } from "@/lib/csv";
import { downloadXlsx, type XlsxExportColumn } from "@/lib/xlsx-export";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Prompt 52 §F1 — the unified list-export kit.
 * Prompt 55 §X1 — upgraded to a format MENU: every list can now export a
 * real Excel workbook (.xlsx — typed number cells, frozen styled header,
 * RTL sheet for fa) alongside the lossless CSV. One consistent affordance
 * for EVERY list view: RFC 4180 escaping + UTF-8 BOM (Excel renders Persian
 * correctly), honest truncation toast, and the same disabled/loading
 * semantics everywhere. Rows come from the view's own `fetchAllPages`
 * walker so the export is complete-or-honest even when the table is
 * paginated.
 */

export type ExportColumn<T> = XlsxExportColumn<T>;

export function ListExportButton<T>({
  filename,
  columns,
  fetchRows,
  disabled = false,
  className,
  size = "sm",
  label,
  sheetName,
}: {
  /** Base filename WITHOUT extension — the stamp + ".csv"/".xlsx" are appended. */
  filename: string;
  columns: ExportColumn<T>[];
  /** Complete rows walker (usually fetchAllPages over the view's list API). */
  fetchRows: () => Promise<{ rows: T[]; total: number; truncated: boolean }>;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "default";
  /** Optional label override (defaults to the shared common key). */
  label?: string;
  /** Optional sheet name override (defaults to the filename base). */
  sheetName?: string;
}) {
  const tCommon = useTranslations("common");
  const uiLocale = useLocale();
  const [pending, setPending] = useState(false);

  async function run(format: "csv" | "xlsx") {
    setPending(true);
    try {
      const { rows, total, truncated } = await fetchRows();
      if (format === "csv") {
        const csv = toCsv(
          columns.map((c) => c.header),
          rows.map((r) => columns.map((c) => c.value(r))),
        );
        downloadCsv(`${filename}-${exportStamp()}.csv`, csv);
      } else {
        await downloadXlsx({
          filename: `${filename}-${exportStamp()}`,
          sheetName: sheetName ?? filename,
          columns,
          rows,
          rightToLeft: uiLocale === "fa",
        });
      }
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size={size}
          className={className}
          disabled={disabled || pending}
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Download className="size-4" aria-hidden="true" />
          )}
          {label ?? tCommon("export")}
          <ChevronDown className="size-3.5 opacity-60" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onSelect={() => void run("csv")}>
          <FileText className="size-4" aria-hidden="true" />
          {tCommon("exportCsv")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void run("xlsx")}>
          <FileSpreadsheet className="size-4" aria-hidden="true" />
          {tCommon("exportExcel")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
