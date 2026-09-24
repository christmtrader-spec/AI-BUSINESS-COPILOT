"use client";

/**
 * Payment history card — Prompt 22. Read-only history of subscription
 * payments recorded from VERIFIED provider webhooks. Informational only:
 * every plan/entitlement decision re-reads the server (§24 — this card
 * never authorizes anything).
 */
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Download, Loader2, ReceiptText } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { formatMinor } from "@/lib/payments/pricing";
import { downloadPaymentsCsv, usePayments } from "@/hooks/use-billing";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function PaymentsHistoryCard({ businessId }: { businessId: string }) {
  const t = useTranslations("billing.payments");
  const tCheckout = useTranslations("billing.checkout");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const paymentsQ = usePayments();
  const [exporting, setExporting] = useState(false);

  const onExport = async () => {
    setExporting(true);
    try {
      const rows = await downloadPaymentsCsv(businessId);
      toast({ title: tCommon("exportedCount", { count: rows }) });
    } catch (error) {
      toast({
        title: tCommon("exportFailed"),
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  };

  const fmtWhen = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(locale === "fa" ? "fa-IR" : locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(iso));
    } catch {
      return iso.slice(0, 10);
    }
  };

  return (
    <Card data-testid="payments-card">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <ReceiptText className="text-muted-foreground size-4" aria-hidden="true" />
              {t("title")}
            </CardTitle>
            <CardDescription className="mt-1">{t("subtitle")}</CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={onExport}
            disabled={exporting}
            data-testid="payments-export"
          >
            {exporting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="size-4" aria-hidden="true" />
            )}
            <span>{t("exportCsv")}</span>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {paymentsQ.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-3/4" />
          </div>
        ) : !paymentsQ.data || paymentsQ.data.items.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="payments-empty">
            {t("empty")}
          </p>
        ) : (
          <div className="max-h-96 overflow-y-auto pr-1" data-testid="payments-list">
            <ul className="space-y-2">
              {paymentsQ.data.items.map((p) => (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-md border px-3 py-2 text-sm"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge
                      variant="outline"
                      className={cn(
                        "font-medium",
                        p.status === "SUCCEEDED"
                          ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                          : "border-destructive/40 bg-destructive/10 text-destructive",
                      )}
                    >
                      {tCheckout(
                        `status_${p.status}` as "status_SUCCEEDED",
                      )}
                    </Badge>
                    <span className="font-medium" data-testid="payments-plan">
                      {p.planCode}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {p.billingPeriod === "YEARLY"
                        ? tCheckout("periodYearly")
                        : tCheckout("periodMonthly")}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-semibold" data-testid="payments-amount">
                      {formatMinor(p.amountMinor, p.currency, locale)}
                    </span>
                    <span className="text-muted-foreground text-xs">{fmtWhen(p.processedAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
