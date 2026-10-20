"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { BarChart3, Loader2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { api, ApiClientError } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Task 2-b F9 — weekly digest preview card (settings).
 * Owner-facing PREVIEW ONLY: calls the digest-preview endpoint and shows the
 * last-7-days stats + window dates. It NEVER sends an email from the browser
 * — delivery is the operator cron's job (scripts/send-weekly-digest.mjs).
 */

type DigestPreview = {
  window: { start: string; end: string };
  computedAt: string;
  stats: {
    salesCount: number;
    salesTotalMinor: number;
    collectedMinor: number;
    expensesMinor: number;
    receivablesMinor: number;
    receivablesCount: number;
    lowStockCount: number;
    lowStockNames: string[];
    topProduct: { name: string; revenueMinor: number } | null;
  };
  formatted: {
    revenue: string;
    collected: string;
    expenses: string;
    receivables: string;
    topProductRevenue: string;
  };
};

export function DigestCard({ activeId }: { activeId: string }) {
  const t = useTranslations("digest");
  const [preview, setPreview] = useState<DigestPreview | null>(null);

  const previewMutation = useMutation({
    mutationFn: async () => api<DigestPreview>("/api/v1/reports/digest-preview"),
    onSuccess: (data) => setPreview(data),
    onError: (err) => {
      toast({
        title: err instanceof ApiClientError ? err.message : t("previewFailed"),
        variant: "destructive",
      });
    },
  });

  const stats = preview?.stats;
  const noData =
    stats !== undefined &&
    stats.salesCount === 0 &&
    stats.collectedMinor === 0 &&
    stats.expensesMinor === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BarChart3 className="text-primary size-4" aria-hidden="true" />
          {t("title")}
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={previewMutation.isPending}
            onClick={() => previewMutation.mutate()}
          >
            {previewMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            {t("preview")}
          </Button>
          {preview ? (
            <p className="text-muted-foreground text-xs" dir="ltr">
              {t("lastUpdated")}: {preview.computedAt.slice(0, 16).replace("T", " ")}Z
            </p>
          ) : null}
        </div>

        {preview && stats ? (
          <div className="space-y-2">
            <p className="text-muted-foreground text-xs">
              {t("previewTitle")}
            </p>
            <p className="text-muted-foreground text-xs">
              {t("windowLabel")}:{" "}
              <span className="tabular-nums" dir="ltr">
                {preview.window.start.slice(0, 10)} → {preview.window.end.slice(0, 10)}
              </span>
            </p>
            {noData ? (
              <p className="text-muted-foreground text-sm">{t("noData")}</p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {(
                    [
                      [t("salesCount"), String(stats.salesCount)],
                      [t("revenueMinor"), preview.formatted.revenue],
                      [t("collectedLabel"), preview.formatted.collected],
                      [t("expensesLabel"), preview.formatted.expenses],
                      [t("receivableLabel"), `${preview.formatted.receivables} (${stats.receivablesCount})`],
                      [
                        t("lowStockLabel"),
                        stats.lowStockNames.length > 0
                          ? `${stats.lowStockCount} — ${stats.lowStockNames.join("، ")}`
                          : String(stats.lowStockCount),
                      ],
                      [
                        t("topProductLabel"),
                        stats.topProduct
                          ? `${stats.topProduct.name} — ${preview.formatted.topProductRevenue}`
                          : "—",
                      ],
                    ] as Array<[string, string]>
                  ).map(([label, value]) => (
                    <tr key={label} className="border-border/60 border-b last:border-0">
                      <td className="py-1.5 pe-3 text-xs">{label}</td>
                      <td className="py-1.5 text-end font-medium" dir="auto">
                        {value}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
